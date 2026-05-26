/**
 * Integration: full auth flows through the router.
 *
 * Uses a real in-memory KV store and the router entry point so that the
 * complete register → verify → login → /auth/me lifecycle is exercised
 * end-to-end without mocking individual handlers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { handleRequest } from '../../src/router.js';
import { makeKv, makeEnv, req, SECRET, ORIGIN } from './helpers.js';

let env;

beforeEach(() => {
  env = makeEnv(makeKv());
});

async function post(path, body) {
  return handleRequest(req('POST', path, { body }), env);
}

async function get(path, token) {
  return handleRequest(req('GET', path, { token }), env);
}

describe('auth/setup-status', () => {
  it('reports unconfigured when no users exist', async () => {
    const r = await handleRequest(req('GET', '/auth/setup-status'), env);
    expect(r.status).toBe(200);
    expect((await r.json()).configured).toBe(false);
  });

  it('reports configured after setup', async () => {
    await post('/auth/setup', { email: 'admin@t.com', password: 'password123' });
    const r = await handleRequest(req('GET', '/auth/setup-status'), env);
    expect((await r.json()).configured).toBe(true);
  });
});

describe('auth/setup', () => {
  it('creates first admin account and returns token', async () => {
    const r = await post('/auth/setup', { email: 'admin@t.com', password: 'password123' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.token).toBeTruthy();
    expect(b.user.role).toBe('admin');
    expect(b.user.email).toBe('admin@t.com');
  });

  it('rejects second setup call (already configured)', async () => {
    await post('/auth/setup', { email: 'admin@t.com', password: 'password123' });
    const r = await post('/auth/setup', { email: 'other@t.com', password: 'password123' });
    expect(r.status).toBe(409);
  });

  it('400 on missing password', async () => {
    const r = await post('/auth/setup', { email: 'admin@t.com' });
    expect(r.status).toBe(400);
  });

  it('400 on password shorter than 8 chars', async () => {
    const r = await post('/auth/setup', { email: 'admin@t.com', password: 'short' });
    expect(r.status).toBe(400);
  });
});

describe('register → verify → login', () => {
  it('register returns ok and stores unverified user', async () => {
    const r = await post('/auth/register', { email: 'client@t.com', password: 'password123' });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    const stored = JSON.parse(await env.KV.get('user:client@t.com'));
    expect(stored.verified).toBe(false);
  });

  it('login before verify returns 403 unverified', async () => {
    await post('/auth/register', { email: 'client@t.com', password: 'password123' });
    const r = await post('/auth/login', { email: 'client@t.com', password: 'password123' });
    expect(r.status).toBe(403);
    expect((await r.json()).unverified).toBe(true);
  });

  it('409 when registering with existing email', async () => {
    await post('/auth/register', { email: 'dup@t.com', password: 'password123' });
    const r = await post('/auth/register', { email: 'dup@t.com', password: 'password123' });
    expect(r.status).toBe(409);
  });

  it('verify endpoint marks user verified and invalidates token', async () => {
    await post('/auth/register', { email: 'v@t.com', password: 'password123' });
    // Extract verify token from KV
    const kv = env.KV;
    const verifyKey = [...kv._store.keys()].find(k => k.startsWith('verify:'));
    const verifyToken = verifyKey.replace('verify:', '');

    const r = await handleRequest(
      req('GET', `/auth/verify?token=${verifyToken}`),
      env,
    );
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    // Token should be deleted from KV
    expect(await kv.get(verifyKey)).toBeNull();
    // User should now be verified
    const user = JSON.parse(await kv.get('user:v@t.com'));
    expect(user.verified).toBe(true);
  });

  it('full flow: register → verify → login → /auth/me', async () => {
    await post('/auth/register', { email: 'full@t.com', password: 'password123' });

    const kv = env.KV;
    const verifyKey = [...kv._store.keys()].find(k => k.startsWith('verify:'));
    const verifyToken = verifyKey.replace('verify:', '');
    await handleRequest(req('GET', `/auth/verify?token=${verifyToken}`), env);

    const loginRes = await post('/auth/login', { email: 'full@t.com', password: 'password123' });
    expect(loginRes.status).toBe(200);
    const { token } = await loginRes.json();
    expect(token).toBeTruthy();

    const meRes = await get('/auth/me', token);
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.email).toBe('full@t.com');
    expect(me.role).toBe('client');
  });
});

describe('auth/login', () => {
  it('401 on wrong password', async () => {
    await post('/auth/setup', { email: 'admin@t.com', password: 'password123' });
    const r = await post('/auth/login', { email: 'admin@t.com', password: 'wrongpassword' });
    expect(r.status).toBe(401);
  });

  it('401 for unknown email', async () => {
    const r = await post('/auth/login', { email: 'nobody@t.com', password: 'password123' });
    expect(r.status).toBe(401);
  });

  it('400 on missing fields', async () => {
    const r = await post('/auth/login', { email: 'admin@t.com' });
    expect(r.status).toBe(400);
  });
});

describe('auth/verify edge cases', () => {
  it('400 for missing token param', async () => {
    const r = await handleRequest(req('GET', '/auth/verify'), env);
    expect(r.status).toBe(400);
  });

  it('400 for unknown verify token', async () => {
    const r = await handleRequest(req('GET', '/auth/verify?token=bad-token'), env);
    expect(r.status).toBe(400);
  });
});

describe('auth/me', () => {
  it('401 when no token', async () => {
    const r = await handleRequest(req('GET', '/auth/me'), env);
    expect(r.status).toBe(401);
  });
});
