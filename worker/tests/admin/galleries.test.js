import { describe, it, expect, vi } from 'vitest';
import {
  handleAdminListGalleries, handleAdminCreateGallery,
  handleAdminUpdateGallery, handleAdminDeleteGallery,
} from '../../src/admin/galleries.js';
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

async function adminReq(method, body) {
  const token = await createJWT({ sub: 'a@t.com', id: 'aid', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
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

const unauthEnv = () => ({ KV: makeKv(), JWT_SECRET: SECRET });

describe('handleAdminListGalleries', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminListGalleries(new Request('http://t'), unauthEnv())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminListGalleries(await clientReq('GET'), unauthEnv())).status).toBe(403);
  });
  it('returns gallery list with sensitive fields stripped', async () => {
    const kv = makeKv();
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', eventName: 'E', passphrase: 'secret' }));
    await kv.put('galleries_list', JSON.stringify(['g1']));
    const r    = await handleAdminListGalleries(await adminReq('GET'), { KV: kv, JWT_SECRET: SECRET });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body[0].passphrase).toBeUndefined();
    expect(body[0].eventName).toBe('E');
  });
});

describe('handleAdminCreateGallery', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminCreateGallery(new Request('http://t', { method: 'POST', body: '{}' }), unauthEnv())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminCreateGallery(await clientReq('POST'), unauthEnv())).status).toBe(403);
  });
  it('201 creates gallery with auto-generated id when none provided', async () => {
    const kv = makeKv();
    const r  = await handleAdminCreateGallery(await adminReq('POST', { eventName: 'E' }), { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.id).toBeTruthy();
    expect(b.eventName).toBe('E');
  });
  it('201 uses provided id', async () => {
    const kv = makeKv();
    const r  = await handleAdminCreateGallery(await adminReq('POST', { id: 'custom-id', eventName: 'E' }), { KV: kv, JWT_SECRET: SECRET });
    expect((await r.json()).id).toBe('custom-id');
  });
});

describe('handleAdminUpdateGallery', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminUpdateGallery(new Request('http://t', { method: 'PUT', body: '{}' }), unauthEnv(), 'g1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminUpdateGallery(await clientReq('PUT'), unauthEnv(), 'g1')).status).toBe(403);
  });
  it('404 when gallery not found', async () => {
    const r = await handleAdminUpdateGallery(await adminReq('PUT', { eventName: 'New' }), unauthEnv(), 'nope');
    expect(r.status).toBe(404);
  });
  it('200 updates existing gallery', async () => {
    const kv = makeKv();
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', eventName: 'Old' }));
    const r = await handleAdminUpdateGallery(await adminReq('PUT', { eventName: 'New' }), { KV: kv, JWT_SECRET: SECRET }, 'g1');
    expect(r.status).toBe(200);
    expect((await r.json()).eventName).toBe('New');
  });
});

describe('handleAdminDeleteGallery', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminDeleteGallery(new Request('http://t', { method: 'DELETE' }), unauthEnv(), 'g1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminDeleteGallery(await clientReq('DELETE'), unauthEnv(), 'g1')).status).toBe(403);
  });
  it('200 deletes nonexistent gallery gracefully', async () => {
    const r = await handleAdminDeleteGallery(await adminReq('DELETE'), unauthEnv(), 'nope');
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
  it('200 deletes gallery and removes from assigned user galleries', async () => {
    const kv = makeKv();
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', assignedUsers: ['user@t.com'] }));
    await kv.put('user:user@t.com', JSON.stringify({ id: 'u1', email: 'user@t.com', galleries: ['g1'] }));
    const r = await handleAdminDeleteGallery(await adminReq('DELETE'), { KV: kv, JWT_SECRET: SECRET }, 'g1');
    expect(r.status).toBe(200);
    expect(await kv.get('gallery:g1')).toBeNull();
  });
  it('200 deletes gallery when assigned user has no KV record (skips user cleanup)', async () => {
    const kv = makeKv();
    await kv.put('gallery:g2', JSON.stringify({ id: 'g2', assignedUsers: ['ghost@t.com'] }));
    const r = await handleAdminDeleteGallery(await adminReq('DELETE'), { KV: kv, JWT_SECRET: SECRET }, 'g2');
    expect(r.status).toBe(200);
    expect(await kv.get('gallery:g2')).toBeNull();
  });
  it('200 deletes gallery with no assignedUsers property (uses empty array fallback)', async () => {
    const kv = makeKv();
    await kv.put('gallery:g3', JSON.stringify({ id: 'g3' }));
    const r = await handleAdminDeleteGallery(await adminReq('DELETE'), { KV: kv, JWT_SECRET: SECRET }, 'g3');
    expect(r.status).toBe(200);
  });
  it('200 deletes gallery and cleans up user with no galleries property (uses empty array fallback)', async () => {
    const kv = makeKv();
    await kv.put('gallery:g4', JSON.stringify({ id: 'g4', assignedUsers: ['u@t.com'] }));
    await kv.put('user:u@t.com', JSON.stringify({ id: 'u2', email: 'u@t.com' }));
    const r = await handleAdminDeleteGallery(await adminReq('DELETE'), { KV: kv, JWT_SECRET: SECRET }, 'g4');
    expect(r.status).toBe(200);
  });
  it('200 deletes gallery and removes R2 assets when ASSETS bound (single page)', async () => {
    const kv     = makeKv();
    const deleted = [];
    await kv.put('gallery:g5', JSON.stringify({ id: 'g5' }));
    const assets = {
      list:   vi.fn().mockResolvedValue({ objects: [{ key: 'galleries/g5/thumbs/1.jpg' }], truncated: false }),
      delete: vi.fn().mockImplementation((keys) => { deleted.push(...keys); }),
    };
    const r = await handleAdminDeleteGallery(await adminReq('DELETE'), { KV: kv, JWT_SECRET: SECRET, ASSETS: assets }, 'g5');
    expect(r.status).toBe(200);
    expect(assets.list).toHaveBeenCalledWith({ prefix: 'galleries/g5/', cursor: undefined, limit: 1000 });
    expect(deleted).toContain('galleries/g5/thumbs/1.jpg');
  });
  it('200 iterates R2 pages when listing is truncated', async () => {
    const kv = makeKv();
    await kv.put('gallery:g6', JSON.stringify({ id: 'g6' }));
    const assets = {
      list: vi.fn()
        .mockResolvedValueOnce({ objects: [{ key: 'galleries/g6/thumbs/1.jpg' }], truncated: true, cursor: 'cursor-next' })
        .mockResolvedValueOnce({ objects: [{ key: 'galleries/g6/thumbs/2.jpg' }], truncated: false }),
      delete: vi.fn(),
    };
    const r = await handleAdminDeleteGallery(await adminReq('DELETE'), { KV: kv, JWT_SECRET: SECRET, ASSETS: assets }, 'g6');
    expect(r.status).toBe(200);
    expect(assets.list).toHaveBeenCalledTimes(2);
    expect(assets.delete).toHaveBeenCalledTimes(2);
  });
});
