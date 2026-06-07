import { describe, it, expect, vi } from 'vitest';
import { handleAdminProjects, handleAdminProjectById, handleAdminProjectNotes, handleAdminProjectDocuments } from '../../src/admin/projects.js';
import { createJWT } from '../../src/jwt.js';

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

const env = (db) => ({ JWT_SECRET: SECRET, DB: db ?? makeDb() });

describe('handleAdminProjects', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminProjects(new Request('http://t'), 'GET', env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminProjects(await clientReq('GET'), 'GET', env())).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminProjects(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET })).status).toBe(503);
  });
  it('returns project list on GET', async () => {
    const r = await handleAdminProjects(await adminReq('GET'), 'GET', env(makeDb([{ id: 'p1', stage: 'Inquiry' }])));
    expect(r.status).toBe(200);
    expect((await r.json()).length).toBe(1);
  });
  it('201 creates project on POST', async () => {
    const r = await handleAdminProjects(
      await adminReq('POST', { client_name: 'Alice', client_email: 'a@t.com' }),
      'POST', env(),
    );
    expect(r.status).toBe(201);
    expect((await r.json()).client_name).toBe('Alice');
  });
  it('400 on POST when client_name or client_email missing', async () => {
    const r = await handleAdminProjects(await adminReq('POST', { client_name: '' }), 'POST', env());
    expect(r.status).toBe(400);
  });
});

describe('handleAdminProjectById', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminProjectById(new Request('http://t', { method: 'PUT', body: '{}' }), 'PUT', env(), 'p1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminProjectById(await clientReq('PUT'), 'PUT', env(), 'p1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminProjectById(await adminReq('PUT', { stage: 'x' }), 'PUT', { JWT_SECRET: SECRET }, 'p1')).status).toBe(503);
  });
  it('400 on PUT when no fields provided', async () => {
    const r = await handleAdminProjectById(await adminReq('PUT', {}), 'PUT', env(), 'p1');
    expect(r.status).toBe(400);
  });
  it('200 on PUT with valid fields', async () => {
    const db   = makeDb([{ id: 'p1', stage: 'Inquiry', updated_at: '' }]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [{ id: 'p1', stage: 'Active' }] });
    const r = await handleAdminProjectById(await adminReq('PUT', { stage: 'Active' }), 'PUT', { JWT_SECRET: SECRET, DB: db }, 'p1');
    expect(r.status).toBe(200);
  });
  it('200 on PUT returns fallback error object when no row found after update', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    const r = await handleAdminProjectById(await adminReq('PUT', { stage: 'Active' }), 'PUT', { JWT_SECRET: SECRET, DB: db }, 'ghost');
    expect(r.status).toBe(200);
    expect((await r.json()).error).toBe('Not found');
  });
  it('200 on DELETE', async () => {
    const r = await handleAdminProjectById(await adminReq('DELETE'), 'DELETE', env(), 'p1');
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
});

describe('handleAdminProjectNotes', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminProjectNotes(new Request('http://t'), 'GET', env(), 'p1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminProjectNotes(await clientReq('GET'), 'GET', env(), 'p1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminProjectNotes(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET }, 'p1')).status).toBe(503);
  });
  it('returns notes list on GET', async () => {
    const r = await handleAdminProjectNotes(await adminReq('GET'), 'GET', env(makeDb([{ id: 'n1', content: 'note' }])), 'p1');
    expect(r.status).toBe(200);
  });
  it('201 creates note on POST', async () => {
    const r = await handleAdminProjectNotes(await adminReq('POST', { content: 'New note' }), 'POST', env(), 'p1');
    expect(r.status).toBe(201);
    expect((await r.json()).content).toBe('New note');
  });
  it('400 on POST when content missing', async () => {
    const r = await handleAdminProjectNotes(await adminReq('POST', { content: '' }), 'POST', env(), 'p1');
    expect(r.status).toBe(400);
  });
});

describe('handleAdminProjectDocuments', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminProjectDocuments(new Request('http://t'), 'GET', env(), 'p1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminProjectDocuments(await clientReq('GET'), 'GET', env(), 'p1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminProjectDocuments(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET }, 'p1')).status).toBe(503);
  });
  it('returns documents on GET', async () => {
    const r = await handleAdminProjectDocuments(await adminReq('GET'), 'GET', env(makeDb([{ id: 'd1' }])), 'p1');
    expect(r.status).toBe(200);
  });
  it('201 creates document on POST', async () => {
    const r = await handleAdminProjectDocuments(
      await adminReq('POST', { type: 'invoice', title: 'INV-001', url: 'https://x.com' }),
      'POST', env(), 'p1',
    );
    expect(r.status).toBe(201);
  });
  it('400 on POST when required fields missing', async () => {
    const r = await handleAdminProjectDocuments(await adminReq('POST', { type: '' }), 'POST', env(), 'p1');
    expect(r.status).toBe(400);
  });
  it('400 on POST when title present but url missing', async () => {
    const r = await handleAdminProjectDocuments(
      await adminReq('POST', { type: 'invoice', title: 'INV-001', url: '' }),
      'POST', env(), 'p1',
    );
    expect(r.status).toBe(400);
  });
  it('201 on POST when type is absent uses "proposal" fallback', async () => {
    const r = await handleAdminProjectDocuments(
      await adminReq('POST', { title: 'Contract', url: 'https://x.com' }),
      'POST', env(), 'p1',
    );
    expect(r.status).toBe(201);
    expect((await r.json()).type).toBe('proposal');
  });
});
