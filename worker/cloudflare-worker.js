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

  // ── Portal ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/portal/galleries') return handlePortalGalleries(request, env);

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

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
