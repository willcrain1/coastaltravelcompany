import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleAdminContractTemplates, handleAdminContractTemplateById,
  handleAdminProjectContracts, handleAdminProjectContractCountersign,
  handlePublicContractGet, handlePublicContractView,
  handlePublicContractSign, handlePublicContractAudit,
} from '../../src/admin/contracts.js';
import { createJWT } from '../../src/jwt.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';

function makeDb(rows = []) {
  const stmt = {
    bind:  vi.fn().mockReturnThis(),
    all:   vi.fn().mockResolvedValue({ results: rows }),
    run:   vi.fn().mockResolvedValue({}),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
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

afterEach(() => { vi.unstubAllGlobals(); });

describe('handleAdminContractTemplates', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminContractTemplates(new Request('http://t'), 'GET', env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminContractTemplates(await clientReq('GET'), 'GET', env())).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminContractTemplates(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET })).status).toBe(503);
  });
  it('returns templates on GET', async () => {
    const r = await handleAdminContractTemplates(await adminReq('GET'), 'GET', env(makeDb([{ id: 'ct1' }])));
    expect(r.status).toBe(200);
  });
  it('400 on POST when name missing', async () => {
    const r = await handleAdminContractTemplates(await adminReq('POST', { name: '' }), 'POST', env());
    expect(r.status).toBe(400);
  });
  it('201 on POST with name', async () => {
    const r = await handleAdminContractTemplates(
      await adminReq('POST', { name: 'Standard Contract', collection_type: 'travel', body: 'Terms...' }),
      'POST', env(),
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.name).toBe('Standard Contract');
    expect(b.collection_type).toBe('travel');
  });
  it('201 on POST with defaults for optional fields', async () => {
    const r = await handleAdminContractTemplates(
      await adminReq('POST', { name: 'Minimal' }),
      'POST', env(),
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.collection_type).toBe('');
    expect(b.body).toBe('');
  });
});

describe('handleAdminContractTemplateById', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminContractTemplateById(new Request('http://t', { method: 'PUT', body: '{}' }), 'PUT', env(), 'ct1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminContractTemplateById(await clientReq('PUT'), 'PUT', env(), 'ct1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminContractTemplateById(await adminReq('PUT', { name: 'x' }), 'PUT', { JWT_SECRET: SECRET }, 'ct1')).status).toBe(503);
  });
  it('400 on PUT when no fields to update', async () => {
    const r = await handleAdminContractTemplateById(await adminReq('PUT', {}), 'PUT', env(), 'ct1');
    expect(r.status).toBe(400);
  });
  it('200 on PUT with valid fields', async () => {
    const db   = makeDb([{ id: 'ct1', name: 'Updated' }]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [{ id: 'ct1', name: 'Updated' }] });
    const r = await handleAdminContractTemplateById(
      await adminReq('PUT', { name: 'Updated', body: 'New body' }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'ct1',
    );
    expect(r.status).toBe(200);
  });
  it('200 on DELETE', async () => {
    const r = await handleAdminContractTemplateById(await adminReq('DELETE'), 'DELETE', env(), 'ct1');
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
  it('returns fallback error object when update finds no matching row', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    const r = await handleAdminContractTemplateById(
      await adminReq('PUT', { name: 'Ghost' }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'missing',
    );
    expect(r.status).toBe(200);
    expect((await r.json()).error).toBe('Not found');
  });
});

describe('handleAdminProjectContracts', () => {
  const adminPrincipal = { email: 'a@t.com', role: 'admin' };

  it('503 when DB missing', async () => {
    const r = await handleAdminProjectContracts(new Request('http://t'), 'GET', {}, 'p1', adminPrincipal);
    expect(r.status).toBe(503);
  });
  it('returns contracts on GET', async () => {
    const r = await handleAdminProjectContracts(new Request('http://t'), 'GET', { DB: makeDb([{ id: 'c1' }]) }, 'p1', adminPrincipal);
    expect(r.status).toBe(200);
  });
  it('400 on POST when title or contract_body missing', async () => {
    const r = await handleAdminProjectContracts(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ title: 'T' }) }),
      'POST', { DB: makeDb() }, 'p1', adminPrincipal,
    );
    expect(r.status).toBe(400);
  });
  it('404 on POST when project not found', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    const r = await handleAdminProjectContracts(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ title: 'T', contract_body: 'Body' }) }),
      'POST', { DB: db }, 'p1', adminPrincipal,
    );
    expect(r.status).toBe(404);
  });
  it('201 on POST creates contract and sends email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [proj] });
    const r = await handleAdminProjectContracts(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ title: 'Contract', contract_body: 'Terms' }) }),
      'POST', { DB: db, RESEND_API_KEY: 'key' }, 'p1', adminPrincipal,
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.title).toBe('Contract');
    expect(b.public_url).toContain('/contract.html#');
    expect(b.status).toBe('sent');
  });
  it('201 skips email when no RESEND_API_KEY', async () => {
    const proj = { id: 'p1', client_name: 'Bob', client_email: 'b@t.com' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [proj] });
    const r = await handleAdminProjectContracts(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ title: 'C', contract_body: 'B' }) }),
      'POST', { DB: db }, 'p1', adminPrincipal,
    );
    expect(r.status).toBe(201);
  });
  it('201 with template_id and merge_fields set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [proj] });
    const r = await handleAdminProjectContracts(
      new Request('http://t', { method: 'POST', body: JSON.stringify({
        title: 'Contract', contract_body: 'Terms',
        template_id: 'tmpl1', merge_fields: { name: 'Alice' },
      }) }),
      'POST', { DB: db, RESEND_API_KEY: 'key' }, 'p1', adminPrincipal,
    );
    expect(r.status).toBe(201);
  });
  it('201 with RESEND_API_KEY but no client_email (no email sent)', async () => {
    const proj = { id: 'p1', client_name: 'NoEmail', client_email: '' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [proj] });
    const r = await handleAdminProjectContracts(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ title: 'C', contract_body: 'B' }) }),
      'POST', { DB: db, RESEND_API_KEY: 'key' }, 'p1', adminPrincipal,
    );
    expect(r.status).toBe(201);
  });
  it('201 when project has no client_name (uses empty string fallback)', async () => {
    const proj = { id: 'p1', client_name: '', client_email: '' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [proj] });
    const r = await handleAdminProjectContracts(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ title: 'C', contract_body: 'B' }) }),
      'POST', { DB: db }, 'p1', adminPrincipal,
    );
    expect(r.status).toBe(201);
    expect((await r.json()).client_name).toBe('');
  });
  it('201 when principal has no email (uses empty string fallback in signing event)', async () => {
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [proj] });
    const r = await handleAdminProjectContracts(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ title: 'C', contract_body: 'B' }) }),
      'POST', { DB: db }, 'p1', { role: 'admin' },
    );
    expect(r.status).toBe(201);
  });
});

describe('handleAdminProjectContractCountersign', () => {
  const adminPrincipal = { email: 'a@t.com' };

  it('503 when DB missing', async () => {
    const r = await handleAdminProjectContractCountersign(
      new Request('http://t', { method: 'POST', body: '{"signature":"x","signature_type":"typed"}' }),
      {}, 'p1', 'c1', adminPrincipal,
    );
    expect(r.status).toBe(503);
  });
  it('400 when signature missing', async () => {
    const r = await handleAdminProjectContractCountersign(
      new Request('http://t', { method: 'POST', body: '{}' }),
      { DB: makeDb() }, 'p1', 'c1', adminPrincipal,
    );
    expect(r.status).toBe(400);
  });
  it('404 when contract not found', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    const r = await handleAdminProjectContractCountersign(
      new Request('http://t', { method: 'POST', body: '{"signature":"x","signature_type":"typed"}' }),
      { DB: db }, 'p1', 'c1', adminPrincipal,
    );
    expect(r.status).toBe(404);
  });
  it('400 when client has not signed', async () => {
    const contract = { id: 'c1', status: 'sent', body_hash: 'abc', signing_token: 'tok' };
    const db       = makeDb([contract]);
    const stmt     = db.prepare();
    stmt.all.mockResolvedValue({ results: [contract] });
    const r = await handleAdminProjectContractCountersign(
      new Request('http://t', { method: 'POST', body: '{"signature":"x","signature_type":"typed"}' }),
      { DB: db }, 'p1', 'c1', adminPrincipal,
    );
    expect(r.status).toBe(400);
  });
  it('200 on countersign sends confirmation email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const contract = { id: 'c1', status: 'client_signed', body_hash: 'abc', signing_token: 'tok', title: 'C' };
    const proj     = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const updated  = { ...contract, status: 'fully_executed' };
    const db       = makeDb([]);
    const stmt     = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [contract] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [updated] });
    const r = await handleAdminProjectContractCountersign(
      new Request('http://t', { method: 'POST', body: '{"signature":"sig","signature_type":"typed"}' }),
      { DB: db, RESEND_API_KEY: 'key' }, 'p1', 'c1', adminPrincipal,
    );
    expect(r.status).toBe(200);
  });
  it('200 on countersign with empty p.email (uses empty string)', async () => {
    const contract = { id: 'c2', status: 'client_signed', body_hash: '', signing_token: 'tok2', title: 'D' };
    const proj     = { id: 'p2', client_name: 'Bob', client_email: '' };
    const updated  = { ...contract, status: 'fully_executed' };
    const db       = makeDb([]);
    const stmt     = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [contract] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [updated] });
    const r = await handleAdminProjectContractCountersign(
      new Request('http://t', { method: 'POST', body: '{"signature":"sig","signature_type":"typed"}' }),
      { DB: db }, 'p2', 'c2', {},
    );
    expect(r.status).toBe(200);
  });
});

describe('handlePublicContractGet', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicContractGet(new Request('http://t'), {}, 'tok')).status).toBe(503);
  });
  it('404 when contract not found', async () => {
    const r = await handlePublicContractGet(new Request('http://t'), { DB: makeDb([]) }, 'tok');
    expect(r.status).toBe(404);
  });
  it('200 returns contract', async () => {
    const contract = { id: 'c1', title: 'Contract', body: 'Terms', status: 'sent' };
    const r = await handlePublicContractGet(new Request('http://t'), { DB: makeDb([contract]) }, 'tok');
    expect(r.status).toBe(200);
    expect((await r.json()).id).toBe('c1');
  });
});

describe('handlePublicContractView', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicContractView(new Request('http://t'), {}, 'tok')).status).toBe(503);
  });
  it('404 when contract not found', async () => {
    const r = await handlePublicContractView(new Request('http://t'), { DB: makeDb([]) }, 'tok');
    expect(r.status).toBe(404);
  });
  it('200 records view event with body_hash', async () => {
    const contract = { id: 'c1', body_hash: 'abc' };
    const r = await handlePublicContractView(new Request('http://t'), { DB: makeDb([contract]) }, 'tok');
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
  it('200 records view event without body_hash (uses empty string)', async () => {
    const contract = { id: 'c1', body_hash: '' };
    const r = await handlePublicContractView(new Request('http://t'), { DB: makeDb([contract]) }, 'tok');
    expect(r.status).toBe(200);
  });
});

describe('handlePublicContractSign', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicContractSign(
      new Request('http://t', { method: 'POST', body: '{}' }), {}, 'tok',
    )).status).toBe(503);
  });
  it('400 when signature missing', async () => {
    const r = await handlePublicContractSign(
      new Request('http://t', { method: 'POST', body: '{}' }),
      { DB: makeDb([{ id: 'c1', status: 'sent' }]) }, 'tok',
    );
    expect(r.status).toBe(400);
  });
  it('404 when contract not found', async () => {
    const r = await handlePublicContractSign(
      new Request('http://t', { method: 'POST', body: '{"signature":"x","signature_type":"typed"}' }),
      { DB: makeDb([]) }, 'tok',
    );
    expect(r.status).toBe(404);
  });
  it('400 when contract already signed', async () => {
    const contract = { id: 'c1', status: 'client_signed', client_email: 'c@t.com', body_hash: '' };
    const r = await handlePublicContractSign(
      new Request('http://t', { method: 'POST', body: '{"signature":"x","signature_type":"typed"}' }),
      { DB: makeDb([contract]) }, 'tok',
    );
    expect(r.status).toBe(400);
  });
  it('200 signs contract and sends notification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const contract = { id: 'c1', status: 'sent', client_email: 'c@t.com', client_name: 'Alice', title: 'C', body_hash: '' };
    const r = await handlePublicContractSign(
      new Request('http://t', { method: 'POST', body: '{"signature":"sig","signature_type":"typed"}' }),
      { DB: makeDb([contract]), RESEND_API_KEY: 'key' }, 'tok',
    );
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.status).toBe('client_signed');
  });
  it('200 signs contract with no client_email (no email sent)', async () => {
    const contract = { id: 'c2', status: 'sent', client_email: '', client_name: 'Bob', title: 'D', body_hash: 'xyz' };
    const r = await handlePublicContractSign(
      new Request('http://t', { method: 'POST', body: '{"signature":"sig","signature_type":"drawn"}' }),
      { DB: makeDb([contract]) }, 'tok',
    );
    expect(r.status).toBe(200);
  });
});

describe('handlePublicContractAudit', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicContractAudit(new Request('http://t'), {}, 'tok')).status).toBe(503);
  });
  it('404 when contract not found', async () => {
    const r = await handlePublicContractAudit(new Request('http://t'), { DB: makeDb([]) }, 'tok');
    expect(r.status).toBe(404);
  });
  it('200 returns audit trail', async () => {
    const contract = { id: 'c1', status: 'client_signed' };
    const events   = [{ id: 'e1', event_type: 'viewed' }];
    const db       = makeDb([contract]);
    const stmt     = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [contract] })
      .mockResolvedValueOnce({ results: events });
    const r = await handlePublicContractAudit(new Request('http://t'), { DB: db }, 'tok');
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.contract_id).toBe('c1');
    expect(b.events.length).toBe(1);
  });
});
