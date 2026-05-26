import { describe, it, expect, vi } from 'vitest';
import {
  handleAdminPackages, handleAdminPackageById,
  handlePublicProposal, handlePublicProposalAnalytics,
  handlePublicProposalSelect, handleAdminProjectProposals,
} from '../../src/admin/packages.js';
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

describe('handleAdminPackages', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminPackages(new Request('http://t'), 'GET', env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminPackages(await clientReq('GET'), 'GET', env())).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminPackages(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET })).status).toBe(503);
  });
  it('returns packages on GET', async () => {
    const r = await handleAdminPackages(await adminReq('GET'), 'GET', env(makeDb([{ id: 'pkg1' }])));
    expect(r.status).toBe(200);
    expect((await r.json()).length).toBe(1);
  });
  it('400 on POST when name missing', async () => {
    const r = await handleAdminPackages(await adminReq('POST', { name: '' }), 'POST', env());
    expect(r.status).toBe(400);
  });
  it('201 on POST with name', async () => {
    const r = await handleAdminPackages(await adminReq('POST', { name: 'Standard', base_price: 1000 }), 'POST', env());
    expect(r.status).toBe(201);
    expect((await r.json()).name).toBe('Standard');
  });
  it('201 on POST with base_price 0 uses 0 fallback', async () => {
    const r = await handleAdminPackages(await adminReq('POST', { name: 'Free', base_price: 0 }), 'POST', env());
    expect(r.status).toBe(201);
    expect((await r.json()).base_price).toBe(0);
  });
});

describe('handleAdminPackageById', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminPackageById(new Request('http://t', { method: 'PUT', body: '{}' }), 'PUT', env(), 'pkg1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminPackageById(await clientReq('PUT'), 'PUT', env(), 'pkg1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminPackageById(await adminReq('PUT', { name: 'x' }), 'PUT', { JWT_SECRET: SECRET }, 'pkg1')).status).toBe(503);
  });
  it('400 on PUT when no updatable fields', async () => {
    const r = await handleAdminPackageById(await adminReq('PUT', {}), 'PUT', env(), 'pkg1');
    expect(r.status).toBe(400);
  });
  it('200 on PUT with valid fields', async () => {
    const db   = makeDb([{ id: 'pkg1' }]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [{ id: 'pkg1', name: 'Updated' }] });
    const r = await handleAdminPackageById(
      await adminReq('PUT', { name: 'Updated', addons: [] }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'pkg1',
    );
    expect(r.status).toBe(200);
  });
  it('200 on PUT with base_price 0 and null addons covers fallback branches', async () => {
    const db   = makeDb([{ id: 'pkg1' }]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [{ id: 'pkg1', base_price: 0 }] });
    const r = await handleAdminPackageById(
      await adminReq('PUT', { base_price: 0, addons: null }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'pkg1',
    );
    expect(r.status).toBe(200);
    expect((await r.json()).base_price).toBe(0);
  });
  it('200 on DELETE', async () => {
    const r = await handleAdminPackageById(await adminReq('DELETE'), 'DELETE', env(), 'pkg1');
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
  it('returns fallback error object when update finds no matching row', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    const r = await handleAdminPackageById(
      await adminReq('PUT', { name: 'Ghost' }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'missing',
    );
    expect(r.status).toBe(200);
    expect((await r.json()).error).toBe('Not found');
  });
});

describe('handlePublicProposal', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicProposal(new Request('http://t'), {}, 'prop1')).status).toBe(503);
  });
  it('404 when proposal not found', async () => {
    const r = await handlePublicProposal(new Request('http://t'), { DB: makeDb([]) }, 'prop1');
    expect(r.status).toBe(404);
  });
  it('200 returns proposal with project and packages', async () => {
    const proposal = { id: 'prop1', project_id: 'p1', package_ids: '[]', view_count: 0, opened_at: '' };
    const db = makeDb([proposal]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [proposal] })     // proposals query
      .mockResolvedValueOnce({ results: [] })              // projects query (via .all)
      .mockResolvedValue({ results: [] });                 // packages query
    const r = await handlePublicProposal(new Request('http://t'), { DB: db }, 'prop1');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.proposal.id).toBe('prop1');
  });
  it('200 returns proposal with packages when package_ids set', async () => {
    const proposal = { id: 'prop1', project_id: 'p1', package_ids: '["pkg1"]', view_count: 0, opened_at: '' };
    const db = makeDb([proposal]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [proposal] })
      .mockResolvedValueOnce({ results: [{ id: 'p1', client_name: 'Alice' }] })
      .mockResolvedValue({ results: [{ id: 'pkg1', name: 'Standard' }] });
    const r = await handlePublicProposal(new Request('http://t'), { DB: db }, 'prop1');
    expect(r.status).toBe(200);
    expect((await r.json()).packages.length).toBe(1);
  });
  it('200 with view_count > 0 and opened_at already set', async () => {
    const proposal = { id: 'prop2', project_id: 'p1', package_ids: '[]', view_count: 5, opened_at: '2025-01-01T00:00:00.000Z' };
    const db = makeDb([proposal]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [proposal] })
      .mockResolvedValueOnce({ results: [{ id: 'p1', client_name: 'Bob' }] })
      .mockResolvedValue({ results: [] });
    const r = await handlePublicProposal(new Request('http://t'), { DB: db }, 'prop2');
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.proposal.view_count).toBe(6);
  });
  it('200 returns proposal with falsy package_ids (uses empty array fallback)', async () => {
    const proposal = { id: 'prop3', project_id: 'p1', package_ids: null, view_count: 0, opened_at: '' };
    const db = makeDb([proposal]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [proposal] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValue({ results: [] });
    const r = await handlePublicProposal(new Request('http://t'), { DB: db }, 'prop3');
    expect(r.status).toBe(200);
    expect((await r.json()).packages).toEqual([]);
  });
});

describe('handlePublicProposalAnalytics', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicProposalAnalytics(new Request('http://t', { method: 'POST', body: '{"seconds":10}' }), {}, 'p1')).status).toBe(503);
  });
  it('200 and updates time spent', async () => {
    const r = await handlePublicProposalAnalytics(
      new Request('http://t', { method: 'POST', body: '{"seconds":30}' }),
      { DB: makeDb() }, 'prop1',
    );
    expect(r.status).toBe(200);
  });
  it('200 when seconds is zero (no DB write)', async () => {
    const r = await handlePublicProposalAnalytics(
      new Request('http://t', { method: 'POST', body: '{"seconds":0}' }),
      { DB: makeDb() }, 'prop1',
    );
    expect(r.status).toBe(200);
  });
  it('200 when body is invalid JSON', async () => {
    const r = await handlePublicProposalAnalytics(
      new Request('http://t', { method: 'POST', body: 'not-json' }),
      { DB: makeDb() }, 'prop1',
    );
    expect(r.status).toBe(200);
  });
  it('200 when body is empty string (uses {} fallback)', async () => {
    const r = await handlePublicProposalAnalytics(
      new Request('http://t', { method: 'POST', body: '' }),
      { DB: makeDb() }, 'prop1',
    );
    expect(r.status).toBe(200);
  });
});

describe('handlePublicProposalSelect', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicProposalSelect(new Request('http://t', { method: 'POST', body: '{}' }), {}, 'p1')).status).toBe(503);
  });
  it('404 when proposal not found', async () => {
    const r = await handlePublicProposalSelect(new Request('http://t', { method: 'POST', body: '{}' }), { DB: makeDb([]) }, 'p1');
    expect(r.status).toBe(404);
  });
  it('400 when package not in allowed list', async () => {
    const proposal = { id: 'prop1', project_id: 'p1', package_ids: '["pkg1"]' };
    const r = await handlePublicProposalSelect(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ package_id: 'other' }) }),
      { DB: makeDb([proposal]) }, 'prop1',
    );
    expect(r.status).toBe(400);
  });
  it('200 on valid selection', async () => {
    const proposal = { id: 'prop1', project_id: 'p1', package_ids: '["pkg1"]' };
    const r = await handlePublicProposalSelect(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ package_id: 'pkg1', addons: [] }) }),
      { DB: makeDb([proposal]) }, 'prop1',
    );
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('approved');
  });
  it('400 when proposal has null package_ids (uses empty array fallback)', async () => {
    const proposal = { id: 'prop2', project_id: 'p1', package_ids: null };
    const r = await handlePublicProposalSelect(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ package_id: 'pkg1' }) }),
      { DB: makeDb([proposal]) }, 'prop2',
    );
    expect(r.status).toBe(400);
  });
});

describe('handleAdminProjectProposals', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminProjectProposals(new Request('http://t'), 'GET', env(), 'p1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminProjectProposals(await clientReq('GET'), 'GET', env(), 'p1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminProjectProposals(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET }, 'p1')).status).toBe(503);
  });
  it('returns proposals on GET', async () => {
    const r = await handleAdminProjectProposals(await adminReq('GET'), 'GET', env(makeDb([{ id: 'pr1' }])), 'p1');
    expect(r.status).toBe(200);
  });
  it('400 on POST when no package_ids', async () => {
    const r = await handleAdminProjectProposals(await adminReq('POST', { package_ids: [] }), 'POST', env(), 'p1');
    expect(r.status).toBe(400);
  });
  it('201 on POST with valid package_ids', async () => {
    const r = await handleAdminProjectProposals(
      await adminReq('POST', { package_ids: ['pkg1', 'pkg2'] }),
      'POST', env(), 'p1',
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.status).toBe('sent');
    expect(JSON.parse(b.package_ids).length).toBe(2);
  });
  it('400 on POST when package_ids is not an array (uses empty array fallback)', async () => {
    const r = await handleAdminProjectProposals(
      await adminReq('POST', { package_ids: 'not-an-array' }),
      'POST', env(), 'p1',
    );
    expect(r.status).toBe(400);
  });
});
