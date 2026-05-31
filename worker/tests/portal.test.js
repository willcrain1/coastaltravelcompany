import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handlePortalContracts, handlePortalGalleries, handleAdminProjectPortalLink,
  handlePublicProjectPortal, handleAdminProjectMessages, handlePortalMyProject,
} from '../src/portal.js';
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

function makeDb(rows = [], firstRow = null) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all:  vi.fn().mockResolvedValue({ results: rows }),
    run:  vi.fn().mockResolvedValue({}),
    first: vi.fn().mockResolvedValue(firstRow),
  };
  stmt.bind.mockReturnValue(stmt);
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

async function makeAuthReq(url, method, payload, body) {
  const token = await createJWT({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return new Request(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── handlePortalGalleries ─────────────────────────────────────────────────────

describe('handlePortalGalleries', () => {
  it('401 when not authenticated', async () => {
    const r = await handlePortalGalleries(new Request('http://t/portal/galleries'), { KV: makeKv(), JWT_SECRET: SECRET });
    expect(r.status).toBe(401);
  });
  it('401 when user not found in KV', async () => {
    const req = await makeAuthReq('http://t/portal/galleries', 'GET', { sub: 'ghost@t.com', role: 'client' });
    const r   = await handlePortalGalleries(req, { KV: makeKv(), JWT_SECRET: SECRET });
    expect(r.status).toBe(401);
  });
  it('returns gallery list with sensitive fields stripped', async () => {
    const kv = makeKv();
    await kv.put('user:client@t.com', JSON.stringify({ id: 'u1', email: 'client@t.com', role: 'client', galleries: ['g1'] }));
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', eventName: 'Shoot', passphrase: 'secret' }));
    const req = await makeAuthReq('http://t/portal/galleries', 'GET', { sub: 'client@t.com', role: 'client' });
    const r   = await handlePortalGalleries(req, { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.length).toBe(1);
    expect(body[0].passphrase).toBeUndefined();
    expect(body[0].eventName).toBe('Shoot');
  });
  it('returns empty array when user has no galleries', async () => {
    const kv = makeKv();
    await kv.put('user:empty@t.com', JSON.stringify({ id: 'u2', email: 'empty@t.com', role: 'client', galleries: [] }));
    const req = await makeAuthReq('http://t/portal/galleries', 'GET', { sub: 'empty@t.com', role: 'client' });
    const r   = await handlePortalGalleries(req, { KV: kv, JWT_SECRET: SECRET });
    expect((await r.json())).toEqual([]);
  });
  it('returns empty array when user.galleries is not set', async () => {
    const kv = makeKv();
    await kv.put('user:nogal@t.com', JSON.stringify({ id: 'u3', email: 'nogal@t.com', role: 'client' }));
    const req = await makeAuthReq('http://t/portal/galleries', 'GET', { sub: 'nogal@t.com', role: 'client' });
    const r   = await handlePortalGalleries(req, { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});

// ── handlePortalContracts ─────────────────────────────────────────────────────

describe('handlePortalContracts', () => {
  it('401 when not authenticated', async () => {
    const r = await handlePortalContracts(new Request('http://t/portal/contracts'), { DB: makeDb(), JWT_SECRET: SECRET });
    expect(r.status).toBe(401);
  });
  it('503 when DB not configured', async () => {
    const req = await makeAuthReq('http://t/portal/contracts', 'GET', { sub: 'c@t.com', role: 'client' });
    const r   = await handlePortalContracts(req, { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });
  it('200 returns contracts with public_url for authenticated user', async () => {
    const rows = [{ id: 'c1', title: 'Agreement', status: 'sent', signing_token: 'tok1', client_signed_at: '', admin_signed_at: '', created_at: '2026-01-01', property: 'Grand Palms', collection: 'Editorial Stay' }];
    const req  = await makeAuthReq('http://t/portal/contracts', 'GET', { sub: 'client@t.com', role: 'client' });
    const r    = await handlePortalContracts(req, { DB: makeDb(rows), JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.length).toBe(1);
    expect(body[0].title).toBe('Agreement');
    expect(body[0].public_url).toContain('contract.html#tok1');
  });
  it('200 returns empty array when user has no contracts', async () => {
    const req = await makeAuthReq('http://t/portal/contracts', 'GET', { sub: 'new@t.com', role: 'client' });
    const r   = await handlePortalContracts(req, { DB: makeDb([]), JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});

// ── handleAdminProjectPortalLink ──────────────────────────────────────────────

describe('handleAdminProjectPortalLink', () => {
  it('401 when not authenticated', async () => {
    const r = await handleAdminProjectPortalLink(new Request('http://t', { method: 'POST' }), { KV: makeKv(), JWT_SECRET: SECRET }, 'proj1');
    expect(r.status).toBe(401);
  });
  it('403 for non-admin', async () => {
    const req = await makeAuthReq('http://t', 'POST', { sub: 'c@t.com', role: 'client' });
    const r   = await handleAdminProjectPortalLink(req, { KV: makeKv(), JWT_SECRET: SECRET }, 'proj1');
    expect(r.status).toBe(403);
  });
  it('503 when DB not configured', async () => {
    const req = await makeAuthReq('http://t', 'POST', { sub: 'a@t.com', role: 'admin' });
    const r   = await handleAdminProjectPortalLink(req, { KV: makeKv(), JWT_SECRET: SECRET }, 'proj1');
    expect(r.status).toBe(503);
  });
  it('201 and returns portal link', async () => {
    const req = await makeAuthReq('http://t', 'POST', { sub: 'a@t.com', role: 'admin' });
    const db  = makeDb();
    const r   = await handleAdminProjectPortalLink(req, { KV: makeKv(), JWT_SECRET: SECRET, DB: db }, 'proj1');
    expect(r.status).toBe(201);
    expect((await r.json()).url).toContain('portal-project.html#');
  });
});

// ── handlePublicProjectPortal ─────────────────────────────────────────────────

describe('handlePublicProjectPortal', () => {
  it('503 when DB not configured', async () => {
    const r = await handlePublicProjectPortal(new Request('http://t/portal/project/tok'), 'GET', {}, 'tok');
    expect(r.status).toBe(503);
  });
  it('404 when token not found', async () => {
    const db = makeDb([]);
    const r  = await handlePublicProjectPortal(new Request('http://t/portal/project/tok'), 'GET', { DB: db }, 'tok');
    expect(r.status).toBe(404);
  });
  it('404 when project not found for token', async () => {
    const tokenStmt  = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [{ project_id: 'p1' }] }) };
    const projStmt   = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [] }) };
    tokenStmt.bind.mockReturnValue(tokenStmt);
    projStmt.bind.mockReturnValue(projStmt);
    let callCount = 0;
    const db = { prepare: vi.fn(() => callCount++ === 0 ? tokenStmt : projStmt) };
    const r  = await handlePublicProjectPortal(new Request('http://t/portal/project/tok'), 'GET', { DB: db }, 'tok');
    expect(r.status).toBe(404);
  });
  it('returns project data on valid GET', async () => {
    const proj = { id: 'p1', client_name: 'Alice', property: 'Bungalow', location: 'Miami', collection: 'Std', shoot_date: '', stage: 'Inquiry', created_at: '' };
    const stmt = {
      bind:  vi.fn().mockReturnThis(),
      all:   vi.fn()
        .mockResolvedValueOnce({ results: [{ project_id: 'p1' }] })
        .mockResolvedValueOnce({ results: [proj] })
        .mockResolvedValue({ results: [] }),
      run:   vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) };
    const r  = await handlePublicProjectPortal(new Request('http://t/portal/project/tok'), 'GET', { DB: db }, 'tok');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.project.client_name).toBe('Alice');
  });
  it('201 on POST with valid content', async () => {
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const stmt = {
      bind:  vi.fn().mockReturnThis(),
      all:   vi.fn()
        .mockResolvedValueOnce({ results: [{ project_id: 'p1' }] })
        .mockResolvedValueOnce({ results: [proj] }),
      run:   vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = new Request('http://t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Hi there' }) });
    const r   = await handlePublicProjectPortal(req, 'POST', { DB: db }, 'tok');
    expect(r.status).toBe(201);
  });
  it('201 on POST sends notification email when RESEND_API_KEY set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const stmt = {
      bind:  vi.fn().mockReturnThis(),
      all:   vi.fn()
        .mockResolvedValueOnce({ results: [{ project_id: 'p1' }] })
        .mockResolvedValueOnce({ results: [proj] }),
      run:   vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = new Request('http://t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Hi', sender_name: 'Alice' }) });
    const r   = await handlePublicProjectPortal(req, 'POST', { DB: db, RESEND_API_KEY: 'key' }, 'tok');
    expect(r.status).toBe(201);
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
  it('400 on POST with empty content', async () => {
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const stmt = {
      bind:  vi.fn().mockReturnThis(),
      all:   vi.fn()
        .mockResolvedValueOnce({ results: [{ project_id: 'p1' }] })
        .mockResolvedValueOnce({ results: [proj] }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = new Request('http://t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '' }) });
    const r   = await handlePublicProjectPortal(req, 'POST', { DB: db }, 'tok');
    expect(r.status).toBe(400);
  });
  it('201 on POST uses "Client" fallback when sender_name and client_name both absent', async () => {
    const proj = { id: 'p1', client_name: '', client_email: 'a@t.com' };
    const stmt = {
      bind:  vi.fn().mockReturnThis(),
      all:   vi.fn()
        .mockResolvedValueOnce({ results: [{ project_id: 'p1' }] })
        .mockResolvedValueOnce({ results: [proj] }),
      run:   vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = new Request('http://t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Hello' }) });
    const r   = await handlePublicProjectPortal(req, 'POST', { DB: db }, 'tok');
    expect(r.status).toBe(201);
    expect((await r.json()).sender_name).toBe('Client');
  });
  it('400 on POST with invalid JSON', async () => {
    const proj = { id: 'p1', client_name: 'Alice' };
    const stmt = {
      bind:  vi.fn().mockReturnThis(),
      all:   vi.fn()
        .mockResolvedValueOnce({ results: [{ project_id: 'p1' }] })
        .mockResolvedValueOnce({ results: [proj] }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = new Request('http://t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    const r   = await handlePublicProjectPortal(req, 'POST', { DB: db }, 'tok');
    expect(r.status).toBe(400);
  });
});

// ── handlePortalMyProject ─────────────────────────────────────────────────────

describe('handlePortalMyProject', () => {
  it('401 when not authenticated', async () => {
    const r = await handlePortalMyProject(new Request('http://t/portal/my-project'), 'GET', { JWT_SECRET: SECRET });
    expect(r.status).toBe(401);
  });
  it('503 when DB not configured', async () => {
    const req = await makeAuthReq('http://t/portal/my-project', 'GET', { sub: 'c@t.com', role: 'client' });
    const r   = await handlePortalMyProject(req, 'GET', { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });
  it('GET returns { project: null } when no project exists', async () => {
    const req = await makeAuthReq('http://t/portal/my-project', 'GET', { sub: 'c@t.com', role: 'client' });
    const r   = await handlePortalMyProject(req, 'GET', { DB: makeDb([]), JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    expect((await r.json()).project).toBeNull();
  });
  it('GET returns token and project when project and token exist', async () => {
    const proj = { id: 'p1', client_name: 'Alice', property: 'Bungalow', location: 'Miami', collection: 'Std', shoot_date: '', stage: 'Inquiry' };
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn()
        .mockResolvedValueOnce({ results: [proj] })
        .mockResolvedValueOnce({ results: [{ id: 'tok1' }] }),
      run: vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = await makeAuthReq('http://t/portal/my-project', 'GET', { sub: 'c@t.com', role: 'client' });
    const r   = await handlePortalMyProject(req, 'GET', { DB: db, JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.token).toBe('tok1');
    expect(body.project.property).toBe('Bungalow');
  });
  it('GET creates portal token when none exists', async () => {
    const proj = { id: 'p1', client_name: 'Alice', property: 'Bungalow', location: '', collection: '', shoot_date: '', stage: 'Inquiry' };
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn()
        .mockResolvedValueOnce({ results: [proj] })
        .mockResolvedValueOnce({ results: [] }),
      run: vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = await makeAuthReq('http://t/portal/my-project', 'GET', { sub: 'c@t.com', role: 'client' });
    const r   = await handlePortalMyProject(req, 'GET', { DB: db, JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body.token).toBe('string');
    expect(stmt.run).toHaveBeenCalled();
  });
  it('POST 503 when DB not configured', async () => {
    const req = await makeAuthReq('http://t/portal/my-project', 'POST', { sub: 'c@t.com', role: 'client' }, { property: 'Test' });
    const r   = await handlePortalMyProject(req, 'POST', { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });
  it('POST 409 when project already exists', async () => {
    const req = await makeAuthReq('http://t/portal/my-project', 'POST', { sub: 'c@t.com', role: 'client' }, { property: 'Test' });
    const r   = await handlePortalMyProject(req, 'POST', { DB: makeDb([{ id: 'p1' }]), JWT_SECRET: SECRET });
    expect(r.status).toBe(409);
  });
  it('POST 400 when property is missing', async () => {
    const req = await makeAuthReq('http://t/portal/my-project', 'POST', { sub: 'c@t.com', role: 'client' }, { location: 'Miami' });
    const r   = await handlePortalMyProject(req, 'POST', { DB: makeDb([]), JWT_SECRET: SECRET });
    expect(r.status).toBe(400);
  });
  it('POST 400 on invalid JSON', async () => {
    const token = await createJWT({ sub: 'c@t.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const request = new Request('http://t/portal/my-project', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const r = await handlePortalMyProject(request, 'POST', { DB: makeDb([]), JWT_SECRET: SECRET });
    expect(r.status).toBe(400);
  });
  it('POST 201 creates project and returns token', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValueOnce({ results: [] }),
      run: vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = await makeAuthReq('http://t/portal/my-project', 'POST', { sub: 'c@t.com', role: 'client' }, { property: 'Bungalow', location: 'Miami' });
    const r   = await handlePortalMyProject(req, 'POST', { DB: db, JWT_SECRET: SECRET });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(typeof body.token).toBe('string');
    expect(body.project.property).toBe('Bungalow');
    expect(body.project.stage).toBe('Inquiry');
  });
  it('POST 201 stores initial message when provided', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValueOnce({ results: [] }),
      run: vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = await makeAuthReq('http://t/portal/my-project', 'POST', { sub: 'c@t.com', role: 'client' }, { property: 'Villa', message: 'Looking forward to it!' });
    const r   = await handlePortalMyProject(req, 'POST', { DB: db, JWT_SECRET: SECRET });
    expect(r.status).toBe(201);
    // INSERT for project + token + message = 3 run() calls
    expect(stmt.run).toHaveBeenCalledTimes(3);
  });
  it('POST 201 sends notification email when RESEND_API_KEY set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValueOnce({ results: [] }),
      run: vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db  = { prepare: vi.fn().mockReturnValue(stmt) };
    const req = await makeAuthReq('http://t/portal/my-project', 'POST', { sub: 'c@t.com', role: 'client' }, { property: 'Villa' });
    const r   = await handlePortalMyProject(req, 'POST', { DB: db, JWT_SECRET: SECRET, RESEND_API_KEY: 'key' });
    expect(r.status).toBe(201);
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
});

// ── handleAdminProjectMessages ────────────────────────────────────────────────

describe('handleAdminProjectMessages', () => {
  it('401 when not authenticated', async () => {
    const r = await handleAdminProjectMessages(new Request('http://t'), 'GET', { KV: makeKv(), JWT_SECRET: SECRET }, 'p1');
    expect(r.status).toBe(401);
  });
  it('403 for non-admin', async () => {
    const req = await makeAuthReq('http://t', 'GET', { sub: 'c@t.com', role: 'client' });
    const r   = await handleAdminProjectMessages(req, 'GET', { KV: makeKv(), JWT_SECRET: SECRET }, 'p1');
    expect(r.status).toBe(403);
  });
  it('503 when DB not configured', async () => {
    const req = await makeAuthReq('http://t', 'GET', { sub: 'a@t.com', role: 'admin' });
    const r   = await handleAdminProjectMessages(req, 'GET', { KV: makeKv(), JWT_SECRET: SECRET }, 'p1');
    expect(r.status).toBe(503);
  });
  it('200 returns messages on GET', async () => {
    const req = await makeAuthReq('http://t', 'GET', { sub: 'a@t.com', role: 'admin' });
    const db  = makeDb([{ id: 'm1', content: 'Hello' }]);
    const r   = await handleAdminProjectMessages(req, 'GET', { KV: makeKv(), JWT_SECRET: SECRET, DB: db }, 'p1');
    expect(r.status).toBe(200);
    expect((await r.json()).length).toBe(1);
  });
  it('201 posts a new message', async () => {
    const req = await makeAuthReq('http://t', 'POST', { sub: 'a@t.com', role: 'admin' }, { content: 'Hello client' });
    const db  = makeDb();
    const r   = await handleAdminProjectMessages(req, 'POST', { KV: makeKv(), JWT_SECRET: SECRET, DB: db }, 'p1');
    expect(r.status).toBe(201);
    expect((await r.json()).sender).toBe('admin');
  });
  it('400 when POST content is empty', async () => {
    const req = await makeAuthReq('http://t', 'POST', { sub: 'a@t.com', role: 'admin' }, { content: '' });
    const db  = makeDb();
    const r   = await handleAdminProjectMessages(req, 'POST', { KV: makeKv(), JWT_SECRET: SECRET, DB: db }, 'p1');
    expect(r.status).toBe(400);
  });
});
