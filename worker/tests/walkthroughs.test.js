import { describe, it, expect, vi } from 'vitest';
import { handlePublicWalkthroughs, handleAdminWalkthroughs, handleAdminWalkthroughById } from '../src/walkthroughs.js';
import { createJWT } from '../src/jwt.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';

function makeDb(rows = [], firstRow = null) {
  const stmt = {
    bind:  vi.fn().mockReturnThis(),
    all:   vi.fn().mockResolvedValue({ results: rows }),
    run:   vi.fn().mockResolvedValue({}),
    first: vi.fn().mockResolvedValue(firstRow),
  };
  stmt.bind.mockReturnValue(stmt);
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

async function adminReq(method, body) {
  const token = await createJWT({ sub: 'a@t.com', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
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

describe('handlePublicWalkthroughs', () => {
  it('returns published walkthroughs', async () => {
    const db = makeDb([{ id: 'w1', title: 'Tour' }]);
    const r  = await handlePublicWalkthroughs(new Request('http://t'), { DB: db, JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    expect((await r.json()).length).toBe(1);
  });
  it('returns empty array when none published', async () => {
    const db = makeDb([]);
    const r  = await handlePublicWalkthroughs(new Request('http://t'), { DB: db, JWT_SECRET: SECRET });
    expect((await r.json())).toEqual([]);
  });
  it('returns empty array when DB returns no results property', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({});
    const r = await handlePublicWalkthroughs(new Request('http://t'), { DB: db, JWT_SECRET: SECRET });
    expect((await r.json())).toEqual([]);
  });
});

describe('handleAdminWalkthroughs', () => {
  it('401 when not authenticated', async () => {
    expect((await handleAdminWalkthroughs(new Request('http://t'), { JWT_SECRET: SECRET, DB: makeDb() })).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    const r = await handleAdminWalkthroughs(await clientReq('GET'), { JWT_SECRET: SECRET, DB: makeDb() });
    expect(r.status).toBe(403);
  });
  it('returns list on GET', async () => {
    const db = makeDb([{ id: 'w1' }]);
    const r  = await handleAdminWalkthroughs(await adminReq('GET'), { JWT_SECRET: SECRET, DB: db });
    expect(r.status).toBe(200);
    expect((await r.json()).length).toBe(1);
  });
  it('returns empty array on GET when DB returns no results property', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({});
    const r = await handleAdminWalkthroughs(await adminReq('GET'), { JWT_SECRET: SECRET, DB: db });
    expect(r.status).toBe(200);
    expect((await r.json())).toEqual([]);
  });
  it('201 on POST creates walkthrough (minimal)', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.first.mockResolvedValue({ id: 'w2', title: 'New' });
    const r = await handleAdminWalkthroughs(await adminReq('POST', { title: 'New', embed_url: 'https://matterport.com/x' }), { JWT_SECRET: SECRET, DB: db });
    expect(r.status).toBe(201);
  });
  it('201 on POST creates walkthrough (no title, no embed_url)', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.first.mockResolvedValue({ id: 'w_bare' });
    const r = await handleAdminWalkthroughs(await adminReq('POST', {}), { JWT_SECRET: SECRET, DB: db });
    expect(r.status).toBe(201);
  });
  it('201 on POST creates walkthrough (all fields)', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.first.mockResolvedValue({ id: 'w3', title: 'Full' });
    const r = await handleAdminWalkthroughs(await adminReq('POST', {
      title: 'Full Tour', property_name: 'Beach House', location: 'Malibu',
      description: 'Amazing views', embed_url: 'https://matterport.com/y',
      thumbnail_url: 'https://cdn.x.com/thumb.jpg', collection: 'coastal',
      sort_order: 3, published: true,
    }), { JWT_SECRET: SECRET, DB: db });
    expect(r.status).toBe(201);
  });
  it('405 for unsupported method', async () => {
    const r = await handleAdminWalkthroughs(await adminReq('DELETE'), { JWT_SECRET: SECRET, DB: makeDb() });
    expect(r.status).toBe(405);
  });
});

describe('handleAdminWalkthroughById', () => {
  it('401 when not authenticated', async () => {
    expect((await handleAdminWalkthroughById(new Request('http://t'), { JWT_SECRET: SECRET, DB: makeDb() }, 'w1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    const r = await handleAdminWalkthroughById(await clientReq('PUT'), { JWT_SECRET: SECRET, DB: makeDb() }, 'w1');
    expect(r.status).toBe(403);
  });
  it('404 on PUT when not found', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.first.mockResolvedValue(null);
    const r = await handleAdminWalkthroughById(await adminReq('PUT', { title: 'X' }), { JWT_SECRET: SECRET, DB: db }, 'w1');
    expect(r.status).toBe(404);
  });
  it('200 on PUT when found (minimal)', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.first.mockResolvedValueOnce({ id: 'w1' }).mockResolvedValue({ id: 'w1', title: 'Updated' });
    const r = await handleAdminWalkthroughById(await adminReq('PUT', { title: 'Updated', embed_url: 'https://x.com' }), { JWT_SECRET: SECRET, DB: db }, 'w1');
    expect(r.status).toBe(200);
  });
  it('200 on PUT with no title/embed_url (uses empty defaults)', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.first.mockResolvedValueOnce({ id: 'w1' }).mockResolvedValue({ id: 'w1' });
    const r = await handleAdminWalkthroughById(await adminReq('PUT', {}), { JWT_SECRET: SECRET, DB: db }, 'w1');
    expect(r.status).toBe(200);
  });
  it('200 on PUT when found (all fields)', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.first.mockResolvedValueOnce({ id: 'w1' }).mockResolvedValue({ id: 'w1', title: 'Full', published: 1 });
    const r = await handleAdminWalkthroughById(await adminReq('PUT', {
      title: 'Full Tour', property_name: 'House', location: 'LA',
      description: 'Nice', embed_url: 'https://matterport.com/z',
      thumbnail_url: 'https://cdn.x.com/t.jpg', collection: 'luxury',
      sort_order: 5, published: true,
    }), { JWT_SECRET: SECRET, DB: db }, 'w1');
    expect(r.status).toBe(200);
  });
  it('200 on DELETE', async () => {
    const r = await handleAdminWalkthroughById(await adminReq('DELETE'), { JWT_SECRET: SECRET, DB: makeDb() }, 'w1');
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
  it('405 for unsupported method', async () => {
    const r = await handleAdminWalkthroughById(await adminReq('PATCH'), { JWT_SECRET: SECRET, DB: makeDb() }, 'w1');
    expect(r.status).toBe(405);
  });
});
