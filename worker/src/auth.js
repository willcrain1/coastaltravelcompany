import { ALLOWED_ORIGIN, JWT_EXPIRY_SECS } from './constants.js';
import { jsonResponse, authRequired } from './utils.js';
import { createJWT, getAuth } from './jwt.js';
import { getUser, putUser } from './kv.js';
import { hashPassword, verifyPassword } from './crypto.js';

export async function handleAuthSetupStatus(env) {
  const raw  = await env.KV.get('users_list');
  const list = raw ? JSON.parse(raw) : [];
  return jsonResponse({ configured: list.length > 0 });
}

export async function handleAuthSetup(request, env) {
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

export async function handleAuthRegister(request, env) {
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

export async function handleAuthVerify(request, env) {
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

export async function handleAuthResendVerify(request, env) {
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
  return jsonResponse({ ok: true });
}

export async function handleAuthLogin(request, env) {
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

export async function handleAuthGoogle(request, env) {
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

export async function handleAuthResetRequest(request, env) {
  const { email } = await request.json();
  if (!email) return jsonResponse({ error: 'Email required' }, 400);
  const user = await getUser(email, env.KV);
  if (user) {
    const token    = crypto.randomUUID();
    const resetUrl = `${ALLOWED_ORIGIN}/login.html?reset=${token}`;
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
  return jsonResponse({ ok: true });
}

export async function handleAuthResetConfirm(request, env) {
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

export async function handleAuthMe(request, env) {
  const payload = await getAuth(request, env);
  if (!payload) return authRequired();
  const user = await getUser(payload.sub, env.KV);
  if (!user) return authRequired();
  return jsonResponse({ id: user.id, email: user.email, role: user.role });
}
