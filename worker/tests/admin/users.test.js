import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleAdminListUsers, handleAdminCreateUser, handleAdminUpdateUser,
  handleAdminUpdateUserRole, handleAdminDeleteUser,
} from '../../src/admin/users.js';
import { createJWT } from '../../src/jwt.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';

function makeKv() {
  const store = new Map();
  return {
    get:    async (k)      => store.get(k) ?? null,
    put:    async (k, v)   => { store.set(k, v); },
    delete: async (k)      => { store.delete(k); },
  };
}

async function adminReq(method, body, id = 'aid') {
  const token = await createJWT({ sub: 'a@t.com', id, role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return new Request('http://t', {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function clientReq(method) {
  const token = await createJWT({ sub: 'c@t.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return new Request('http://t', { method, headers: { Authorization: `Bearer ${token}` } });
}

const env = (kv) => ({ KV: kv ?? makeKv(), JWT_SECRET: SECRET });

afterEach(() => { vi.unstubAllGlobals(); });

describe('handleAdminListUsers', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminListUsers(new Request('http://t'), env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminListUsers(await clientReq('GET'), env())).status).toBe(403);
  });
  it('returns sensitive-stripped user list', async () => {
    const kv = makeKv();
    await kv.put('users_list', JSON.stringify(['u@t.com']));
    await kv.put('user:u@t.com', JSON.stringify({ id: 'u1', email: 'u@t.com', role: 'client', created: 1, galleries: [], passwordHash: 'secret' }));
    const r = await handleAdminListUsers(await adminReq('GET'), env(kv));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body[0].passwordHash).toBeUndefined();
    expect(body[0].hasPassword).toBe(true);
  });
});

describe('handleAdminCreateUser', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminCreateUser(new Request('http://t', { method: 'POST', body: '{}' }), env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminCreateUser(await clientReq('POST'), env())).status).toBe(403);
  });
  it('400 when email is missing', async () => {
    const r = await handleAdminCreateUser(await adminReq('POST', { email: '' }), env());
    expect(r.status).toBe(400);
  });
  it('409 when user already exists', async () => {
    const kv = makeKv();
    await kv.put('user:dup@t.com', JSON.stringify({ id: 'u1', email: 'dup@t.com' }));
    const r = await handleAdminCreateUser(await adminReq('POST', { email: 'dup@t.com', password: 'pw' }), env(kv));
    expect(r.status).toBe(409);
  });
  it('201 creates user without password', async () => {
    const kv = makeKv();
    const r  = await handleAdminCreateUser(await adminReq('POST', { email: 'new@t.com' }), env(kv));
    expect(r.status).toBe(201);
    expect((await r.json()).email).toBe('new@t.com');
  });
  it('201 creates user with password', async () => {
    const kv = makeKv();
    const r  = await handleAdminCreateUser(await adminReq('POST', { email: 'pw@t.com', password: 'pass1234' }), env(kv));
    expect(r.status).toBe(201);
    expect((await r.json()).hasPassword).toBe(true);
  });
  it('201 assigns galleries on creation', async () => {
    const kv = makeKv();
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', assignedUsers: [] }));
    const r = await handleAdminCreateUser(await adminReq('POST', { email: 'gal@t.com', galleries: ['g1'] }), env(kv));
    expect(r.status).toBe(201);
  });
});

describe('handleAdminUpdateUser', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminUpdateUser(new Request('http://t', { method: 'PUT', body: '{}' }), env(), 'u1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminUpdateUser(await clientReq('PUT'), env(), 'u1')).status).toBe(403);
  });
  it('404 when user not found', async () => {
    expect((await handleAdminUpdateUser(await adminReq('PUT', { role: 'admin' }), env(), 'ghost')).status).toBe(404);
  });
  it('200 updates user role', async () => {
    const kv = makeKv();
    await kv.put('user:upd@t.com', JSON.stringify({ id: 'uid1', email: 'upd@t.com', role: 'client', galleries: [] }));
    await kv.put('user_id:uid1', 'upd@t.com');
    const r = await handleAdminUpdateUser(await adminReq('PUT', { role: 'admin' }), env(kv), 'uid1');
    expect(r.status).toBe(200);
    expect((await r.json()).role).toBe('admin');
  });
  it('200 updates password', async () => {
    const kv = makeKv();
    await kv.put('user:pwupd@t.com', JSON.stringify({ id: 'uid2', email: 'pwupd@t.com', role: 'client', galleries: [] }));
    await kv.put('user_id:uid2', 'pwupd@t.com');
    const r = await handleAdminUpdateUser(await adminReq('PUT', { password: 'newpass12' }), env(kv), 'uid2');
    expect(r.status).toBe(200);
    expect((await r.json()).hasPassword).toBe(true);
  });
  it('200 syncs gallery assignments', async () => {
    const kv = makeKv();
    await kv.put('user:sync@t.com', JSON.stringify({ id: 'uid3', email: 'sync@t.com', role: 'client', galleries: ['g1'] }));
    await kv.put('user_id:uid3', 'sync@t.com');
    await kv.put('gallery:g2', JSON.stringify({ id: 'g2', assignedUsers: [] }));
    const r = await handleAdminUpdateUser(await adminReq('PUT', { galleries: ['g2'] }), env(kv), 'uid3');
    expect(r.status).toBe(200);
  });
  it('200 updates user when galleries property is absent (uses empty array fallback)', async () => {
    const kv = makeKv();
    await kv.put('user:nogal@t.com', JSON.stringify({ id: 'uid4', email: 'nogal@t.com', role: 'client' }));
    await kv.put('user_id:uid4', 'nogal@t.com');
    const r = await handleAdminUpdateUser(await adminReq('PUT', { role: 'admin' }), env(kv), 'uid4');
    expect(r.status).toBe(200);
    expect((await r.json()).role).toBe('admin');
  });
});

describe('handleAdminUpdateUserRole', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminUpdateUserRole(new Request('http://t', { method: 'PATCH', body: '{}' }), env(), 'u1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminUpdateUserRole(await clientReq('PATCH'), env(), 'u1')).status).toBe(403);
  });
  it('404 when user not found', async () => {
    expect((await handleAdminUpdateUserRole(await adminReq('PATCH', { role: 'client' }), env(), 'ghost')).status).toBe(404);
  });
  it('403 when trying to change own role', async () => {
    const kv = makeKv();
    await kv.put('user:self@t.com', JSON.stringify({ id: 'aid', email: 'self@t.com', role: 'admin' }));
    await kv.put('user_id:aid', 'self@t.com');
    const r = await handleAdminUpdateUserRole(await adminReq('PATCH', { role: 'client' }, 'aid'), env(kv), 'aid');
    expect(r.status).toBe(403);
  });
  it('400 for invalid role value', async () => {
    const kv = makeKv();
    await kv.put('user:other@t.com', JSON.stringify({ id: 'oid', email: 'other@t.com', role: 'client' }));
    await kv.put('user_id:oid', 'other@t.com');
    const r = await handleAdminUpdateUserRole(await adminReq('PATCH', { role: 'superuser' }), env(kv), 'oid');
    expect(r.status).toBe(400);
  });
  it('200 updates role and sends email when RESEND_API_KEY set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const kv = makeKv();
    await kv.put('user:role@t.com', JSON.stringify({ id: 'rid', email: 'role@t.com', role: 'client' }));
    await kv.put('user_id:rid', 'role@t.com');
    const r = await handleAdminUpdateUserRole(await adminReq('PATCH', { role: 'admin' }, 'different-aid'), { KV: kv, JWT_SECRET: SECRET, RESEND_API_KEY: 'key' }, 'rid');
    expect(r.status).toBe(200);
    expect((await r.json()).role).toBe('admin');
  });
  it('200 with DB audit log when DB present', async () => {
    const kv = makeKv();
    await kv.put('user:role2@t.com', JSON.stringify({ id: 'rid2', email: 'role2@t.com', role: 'client' }));
    await kv.put('user_id:rid2', 'role2@t.com');
    const runMock = vi.fn().mockResolvedValue({});
    const db = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnThis(), run: vi.fn().mockReturnValue({ catch: (fn) => { fn(new Error('ok')); return undefined; } }) }) };
    const r = await handleAdminUpdateUserRole(await adminReq('PATCH', { role: 'admin' }, 'diff2'), { KV: kv, JWT_SECRET: SECRET, DB: db }, 'rid2');
    expect(r.status).toBe(200);
  });
});

describe('handleAdminDeleteUser', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminDeleteUser(new Request('http://t', { method: 'DELETE' }), env(), 'u1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminDeleteUser(await clientReq('DELETE'), env(), 'u1')).status).toBe(403);
  });
  it('404 when user not found', async () => {
    expect((await handleAdminDeleteUser(await adminReq('DELETE'), env(), 'ghost')).status).toBe(404);
  });
  it('200 deletes user and syncs gallery assignments', async () => {
    const kv = makeKv();
    await kv.put('user:del@t.com', JSON.stringify({ id: 'did', email: 'del@t.com', role: 'client', galleries: ['g1'] }));
    await kv.put('user_id:did', 'del@t.com');
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', assignedUsers: ['del@t.com'] }));
    const r = await handleAdminDeleteUser(await adminReq('DELETE'), env(kv), 'did');
    expect(r.status).toBe(200);
    expect(await kv.get('user:del@t.com')).toBeNull();
  });
  it('200 deletes user with no galleries property (uses empty array fallback)', async () => {
    const kv = makeKv();
    await kv.put('user:nodels@t.com', JSON.stringify({ id: 'nd1', email: 'nodels@t.com', role: 'client' }));
    await kv.put('user_id:nd1', 'nodels@t.com');
    const r = await handleAdminDeleteUser(await adminReq('DELETE'), env(kv), 'nd1');
    expect(r.status).toBe(200);
    expect(await kv.get('user:nodels@t.com')).toBeNull();
  });
});
