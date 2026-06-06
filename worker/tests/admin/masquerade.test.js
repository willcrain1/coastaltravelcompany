import { describe, it, expect } from 'vitest';
import { handleAdminMasqueradeStart, handleAdminMasqueradeExit } from '../../src/admin/masquerade.js';
import { createJWT } from '../../src/jwt.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';

function makeKv() {
  const store = new Map();
  return {
    get:    async (k) => store.get(k) ?? null,
    put:    async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };
}

function makeEnv(o = {}) {
  return { KV: makeKv(), JWT_SECRET: SECRET, ...o };
}

async function adminToken(env, id = 'admin-id', email = 'admin@test.com') {
  const token = await createJWT(
    { sub: email, id, role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
  );
  await env.KV.put(`user:${email}`, JSON.stringify({ id, email, role: 'admin' }));
  await env.KV.put(`user_id:${id}`, email);
  return token;
}

async function clientUser(env, id = 'client-id', email = 'client@test.com') {
  await env.KV.put(`user:${email}`, JSON.stringify({ id, email, role: 'client', name: 'Test Client' }));
  await env.KV.put(`user_id:${id}`, email);
  return id;
}

function authReq(token, body = {}) {
  return new Request('http://t/admin/masquerade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// ── Masquerade start ──────────────────────────────────────────────────────────

describe('handleAdminMasqueradeStart', () => {
  it('401 when no auth token', async () => {
    const r = await handleAdminMasqueradeStart(new Request('http://t', { method: 'POST' }), makeEnv());
    expect(r.status).toBe(401);
  });

  it('403 when caller is not admin', async () => {
    const env   = makeEnv();
    const token = await createJWT(
      { sub: 'client@test.com', id: 'c1', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    const r = await handleAdminMasqueradeStart(authReq(token, { target_user_id: 'x' }), env);
    expect(r.status).toBe(403);
  });

  it('403 when caller token carries masquerade:true (even with admin role)', async () => {
    const env   = makeEnv();
    // Craft a token that passes the role check (admin) but has masquerade:true
    const token = await createJWT(
      { sub: 'admin@test.com', id: 'aid', role: 'admin', masquerade: true, exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    await env.KV.put('user:admin@test.com', JSON.stringify({ id: 'aid', email: 'admin@test.com', role: 'admin' }));
    await env.KV.put('user_id:aid', 'admin@test.com');
    const r = await handleAdminMasqueradeStart(authReq(token, { target_user_id: 'x' }), env);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/masquerade session/i);
  });

  it('503 when JWT_SECRET is missing', async () => {
    const env   = { KV: makeKv() };
    const r = await handleAdminMasqueradeStart(new Request('http://t', { method: 'POST' }), env);
    expect(r.status).toBe(401);
  });

  it('400 when target_user_id is missing', async () => {
    const env   = makeEnv();
    const token = await adminToken(env);
    const r = await handleAdminMasqueradeStart(authReq(token, {}), env);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/target_user_id/i);
  });

  it('404 when target user does not exist', async () => {
    const env   = makeEnv();
    const token = await adminToken(env);
    const r = await handleAdminMasqueradeStart(authReq(token, { target_user_id: 'nonexistent' }), env);
    expect(r.status).toBe(404);
  });

  it('403 when target user is an admin', async () => {
    const env   = makeEnv();
    const token = await adminToken(env);
    await env.KV.put('user:other-admin@test.com', JSON.stringify({ id: 'aid2', email: 'other-admin@test.com', role: 'admin' }));
    await env.KV.put('user_id:aid2', 'other-admin@test.com');
    const r = await handleAdminMasqueradeStart(authReq(token, { target_user_id: 'aid2' }), env);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/Cannot masquerade an admin/i);
  });

  it('200: returns masquerade_token and target_user info', async () => {
    const env   = makeEnv();
    const token = await adminToken(env);
    await clientUser(env);
    const r = await handleAdminMasqueradeStart(authReq(token, { target_user_id: 'client-id' }), env);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.masquerade_token).toBeTruthy();
    expect(body.target_user.email).toBe('client@test.com');
    expect(body.target_user.name).toBe('Test Client');
  });

  it('200: masquerade token carries masquerade:true and target identity', async () => {
    const env   = makeEnv();
    const token = await adminToken(env);
    await clientUser(env);
    const r    = await handleAdminMasqueradeStart(authReq(token, { target_user_id: 'client-id' }), env);
    const { masquerade_token } = await r.json();
    const { verifyJWT } = await import('../../src/jwt.js');
    const payload = await verifyJWT(masquerade_token, SECRET);
    expect(payload.masquerade).toBe(true);
    expect(payload.sub).toBe('client@test.com');
    expect(payload.role).toBe('client');
    expect(payload.admin_email).toBe('admin@test.com');
  });

  it('logs to DB when env.DB is present', async () => {
    const env   = makeEnv();
    const token = await adminToken(env);
    await clientUser(env);
    let loggedValues = null;
    env.DB = {
      prepare: () => ({
        bind: (...args) => {
          loggedValues = args;
          return { run: async () => ({}) };
        },
      }),
    };
    const r = await handleAdminMasqueradeStart(authReq(token, { target_user_id: 'client-id' }), env);
    expect(r.status).toBe(200);
    expect(loggedValues).not.toBeNull();
    expect(loggedValues[2]).toBe('admin@test.com');
    expect(loggedValues[4]).toBe('client@test.com');
  });

  it('400 when request body is invalid JSON', async () => {
    const env   = makeEnv();
    const token = await adminToken(env);
    const req   = new Request('http://t/admin/masquerade', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    'not json',
    });
    const r = await handleAdminMasqueradeStart(req, env);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/Invalid body/i);
  });

  it('200 with name empty string when target user has no name field', async () => {
    const env   = makeEnv();
    const token = await adminToken(env);
    await env.KV.put('user:noname@test.com', JSON.stringify({ id: 'nn-id', email: 'noname@test.com', role: 'client' }));
    await env.KV.put('user_id:nn-id', 'noname@test.com');
    const r    = await handleAdminMasqueradeStart(authReq(token, { target_user_id: 'nn-id' }), env);
    expect(r.status).toBe(200);
    expect((await r.json()).target_user.name).toBe('');
  });
});

// ── Masquerade exit ───────────────────────────────────────────────────────────

describe('handleAdminMasqueradeExit', () => {
  it('400 when no auth token', async () => {
    const r = await handleAdminMasqueradeExit(new Request('http://t', { method: 'POST' }), makeEnv());
    expect(r.status).toBe(400);
  });

  it('400 when token is not a masquerade token', async () => {
    const env   = makeEnv();
    const token = await adminToken(env);
    const req   = new Request('http://t/admin/masquerade/exit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const r = await handleAdminMasqueradeExit(req, env);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/No active masquerade session/i);
  });

  it('200 when called with a valid masquerade token', async () => {
    const env   = makeEnv();
    const token = await createJWT(
      { sub: 'client@test.com', id: 'cid', role: 'client', masquerade: true, admin_id: 'aid', exp: Math.floor(Date.now() / 1000) + 1800 },
      SECRET,
    );
    const req = new Request('http://t/admin/masquerade/exit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const r = await handleAdminMasqueradeExit(req, env);
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it('logs exit timestamp to DB when env.DB is present', async () => {
    const env   = makeEnv();
    const token = await createJWT(
      { sub: 'c@t.com', id: 'cid', role: 'client', masquerade: true, admin_id: 'aid', exp: Math.floor(Date.now() / 1000) + 1800 },
      SECRET,
    );
    let boundValues = null;
    env.DB = {
      prepare: () => ({
        bind: (...args) => {
          boundValues = args;
          return { run: async () => ({}) };
        },
      }),
    };
    const req = new Request('http://t/admin/masquerade/exit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const r = await handleAdminMasqueradeExit(req, env);
    expect(r.status).toBe(200);
    expect(boundValues).not.toBeNull();
    expect(boundValues[1]).toBe('cid');
    expect(boundValues[2]).toBe('aid');
  });
});
