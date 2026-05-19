// Cloudflare Worker — CORS proxy + contact form + watermarking + auth/admin/portal
// Deploy via: ./worker/deploy-worker.sh  (uses wrangler + npm)
//
// Security model:
//  1. Origin header validation — rejects requests not from coastaltravelcompany.com
//  2. Session token exchange — POST /token exchanges passphrase for a short-lived sid
//  3. JWT auth (HS256) — 7-day tokens for client and admin sessions
//  4. Synology API allowlist — only Browse.Item, Thumbnail, Download forwarded
//  5. KV rate limiting — 300 req/min per gallery; 5/hour for contact form
//  6. Server-side watermarking — watermark=1 burns text into the image
//
// Required Worker secrets (set in Cloudflare dashboard or via wrangler secret put):
//   JWT_SECRET       — long random string used to sign auth tokens
//   RESEND_API_KEY   — already set from contact form setup
//   GOOGLE_CLIENT_ID — optional; enables Google Sign-In (set in dashboard → Variables)
//
// KV key schema (all in CTC_AUTH namespace, bound as KV):
//   user:{email}        → JSON user object
//   user_id:{uuid}      → email string (for lookup by id)
//   users_list          → JSON array of emails
//   gallery:{id}        → JSON gallery object
//   galleries_list      → JSON array of gallery ids (newest first)
//   reset:{token}       → JSON { email } — auto-expires after 1 hour
//   tok:{sid}           → JSON { passphrase, sharePassword } — auto-expires after 4 hours
//   rl:{passphrase}     → request count — auto-expires after 60 seconds
//   contact_rl:{ip}     → request count — auto-expires after 1 hour

import { PhotonImage, draw_text_with_border } from '@cf-wasm/photon';

const NAS_SHARE_API  = 'https://nas.coastaltravelcompany.com/mo/sharing/webapi/entry.cgi';
const NAS_SHARE_PAGE = 'https://nas.coastaltravelcompany.com/mo/sharing/';
const ALLOWED_ORIGIN = 'https://coastaltravelcompany.com';
const RATE_LIMIT         = 300; // max requests per 60 s per gallery
const CONTACT_RATE_LIMIT = 5;   // max contact form submissions per hour per IP
const CONTACT_TO         = 'thecoastaltravelcompany@gmail.com';
const WM_TEXT            = '© Coastal Travel Company';
const JWT_EXPIRY_SECS    = 7 * 24 * 3600; // 7 days

const ALLOWED_APIS = new Set([
  'SYNO.Foto.Browse.Item',
  'SYNO.Foto.Thumbnail',
  'SYNO.Foto.Download',
]);

const CORS = {
  'Access-Control-Allow-Origin':   ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods':  'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':  'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'Content-Disposition',
  'Access-Control-Max-Age':        '86400',
};

// ── Per-isolate session cache (passphrase → sharing_sid cookie) ───────────
const sidCache = {};

// ── Utility ──────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function authRequired() { return jsonResponse({ error: 'Authentication required' }, 401); }
function forbidden()    { return jsonResponse({ error: 'Forbidden' }, 403); }

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── JWT helpers (HS256, Web Crypto) ──────────────────────────────────────────

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(s) {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, pad);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function createJWT(payload, secret) {
  const enc = v => b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  const header  = enc({ alg: 'HS256', typ: 'JWT' });
  const body    = enc(payload);
  const input   = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad format');
  const [header, body, sig] = parts;
  const input = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, b64urlDecode(sig), new TextEncoder().encode(input)
  );
  if (!valid) throw new Error('bad signature');
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired');
  return payload;
}

async function getAuth(request, env) {
  if (!env.JWT_SECRET) return null;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  try { return await verifyJWT(auth.slice(7), env.JWT_SECRET); } catch { return null; }
}

// ── Password hashing (PBKDF2-SHA256, 100k iterations) ────────────────────────

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, km, 256
  );
  const out = new Uint8Array(48);
  out.set(salt);
  out.set(new Uint8Array(bits), 16);
  return btoa(String.fromCharCode(...out));
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const combined = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
  const salt = combined.slice(0, 16);
  const expected = combined.slice(16);
  const km = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, km, 256
  );
  const hash = new Uint8Array(bits);
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}

// ── KV: Users ────────────────────────────────────────────────────────────────

async function getUser(email, kv) {
  const raw = await kv.get('user:' + email.toLowerCase());
  return raw ? JSON.parse(raw) : null;
}

async function getUserById(id, kv) {
  const email = await kv.get('user_id:' + id);
  return email ? getUser(email, kv) : null;
}

async function putUser(user, kv) {
  const email = user.email.toLowerCase();
  await kv.put('user:' + email, JSON.stringify(user));
  await kv.put('user_id:' + user.id, email);
  const raw  = await kv.get('users_list');
  const list = raw ? JSON.parse(raw) : [];
  if (!list.includes(email)) {
    list.push(email);
    await kv.put('users_list', JSON.stringify(list));
  }
}

async function deleteUser(email, kv) {
  email = email.toLowerCase();
  const user = await getUser(email, kv);
  if (!user) return;
  await kv.delete('user:' + email);
  await kv.delete('user_id:' + user.id);
  const raw  = await kv.get('users_list');
  const list = raw ? JSON.parse(raw).filter(e => e !== email) : [];
  await kv.put('users_list', JSON.stringify(list));
}

async function listUsers(kv) {
  const raw    = await kv.get('users_list');
  const emails = raw ? JSON.parse(raw) : [];
  const users  = await Promise.all(emails.map(e => getUser(e, kv)));
  return users.filter(Boolean);
}

// ── KV: Galleries ────────────────────────────────────────────────────────────

async function getGallery(id, kv) {
  const raw = await kv.get('gallery:' + id);
  return raw ? JSON.parse(raw) : null;
}

async function putGallery(gallery, kv) {
  await kv.put('gallery:' + gallery.id, JSON.stringify(gallery));
  const raw  = await kv.get('galleries_list');
  const list = raw ? JSON.parse(raw) : [];
  if (!list.includes(gallery.id)) {
    list.unshift(gallery.id); // newest first
    await kv.put('galleries_list', JSON.stringify(list));
  }
}

async function deleteGallery(id, kv) {
  await kv.delete('gallery:' + id);
  const raw  = await kv.get('galleries_list');
  const list = raw ? JSON.parse(raw).filter(g => g !== id) : [];
  await kv.put('galleries_list', JSON.stringify(list));
}

async function listGalleries(kv) {
  const raw = await kv.get('galleries_list');
  const ids = raw ? JSON.parse(raw) : [];
  const gs  = await Promise.all(ids.map(id => getGallery(id, kv)));
  return gs.filter(Boolean);
}

// Keep gallery.assignedUsers and user.galleries in sync
async function syncGalleryAssignments(userEmail, added, removed, kv) {
  for (const id of added) {
    const g = await getGallery(id, kv);
    if (g && !(g.assignedUsers || []).includes(userEmail)) {
      g.assignedUsers = [...(g.assignedUsers || []), userEmail];
      await putGallery(g, kv);
    }
  }
  for (const id of removed) {
    const g = await getGallery(id, kv);
    if (g) {
      g.assignedUsers = (g.assignedUsers || []).filter(e => e !== userEmail);
      await putGallery(g, kv);
    }
  }
}

function stripSensitive(u) {
  return {
    id: u.id, email: u.email, role: u.role, created: u.created,
    galleries: u.galleries || [],
    verified: u.verified !== false,
    hasPassword: !!u.passwordHash,
  };
}

// ── Auth route handlers ───────────────────────────────────────────────────────

async function handleAuthSetupStatus(env) {
  const raw  = await env.KV.get('users_list');
  const list = raw ? JSON.parse(raw) : [];
  return jsonResponse({ configured: list.length > 0 });
}

async function handleAuthSetup(request, env) {
  if (!env.JWT_SECRET) return jsonResponse({ error: 'JWT_SECRET not configured' }, 503);
  const raw = await env.KV.get('users_list');
  if (raw && JSON.parse(raw).length > 0) return jsonResponse({ error: 'Already configured' }, 409);
  const { email, password } = await request.json();
  if (!email || !password || password.length < 8) {
    return jsonResponse({ error: 'Email and password (min 8 chars) required' }, 400);
  }
  const id   = crypto.randomUUID();
  const user = {
    id, email: email.toLowerCase(),
    passwordHash: await hashPassword(password),
    role: 'admin', created: Date.now(), galleries: [],
  };
  await putUser(user, env.KV);
  const now   = Math.floor(Date.now() / 1000);
  const token = await createJWT(
    { sub: user.email, id, role: 'admin', iat: now, exp: now + JWT_EXPIRY_SECS },
    env.JWT_SECRET
  );
  return jsonResponse({ token, user: { id, email: user.email, role: 'admin' } });
}

async function handleAuthRegister(request, env) {
  if (!env.JWT_SECRET) return jsonResponse({ error: 'JWT_SECRET not configured' }, 503);
  const { email, password } = await request.json();
  if (!email || !password || password.length < 8) {
    return jsonResponse({ error: 'Email and password (min 8 chars) required' }, 400);
  }
  if (await getUser(email.toLowerCase(), env.KV)) {
    return jsonResponse({ error: 'An account with that email already exists' }, 409);
  }
  const id          = crypto.randomUUID();
  const verifyToken = crypto.randomUUID();
  const user = {
    id, email: email.toLowerCase(),
    passwordHash: await hashPassword(password),
    role: 'client', created: Date.now(), galleries: [],
    verified: false,
  };
  await putUser(user, env.KV);
  await env.KV.put('verify:' + verifyToken, JSON.stringify({ email: user.email }), { expirationTtl: 86400 });
  if (env.RESEND_API_KEY) {
    const verifyUrl = `${ALLOWED_ORIGIN}/login.html?verify=${verifyToken}`;
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:      [user.email],
        subject: 'Verify your email — Coastal Travel Company',
        html:    `<p style="font-family:sans-serif;font-size:15px">Thanks for creating an account with Coastal Travel Company.</p>
<p style="font-family:sans-serif;font-size:15px">Please verify your email address to access your galleries. The link expires in 24 hours.</p>
<p style="font-family:sans-serif;font-size:15px"><a href="${verifyUrl}" style="color:#2A5C45">${verifyUrl}</a></p>
<p style="font-family:sans-serif;font-size:13px;color:#999">If you didn't create this account, you can ignore this email.</p>`,
      }),
    }).catch(() => {});
  }
  return jsonResponse({ ok: true });
}

async function handleAuthVerify(request, env) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return jsonResponse({ error: 'Verification token required' }, 400);
  const raw = await env.KV.get('verify:' + token);
  if (!raw) return jsonResponse({ error: 'Invalid or expired verification link' }, 400);
  const { email } = JSON.parse(raw);
  const user = await getUser(email, env.KV);
  if (!user) return jsonResponse({ error: 'Account not found' }, 404);
  user.verified = true;
  await putUser(user, env.KV);
  await env.KV.delete('verify:' + token);
  return jsonResponse({ ok: true });
}

async function handleAuthResendVerify(request, env) {
  const { email } = await request.json();
  if (!email) return jsonResponse({ error: 'Email required' }, 400);
  const user = await getUser(email.toLowerCase(), env.KV);
  if (user && user.verified === false && env.RESEND_API_KEY) {
    const token     = crypto.randomUUID();
    const verifyUrl = `${ALLOWED_ORIGIN}/login.html?verify=${token}`;
    await env.KV.put('verify:' + token, JSON.stringify({ email: user.email }), { expirationTtl: 86400 });
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:      [user.email],
        subject: 'Verify your email — Coastal Travel Company',
        html:    `<p style="font-family:sans-serif;font-size:15px">Here's a new verification link for your Coastal Travel Company account. It expires in 24 hours.</p>
<p style="font-family:sans-serif;font-size:15px"><a href="${verifyUrl}" style="color:#2A5C45">${verifyUrl}</a></p>`,
      }),
    }).catch(() => {});
  }
  return jsonResponse({ ok: true }); // always ok — don't reveal account status
}

async function handleAuthLogin(request, env) {
  if (!env.JWT_SECRET) return jsonResponse({ error: 'JWT_SECRET not configured' }, 503);
  const { email, password } = await request.json();
  if (!email || !password) return jsonResponse({ error: 'Email and password required' }, 400);
  const user = await getUser(email, env.KV);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return jsonResponse({ error: 'Invalid email or password' }, 401);
  }
  if (user.verified === false) {
    return jsonResponse({ error: 'Please verify your email address before signing in.', unverified: true }, 403);
  }
  const now   = Math.floor(Date.now() / 1000);
  const token = await createJWT(
    { sub: user.email, id: user.id, role: user.role, iat: now, exp: now + JWT_EXPIRY_SECS },
    env.JWT_SECRET
  );
  return jsonResponse({ token, user: { id: user.id, email: user.email, role: user.role } });
}

async function handleAuthGoogle(request, env) {
  if (!env.JWT_SECRET)       return jsonResponse({ error: 'JWT_SECRET not configured' }, 503);
  if (!env.GOOGLE_CLIENT_ID) return jsonResponse({ error: 'Google login not configured' }, 503);
  const { credential } = await request.json();
  if (!credential) return jsonResponse({ error: 'Missing credential' }, 400);
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
  if (!res.ok) return jsonResponse({ error: 'Invalid Google token' }, 401);
  const info = await res.json();
  if (info.aud !== env.GOOGLE_CLIENT_ID) return jsonResponse({ error: 'Token audience mismatch' }, 401);
  if (info.email_verified !== 'true')    return jsonResponse({ error: 'Email not verified' }, 401);
  const email = info.email.toLowerCase();
  const user  = await getUser(email, env.KV);
  if (!user) return jsonResponse({ error: 'No account found. Contact your administrator.' }, 403);
  // Google has already verified the email address — auto-verify any unverified account
  if (user.verified === false) {
    user.verified = true;
    await putUser(user, env.KV);
  }
  const now   = Math.floor(Date.now() / 1000);
  const token = await createJWT(
    { sub: user.email, id: user.id, role: user.role, iat: now, exp: now + JWT_EXPIRY_SECS },
    env.JWT_SECRET
  );
  return jsonResponse({ token, user: { id: user.id, email: user.email, role: user.role } });
}

async function handleAuthResetRequest(request, env) {
  const { email } = await request.json();
  if (!email) return jsonResponse({ error: 'Email required' }, 400);
  const user = await getUser(email, env.KV);
  if (user) {
    const token     = crypto.randomUUID();
    const resetUrl  = `${ALLOWED_ORIGIN}/login.html?reset=${token}`;
    await env.KV.put('reset:' + token, JSON.stringify({ email: user.email }), { expirationTtl: 3600 });
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:      [user.email],
        subject: 'Reset your password — Coastal Travel Company',
        html:    `<p style="font-family:sans-serif">Click the link below to reset your password. The link expires in 1 hour.</p>
<p style="font-family:sans-serif"><a href="${resetUrl}">${resetUrl}</a></p>
<p style="font-family:sans-serif;color:#999">If you didn't request this, you can ignore this email.</p>`,
      }),
    });
  }
  return jsonResponse({ ok: true }); // always ok — don't reveal whether email exists
}

async function handleAuthResetConfirm(request, env) {
  const { token, password } = await request.json();
  if (!token || !password || password.length < 8) {
    return jsonResponse({ error: 'Token and new password (min 8 chars) required' }, 400);
  }
  const raw = await env.KV.get('reset:' + token);
  if (!raw) return jsonResponse({ error: 'Invalid or expired reset link' }, 400);
  const { email } = JSON.parse(raw);
  const user = await getUser(email, env.KV);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);
  user.passwordHash = await hashPassword(password);
  await putUser(user, env.KV);
  await env.KV.delete('reset:' + token);
  return jsonResponse({ ok: true });
}

async function handleAuthMe(request, env) {
  const payload = await getAuth(request, env);
  if (!payload) return authRequired();
  const user = await getUser(payload.sub, env.KV);
  if (!user) return authRequired();
  return jsonResponse({ id: user.id, email: user.email, role: user.role });
}

// ── Gallery response sanitiser ────────────────────────────────────────────────
// passphrase, pw, pwHash are internal — never sent to any client.

function stripGallery(g) {
  if (!g) return null;
  const { passphrase, pw, pwHash, sharePassword, ...safe } = g;
  return safe;
}

// ── Admin: Gallery CRUD ───────────────────────────────────────────────────────

async function handleAdminListGalleries(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  return jsonResponse((await listGalleries(env.KV)).map(stripGallery));
}

async function handleAdminCreateGallery(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const gallery = await request.json();
  if (!gallery.id) gallery.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (!gallery.assignedUsers) gallery.assignedUsers = [];
  await putGallery(gallery, env.KV);
  return jsonResponse(stripGallery(gallery), 201);
}

async function handleAdminUpdateGallery(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const existing = await getGallery(id, env.KV);
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);
  const updates = await request.json();
  const updated = { ...existing, ...updates, id };
  await putGallery(updated, env.KV);
  return jsonResponse(stripGallery(updated));
}

async function handleAdminDeleteGallery(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  // Remove gallery from all assigned users
  const gallery = await getGallery(id, env.KV);
  if (gallery) {
    for (const email of (gallery.assignedUsers || [])) {
      const u = await getUser(email, env.KV);
      if (u) {
        u.galleries = (u.galleries || []).filter(g => g !== id);
        await putUser(u, env.KV);
      }
    }
  }
  await deleteGallery(id, env.KV);
  return jsonResponse({ ok: true });
}

// ── Admin: User CRUD ──────────────────────────────────────────────────────────

async function handleAdminListUsers(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const users = await listUsers(env.KV);
  return jsonResponse(users.map(stripSensitive));
}

async function handleAdminCreateUser(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const { email, password, role = 'client', galleries = [] } = await request.json();
  if (!email) return jsonResponse({ error: 'Email required' }, 400);
  if (await getUser(email, env.KV)) return jsonResponse({ error: 'User already exists' }, 409);
  const id   = crypto.randomUUID();
  const user = {
    id, email: email.toLowerCase(),
    passwordHash: password ? await hashPassword(password) : null,
    role, created: Date.now(), galleries,
    verified: true, // admin-created accounts are pre-verified
  };
  await putUser(user, env.KV);
  if (galleries.length) await syncGalleryAssignments(user.email, galleries, [], env.KV);
  return jsonResponse(stripSensitive(user), 201);
}

async function handleAdminUpdateUser(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const user = await getUserById(id, env.KV);
  if (!user) return jsonResponse({ error: 'Not found' }, 404);
  const { password, role, galleries } = await request.json();
  const oldGalleries = user.galleries || [];
  const newGalleries = galleries !== undefined ? galleries : oldGalleries;
  if (password) user.passwordHash = await hashPassword(password);
  if (role !== undefined) user.role = role;
  user.galleries = newGalleries;
  await putUser(user, env.KV);
  const added   = newGalleries.filter(g => !oldGalleries.includes(g));
  const removed = oldGalleries.filter(g => !newGalleries.includes(g));
  if (added.length || removed.length) await syncGalleryAssignments(user.email, added, removed, env.KV);
  return jsonResponse(stripSensitive(user));
}

async function handleAdminDeleteUser(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const user = await getUserById(id, env.KV);
  if (!user) return jsonResponse({ error: 'Not found' }, 404);
  await syncGalleryAssignments(user.email, [], user.galleries || [], env.KV);
  await deleteUser(user.email, env.KV);
  return jsonResponse({ ok: true });
}

// ── Portal ────────────────────────────────────────────────────────────────────

async function handlePortalGalleries(request, env) {
  const payload = await getAuth(request, env);
  if (!payload) return authRequired();
  const user = await getUser(payload.sub, env.KV);
  if (!user) return authRequired();
  const galleries = (await Promise.all((user.galleries || []).map(id => getGallery(id, env.KV))))
    .filter(Boolean)
    .map(stripGallery);
  return jsonResponse(galleries);
}

// ── NAS proxy helpers ─────────────────────────────────────────────────────────

function parseCookies(headers) {
  const setCookie = headers.get('set-cookie');
  if (!setCookie) return '';
  return setCookie.split(/,(?=\s*[^,;]+=[^,;]+)/)
    .map(c => c.split(';')[0].trim()).join('; ');
}

async function getSharingSid(passphrase, sharePassword = null) {
  const cached = sidCache[passphrase];
  if (cached && cached.exp > Date.now()) return cached;

  let cookieString, sid;

  if (sharePassword) {
    // Password-protected share: call SYNO.Core.Sharing.Login first.
    // Use redirect:'manual' so we capture Set-Cookie from any 3xx response
    // (cookies on the redirect response are lost when redirect:'follow' is used).
    const params = new URLSearchParams({
      api: 'SYNO.Core.Sharing.Login', version: '1', method: 'login',
      sharing_id: passphrase,
      password: sharePassword,
    });
    const loginRes = await fetch(NAS_SHARE_API + '?' + params, { redirect: 'manual' });

    cookieString = parseCookies(loginRes.headers);
    const setCookieHeader = loginRes.headers.get('set-cookie') || '';
    const sidMatch = setCookieHeader.match(/sharing_sid=([^;]+)/);
    sid = sidMatch ? sidMatch[1] : null;

    if (!cookieString) {
      // SID might be in the JSON response body instead of a cookie
      let loginJson = null;
      try { loginJson = await loginRes.json(); } catch {}
      if (loginJson?.success && loginJson?.data?.sid) {
        sid = loginJson.data.sid;
        cookieString = `sharing_sid=${sid}`;
      } else {
        const detail = loginJson
          ? JSON.stringify(loginJson.error ?? loginJson)
          : `HTTP ${loginRes.status}`;
        throw new Error(`Share login returned no session (${detail})`);
      }
    }
  } else {
    const res = await fetch(NAS_SHARE_PAGE + passphrase, { redirect: 'follow' });
    const setCookieHeader = res.headers.get('set-cookie') || '';
    const sidMatch = setCookieHeader.match(/sharing_sid=([^;]+)/);
    sid = sidMatch ? sidMatch[1] : null;
    cookieString = parseCookies(res.headers);
    if (!cookieString) throw new Error('NAS sharing page returned no session cookie');
  }

  const data = { cookie: cookieString, sid, exp: Date.now() + 2 * 60 * 60 * 1000 };
  sidCache[passphrase] = data;
  return data;
}

function extractPassphrase(raw) {
  if (!raw) return '';
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch {}
  }
  return raw;
}

async function checkRateLimit(passphrase, kv) {
  const key      = 'rl:' + passphrase;
  const countStr = await kv.get(key);
  const count    = countStr ? parseInt(countStr, 10) : 0;
  if (count >= RATE_LIMIT) return false;
  await kv.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

// ── Watermarking ──────────────────────────────────────────────────────────────

async function applyWatermark(imageBytes) {
  const photon = PhotonImage.new_from_byteslice(new Uint8Array(imageBytes));
  const w = photon.get_width();
  const h = photon.get_height();
  const fontSize = 40.0;
  const colW = 520;
  const rowH = 110;
  for (let row = 0; row * rowH < h + rowH; row++) {
    const y    = row * rowH;
    const xOff = (row % 2) * Math.round(colW / 2);
    for (let col = -1; col * colW + xOff < w + colW; col++) {
      const x = col * colW + xOff;
      if (x >= 0) draw_text_with_border(photon, WM_TEXT, x, y, fontSize);
    }
  }
  const result = photon.get_bytes_jpeg(85);
  photon.free();
  return result;
}

// ── Main request handler ──────────────────────────────────────────────────────

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const origin  = request.headers.get('Origin');
  const referer = request.headers.get('Referer') || '';
  if (origin !== ALLOWED_ORIGIN && !referer.startsWith(ALLOWED_ORIGIN)) {
    return new Response('Forbidden', { status: 403 });
  }

  const url      = new URL(request.url);
  const { pathname } = url;
  const method   = request.method;

  // ── Auth routes (no JWT required) ─────────────────────────────────────────
  if (method === 'GET'  && pathname === '/auth/setup-status')   return handleAuthSetupStatus(env);
  if (method === 'POST' && pathname === '/auth/setup')          return handleAuthSetup(request, env);
  if (method === 'POST' && pathname === '/auth/register')       return handleAuthRegister(request, env);
  if (method === 'POST' && pathname === '/auth/login')          return handleAuthLogin(request, env);
  if (method === 'POST' && pathname === '/auth/google')         return handleAuthGoogle(request, env);
  if (method === 'POST' && pathname === '/auth/reset-request')  return handleAuthResetRequest(request, env);
  if (method === 'POST' && pathname === '/auth/reset-confirm')  return handleAuthResetConfirm(request, env);
  if (method === 'GET'  && pathname === '/auth/me')             return handleAuthMe(request, env);
  if (method === 'GET'  && pathname === '/auth/verify')         return handleAuthVerify(request, env);
  if (method === 'POST' && pathname === '/auth/resend-verify')  return handleAuthResendVerify(request, env);

  const publicProposalMatch = pathname.match(/^\/proposals\/([^/]+)$/);
  const publicProposalAnalyticsMatch = pathname.match(/^\/proposals\/([^/]+)\/analytics$/);
  const publicProposalSelectMatch = pathname.match(/^\/proposals\/([^/]+)\/select$/);

  if (publicProposalMatch && method === 'GET') {
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const id = publicProposalMatch[1];
    const now = new Date().toISOString();
    const { results } = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).all();
    const proposal = results[0];
    if (!proposal) return jsonResponse({ error: 'Proposal not found' }, 404);
    await env.DB.prepare(
      "UPDATE proposals SET view_count = view_count + 1, opened_at = CASE WHEN opened_at = '' THEN ? ELSE opened_at END, updated_at = ? WHERE id = ?"
    ).bind(now, now, id).run();
    proposal.view_count = Number(proposal.view_count || 0) + 1;
    proposal.opened_at = proposal.opened_at || now;

    const projectRows = await env.DB.prepare(
      'SELECT id,client_name,client_email,property,location,collection,shoot_date,stage FROM projects WHERE id = ?'
    ).bind(proposal.project_id).all();
    const packageIds = JSON.parse(proposal.package_ids || '[]');
    let packages = [];
    if (packageIds.length) {
      const placeholders = packageIds.map(() => '?').join(',');
      const packageRows = await env.DB.prepare(
        `SELECT * FROM service_packages WHERE id IN (${placeholders})`
      ).bind(...packageIds).all();
      packages = packageIds.map(pid => packageRows.results.find(pkg => pkg.id === pid)).filter(Boolean);
    }
    return jsonResponse({ proposal, project: projectRows.results[0] || null, packages });
  }

  if (publicProposalAnalyticsMatch && method === 'POST') {
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const id = publicProposalAnalyticsMatch[1];
    let seconds = 0;
    try {
      const body = await request.text();
      seconds = Math.max(0, Math.min(3600, Number(JSON.parse(body || '{}').seconds) || 0));
    } catch {}
    if (seconds > 0) {
      await env.DB.prepare(
        'UPDATE proposals SET time_spent_seconds = time_spent_seconds + ?, updated_at = ? WHERE id = ?'
      ).bind(Math.round(seconds), new Date().toISOString(), id).run();
    }
    return jsonResponse({ ok: true });
  }

  if (publicProposalSelectMatch && method === 'POST') {
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const id = publicProposalSelectMatch[1];
    const body = await request.json();
    const packageId = body.package_id || '';
    const addons = Array.isArray(body.addons) ? body.addons : [];
    const { results } = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).all();
    const proposal = results[0];
    if (!proposal) return jsonResponse({ error: 'Proposal not found' }, 404);
    const allowed = JSON.parse(proposal.package_ids || '[]');
    if (!allowed.includes(packageId)) return jsonResponse({ error: 'Select a package from this proposal' }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE proposals SET status = ?, selected_package_id = ?, selected_addons = ?, selected_at = ?, updated_at = ? WHERE id = ?'
    ).bind('approved', packageId, JSON.stringify(addons), now, now, id).run();
    await env.DB.prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?').bind('Contract Sent', now, proposal.project_id).run();
    return jsonResponse({ ok: true, status: 'approved', selected_package_id: packageId, selected_addons: addons, selected_at: now });
  }

  // ── Admin: Gallery CRUD ────────────────────────────────────────────────────
  if (method === 'GET'  && pathname === '/admin/galleries') return handleAdminListGalleries(request, env);
  if (method === 'POST' && pathname === '/admin/galleries') return handleAdminCreateGallery(request, env);
  const galleryIdMatch = pathname.match(/^\/admin\/galleries\/([^/]+)$/);
  if (galleryIdMatch) {
    if (method === 'PUT')    return handleAdminUpdateGallery(request, env, galleryIdMatch[1]);
    if (method === 'DELETE') return handleAdminDeleteGallery(request, env, galleryIdMatch[1]);
  }

  // ── Admin: User CRUD ───────────────────────────────────────────────────────
  if (method === 'GET'  && pathname === '/admin/users') return handleAdminListUsers(request, env);
  if (method === 'POST' && pathname === '/admin/users') return handleAdminCreateUser(request, env);
  const userIdMatch = pathname.match(/^\/admin\/users\/([^/]+)$/);
  if (userIdMatch) {
    if (method === 'PUT')    return handleAdminUpdateUser(request, env, userIdMatch[1]);
    if (method === 'DELETE') return handleAdminDeleteUser(request, env, userIdMatch[1]);
  }

  // ── Admin: Service package library ─────────────────────────────────────────
  if (pathname === '/admin/packages') {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM service_packages ORDER BY created_at DESC'
      ).all();
      return jsonResponse(results);
    }

    if (method === 'POST') {
      const body = await request.json();
      const { name, description, inclusions, hero_photo, base_price, addons } = body;
      if (!name) return jsonResponse({ error: 'name required' }, 400);
      const id  = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO service_packages (id,name,description,inclusions,hero_photo,base_price,addons,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(id, name, description||'', inclusions||'', hero_photo||'', Number(base_price)||0, JSON.stringify(addons||[]), now, now).run();
      return jsonResponse({ id, name, description:description||'', inclusions:inclusions||'', hero_photo:hero_photo||'', base_price:Number(base_price)||0, addons:JSON.stringify(addons||[]), created_at:now, updated_at:now }, 201);
    }
  }

  const packageIdMatch = pathname.match(/^\/admin\/packages\/([^/]+)$/);
  if (packageIdMatch) {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const id = packageIdMatch[1];

    if (method === 'PUT') {
      const body = await request.json();
      const allowed = ['name','description','inclusions','hero_photo','base_price','addons'];
      const sets = [], vals = [];
      for (const f of allowed) {
        if (body[f] !== undefined) {
          sets.push(f + ' = ?');
          vals.push(f === 'addons' ? JSON.stringify(body[f] || []) : (f === 'base_price' ? Number(body[f]) || 0 : body[f]));
        }
      }
      if (!sets.length) return jsonResponse({ error: 'No fields to update' }, 400);
      const now = new Date().toISOString();
      sets.push('updated_at = ?'); vals.push(now); vals.push(id);
      await env.DB.prepare('UPDATE service_packages SET ' + sets.join(', ') + ' WHERE id = ?').bind(...vals).run();
      const { results } = await env.DB.prepare('SELECT * FROM service_packages WHERE id = ?').bind(id).all();
      return jsonResponse(results[0] || { error: 'Not found' });
    }

    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM service_packages WHERE id = ?').bind(id).run();
      return jsonResponse({ ok: true });
    }
  }

  // ── Admin: Questionnaire builder ──────────────────────────────────────────
  if (pathname === '/admin/questionnaires') {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM questionnaire_sets ORDER BY created_at DESC'
      ).all();
      return jsonResponse(results);
    }

    if (method === 'POST') {
      const { name, phase, questions } = await request.json();
      if (!name) return jsonResponse({ error: 'name required' }, 400);
      const cleanQuestions = Array.isArray(questions) ? questions : [];
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO questionnaire_sets (id,name,phase,questions,created_at,updated_at) VALUES (?,?,?,?,?,?)'
      ).bind(id, name, phase||'pre-booking', JSON.stringify(cleanQuestions), now, now).run();
      return jsonResponse({ id, name, phase:phase||'pre-booking', questions:JSON.stringify(cleanQuestions), created_at:now, updated_at:now }, 201);
    }
  }

  const questionnaireIdMatch = pathname.match(/^\/admin\/questionnaires\/([^/]+)$/);
  if (questionnaireIdMatch) {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM questionnaire_sets WHERE id = ?').bind(questionnaireIdMatch[1]).run();
      return jsonResponse({ ok: true });
    }
  }

  // ── Admin: Project pipeline CRUD ──────────────────────────────────────────
  if (pathname === '/admin/projects') {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM projects ORDER BY updated_at DESC'
      ).all();
      return jsonResponse(results);
    }

    if (method === 'POST') {
      const body = await request.json();
      const { client_name, client_email, property, location, collection, shoot_date, message, source } = body;
      if (!client_name || !client_email) return jsonResponse({ error: 'client_name and client_email required' }, 400);
      const id  = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO projects (id,stage,client_name,client_email,property,location,collection,shoot_date,message,source,labels,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(id, 'Inquiry', client_name, client_email, property||'', location||'', collection||'', shoot_date||'', message||'', source||'manual', '', now, now).run();
      return jsonResponse({ id, stage:'Inquiry', client_name, client_email, property:property||'', location:location||'', collection:collection||'', shoot_date:shoot_date||'', message:message||'', source:source||'manual', labels:'', created_at:now, updated_at:now }, 201);
    }
  }

  const projectIdMatch    = pathname.match(/^\/admin\/projects\/([^/]+)$/);
  const projectNotesMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/notes$/);
  const projectDocsMatch  = pathname.match(/^\/admin\/projects\/([^/]+)\/documents$/);
  const projectProposalsMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/proposals$/);

  if (projectIdMatch) {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const id = projectIdMatch[1];

    if (method === 'PUT') {
      const body = await request.json();
      const allowed = ['stage','client_name','client_email','property','location','collection','shoot_date','labels'];
      const sets = [], vals = [];
      for (const f of allowed) {
        if (body[f] !== undefined) { sets.push(f + ' = ?'); vals.push(body[f]); }
      }
      if (!sets.length) return jsonResponse({ error: 'No fields to update' }, 400);
      const now = new Date().toISOString();
      sets.push('updated_at = ?'); vals.push(now); vals.push(id);
      await env.DB.prepare('UPDATE projects SET ' + sets.join(', ') + ' WHERE id = ?').bind(...vals).run();
      const { results } = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).all();
      return jsonResponse(results[0] || { error: 'Not found' });
    }

    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM project_notes WHERE project_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM project_documents WHERE project_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM proposals WHERE project_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
      return jsonResponse({ ok: true });
    }
  }

  if (projectNotesMatch) {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const projectId = projectNotesMatch[1];

    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at DESC'
      ).bind(projectId).all();
      return jsonResponse(results);
    }

    if (method === 'POST') {
      const { type, content, due_date } = await request.json();
      if (!content) return jsonResponse({ error: 'content required' }, 400);
      const id  = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO project_notes (id,project_id,type,content,due_date,created_at) VALUES (?,?,?,?,?,?)'
      ).bind(id, projectId, type||'note', content, due_date||'', now).run();
      await env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, projectId).run();
      return jsonResponse({ id, project_id:projectId, type:type||'note', content, due_date:due_date||'', created_at:now }, 201);
    }
  }

  if (projectDocsMatch) {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const projectId = projectDocsMatch[1];

    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM project_documents WHERE project_id = ? ORDER BY created_at DESC'
      ).bind(projectId).all();
      return jsonResponse(results);
    }

    if (method === 'POST') {
      const { type, title, url } = await request.json();
      if (!title || !url) return jsonResponse({ error: 'title and url required' }, 400);
      const id  = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO project_documents (id,project_id,type,title,url,created_at) VALUES (?,?,?,?,?,?)'
      ).bind(id, projectId, type||'proposal', title, url, now).run();
      await env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, projectId).run();
      return jsonResponse({ id, project_id:projectId, type:type||'proposal', title, url, created_at:now }, 201);
    }
  }

  if (projectProposalsMatch) {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const projectId = projectProposalsMatch[1];

    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM proposals WHERE project_id = ? ORDER BY created_at DESC'
      ).bind(projectId).all();
      return jsonResponse(results);
    }

    if (method === 'POST') {
      const { package_ids, cover_note, expires_at } = await request.json();
      const ids = Array.isArray(package_ids) ? package_ids.slice(0, 3) : [];
      if (!ids.length) return jsonResponse({ error: 'Select at least one package' }, 400);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const publicUrl = `${ALLOWED_ORIGIN}/proposal.html#${id}`;
      await env.DB.prepare(
        'INSERT INTO proposals (id,project_id,cover_note,expires_at,package_ids,status,public_url,opened_at,view_count,time_spent_seconds,selected_package_id,selected_addons,selected_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(id, projectId, cover_note||'', expires_at||'', JSON.stringify(ids), 'sent', publicUrl, '', 0, 0, '', '[]', '', now, now).run();
      await env.DB.prepare(
        'INSERT INTO project_documents (id,project_id,type,title,url,created_at) VALUES (?,?,?,?,?,?)'
      ).bind(crypto.randomUUID(), projectId, 'proposal', 'Proposal ' + new Date(now).toLocaleDateString('en-US'), publicUrl, now).run();
      await env.DB.prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?').bind('Proposal Sent', now, projectId).run();
      return jsonResponse({ id, project_id:projectId, cover_note:cover_note||'', expires_at:expires_at||'', package_ids:JSON.stringify(ids), status:'sent', public_url:publicUrl, opened_at:'', view_count:0, time_spent_seconds:0, selected_package_id:'', selected_addons:'[]', selected_at:'', created_at:now, updated_at:now }, 201);
    }
  }

  // ── Portal ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/portal/galleries') return handlePortalGalleries(request, env);

  // ── Questionnaire instances ───────────────────────────────────────────────
  const projectQuestionnairesMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/questionnaires$/);
  if (projectQuestionnairesMatch)
    return handleAdminProjectQuestionnaires(request, method, env, projectQuestionnairesMatch[1]);
  const publicQnMatch = pathname.match(/^\/questionnaire\/([^/]+)$/);
  if (publicQnMatch && (method === 'GET' || method === 'POST'))
    return handlePublicQuestionnaire(request, method, env, publicQnMatch[1]);

  // ── Project portal & messaging ────────────────────────────────────────────
  const projectPortalLinkMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/portal-link$/);
  if (projectPortalLinkMatch && method === 'POST')
    return handleAdminProjectPortalLink(request, env, projectPortalLinkMatch[1]);
  const projectMsgMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/messages$/);
  if (projectMsgMatch)
    return handleAdminProjectMessages(request, method, env, projectMsgMatch[1]);
  const publicPortalProjMatch = pathname.match(/^\/portal\/project\/([^/]+)$/);
  if (publicPortalProjMatch && (method === 'GET' || method === 'POST'))
    return handlePublicProjectPortal(request, method, env, publicPortalProjMatch[1]);

  // ── Scheduling ────────────────────────────────────────────────────────────
  if (pathname === '/admin/availability' && (method === 'GET' || method === 'PUT'))
    return handleAdminAvailability(request, method, env);
  const blockedDateDelMatch = pathname.match(/^\/admin\/blocked-dates\/([^/]+)$/);
  if (pathname === '/admin/blocked-dates' || blockedDateDelMatch)
    return handleAdminBlockedDates(request, method, env, blockedDateDelMatch?.[1]);
  const projectSchedMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/schedule-links$/);
  if (projectSchedMatch)
    return handleAdminProjectScheduleLinks(request, method, env, projectSchedMatch[1]);
  const publicSchedMatch = pathname.match(/^\/schedule\/([^/]+)$/);
  if (publicSchedMatch && (method === 'GET' || method === 'POST'))
    return handlePublicSchedule(request, method, env, publicSchedMatch[1]);

  // ── Automations ───────────────────────────────────────────────────────────
  if (pathname === '/admin/automations' && (method === 'GET' || method === 'PUT'))
    return handleAdminAutomations(request, method, env);
  if (method === 'GET' && pathname === '/admin/automation-logs')
    return handleAdminAutomationLogs(request, env);

  // ── Contract templates ────────────────────────────────────────────────────
  if (pathname === '/admin/contract-templates') {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    if (method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM contract_templates ORDER BY created_at DESC').all();
      return jsonResponse(results);
    }
    if (method === 'POST') {
      const { name, collection_type, body: tmplBody } = await request.json();
      if (!name) return jsonResponse({ error: 'name required' }, 400);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO contract_templates (id,name,collection_type,body,created_at,updated_at) VALUES (?,?,?,?,?,?)'
      ).bind(id, name, collection_type || '', tmplBody || '', now, now).run();
      return jsonResponse({ id, name, collection_type: collection_type || '', body: tmplBody || '', created_at: now, updated_at: now }, 201);
    }
  }

  const contractTemplateIdMatch = pathname.match(/^\/admin\/contract-templates\/([^/]+)$/);
  if (contractTemplateIdMatch) {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const tmplId = contractTemplateIdMatch[1];
    if (method === 'PUT') {
      const body = await request.json();
      const allowed = ['name', 'collection_type', 'body'];
      const sets = [], vals = [];
      for (const f of allowed) {
        if (body[f] !== undefined) { sets.push(f + ' = ?'); vals.push(body[f]); }
      }
      if (!sets.length) return jsonResponse({ error: 'No fields to update' }, 400);
      const now = new Date().toISOString();
      sets.push('updated_at = ?'); vals.push(now); vals.push(tmplId);
      await env.DB.prepare('UPDATE contract_templates SET ' + sets.join(', ') + ' WHERE id = ?').bind(...vals).run();
      const { results } = await env.DB.prepare('SELECT * FROM contract_templates WHERE id = ?').bind(tmplId).all();
      return jsonResponse(results[0] || { error: 'Not found' });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM contract_templates WHERE id = ?').bind(tmplId).run();
      return jsonResponse({ ok: true });
    }
  }

  // ── Project contracts ─────────────────────────────────────────────────────
  const projectContractsMatch           = pathname.match(/^\/admin\/projects\/([^/]+)\/contracts$/);
  const projectContractCountersignMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/contracts\/([^/]+)\/countersign$/);

  if (projectContractsMatch) {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const projectId = projectContractsMatch[1];

    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM contracts WHERE project_id = ? ORDER BY created_at DESC'
      ).bind(projectId).all();
      return jsonResponse(results);
    }

    if (method === 'POST') {
      const body = await request.json();
      const { title, contract_body, merge_fields, template_id } = body;
      if (!title || !contract_body) return jsonResponse({ error: 'title and contract_body required' }, 400);
      const { results: projR } = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).all();
      const project = projR[0];
      if (!project) return jsonResponse({ error: 'Project not found' }, 404);
      const id           = crypto.randomUUID();
      const signingToken = crypto.randomUUID();
      const now          = new Date().toISOString();
      const bodyHashBuf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contract_body));
      const bodyHash     = Array.from(new Uint8Array(bodyHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
      const publicUrl    = ALLOWED_ORIGIN + '/contract.html#' + signingToken;
      await env.DB.prepare(
        'INSERT INTO contracts (id,project_id,template_id,title,body,merge_fields,signing_token,status,client_name,client_email,client_signature,client_signature_type,client_signed_at,client_ip,client_ua,admin_signature,admin_signature_type,admin_signed_at,admin_ip,admin_ua,body_hash,sent_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(id, projectId, template_id || '', title, contract_body, JSON.stringify(merge_fields || {}), signingToken, 'sent',
        project.client_name || '', project.client_email || '', '', '', '', '', '', '', '', '', '', '', bodyHash, now, now, now).run();
      await env.DB.prepare(
        'INSERT INTO project_documents (id,project_id,type,title,url,created_at) VALUES (?,?,?,?,?,?)'
      ).bind(crypto.randomUUID(), projectId, 'contract', title, publicUrl, now).run();
      await env.DB.prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?').bind('Contract Sent', now, projectId).run();
      await env.DB.prepare(
        'INSERT INTO contract_signing_events (id,contract_id,event_type,actor,actor_email,ip_address,user_agent,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(crypto.randomUUID(), id, 'created', 'admin', p.email || '', request.headers.get('CF-Connecting-IP') || '', request.headers.get('User-Agent') || '', bodyHash, now).run();
      if (env.RESEND_API_KEY && project.client_email) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
            to: [project.client_email],
            subject: 'Your contract is ready to sign — Coastal Travel Company',
            html: `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(project.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Your contract <strong>${escHtml(title)}</strong> is ready for your review and signature.</p><p style="font-family:sans-serif;font-size:15px"><a href="${publicUrl}" style="color:#2A5C45;font-weight:600">Review &amp; Sign Contract →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`,
          }),
        }).catch(() => {});
      }
      return jsonResponse({ id, project_id: projectId, title, signing_token: signingToken, status: 'sent', public_url: publicUrl, client_name: project.client_name || '', client_email: project.client_email || '', created_at: now, updated_at: now }, 201);
    }
  }

  if (projectContractCountersignMatch && method === 'POST') {
    const p = await getAuth(request, env);
    if (!p) return authRequired();
    if (p.role !== 'admin') return forbidden();
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const projectId  = projectContractCountersignMatch[1];
    const contractId = projectContractCountersignMatch[2];
    const { signature, signature_type } = await request.json();
    if (!signature || !signature_type) return jsonResponse({ error: 'signature and signature_type required' }, 400);
    const { results: cR } = await env.DB.prepare('SELECT * FROM contracts WHERE id = ? AND project_id = ?').bind(contractId, projectId).all();
    const contract = cR[0];
    if (!contract) return jsonResponse({ error: 'Contract not found' }, 404);
    if (contract.status !== 'client_signed') return jsonResponse({ error: 'Client must sign before countersigning' }, 400);
    const now = new Date().toISOString();
    const ip  = request.headers.get('CF-Connecting-IP') || '';
    const ua  = request.headers.get('User-Agent') || '';
    await env.DB.prepare(
      'UPDATE contracts SET admin_signature=?,admin_signature_type=?,admin_signed_at=?,admin_ip=?,admin_ua=?,status=?,updated_at=? WHERE id=?'
    ).bind(signature, signature_type, now, ip, ua, 'fully_executed', now, contractId).run();
    await env.DB.prepare('UPDATE projects SET stage=?,updated_at=? WHERE id=?').bind('Contract Signed', now, projectId).run();
    await env.DB.prepare(
      'INSERT INTO contract_signing_events (id,contract_id,event_type,actor,actor_email,ip_address,user_agent,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), contractId, 'admin_countersigned', 'admin', p.email || '', ip, ua, contract.body_hash || '', now).run();
    const contractUrl = ALLOWED_ORIGIN + '/contract.html#' + contract.signing_token;
    const { results: projR2 } = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(projectId).all();
    const project2 = projR2[0];
    if (env.RESEND_API_KEY && project2?.client_email) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to: [project2.client_email],
          subject: 'Your contract is fully executed — Coastal Travel Company',
          html: `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(project2.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Your contract <strong>${escHtml(contract.title)}</strong> has been signed by both parties. You can view and download your copy at any time:</p><p style="font-family:sans-serif;font-size:15px"><a href="${contractUrl}" style="color:#2A5C45;font-weight:600">View Fully Executed Contract →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`,
        }),
      }).catch(() => {});
    }
    const { results: updated } = await env.DB.prepare('SELECT * FROM contracts WHERE id=?').bind(contractId).all();
    return jsonResponse(updated[0]);
  }

  // ── Public contract signing ────────────────────────────────────────────────
  const publicContractMatch      = pathname.match(/^\/contracts\/([^/]+)$/);
  const publicContractViewMatch  = pathname.match(/^\/contracts\/([^/]+)\/view$/);
  const publicContractSignMatch  = pathname.match(/^\/contracts\/([^/]+)\/sign$/);
  const publicContractAuditMatch = pathname.match(/^\/contracts\/([^/]+)\/audit$/);

  if (publicContractMatch && method === 'GET') {
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const { results } = await env.DB.prepare(
      'SELECT id,title,body,status,merge_fields,client_name,client_email,client_signed_at,client_signature_type,admin_signed_at,admin_signature_type,created_at FROM contracts WHERE signing_token = ?'
    ).bind(publicContractMatch[1]).all();
    if (!results[0]) return jsonResponse({ error: 'Contract not found' }, 404);
    return jsonResponse(results[0]);
  }

  if (publicContractViewMatch && method === 'POST') {
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const { results } = await env.DB.prepare('SELECT id,body_hash FROM contracts WHERE signing_token = ?').bind(publicContractViewMatch[1]).all();
    if (!results[0]) return jsonResponse({ error: 'Not found' }, 404);
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO contract_signing_events (id,contract_id,event_type,actor,actor_email,ip_address,user_agent,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), results[0].id, 'viewed', 'client', '', request.headers.get('CF-Connecting-IP') || '', request.headers.get('User-Agent') || '', results[0].body_hash || '', now).run();
    return jsonResponse({ ok: true });
  }

  if (publicContractSignMatch && method === 'POST') {
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const token = publicContractSignMatch[1];
    const body  = await request.json();
    const { signature, signature_type } = body;
    if (!signature || !signature_type) return jsonResponse({ error: 'signature and signature_type required' }, 400);
    const { results: cR } = await env.DB.prepare('SELECT * FROM contracts WHERE signing_token = ?').bind(token).all();
    const contract = cR[0];
    if (!contract) return jsonResponse({ error: 'Contract not found' }, 404);
    if (contract.status !== 'sent') return jsonResponse({ error: 'Contract already signed' }, 400);
    const now = new Date().toISOString();
    const ip  = request.headers.get('CF-Connecting-IP') || '';
    const ua  = request.headers.get('User-Agent') || '';
    await env.DB.prepare(
      'UPDATE contracts SET client_signature=?,client_signature_type=?,client_signed_at=?,client_ip=?,client_ua=?,status=?,updated_at=? WHERE signing_token=?'
    ).bind(signature, signature_type, now, ip, ua, 'client_signed', now, token).run();
    await env.DB.prepare(
      'INSERT INTO contract_signing_events (id,contract_id,event_type,actor,actor_email,ip_address,user_agent,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), contract.id, 'client_signed', 'client', contract.client_email || '', ip, ua, contract.body_hash || '', now).run();
    if (env.RESEND_API_KEY) {
      const contractUrl = ALLOWED_ORIGIN + '/contract.html#' + token;
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to: [CONTACT_TO],
          subject: 'Contract signed — ' + contract.title,
          html: `<p style="font-family:sans-serif;font-size:15px"><strong>${escHtml(contract.client_name)}</strong> has signed the contract "${escHtml(contract.title)}".</p><p style="font-family:sans-serif;font-size:15px">Please review and countersign to fully execute the agreement.</p><p style="font-family:sans-serif;font-size:15px"><a href="${contractUrl}" style="color:#2A5C45;font-weight:600">View &amp; Countersign →</a></p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ ok: true, status: 'client_signed', signed_at: now });
  }

  if (publicContractAuditMatch && method === 'GET') {
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
    const { results: cR } = await env.DB.prepare('SELECT id,status FROM contracts WHERE signing_token = ?').bind(publicContractAuditMatch[1]).all();
    if (!cR[0]) return jsonResponse({ error: 'Contract not found' }, 404);
    const { results: events } = await env.DB.prepare(
      'SELECT event_type,actor,actor_email,ip_address,user_agent,body_hash,created_at FROM contract_signing_events WHERE contract_id = ? ORDER BY created_at ASC'
    ).bind(cR[0].id).all();
    return jsonResponse({ contract_id: cR[0].id, status: cR[0].status, events });
  }

  // ── Invoices ──────────────────────────────────────────────────────────────
  const projectInvoicesMatch       = pathname.match(/^\/admin\/projects\/([^/]+)\/invoices$/);
  const adminInvoiceSendMatch      = pathname.match(/^\/admin\/invoices\/([^/]+)\/send$/);
  const adminInvoiceMatch          = pathname.match(/^\/admin\/invoices\/([^/]+)$/);
  const publicInvoiceCheckoutMatch = pathname.match(/^\/invoices\/([^/]+)\/checkout$/);
  const publicInvoiceMatch         = pathname.match(/^\/invoices\/([^/]+)$/);
  if (projectInvoicesMatch)
    return handleAdminProjectInvoices(request, method, env, projectInvoicesMatch[1]);
  if (adminInvoiceSendMatch && method === 'POST')
    return handleAdminInvoiceSend(request, env, adminInvoiceSendMatch[1]);
  if (adminInvoiceMatch && (method === 'GET' || method === 'PUT'))
    return handleAdminInvoice(request, method, env, adminInvoiceMatch[1]);
  if (publicInvoiceCheckoutMatch && method === 'POST')
    return handleInvoiceCheckout(request, env, publicInvoiceCheckoutMatch[1]);
  if (publicInvoiceMatch && method === 'GET')
    return handlePublicInvoice(request, env, publicInvoiceMatch[1]);
  if (method === 'POST' && pathname === '/stripe/webhook')
    return handleStripeWebhook(request, env);
  if (method === 'GET' && pathname === '/portal/invoices')
    return handlePortalInvoices(request, env);

  // ── Token exchange: POST /token {galleryId} + JWT → {sid} ────────────────
  if (method === 'POST' && pathname === '/token') {
    const payload = await getAuth(request, env);
    if (!payload) return authRequired();

    const body      = await request.text();
    const galleryId = new URLSearchParams(body).get('galleryId');
    if (!galleryId) return jsonResponse({ error: 'Missing galleryId' }, 400);

    const gallery = await getGallery(galleryId, env.KV);
    if (!gallery) return jsonResponse({ error: 'Gallery not found' }, 404);

    if (payload.role !== 'admin') {
      const assigned = gallery.assignedUsers || [];
      if (!assigned.includes(payload.sub)) return forbidden();
    }

    const passphrase = gallery.passphrase;
    if (!passphrase) return jsonResponse({ error: 'Gallery configuration error' }, 500);

    try {
      await getSharingSid(passphrase, gallery.sharePassword || null);
    } catch (err) {
      return jsonResponse({ error: 'Gallery session failed: ' + err.message }, 401);
    }
    const sid = crypto.randomUUID();
    await env.KV.put('tok:' + sid, JSON.stringify({ passphrase, sharePassword: gallery.sharePassword || null }), { expirationTtl: 14400 });
    return jsonResponse({ sid });
  }

  // ── Contact form: POST /contact ────────────────────────────────────────────
  if (method === 'POST' && pathname === '/contact') {
    const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rlKey   = 'contact_rl:' + ip;
    const countStr = await env.KV.get(rlKey);
    const count   = countStr ? parseInt(countStr, 10) : 0;
    if (count >= CONTACT_RATE_LIMIT) {
      return jsonResponse({ error: 'Too many submissions. Please try again later.' }, 429);
    }
    await env.KV.put(rlKey, String(count + 1), { expirationTtl: 3600 });

    const body       = await request.text();
    const p          = new URLSearchParams(body);
    const firstName  = (p.get('first-name') || '').trim();
    const lastName   = (p.get('last-name')  || '').trim();
    const email      = (p.get('email')      || '').trim();
    const property   = (p.get('property')   || '').trim();
    const location   = (p.get('location')   || '').trim();
    const collection = (p.get('collection') || '').trim();
    const timeline   = (p.get('timeline')   || '').trim();
    const message    = (p.get('message')    || '').trim();

    if (!firstName || !email || !message) {
      return jsonResponse({ error: 'Please fill in all required fields.' }, 400);
    }

    const row = (label, val) =>
      `<tr><td style="padding:4px 16px 4px 0;color:#666;white-space:nowrap"><strong>${label}</strong></td>` +
      `<td style="padding:4px 0">${escHtml(val) || '—'}</td></tr>`;

    const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1C1C1C;max-width:600px">
<h2 style="color:#2A5C45">New Inquiry — Coastal Travel Company</h2>
<table style="border-collapse:collapse;margin-bottom:24px">
  ${row('Name',       firstName + (lastName ? ' ' + lastName : ''))}
  ${row('Email',      email)}
  ${row('Property',   property)}
  ${row('Location',   location)}
  ${row('Collection', collection)}
  ${row('Timeline',   timeline)}
</table>
<h3 style="color:#2A5C45;margin-bottom:8px">Message</h3>
<p style="line-height:1.7;white-space:pre-wrap">${escHtml(message)}</p>
</body></html>`;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:     'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:       [CONTACT_TO],
        reply_to: email,
        subject:  `Inquiry: ${firstName}${lastName ? ' ' + lastName : ''}${property ? ' — ' + property : ''}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      return jsonResponse({ error: 'Failed to send. Please try again or email us directly.' }, 502);
    }

    if (env.DB) {
      try {
        const pid = crypto.randomUUID();
        const now = new Date().toISOString();
        const clientName = firstName + (lastName ? ' ' + lastName : '');
        await env.DB.prepare(
          'INSERT INTO projects (id,stage,client_name,client_email,property,location,collection,shoot_date,message,source,labels,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).bind(pid, 'Inquiry', clientName, email, property, location, collection, timeline, message, 'inquiry', '', now, now).run();
      } catch (_) { /* don't fail the contact form if DB write fails */ }
    }

    return jsonResponse({ ok: true });
  }

  // ── NAS proxy ──────────────────────────────────────────────────────────────
  const bodyText = method === 'POST' ? await request.text() : '';

  let passphrase;
  let rawSid, rawPassphrase;
  if (method === 'POST') {
    const params  = new URLSearchParams(bodyText);
    rawSid        = params.get('sid');
    rawPassphrase = params.get('passphrase');
  } else {
    rawSid        = url.searchParams.get('sid');
    rawPassphrase = url.searchParams.get('passphrase');
  }

  let sharePassword = null;
  if (rawSid) {
    const stored = await env.KV.get('tok:' + rawSid);
    if (!stored) {
      return jsonResponse({ success: false, error: { code: 401, message: 'Session expired — reload the gallery' } }, 401);
    }
    try {
      const parsed = JSON.parse(stored);
      passphrase   = parsed.passphrase;
      sharePassword = parsed.sharePassword || null;
    } catch {
      passphrase = stored; // backward compat: old tokens stored plain passphrase string
    }
  } else if (rawPassphrase) {
    passphrase = extractPassphrase(rawPassphrase);
  }

  if (!passphrase) {
    return jsonResponse({ success: false, error: { code: 400, message: 'Missing passphrase' } }, 400);
  }

  const apiMethod = method === 'POST'
    ? new URLSearchParams(bodyText).get('api') || ''
    : url.searchParams.get('api') || '';
  if (!ALLOWED_APIS.has(apiMethod)) {
    return jsonResponse({ success: false, error: { code: 403, message: 'API method not permitted' } }, 403);
  }

  if (!await checkRateLimit(passphrase, env.KV)) {
    return jsonResponse({ success: false, error: { code: 429, message: 'Too many requests — try again in a minute' } }, 429);
  }

  let nasAuth;
  try {
    nasAuth = await getSharingSid(passphrase, sharePassword);
  } catch (err) {
    return jsonResponse({ success: false, error: { code: 502, message: 'Sharing session failed: ' + err.message } }, 502);
  }

  const wantsWatermark = method === 'GET' && url.searchParams.get('watermark') === '1';

  let nasUrl, nasBody;
  if (method === 'GET') {
    const nasParams = new URLSearchParams(url.search);
    nasParams.delete('sid');
    nasParams.delete('passphrase');
    nasParams.delete('watermark');
    nasParams.set('_sharing_id', passphrase);
    if (nasAuth.sid) nasParams.set('sid', nasAuth.sid);
    nasUrl = NAS_SHARE_API + '?' + nasParams.toString();
  } else {
    const nasParams = new URLSearchParams(bodyText);
    nasParams.delete('sid');
    nasParams.set('passphrase', passphrase);
    if (nasAuth.sid) nasParams.set('sid', nasAuth.sid);
    nasUrl  = NAS_SHARE_API;
    nasBody = nasParams.toString();
  }

  const nasReqHeaders = {
    'Cookie':        nasAuth.cookie,
    'X-SYNO-SHARING': passphrase,
  };
  if (method === 'POST') nasReqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';

  let nasResponse;
  try {
    nasResponse = await fetch(nasUrl, {
      method, headers: nasReqHeaders,
      body: method === 'POST' ? nasBody : undefined,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: { code: 502, message: 'NAS unreachable: ' + err.message } }, 502);
  }

  const body = await nasResponse.arrayBuffer();
  const ct   = nasResponse.headers.get('Content-Type') || '';
  const cd   = nasResponse.headers.get('Content-Disposition');

  if (wantsWatermark && ct.startsWith('image/')) {
    try {
      const watermarked = await applyWatermark(body);
      const resHeaders  = new Headers(CORS);
      resHeaders.set('Content-Type', 'image/jpeg');
      resHeaders.set('Content-Disposition', 'attachment; filename="coastal.jpg"');
      return new Response(watermarked, { status: 200, headers: resHeaders });
    } catch (e) {
      console.error('[watermark] applyWatermark failed:', e?.message ?? e);
    }
  }

  const resHeaders = new Headers(CORS);
  if (ct) resHeaders.set('Content-Type', ct);
  if (cd) resHeaders.set('Content-Disposition', cd);
  return new Response(body, { status: nasResponse.status, headers: resHeaders });
}

// ── ICS calendar invite generator ────────────────────────────────────────────

function generateICS({ uid, summary, description, dtstart, dtend, organizerEmail, attendeeEmail, attendeeName }) {
  const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'PRODID:-//Coastal Travel Company//EN', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTART:' + fmt(dtstart),
    'DTEND:' + fmt(dtend),
    'SUMMARY:' + summary,
    'DESCRIPTION:' + description,
    'ORGANIZER;CN=Coastal Travel Company:mailto:' + organizerEmail,
    attendeeEmail ? 'ATTENDEE;CN=' + attendeeName + ';RSVP=TRUE:mailto:' + attendeeEmail : '',
    'STATUS:CONFIRMED', 'SEQUENCE:0',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

// ── Available scheduling slot generator ──────────────────────────────────────

function generateAvailableSlots(windows, blockedDates, bookedSlots, durationMins = 30, numDays = 28) {
  const now     = new Date();
  const blocked = new Set(blockedDates.map(b => b.date));
  const booked  = new Set(bookedSlots.map(s => s.booked_slot).filter(Boolean));
  const slots   = [];
  for (let d = 1; d <= numDays; d++) {
    const day     = new Date(now);
    day.setDate(day.getDate() + d);
    const dow     = day.getDay();
    const dateStr = day.toISOString().slice(0, 10);
    if (blocked.has(dateStr)) continue;
    for (const w of windows.filter(w => Number(w.day_of_week) === dow && w.active)) {
      const [sh, sm] = w.start_time.split(':').map(Number);
      const [eh, em] = w.end_time.split(':').map(Number);
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;
      while (cur + durationMins <= end) {
        const hh  = String(Math.floor(cur / 60)).padStart(2, '0');
        const mm  = String(cur % 60).padStart(2, '0');
        const iso = dateStr + 'T' + hh + ':' + mm + ':00';
        if (!booked.has(iso)) slots.push(iso);
        cur += durationMins;
      }
    }
  }
  return slots;
}

// ── Questionnaire delivery ────────────────────────────────────────────────────

async function handleAdminProjectQuestionnaires(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(`
      SELECT qi.*, qs.name AS set_name
      FROM questionnaire_instances qi
      JOIN questionnaire_sets qs ON qi.set_id = qs.id
      WHERE qi.project_id = ? ORDER BY qi.sent_at DESC
    `).bind(projectId).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const { set_id } = await request.json();
    if (!set_id) return jsonResponse({ error: 'set_id required' }, 400);
    const [setRes, projRes] = await Promise.all([
      env.DB.prepare('SELECT * FROM questionnaire_sets WHERE id = ?').bind(set_id).all(),
      env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).all(),
    ]);
    if (!setRes.results.length)  return jsonResponse({ error: 'Questionnaire set not found' }, 404);
    if (!projRes.results.length) return jsonResponse({ error: 'Project not found' }, 404);
    const qs   = setRes.results[0];
    const proj = projRes.results[0];
    const id    = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now   = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO questionnaire_instances (id,project_id,set_id,magic_token,phase,status,sent_at,completed_at,responses) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(id, projectId, set_id, token, qs.phase, 'sent', now, '', '{}').run();
    const url = `${ALLOWED_ORIGIN}/questionnaire.html#${token}`;
    if (env.RESEND_API_KEY && proj.client_email) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to:      [proj.client_email],
          subject: qs.name + ' — Coastal Travel Company',
          html:    `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p>
<p style="font-family:sans-serif;font-size:15px">Please take a moment to complete this questionnaire for your upcoming project.</p>
<p><a href="${url}" style="background:#2A5C45;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;font-family:sans-serif">Complete Questionnaire</a></p>
<p style="font-family:sans-serif;font-size:13px;color:#999">Or copy this link: ${url}</p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ id, project_id: projectId, set_id, magic_token: token, phase: qs.phase, status: 'sent', sent_at: now, public_url: url }, 201);
  }
}

async function handlePublicQuestionnaire(request, method, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(`
    SELECT qi.*, qs.name AS set_name, qs.questions,
           p.client_name, p.property, p.collection
    FROM questionnaire_instances qi
    JOIN questionnaire_sets qs ON qi.set_id = qs.id
    JOIN projects p ON qi.project_id = p.id
    WHERE qi.magic_token = ?
  `).bind(token).all();
  if (!results.length) return jsonResponse({ error: 'Questionnaire not found or link expired' }, 404);
  const qi = results[0];

  if (method === 'GET') {
    return jsonResponse({
      id: qi.id, set_name: qi.set_name, phase: qi.phase, status: qi.status,
      questions: JSON.parse(qi.questions || '[]'),
      client_name: qi.client_name, property: qi.property, collection: qi.collection,
    });
  }

  if (method === 'POST') {
    if (qi.status === 'completed') return jsonResponse({ error: 'Already submitted' }, 409);
    let responses;
    try { responses = await request.json(); } catch { return jsonResponse({ error: 'Invalid body' }, 400); }
    const now = new Date().toISOString();
    await env.DB.prepare('UPDATE questionnaire_instances SET status=?,completed_at=?,responses=? WHERE id=?')
      .bind('completed', now, JSON.stringify(responses), qi.id).run();
    if (env.RESEND_API_KEY) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to:      [CONTACT_TO],
          subject: `Questionnaire submitted — ${qi.client_name}`,
          html:    `<p style="font-family:sans-serif"><strong>${escHtml(qi.client_name)}</strong> completed the questionnaire "<em>${escHtml(qi.set_name)}</em>".</p><p style="font-family:sans-serif"><a href="${ALLOWED_ORIGIN}/admin/pipeline.html">View in Pipeline →</a></p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ ok: true, completed_at: now });
  }
}

// ── Project portal ────────────────────────────────────────────────────────────

async function handleAdminProjectPortalLink(request, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO project_portal_tokens (id,project_id,expires_at,created_at) VALUES (?,?,?,?)')
    .bind(id, projectId, '', now).run();
  return jsonResponse({ id, project_id: projectId, url: `${ALLOWED_ORIGIN}/portal-project.html#${id}`, created_at: now }, 201);
}

async function handlePublicProjectPortal(request, method, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results: tokenRows } = await env.DB.prepare('SELECT * FROM project_portal_tokens WHERE id = ?').bind(token).all();
  if (!tokenRows.length) return jsonResponse({ error: 'Portal link not found' }, 404);
  const projectId = tokenRows[0].project_id;
  const { results: projRows } = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).all();
  if (!projRows.length) return jsonResponse({ error: 'Project not found' }, 404);
  const proj = projRows[0];

  if (method === 'GET') {
    const [docsRes, propsRes, msgsRes, questRes] = await Promise.all([
      env.DB.prepare('SELECT * FROM project_documents WHERE project_id=? ORDER BY created_at DESC').bind(projectId).all(),
      env.DB.prepare('SELECT id,status,public_url,selected_package_id,expires_at,opened_at,selected_at,created_at FROM proposals WHERE project_id=? ORDER BY created_at DESC').bind(projectId).all(),
      env.DB.prepare('SELECT * FROM project_messages WHERE project_id=? ORDER BY created_at ASC').bind(projectId).all(),
      env.DB.prepare('SELECT id,phase,status,sent_at,completed_at FROM questionnaire_instances WHERE project_id=? ORDER BY sent_at DESC').bind(projectId).all(),
    ]);
    return jsonResponse({
      project: { id: proj.id, client_name: proj.client_name, property: proj.property, location: proj.location, collection: proj.collection, shoot_date: proj.shoot_date, stage: proj.stage, created_at: proj.created_at },
      documents: docsRes.results, proposals: propsRes.results,
      messages: msgsRes.results, questionnaires: questRes.results,
    });
  }

  if (method === 'POST') {
    let body; try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid body' }, 400); }
    const { content, sender_name } = body;
    if (!content?.trim()) return jsonResponse({ error: 'content required' }, 400);
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    const name = (sender_name || proj.client_name || 'Client').trim();
    await env.DB.prepare('INSERT INTO project_messages (id,project_id,sender,sender_name,content,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, projectId, 'client', name, content.trim(), now).run();
    if (env.RESEND_API_KEY) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to:      [CONTACT_TO],
          subject: `New portal message — ${proj.client_name}`,
          html:    `<p style="font-family:sans-serif"><strong>${escHtml(name)}</strong> sent a message:</p><blockquote style="font-family:sans-serif;border-left:3px solid #2A5C45;padding-left:12px;margin-left:0">${escHtml(content)}</blockquote><p style="font-family:sans-serif"><a href="${ALLOWED_ORIGIN}/admin/pipeline.html">View in Pipeline →</a></p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ id, project_id: projectId, sender: 'client', sender_name: name, content: content.trim(), created_at: now }, 201);
  }
}

async function handleAdminProjectMessages(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM project_messages WHERE project_id=? ORDER BY created_at ASC').bind(projectId).all();
    return jsonResponse(results);
  }
  if (method === 'POST') {
    const { content } = await request.json();
    if (!content?.trim()) return jsonResponse({ error: 'content required' }, 400);
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO project_messages (id,project_id,sender,sender_name,content,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, projectId, 'admin', 'Coastal Travel Company', content.trim(), now).run();
    return jsonResponse({ id, project_id: projectId, sender: 'admin', sender_name: 'Coastal Travel Company', content: content.trim(), created_at: now }, 201);
  }
}

// ── Scheduling ────────────────────────────────────────────────────────────────

async function handleAdminAvailability(request, method, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const [winRes, blkRes] = await Promise.all([
      env.DB.prepare('SELECT * FROM availability_windows ORDER BY day_of_week, start_time').all(),
      env.DB.prepare('SELECT * FROM blocked_dates ORDER BY date').all(),
    ]);
    return jsonResponse({ windows: winRes.results, blocked_dates: blkRes.results });
  }
  if (method === 'PUT') {
    const { windows } = await request.json();
    if (!Array.isArray(windows)) return jsonResponse({ error: 'windows array required' }, 400);
    await env.DB.prepare('DELETE FROM availability_windows').run();
    for (const w of windows) {
      if (w.day_of_week == null || !w.start_time || !w.end_time) continue;
      await env.DB.prepare('INSERT INTO availability_windows (id,day_of_week,start_time,end_time,active) VALUES (?,?,?,?,?)')
        .bind(crypto.randomUUID(), Number(w.day_of_week), w.start_time, w.end_time, w.active !== false ? 1 : 0).run();
    }
    const { results } = await env.DB.prepare('SELECT * FROM availability_windows ORDER BY day_of_week, start_time').all();
    return jsonResponse({ windows: results });
  }
}

async function handleAdminBlockedDates(request, method, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM blocked_dates ORDER BY date').all();
    return jsonResponse(results);
  }
  if (method === 'POST') {
    const { date, reason } = await request.json();
    if (!date) return jsonResponse({ error: 'date required' }, 400);
    const bid = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO blocked_dates (id,date,reason) VALUES (?,?,?)').bind(bid, date, reason || '').run();
    return jsonResponse({ id: bid, date, reason: reason || '' }, 201);
  }
  if (method === 'DELETE' && id) {
    await env.DB.prepare('DELETE FROM blocked_dates WHERE id=?').bind(id).run();
    return jsonResponse({ ok: true });
  }
}

async function handleAdminProjectScheduleLinks(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM scheduling_links WHERE project_id=? ORDER BY created_at DESC').bind(projectId).all();
    return jsonResponse(results);
  }
  if (method === 'POST') {
    const { link_type, duration_mins } = await request.json();
    const { results: projRows } = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(projectId).all();
    if (!projRows.length) return jsonResponse({ error: 'Project not found' }, 404);
    const proj  = projRows[0];
    const id    = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now   = new Date().toISOString();
    const type  = link_type || 'discovery-call';
    const dur   = Number(duration_mins) || 30;
    await env.DB.prepare(
      'INSERT INTO scheduling_links (id,project_id,link_type,duration_mins,magic_token,expires_at,booked_at,booked_slot,client_name,client_email,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, projectId, type, dur, token, '', '', '', proj.client_name, proj.client_email, '', now).run();
    const url   = `${ALLOWED_ORIGIN}/schedule.html#${token}`;
    const label = type === 'shoot' ? 'shoot date' : 'discovery call';
    if (env.RESEND_API_KEY && proj.client_email) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to:      [proj.client_email],
          subject: `Schedule your ${label} — Coastal Travel Company`,
          html:    `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Please choose a time that works for your ${escHtml(label)}.</p><p><a href="${url}" style="background:#2A5C45;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;font-family:sans-serif">Choose a Time</a></p><p style="font-family:sans-serif;font-size:13px;color:#999">Or copy this link: ${url}</p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ id, project_id: projectId, link_type: type, duration_mins: dur, magic_token: token, public_url: url, booked_at: '', created_at: now }, 201);
  }
}

async function handlePublicSchedule(request, method, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results: linkRows } = await env.DB.prepare('SELECT * FROM scheduling_links WHERE magic_token=?').bind(token).all();
  if (!linkRows.length) return jsonResponse({ error: 'Scheduling link not found' }, 404);
  const link = linkRows[0];

  if (method === 'GET') {
    const [winRes, blkRes, bookedRes] = await Promise.all([
      env.DB.prepare("SELECT * FROM availability_windows WHERE active=1 ORDER BY day_of_week, start_time").all(),
      env.DB.prepare("SELECT * FROM blocked_dates ORDER BY date").all(),
      env.DB.prepare("SELECT booked_slot FROM scheduling_links WHERE booked_slot != ''").all(),
    ]);
    return jsonResponse({
      link_type: link.link_type, duration_mins: link.duration_mins,
      client_name: link.client_name, booked: !!link.booked_at, booked_slot: link.booked_slot,
      available_slots: link.booked_at ? [] : generateAvailableSlots(winRes.results, blkRes.results, bookedRes.results, link.duration_mins || 30),
    });
  }

  if (method === 'POST') {
    if (link.booked_at) return jsonResponse({ error: 'This time has already been booked' }, 409);
    let body; try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid body' }, 400); }
    const { slot, notes } = body;
    if (!slot) return jsonResponse({ error: 'slot required' }, 400);
    const now      = new Date().toISOString();
    await env.DB.prepare('UPDATE scheduling_links SET booked_at=?,booked_slot=?,notes=? WHERE magic_token=?')
      .bind(now, slot, notes || '', token).run();

    const slotDate = new Date(slot);
    const slotEnd  = new Date(slotDate.getTime() + (link.duration_mins || 30) * 60000);
    const label    = link.link_type === 'shoot' ? 'Shoot Date — Coastal Travel Company' : 'Discovery Call — Coastal Travel Company';
    const ics      = generateICS({
      uid: link.id + '@coastaltravelcompany.com', summary: label,
      description: `${label}\\nClient: ${link.client_name}`,
      dtstart: slotDate, dtend: slotEnd,
      organizerEmail: 'noreply@coastaltravelcompany.com',
      attendeeEmail: link.client_email, attendeeName: link.client_name,
    });
    const formattedSlot = slotDate.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
    const emailHtml = `<p style="font-family:sans-serif;font-size:15px">Your ${link.link_type === 'shoot' ? 'shoot date' : 'discovery call'} is confirmed!</p><p style="font-family:sans-serif;font-size:16px;font-weight:600">${formattedSlot} ET</p>${notes ? `<p style="font-family:sans-serif;font-size:14px;color:#555">Notes: ${escHtml(notes)}</p>` : ''}<p style="font-family:sans-serif;font-size:13px;color:#999">A calendar invite is attached.</p>`;
    const icsB64   = btoa(unescape(encodeURIComponent(ics)));
    if (env.RESEND_API_KEY) {
      const att = [{ filename: 'invite.ics', content: icsB64 }];
      await Promise.all([
        fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>', to: [link.client_email], subject: 'Confirmed: ' + label, html: emailHtml, attachments: att }) }).catch(() => {}),
        fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>', to: [CONTACT_TO], subject: `Confirmed: ${label} — ${link.client_name}`, html: emailHtml, attachments: att }) }).catch(() => {}),
      ]);
    }
    if (link.link_type === 'shoot') {
      await env.DB.prepare('UPDATE projects SET shoot_date=?,updated_at=? WHERE id=?')
        .bind(slot.slice(0, 10), now, link.project_id).run();
    }
    return jsonResponse({ ok: true, booked_slot: slot, booked_at: now });
  }
}

// ── Automations ───────────────────────────────────────────────────────────────

async function handleAdminAutomations(request, method, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM automation_settings ORDER BY id').all();
    return jsonResponse(results);
  }
  if (method === 'PUT') {
    const updates = await request.json();
    if (!Array.isArray(updates)) return jsonResponse({ error: 'Array required' }, 400);
    const now = new Date().toISOString();
    for (const u of updates) {
      await env.DB.prepare('UPDATE automation_settings SET enabled=?,delay_hours=?,updated_at=? WHERE id=?')
        .bind(u.enabled ? 1 : 0, Number(u.delay_hours) || 0, now, u.id).run();
    }
    const { results } = await env.DB.prepare('SELECT * FROM automation_settings ORDER BY id').all();
    return jsonResponse(results);
  }
}

async function handleAdminAutomationLogs(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(`
    SELECT al.*, p.client_name FROM automation_logs al
    LEFT JOIN projects p ON al.project_id = p.id
    ORDER BY al.created_at DESC LIMIT 100
  `).all();
  return jsonResponse(results);
}

async function sendAutomationEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !to) return;
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>', to: [to], subject, html }),
  }).catch(() => {});
}

async function logAutomation(db, projectId, triggerKey, action, now) {
  await db.prepare('INSERT INTO automation_logs (id,project_id,trigger_key,action,status,created_at) VALUES (?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), projectId, triggerKey, action, 'sent', now).run();
}

// ── Cron: run automation checks hourly ───────────────────────────────────────

async function handleScheduled(event, env) {
  if (!env.DB || !env.RESEND_API_KEY) return;
  const { results: settings } = await env.DB.prepare("SELECT * FROM automation_settings WHERE enabled=1").all();
  if (!settings.length) return;
  const cfg    = Object.fromEntries(settings.map(s => [s.trigger_key, s]));
  const now    = new Date();
  const nowIso = now.toISOString();
  const hrsSince = iso => (now - new Date(iso)) / 3600000;

  const { results: projects } = await env.DB.prepare(
    "SELECT * FROM projects WHERE stage NOT IN ('Complete') ORDER BY created_at ASC"
  ).all();

  for (const proj of projects) {
    if (!proj.client_email) continue;

    if (cfg['inquiry_auto_reply'] && proj.stage === 'Inquiry' && proj.source === 'inquiry') {
      const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='inquiry_auto_reply'").bind(proj.id).all();
      if (!logged.length) {
        await sendAutomationEmail(env, proj.client_email, 'Thank you for reaching out — Coastal Travel Company',
          `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Thank you for your inquiry! We've received your message and will be in touch within 24 hours. In the meantime, feel free to explore our <a href="${ALLOWED_ORIGIN}/collections.html" style="color:#2A5C45">portfolio</a>.</p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`);
        await logAutomation(env.DB, proj.id, 'inquiry_auto_reply', 'auto-reply sent', nowIso);
      }
    }

    if (cfg['proposal_not_opened_followup'] && proj.stage === 'Proposal Sent') {
      const { results: props } = await env.DB.prepare("SELECT * FROM proposals WHERE project_id=? AND (opened_at IS NULL OR opened_at='') ORDER BY created_at DESC LIMIT 1").bind(proj.id).all();
      if (props.length && hrsSince(props[0].created_at) >= cfg['proposal_not_opened_followup'].delay_hours) {
        const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='proposal_not_opened_followup'").bind(proj.id).all();
        if (!logged.length) {
          await sendAutomationEmail(env, proj.client_email, 'Just checking in — Coastal Travel Company',
            `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">I wanted to make sure you received the proposal I sent. Happy to answer any questions. <a href="${escHtml(props[0].public_url)}" style="color:#2A5C45">View your proposal →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`);
          await logAutomation(env.DB, proj.id, 'proposal_not_opened_followup', 'follow-up sent', nowIso);
        }
      }
    }

    if (cfg['proposal_not_approved_reminder'] && proj.stage === 'Proposal Sent') {
      const { results: props } = await env.DB.prepare("SELECT * FROM proposals WHERE project_id=? AND status='sent' ORDER BY created_at DESC LIMIT 1").bind(proj.id).all();
      if (props.length && hrsSince(props[0].created_at) >= cfg['proposal_not_approved_reminder'].delay_hours) {
        const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='proposal_not_approved_reminder'").bind(proj.id).all();
        if (!logged.length) {
          await sendAutomationEmail(env, proj.client_email, 'Dates are filling up — Coastal Travel Company',
            `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">I wanted to follow up before your preferred window fills. Happy to adjust the proposal to fit your needs. <a href="${escHtml(props[0].public_url)}" style="color:#2A5C45">Review your proposal →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`);
          await logAutomation(env.DB, proj.id, 'proposal_not_approved_reminder', 'reminder sent', nowIso);
        }
      }
    }

    if (cfg['contract_not_signed_reminder'] && proj.stage === 'Contract Sent') {
      if (hrsSince(proj.updated_at) >= cfg['contract_not_signed_reminder'].delay_hours) {
        const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='contract_not_signed_reminder'").bind(proj.id).all();
        if (!logged.length) {
          await sendAutomationEmail(env, proj.client_email, 'Your contract is ready to sign — Coastal Travel Company',
            `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Just a reminder that your contract is awaiting your signature. Please sign at your earliest convenience to secure your shoot date.</p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`);
          await logAutomation(env.DB, proj.id, 'contract_not_signed_reminder', 'reminder sent', nowIso);
        }
      }
    }

    if (cfg['post_delivery_review_request'] && proj.stage === 'Delivered') {
      if (hrsSince(proj.updated_at) >= cfg['post_delivery_review_request'].delay_hours) {
        const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='post_delivery_review_request'").bind(proj.id).all();
        if (!logged.length) {
          await sendAutomationEmail(env, proj.client_email, 'How did we do? — Coastal Travel Company',
            `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">It was a pleasure working with you on ${escHtml(proj.property || 'your project')}. If you have a moment, we'd love to hear your feedback — reviews mean the world to us.</p><p style="font-family:sans-serif;font-size:15px">Thank you for choosing Coastal Travel Company.<br>Warmly,<br>Coastal Travel Company</p>`);
          await logAutomation(env.DB, proj.id, 'post_delivery_review_request', 'review request sent', nowIso);
        }
      }
    }
  }
}

// ── Invoices ──────────────────────────────────────────────────────────────────

function calcInvoiceTotals(lineItems, taxCents) {
  const subtotal = lineItems.reduce(
    (s, i) => s + Math.round((Number(i.quantity) || 1) * (Number(i.unit_price_cents) || 0)), 0
  );
  const tax = Math.round(Number(taxCents) || 0);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax };
}

async function handleAdminProjectInvoices(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM invoices WHERE project_id=? ORDER BY created_at DESC'
    ).bind(projectId).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const body = await request.json();
    const { line_items, due_date, notes, tax_cents } = body;
    if (!Array.isArray(line_items) || !line_items.length)
      return jsonResponse({ error: 'line_items array required' }, 400);
    const { results: projR } = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(projectId).all();
    if (!projR.length) return jsonResponse({ error: 'Project not found' }, 404);
    const proj = projR[0];
    const totals = calcInvoiceTotals(line_items, tax_cents);
    const { results: countR } = await env.DB.prepare('SELECT COUNT(*) as n FROM invoices').all();
    const invoiceNumber = 'INV-' + String((Number(countR[0].n) || 0) + 1).padStart(4, '0');
    const id    = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now   = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO invoices (id,project_id,invoice_number,status,line_items,subtotal_cents,tax_cents,total_cents,due_date,magic_token,stripe_session_id,stripe_payment_intent_id,client_name,client_email,notes,sent_at,paid_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      id, projectId, invoiceNumber, 'draft', JSON.stringify(line_items),
      totals.subtotal_cents, totals.tax_cents, totals.total_cents,
      due_date || '', token, '', '', proj.client_name || '', proj.client_email || '',
      notes || '', '', '', now, now
    ).run();
    return jsonResponse({
      id, project_id: projectId, invoice_number: invoiceNumber, status: 'draft',
      line_items: JSON.stringify(line_items), ...totals, due_date: due_date || '',
      magic_token: token, stripe_session_id: '', stripe_payment_intent_id: '',
      client_name: proj.client_name || '', client_email: proj.client_email || '',
      notes: notes || '', sent_at: '', paid_at: '', created_at: now, updated_at: now,
    }, 201);
  }
}

async function handleAdminInvoice(request, method, env, invoiceId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
  if (!results.length) return jsonResponse({ error: 'Invoice not found' }, 404);
  const inv = results[0];

  if (method === 'GET') return jsonResponse(inv);

  if (method === 'PUT') {
    const body = await request.json();
    const now    = new Date().toISOString();
    const status   = body.status   !== undefined ? body.status   : inv.status;
    const due_date = body.due_date !== undefined ? body.due_date : inv.due_date;
    const notes    = body.notes    !== undefined ? body.notes    : inv.notes;
    const paid_at  = body.paid_at  !== undefined ? body.paid_at  : inv.paid_at;
    let lineItems  = JSON.parse(inv.line_items || '[]');
    let taxCents   = inv.tax_cents;
    if (Array.isArray(body.line_items)) {
      lineItems = body.line_items;
      taxCents  = body.tax_cents !== undefined ? body.tax_cents : inv.tax_cents;
    }
    const totals = calcInvoiceTotals(lineItems, taxCents);
    await env.DB.prepare(
      'UPDATE invoices SET status=?,due_date=?,notes=?,line_items=?,subtotal_cents=?,tax_cents=?,total_cents=?,paid_at=?,updated_at=? WHERE id=?'
    ).bind(status, due_date, notes, JSON.stringify(lineItems), totals.subtotal_cents, totals.tax_cents, totals.total_cents, paid_at, now, invoiceId).run();
    if (status === 'paid' && inv.status !== 'paid') {
      await env.DB.prepare('UPDATE projects SET stage=?,updated_at=? WHERE id=?')
        .bind('Retainer Paid', now, inv.project_id).run();
    }
    const { results: updated } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
    return jsonResponse(updated[0]);
  }
}

async function handleAdminInvoiceSend(request, env, invoiceId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
  if (!results.length) return jsonResponse({ error: 'Invoice not found' }, 404);
  const inv = results[0];
  const now = new Date().toISOString();
  const publicUrl = `${ALLOWED_ORIGIN}/invoice.html#${inv.magic_token}`;
  await env.DB.prepare('UPDATE invoices SET status=?,sent_at=?,updated_at=? WHERE id=?')
    .bind('sent', now, now, invoiceId).run();
  await env.DB.prepare(
    'INSERT INTO project_documents (id,project_id,type,title,url,created_at) VALUES (?,?,?,?,?,?)'
  ).bind(crypto.randomUUID(), inv.project_id, 'invoice', inv.invoice_number, publicUrl, now).run();
  const items = JSON.parse(inv.line_items || '[]');
  const rowsHtml = items.map(i =>
    `<tr>` +
    `<td style="padding:8px 0;border-bottom:1px solid #f0ebe3;font-family:sans-serif;font-size:14px;">${escHtml(i.description || '')}</td>` +
    `<td style="padding:8px 0;border-bottom:1px solid #f0ebe3;font-family:sans-serif;font-size:14px;text-align:center;">${Number(i.quantity) || 1}</td>` +
    `<td style="padding:8px 0;border-bottom:1px solid #f0ebe3;font-family:sans-serif;font-size:14px;text-align:right;">$${((Number(i.unit_price_cents) || 0) / 100).toFixed(2)}</td>` +
    `<td style="padding:8px 0;border-bottom:1px solid #f0ebe3;font-family:sans-serif;font-size:14px;text-align:right;">$${(((Number(i.quantity) || 1) * (Number(i.unit_price_cents) || 0)) / 100).toFixed(2)}</td>` +
    `</tr>`
  ).join('');
  const dueStr = inv.due_date
    ? new Date(inv.due_date + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  if (env.RESEND_API_KEY && inv.client_email) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:      [inv.client_email],
        subject: `Invoice ${inv.invoice_number} — Coastal Travel Company`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1C1C1C;">
<h2 style="color:#2A5C45;margin-bottom:4px;">Coastal Travel Company</h2>
<p style="font-size:13px;color:#888;margin:0 0 24px;">Invoice ${escHtml(inv.invoice_number)}${dueStr ? ' · Due ' + dueStr : ''}</p>
<p style="font-size:15px;">Hi ${escHtml(inv.client_name)},</p>
<p style="font-size:15px;">Please find your invoice below. You can view and pay securely online.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<thead><tr style="border-bottom:2px solid #E8DDD0;">
<th style="text-align:left;padding:8px 0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;">Description</th>
<th style="text-align:center;padding:8px 0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;">Qty</th>
<th style="text-align:right;padding:8px 0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;">Rate</th>
<th style="text-align:right;padding:8px 0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;">Amount</th>
</tr></thead>
<tbody>${rowsHtml}</tbody>
</table>
${inv.tax_cents > 0 ? `<p style="text-align:right;font-size:14px;color:#666;margin:4px 0;">Tax: $${(inv.tax_cents / 100).toFixed(2)}</p>` : ''}
<p style="text-align:right;font-size:17px;font-weight:600;margin:8px 0 16px;">Total: $${(inv.total_cents / 100).toFixed(2)}</p>
${inv.notes ? `<p style="font-size:13px;color:#666;border-top:1px solid #f0ebe3;padding-top:12px;">${escHtml(inv.notes)}</p>` : ''}
<p style="margin-top:24px;"><a href="${publicUrl}" style="background:#2A5C45;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-size:14px;font-family:sans-serif;">View &amp; Pay Invoice →</a></p>
<p style="font-size:12px;color:#999;margin-top:8px;">Or copy: ${publicUrl}</p>
<p style="font-size:15px;margin-top:24px;">Warmly,<br>Coastal Travel Company</p>
</div>`,
      }),
    }).catch(() => {});
  }
  const { results: updated } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
  return jsonResponse({ ...updated[0], public_url: publicUrl });
}

async function handlePublicInvoice(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    'SELECT id,invoice_number,status,line_items,subtotal_cents,tax_cents,total_cents,due_date,client_name,notes,sent_at,paid_at,created_at FROM invoices WHERE magic_token=?'
  ).bind(token).all();
  if (!results.length) return jsonResponse({ error: 'Invoice not found' }, 404);
  return jsonResponse({ ...results[0], stripe_enabled: !!env.STRIPE_SECRET_KEY });
}

async function handleInvoiceCheckout(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Online payment not configured' }, 503);
  const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE magic_token=?').bind(token).all();
  if (!results.length) return jsonResponse({ error: 'Invoice not found' }, 404);
  const inv = results[0];
  if (inv.status === 'paid') return jsonResponse({ error: 'Invoice already paid' }, 400);
  if (inv.status === 'void') return jsonResponse({ error: 'Invoice is void' }, 400);
  const items = JSON.parse(inv.line_items || '[]');
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', `${ALLOWED_ORIGIN}/invoice.html#${token}`);
  params.append('cancel_url', `${ALLOWED_ORIGIN}/invoice.html#${token}`);
  if (inv.client_email) params.append('customer_email', inv.client_email);
  params.append('metadata[invoice_id]', inv.id);
  params.append('metadata[magic_token]', token);
  items.forEach((item, i) => {
    params.append(`line_items[${i}][price_data][currency]`, 'usd');
    params.append(`line_items[${i}][price_data][product_data][name]`, item.description || 'Service');
    params.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(Number(item.unit_price_cents) || 0)));
    params.append(`line_items[${i}][quantity]`, String(Math.max(1, Math.round(Number(item.quantity) || 1))));
  });
  if (inv.tax_cents > 0) {
    const i = items.length;
    params.append(`line_items[${i}][price_data][currency]`, 'usd');
    params.append(`line_items[${i}][price_data][product_data][name]`, 'Tax');
    params.append(`line_items[${i}][price_data][unit_amount]`, String(inv.tax_cents));
    params.append(`line_items[${i}][quantity]`, '1');
  }
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const session = await res.json();
  if (!res.ok) return jsonResponse({ error: session.error?.message || 'Stripe error' }, 502);
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE invoices SET stripe_session_id=?,updated_at=? WHERE id=?')
    .bind(session.id, now, inv.id).run();
  return jsonResponse({ url: session.url });
}

async function handleStripeWebhook(request, env) {
  if (!env.DB || !env.STRIPE_WEBHOOK_SECRET) return jsonResponse({ ok: true });
  const rawBody = await request.text();
  const sig     = request.headers.get('Stripe-Signature') || '';
  const valid   = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return jsonResponse({ error: 'Invalid signature' }, 400);
  let event;
  try { event = JSON.parse(rawBody); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object;
    const invoiceId = session.metadata?.invoice_id;
    if (invoiceId && session.payment_status === 'paid') {
      const now = new Date().toISOString();
      const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
      if (results.length && results[0].status !== 'paid') {
        const inv = results[0];
        await env.DB.prepare(
          'UPDATE invoices SET status=?,paid_at=?,stripe_payment_intent_id=?,updated_at=? WHERE id=?'
        ).bind('paid', now, session.payment_intent || '', now, invoiceId).run();
        await env.DB.prepare('UPDATE projects SET stage=?,updated_at=? WHERE id=?')
          .bind('Retainer Paid', now, inv.project_id).run();
        const publicUrl = `${ALLOWED_ORIGIN}/invoice.html#${inv.magic_token}`;
        if (env.RESEND_API_KEY && inv.client_email) {
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
              to:      [inv.client_email],
              subject: `Payment received — ${inv.invoice_number}`,
              html:    `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(inv.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Thank you! We received your payment of <strong>$${(inv.total_cents / 100).toFixed(2)}</strong> for invoice ${escHtml(inv.invoice_number)}.</p><p><a href="${publicUrl}" style="color:#2A5C45;">View receipt →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`,
            }),
          }).catch(() => {});
        }
        if (env.RESEND_API_KEY) {
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
              to:      [CONTACT_TO],
              subject: `Payment received — ${inv.invoice_number} — ${inv.client_name}`,
              html:    `<p style="font-family:sans-serif;font-size:15px">Payment of <strong>$${(inv.total_cents / 100).toFixed(2)}</strong> received from ${escHtml(inv.client_name)} for invoice ${escHtml(inv.invoice_number)}.</p>`,
            }),
          }).catch(() => {});
        }
      }
    }
  }
  return jsonResponse({ ok: true });
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = sigHeader.split(',');
  const t  = (parts.find(s => s.startsWith('t='))  || '').slice(2);
  const v1 = (parts.find(s => s.startsWith('v1=')) || '').slice(3);
  if (!t || !v1) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig      = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + rawBody));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === v1;
}

async function handlePortalInvoices(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    `SELECT i.id,i.invoice_number,i.status,i.total_cents,i.due_date,i.paid_at,i.magic_token,i.created_at,
            p.property,p.collection
     FROM invoices i
     JOIN projects p ON i.project_id = p.id
     WHERE i.client_email = ? AND i.status != 'draft'
     ORDER BY i.created_at DESC`
  ).bind(p.sub).all();
  return jsonResponse(results.map(r => ({
    ...r, public_url: `${ALLOWED_ORIGIN}/invoice.html#${r.magic_token}`,
  })));
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};
