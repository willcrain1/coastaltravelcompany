import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleAuthSetupStatus, handleAuthSetup, handleAuthRegister, handleAuthLogin,
  handleAuthMe, handleAuthVerify, handleAuthResendVerify,
  handleAuthResetRequest, handleAuthResetConfirm, handleAuthGoogle,
} from '../src/auth.js';
import { createJWT } from '../src/jwt.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';

function makeKv() {
  const store = new Map();
  return {
    get:    async (k)      => store.get(k) ?? null,
    put:    async (k, v)   => { store.set(k, v); },
    delete: async (k)      => { store.delete(k); },
  };
}

function makeEnv(o = {}) {
  return { KV: makeKv(), JWT_SECRET: SECRET, ...o };
}

function post(url, body, env) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── Setup status ──────────────────────────────────────────────────────────────

describe('handleAuthSetupStatus', () => {
  it('returns configured:false when users list is empty', async () => {
    const r = await handleAuthSetupStatus(makeEnv());
    expect((await r.json()).configured).toBe(false);
  });
  it('returns configured:true when users exist', async () => {
    const env = makeEnv();
    await env.KV.put('users_list', JSON.stringify(['a@b.com']));
    expect((await (await handleAuthSetupStatus(env)).json()).configured).toBe(true);
  });
});

// ── Setup (first admin) ───────────────────────────────────────────────────────

describe('handleAuthSetup', () => {
  it('503 when JWT_SECRET missing', async () => {
    const r = await handleAuthSetup(post('http://t', { email: 'a@b.com', password: 'pass1234' }), makeEnv({ JWT_SECRET: undefined }));
    expect(r.status).toBe(503);
  });
  it('409 when already configured', async () => {
    const env = makeEnv();
    await env.KV.put('users_list', JSON.stringify(['x@x.com']));
    expect((await handleAuthSetup(post('http://t', { email: 'a@b.com', password: 'pass1234' }), env)).status).toBe(409);
  });
  it('400 for missing email', async () => {
    expect((await handleAuthSetup(post('http://t', { email: '', password: 'pass1234' }), makeEnv())).status).toBe(400);
  });
  it('400 for short password', async () => {
    expect((await handleAuthSetup(post('http://t', { email: 'a@b.com', password: 'short' }), makeEnv())).status).toBe(400);
  });
  it('creates admin and returns token', async () => {
    const env = makeEnv();
    const r   = await handleAuthSetup(post('http://t', { email: 'admin@test.com', password: 'securepw1' }), env);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.token).toBeTruthy();
    expect(b.user.role).toBe('admin');
    expect(b.user.email).toBe('admin@test.com');
  });
});

// ── Register ──────────────────────────────────────────────────────────────────

describe('handleAuthRegister', () => {
  it('503 when JWT_SECRET missing', async () => {
    const r = await handleAuthRegister(post('http://t', { email: 'a@b.com', password: 'pass1234' }), makeEnv({ JWT_SECRET: undefined }));
    expect(r.status).toBe(503);
  });
  it('400 for short password', async () => {
    expect((await handleAuthRegister(post('http://t', { email: 'a@b.com', password: 'short' }), makeEnv())).status).toBe(400);
  });
  it('400 for missing email', async () => {
    expect((await handleAuthRegister(post('http://t', { email: '', password: 'pass1234' }), makeEnv())).status).toBe(400);
  });
  it('409 when email already registered', async () => {
    const env = makeEnv();
    await env.KV.put('user:dup@test.com', JSON.stringify({ id: 'x', email: 'dup@test.com' }));
    expect((await handleAuthRegister(post('http://t', { email: 'dup@test.com', password: 'pass1234' }), env)).status).toBe(409);
  });
  it('returns ok:true on success (no email)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const r = await handleAuthRegister(post('http://t', { email: 'new@test.com', password: 'pass1234' }), makeEnv());
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
  it('sends verification email when RESEND_API_KEY set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await handleAuthRegister(post('http://t', { email: 'verify@test.com', password: 'pass1234' }), makeEnv({ RESEND_API_KEY: 'key' }));
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.any(Object));
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────

describe('handleAuthLogin', () => {
  it('503 when JWT_SECRET missing', async () => {
    expect((await handleAuthLogin(post('http://t', { email: 'a@b.com', password: 'pw' }), makeEnv({ JWT_SECRET: undefined }))).status).toBe(503);
  });
  it('400 for missing credentials', async () => {
    expect((await handleAuthLogin(post('http://t', { email: '', password: '' }), makeEnv())).status).toBe(400);
  });
  it('401 for wrong credentials', async () => {
    expect((await handleAuthLogin(post('http://t', { email: 'ghost@test.com', password: 'pw' }), makeEnv())).status).toBe(401);
  });
  it('403 for unverified user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const env = makeEnv();
    await handleAuthRegister(post('http://t', { email: 'unv@test.com', password: 'pass1234' }), env);
    const r = await handleAuthLogin(post('http://t', { email: 'unv@test.com', password: 'pass1234' }), env);
    expect(r.status).toBe(403);
    expect((await r.json()).unverified).toBe(true);
  });
  it('returns token for valid verified admin', async () => {
    const env = makeEnv();
    await handleAuthSetup(post('http://t', { email: 'admin@test.com', password: 'pass1234' }), env);
    const r = await handleAuthLogin(post('http://t', { email: 'admin@test.com', password: 'pass1234' }), env);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.token).toBeTruthy();
    expect(b.user.role).toBe('admin');
  });
  it('401 for wrong password on existing user', async () => {
    const env = makeEnv();
    await handleAuthSetup(post('http://t', { email: 'admin@test.com', password: 'pass1234' }), env);
    expect((await handleAuthLogin(post('http://t', { email: 'admin@test.com', password: 'wrongpass' }), env)).status).toBe(401);
  });
});

// ── Me ────────────────────────────────────────────────────────────────────────

describe('handleAuthMe', () => {
  it('401 when no JWT', async () => {
    expect((await handleAuthMe(new Request('http://t/auth/me'), makeEnv())).status).toBe(401);
  });
  it('401 for invalid token', async () => {
    const req = new Request('http://t/auth/me', { headers: { Authorization: 'Bearer bad' } });
    expect((await handleAuthMe(req, makeEnv())).status).toBe(401);
  });
  it('401 when user has been deleted after token was issued', async () => {
    const token = await createJWT({ sub: 'ghost@test.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    expect((await handleAuthMe(req, makeEnv())).status).toBe(401);
  });
  it('returns user info for valid token', async () => {
    const env = makeEnv();
    const setup = await handleAuthSetup(post('http://t', { email: 'me@test.com', password: 'pass1234' }), env);
    const { token } = await setup.json();
    const req = new Request('http://t/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    const r   = await handleAuthMe(req, env);
    expect(r.status).toBe(200);
    expect((await r.json()).email).toBe('me@test.com');
  });
});

// ── Verify ────────────────────────────────────────────────────────────────────

describe('handleAuthVerify', () => {
  it('400 when no token param', async () => {
    expect((await handleAuthVerify(new Request('http://t/auth/verify'), makeEnv())).status).toBe(400);
  });
  it('400 for unknown token', async () => {
    expect((await handleAuthVerify(new Request('http://t/auth/verify?token=bad'), makeEnv())).status).toBe(400);
  });
  it('404 when user not found for valid token', async () => {
    const env = makeEnv();
    await env.KV.put('verify:tok123', JSON.stringify({ email: 'orphan@test.com' }));
    expect((await handleAuthVerify(new Request('http://t/auth/verify?token=tok123'), env)).status).toBe(404);
  });
  it('marks user as verified and deletes token', async () => {
    const env = makeEnv();
    await env.KV.put('verify:tok456', JSON.stringify({ email: 'toverify@test.com' }));
    await env.KV.put('user:toverify@test.com', JSON.stringify({ id: 'u1', email: 'toverify@test.com', role: 'client', verified: false }));
    const r = await handleAuthVerify(new Request('http://t/auth/verify?token=tok456'), env);
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    expect(await env.KV.get('verify:tok456')).toBeNull();
    const updated = JSON.parse(await env.KV.get('user:toverify@test.com'));
    expect(updated.verified).toBe(true);
  });
});

// ── ResendVerify ──────────────────────────────────────────────────────────────

describe('handleAuthResendVerify', () => {
  it('400 when no email', async () => {
    expect((await handleAuthResendVerify(post('http://t', {}), makeEnv())).status).toBe(400);
  });
  it('200 even for unknown email (no enumeration)', async () => {
    expect((await handleAuthResendVerify(post('http://t', { email: 'ghost@test.com' }), makeEnv())).status).toBe(200);
  });
  it('sends email for unverified user with RESEND_API_KEY', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv({ RESEND_API_KEY: 'key' });
    await env.KV.put('user:unver@test.com', JSON.stringify({ id: 'u1', email: 'unver@test.com', role: 'client', verified: false }));
    await handleAuthResendVerify(post('http://t', { email: 'unver@test.com' }), env);
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.any(Object));
  });
  it('does not send email for already-verified user', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv({ RESEND_API_KEY: 'key' });
    await env.KV.put('user:ver@test.com', JSON.stringify({ id: 'u1', email: 'ver@test.com', verified: true }));
    await handleAuthResendVerify(post('http://t', { email: 'ver@test.com' }), env);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── ResetRequest ──────────────────────────────────────────────────────────────

describe('handleAuthResetRequest', () => {
  it('400 when no email', async () => {
    expect((await handleAuthResetRequest(post('http://t', {}), makeEnv())).status).toBe(400);
  });
  it('200 for unknown email', async () => {
    expect((await handleAuthResetRequest(post('http://t', { email: 'ghost@test.com' }), makeEnv())).status).toBe(200);
  });
  it('stores reset token and sends email for existing user', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv({ RESEND_API_KEY: 'key' });
    await env.KV.put('user:reset@test.com', JSON.stringify({ id: 'u1', email: 'reset@test.com', role: 'client' }));
    const r = await handleAuthResetRequest(post('http://t', { email: 'reset@test.com' }), env);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.any(Object));
  });
});

// ── ResetConfirm ──────────────────────────────────────────────────────────────

describe('handleAuthResetConfirm', () => {
  it('400 for missing token', async () => {
    expect((await handleAuthResetConfirm(post('http://t', { token: '', password: 'newpass12' }), makeEnv())).status).toBe(400);
  });
  it('400 for short password', async () => {
    expect((await handleAuthResetConfirm(post('http://t', { token: 'tok', password: 'short' }), makeEnv())).status).toBe(400);
  });
  it('400 for invalid reset token', async () => {
    expect((await handleAuthResetConfirm(post('http://t', { token: 'bad', password: 'newpass12' }), makeEnv())).status).toBe(400);
  });
  it('404 when user not found for valid token', async () => {
    const env = makeEnv();
    await env.KV.put('reset:tok', JSON.stringify({ email: 'orphan@test.com' }));
    expect((await handleAuthResetConfirm(post('http://t', { token: 'tok', password: 'newpass12' }), env)).status).toBe(404);
  });
  it('updates password and deletes token', async () => {
    const env = makeEnv();
    await env.KV.put('reset:tok', JSON.stringify({ email: 'user@test.com' }));
    await env.KV.put('user:user@test.com', JSON.stringify({ id: 'u1', email: 'user@test.com', passwordHash: 'old' }));
    const r = await handleAuthResetConfirm(post('http://t', { token: 'tok', password: 'newpass12' }), env);
    expect(r.status).toBe(200);
    expect(await env.KV.get('reset:tok')).toBeNull();
  });
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

describe('handleAuthGoogle', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('503 when JWT_SECRET missing', async () => {
    expect((await handleAuthGoogle(post('http://t', { credential: 'x' }), makeEnv({ JWT_SECRET: undefined }))).status).toBe(503);
  });
  it('503 when GOOGLE_CLIENT_ID missing', async () => {
    expect((await handleAuthGoogle(post('http://t', { credential: 'x' }), makeEnv())).status).toBe(503);
  });
  it('400 when credential missing', async () => {
    expect((await handleAuthGoogle(post('http://t', {}), makeEnv({ GOOGLE_CLIENT_ID: 'gid' }))).status).toBe(400);
  });
  it('401 when Google tokeninfo fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect((await handleAuthGoogle(post('http://t', { credential: 'bad' }), makeEnv({ GOOGLE_CLIENT_ID: 'gid' }))).status).toBe(401);
  });
  it('401 when aud mismatches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ aud: 'other', email: 'g@t.com', email_verified: 'true' }) }));
    expect((await handleAuthGoogle(post('http://t', { credential: 'x' }), makeEnv({ GOOGLE_CLIENT_ID: 'expected' }))).status).toBe(401);
  });
  it('401 when email not verified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ aud: 'gid', email: 'g@t.com', email_verified: 'false' }) }));
    expect((await handleAuthGoogle(post('http://t', { credential: 'x' }), makeEnv({ GOOGLE_CLIENT_ID: 'gid' }))).status).toBe(401);
  });
  it('creates new user and returns token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ aud: 'gid', email: 'google@test.com', email_verified: 'true' }) }));
    const env = makeEnv({ GOOGLE_CLIENT_ID: 'gid' });
    const r = await handleAuthGoogle(post('http://t', { credential: 'valid' }), env);
    expect(r.status).toBe(200);
    expect((await r.json()).token).toBeTruthy();
  });
  it('updates existing unverified user to verified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ aud: 'gid', email: 'existing@test.com', email_verified: 'true' }) }));
    const env = makeEnv({ GOOGLE_CLIENT_ID: 'gid' });
    await env.KV.put('user:existing@test.com', JSON.stringify({ id: 'eid', email: 'existing@test.com', role: 'client', verified: false, galleries: [] }));
    await env.KV.put('user_id:eid', 'existing@test.com');
    const r = await handleAuthGoogle(post('http://t', { credential: 'tok' }), env);
    expect(r.status).toBe(200);
    const updated = JSON.parse(await env.KV.get('user:existing@test.com'));
    expect(updated.verified).toBe(true);
  });
  it('returns token for existing verified user without modifying', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ aud: 'gid', email: 'verif@test.com', email_verified: 'true' }) }));
    const env = makeEnv({ GOOGLE_CLIENT_ID: 'gid' });
    await env.KV.put('user:verif@test.com', JSON.stringify({ id: 'vid', email: 'verif@test.com', role: 'client', verified: true, galleries: [] }));
    await env.KV.put('user_id:vid', 'verif@test.com');
    const r = await handleAuthGoogle(post('http://t', { credential: 'tok' }), env);
    expect(r.status).toBe(200);
    expect((await r.json()).user.email).toBe('verif@test.com');
  });
});
