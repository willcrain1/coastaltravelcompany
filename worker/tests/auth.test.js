import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createJWT } from '../src/jwt.js';
import { hashPassword } from '../src/crypto.js';

// Mock brute-force module
vi.mock('../src/brute-force.js', () => ({
  checkLoginBruteForce:         vi.fn().mockResolvedValue({ locked: false }),
  recordLoginFailure:           vi.fn().mockResolvedValue(undefined),
  clearLoginCounters:           vi.fn().mockResolvedValue(undefined),
  checkResetBruteForce:         vi.fn().mockResolvedValue({ locked: false }),
  recordResetAttempt:           vi.fn().mockResolvedValue(undefined),
  checkGalleryUnlockBruteForce: vi.fn().mockResolvedValue(false),
  recordGalleryUnlockFailure:   vi.fn().mockResolvedValue(undefined),
  clearGalleryUnlockCounter:    vi.fn().mockResolvedValue(undefined),
}));

import {
  handleAuthLogin,
  handleAuthSetupStatus,
  handleAuthSetup,
  handleAuthRegister,
  handleAuthMe,
  handleAuthVerify,
  handleAuthResetRequest,
  handleAuthResetConfirm,
} from '../src/auth.js';

import {
  checkLoginBruteForce,
  recordLoginFailure,
  clearLoginCounters,
} from '../src/brute-force.js';

const SECRET = 'test-secret-32-chars-long-enough!';
const ORIGIN = 'https://coastaltravelcompany.com';

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    get:    (k)           => Promise.resolve(store.has(k) ? store.get(k) : null),
    put:    (k, v, _opts) => { store.set(k, v); return Promise.resolve(); },
    delete: (k)           => { store.delete(k); return Promise.resolve(); },
  };
}

function makeEnv(kv, overrides = {}) {
  return { KV: kv, JWT_SECRET: SECRET, ...overrides };
}

function makeRequest(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json', 'Origin': ORIGIN };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return new Request('https://worker.example.com' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function signToken(payload) {
  const now = Math.floor(Date.now() / 1000);
  return createJWT({ iat: now, exp: now + 3600, ...payload }, SECRET);
}

describe('handleAuthSetupStatus', () => {
  it('returns configured: false when no users', async () => {
    const kv  = makeKv();
    const res = await handleAuthSetupStatus(makeEnv(kv));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(false);
  });

  it('returns configured: true when users list is non-empty', async () => {
    const kv = makeKv();
    kv._store.set('users_list', JSON.stringify(['admin@test.com']));
    const res  = await handleAuthSetupStatus(makeEnv(kv));
    const body = await res.json();
    expect(body.configured).toBe(true);
  });
});

describe('handleAuthSetup', () => {
  it('returns 503 when JWT_SECRET is missing', async () => {
    const kv  = makeKv();
    const req = makeRequest('POST', '/auth/setup', { email: 'a@b.com', password: 'password123' });
    const res = await handleAuthSetup(req, { KV: kv });
    expect(res.status).toBe(503);
  });

  it('returns 409 when already configured', async () => {
    const kv = makeKv();
    kv._store.set('users_list', JSON.stringify(['admin@test.com']));
    const req = makeRequest('POST', '/auth/setup', { email: 'a@b.com', password: 'password123' });
    const res = await handleAuthSetup(req, makeEnv(kv));
    expect(res.status).toBe(409);
  });

  it('returns 400 when email is missing', async () => {
    const kv  = makeKv();
    const req = makeRequest('POST', '/auth/setup', { password: 'password123' });
    const res = await handleAuthSetup(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is too short', async () => {
    const kv  = makeKv();
    const req = makeRequest('POST', '/auth/setup', { email: 'a@b.com', password: 'short' });
    const res = await handleAuthSetup(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('creates admin user and returns token on success', async () => {
    const kv  = makeKv();
    const req = makeRequest('POST', '/auth/setup', { email: 'admin@test.com', password: 'password123' });
    const res = await handleAuthSetup(req, makeEnv(kv));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.role).toBe('admin');
    expect(body.user.email).toBe('admin@test.com');
  });
});

describe('handleAuthLogin', () => {
  let kv;

  beforeEach(() => {
    kv = makeKv();
    vi.mocked(checkLoginBruteForce).mockResolvedValue({ locked: false });
    vi.mocked(recordLoginFailure).mockResolvedValue(undefined);
    vi.mocked(clearLoginCounters).mockResolvedValue(undefined);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it('returns 503 when JWT_SECRET is missing', async () => {
    const req = makeRequest('POST', '/auth/login', { email: 'a@b.com', password: 'pass' });
    const res = await handleAuthLogin(req, { KV: kv });
    expect(res.status).toBe(503);
  });

  it('returns 400 when email is missing', async () => {
    const req = makeRequest('POST', '/auth/login', { password: 'password123' });
    const res = await handleAuthLogin(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const req = makeRequest('POST', '/auth/login', { email: 'a@b.com' });
    const res = await handleAuthLogin(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('returns 429 when email is locked', async () => {
    vi.mocked(checkLoginBruteForce).mockResolvedValue({
      locked: true,
      reason: 'Too many failed login attempts. Please try again in 15 minutes.',
    });
    const req = makeRequest('POST', '/auth/login', { email: 'user@test.com', password: 'pass' });
    const res = await handleAuthLogin(req, makeEnv(kv));
    expect(res.status).toBe(429);
  });

  it('returns 401 for non-existent user (generic message)', async () => {
    const req = makeRequest('POST', '/auth/login', { email: 'nobody@test.com', password: 'password123' });
    const res = await handleAuthLogin(req, makeEnv(kv));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid email or password/i);
  });

  it('returns 401 for wrong password (generic message)', async () => {
    const hash = await hashPassword('correct-password');
    kv._store.set('user:wrong@test.com', JSON.stringify({
      id: 'uid1', email: 'wrong@test.com', passwordHash: hash,
      role: 'client', created: Date.now(), galleries: [], verified: true,
    }));
    kv._store.set('users_list', JSON.stringify(['wrong@test.com']));
    const req = makeRequest('POST', '/auth/login', { email: 'wrong@test.com', password: 'wrong-password' });
    const res = await handleAuthLogin(req, makeEnv(kv));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid email or password/i);
  });

  it('calls recordLoginFailure on wrong password', async () => {
    const req = makeRequest('POST', '/auth/login', { email: 'nobody@test.com', password: 'pass' });
    await handleAuthLogin(req, makeEnv(kv));
    expect(vi.mocked(recordLoginFailure)).toHaveBeenCalledOnce();
  });

  it('returns 403 for unverified user', async () => {
    const hash = await hashPassword('mypassword');
    kv._store.set('user:unverified@test.com', JSON.stringify({
      id: 'uid2', email: 'unverified@test.com', passwordHash: hash,
      role: 'client', created: Date.now(), galleries: [], verified: false,
    }));
    kv._store.set('users_list', JSON.stringify(['unverified@test.com']));
    const req = makeRequest('POST', '/auth/login', { email: 'unverified@test.com', password: 'mypassword' });
    const res = await handleAuthLogin(req, makeEnv(kv));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.unverified).toBe(true);
  });

  it('returns 200 with token on successful login', async () => {
    const hash = await hashPassword('correct-pass');
    kv._store.set('user:user@test.com', JSON.stringify({
      id: 'uid3', email: 'user@test.com', passwordHash: hash,
      role: 'client', created: Date.now(), galleries: [], verified: true,
    }));
    kv._store.set('users_list', JSON.stringify(['user@test.com']));
    const req = makeRequest('POST', '/auth/login', { email: 'user@test.com', password: 'correct-pass' });
    const res = await handleAuthLogin(req, makeEnv(kv));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe('user@test.com');
  });

  it('clears brute-force counters on successful login', async () => {
    const hash = await hashPassword('correct-pass');
    kv._store.set('user@test.com', JSON.stringify({}));
    kv._store.set('user:user2@test.com', JSON.stringify({
      id: 'uid4', email: 'user2@test.com', passwordHash: hash,
      role: 'client', created: Date.now(), galleries: [], verified: true,
    }));
    kv._store.set('users_list', JSON.stringify(['user2@test.com']));
    const req = makeRequest('POST', '/auth/login', { email: 'user2@test.com', password: 'correct-pass' });
    await handleAuthLogin(req, makeEnv(kv));
    expect(vi.mocked(clearLoginCounters)).toHaveBeenCalledOnce();
  });
});

describe('handleAuthMe', () => {
  it('returns 401 when no auth header', async () => {
    const kv  = makeKv();
    const req = makeRequest('GET', '/auth/me', null);
    const res = await handleAuthMe(req, makeEnv(kv));
    expect(res.status).toBe(401);
  });

  it('returns 401 when user not found in KV', async () => {
    const kv    = makeKv();
    const token = await signToken({ sub: 'ghost@test.com', id: 'ghost', role: 'client' });
    const req   = makeRequest('GET', '/auth/me', null, token);
    const res   = await handleAuthMe(req, makeEnv(kv));
    expect(res.status).toBe(401);
  });

  it('returns 200 with user data for valid auth', async () => {
    const kv = makeKv();
    kv._store.set('user:me@test.com', JSON.stringify({
      id: 'me-id', email: 'me@test.com', role: 'admin',
    }));
    const token = await signToken({ sub: 'me@test.com', id: 'me-id', role: 'admin' });
    const req   = makeRequest('GET', '/auth/me', null, token);
    const res   = await handleAuthMe(req, makeEnv(kv));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe('me@test.com');
    expect(body.role).toBe('admin');
  });
});

describe('handleAuthVerify', () => {
  it('returns 400 when no token param', async () => {
    const kv  = makeKv();
    const req = new Request('https://worker.example.com/auth/verify');
    const res = await handleAuthVerify(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid/expired token', async () => {
    const kv  = makeKv();
    const req = new Request('https://worker.example.com/auth/verify?token=bad-token');
    const res = await handleAuthVerify(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('marks user verified on valid token', async () => {
    const kv = makeKv();
    kv._store.set('verify:valid-token', JSON.stringify({ email: 'new@test.com' }));
    kv._store.set('user:new@test.com', JSON.stringify({
      id: 'new-id', email: 'new@test.com', role: 'client',
      created: Date.now(), galleries: [], verified: false,
    }));
    kv._store.set('users_list', JSON.stringify(['new@test.com']));
    kv._store.set('user_id:new-id', 'new@test.com');
    const req = new Request('https://worker.example.com/auth/verify?token=valid-token');
    const res = await handleAuthVerify(req, makeEnv(kv));
    expect(res.status).toBe(200);
    const user = JSON.parse(kv._store.get('user:new@test.com'));
    expect(user.verified).toBe(true);
  });
});

describe('handleAuthResetRequest', () => {
  let kv;
  beforeEach(() => {
    kv = makeKv();
    vi.mocked(checkLoginBruteForce).mockResolvedValue({ locked: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('returns 400 when email is missing', async () => {
    const req = makeRequest('POST', '/auth/reset-request', {});
    const res = await handleAuthResetRequest(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('returns 200 even when rate limited (prevents enumeration)', async () => {
    vi.mocked(checkLoginBruteForce).mockResolvedValue({ locked: true, reason: 'locked' });
    const req = makeRequest('POST', '/auth/reset-request', { email: 'user@test.com' });
    const res = await handleAuthResetRequest(req, makeEnv(kv));
    expect(res.status).toBe(200);
  });
});

describe('handleAuthResetConfirm', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('returns 400 when token is missing', async () => {
    const req = makeRequest('POST', '/auth/reset-confirm', { password: 'newpassword' });
    const res = await handleAuthResetConfirm(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is too short', async () => {
    const req = makeRequest('POST', '/auth/reset-confirm', { token: 'tok', password: 'short' });
    const res = await handleAuthResetConfirm(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid/expired token', async () => {
    const req = makeRequest('POST', '/auth/reset-confirm', { token: 'bad-token', password: 'newpassword' });
    const res = await handleAuthResetConfirm(req, makeEnv(kv));
    expect(res.status).toBe(400);
  });

  it('resets password and clears admin lockout on valid token', async () => {
    kv._store.set('reset:good-token', JSON.stringify({ email: 'user@test.com' }));
    kv._store.set('user:user@test.com', JSON.stringify({
      id: 'uid', email: 'user@test.com', role: 'admin',
      passwordHash: 'old-hash', created: Date.now(), galleries: [],
    }));
    kv._store.set('users_list', JSON.stringify(['user@test.com']));
    kv._store.set('user_id:uid', 'user@test.com');
    kv._store.set('locked:user@test.com', '1');
    const req = makeRequest('POST', '/auth/reset-confirm', { token: 'good-token', password: 'newpassword' });
    const res = await handleAuthResetConfirm(req, makeEnv(kv));
    expect(res.status).toBe(200);
    expect(kv._store.has('locked:user@test.com')).toBe(false);
  });
});
