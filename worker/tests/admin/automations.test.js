import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleAdminAutomations, handleAdminAutomationLogs,
  sendAutomationEmail, logAutomation, handleScheduled,
} from '../../src/admin/automations.js';
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

describe('handleAdminAutomations', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminAutomations(new Request('http://t'), 'GET', env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminAutomations(await clientReq('GET'), 'GET', env())).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminAutomations(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET })).status).toBe(503);
  });
  it('returns settings on GET', async () => {
    const r = await handleAdminAutomations(await adminReq('GET'), 'GET', env(makeDb([{ id: 'inquiry_auto_reply', enabled: 1 }])));
    expect(r.status).toBe(200);
  });
  it('400 on PUT when not array', async () => {
    const r = await handleAdminAutomations(await adminReq('PUT', { invalid: true }), 'PUT', env());
    expect(r.status).toBe(400);
  });
  it('200 on PUT with array updates settings', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [{ id: 'inquiry_auto_reply', enabled: 1, delay_hours: 0 }] });
    const r = await handleAdminAutomations(
      await adminReq('PUT', [{ id: 'inquiry_auto_reply', enabled: true, delay_hours: 2 }]),
      'PUT', { JWT_SECRET: SECRET, DB: db },
    );
    expect(r.status).toBe(200);
  });
  it('200 on PUT with empty array', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    const r = await handleAdminAutomations(await adminReq('PUT', []), 'PUT', { JWT_SECRET: SECRET, DB: db });
    expect(r.status).toBe(200);
  });
  it('200 on PUT with enabled=false sets disabled state', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [{ id: 'inquiry_auto_reply', enabled: 0, delay_hours: 0 }] });
    const r = await handleAdminAutomations(
      await adminReq('PUT', [{ id: 'inquiry_auto_reply', enabled: false, delay_hours: 0 }]),
      'PUT', { JWT_SECRET: SECRET, DB: db },
    );
    expect(r.status).toBe(200);
  });
});

describe('handleAdminAutomationLogs', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminAutomationLogs(new Request('http://t'), env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminAutomationLogs(await clientReq('GET'), env())).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminAutomationLogs(await adminReq('GET'), { JWT_SECRET: SECRET })).status).toBe(503);
  });
  it('200 returns logs', async () => {
    const r = await handleAdminAutomationLogs(
      await adminReq('GET'),
      env(makeDb([{ id: 'log1', trigger_key: 'inquiry_auto_reply' }])),
    );
    expect(r.status).toBe(200);
  });
});

describe('sendAutomationEmail', () => {
  it('no-op when no RESEND_API_KEY', async () => {
    const result = await sendAutomationEmail({}, 'c@t.com', 'Subject', '<p>Hi</p>');
    expect(result).toBeUndefined();
  });
  it('no-op when no to address', async () => {
    const result = await sendAutomationEmail({ RESEND_API_KEY: 'key' }, '', 'Subject', '<p>Hi</p>');
    expect(result).toBeUndefined();
  });
  it('calls fetch when key and to are present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await sendAutomationEmail({ RESEND_API_KEY: 'key' }, 'c@t.com', 'Subject', '<p>Hi</p>');
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });
  it('swallows fetch errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(sendAutomationEmail({ RESEND_API_KEY: 'key' }, 'c@t.com', 'S', '<p/>')).resolves.not.toThrow();
  });
});

describe('logAutomation', () => {
  it('inserts automation log row', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    await logAutomation(db, 'p1', 'inquiry_auto_reply', 'auto-reply sent', new Date().toISOString());
    expect(stmt.run).toHaveBeenCalled();
  });
});

describe('handleScheduled', () => {
  it('returns early when no DB or RESEND_API_KEY', async () => {
    await expect(handleScheduled({}, {})).resolves.toBeUndefined();
    await expect(handleScheduled({}, { DB: makeDb() })).resolves.toBeUndefined();
  });

  it('returns early when no enabled automation settings', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    await expect(handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' })).resolves.toBeUndefined();
  });

  it('sends inquiry auto-reply for new inquiry projects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com', stage: 'Inquiry', source: 'inquiry', updated_at: new Date(Date.now() - 5 * 3600000).toISOString() };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ id: 'inquiry_auto_reply', trigger_key: 'inquiry_auto_reply', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValue({ results: [] });

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it('skips inquiry auto-reply when already logged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com', stage: 'Inquiry', source: 'inquiry', updated_at: new Date(Date.now() - 5 * 3600000).toISOString() };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ id: 'inquiry_auto_reply', trigger_key: 'inquiry_auto_reply', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValue({ results: [{ id: 'log1' }] }); // already logged

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('skips projects without client_email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p2', client_name: 'Bob', client_email: '', stage: 'Inquiry', source: 'inquiry', updated_at: new Date().toISOString() };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ id: 'inquiry_auto_reply', trigger_key: 'inquiry_auto_reply', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [proj] });

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('sends proposal_not_opened_followup when delay elapsed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com', stage: 'Proposal Sent', source: '', updated_at: new Date(Date.now() - 50 * 3600000).toISOString() };
    const proposal = { id: 'prop1', created_at: new Date(Date.now() - 50 * 3600000).toISOString(), public_url: 'http://x' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ id: 'proposal_not_opened_followup', trigger_key: 'proposal_not_opened_followup', enabled: 1, delay_hours: 48 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [proposal] })  // unopened proposal
      .mockResolvedValue({ results: [] });              // not yet logged

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it('sends contract_not_signed_reminder when delay elapsed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com', stage: 'Contract Sent', source: '', updated_at: new Date(Date.now() - 50 * 3600000).toISOString() };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ id: 'contract_not_signed_reminder', trigger_key: 'contract_not_signed_reminder', enabled: 1, delay_hours: 48 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValue({ results: [] }); // not yet logged

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it('sends post_delivery_review_request when delay elapsed (with property)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com', stage: 'Delivered', source: '', property: 'Beach House', updated_at: new Date(Date.now() - 200 * 3600000).toISOString() };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ id: 'post_delivery_review_request', trigger_key: 'post_delivery_review_request', enabled: 1, delay_hours: 168 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValue({ results: [] }); // not yet logged

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
  it('sends post_delivery_review_request when delay elapsed (no property uses fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p2', client_name: 'Bob', client_email: 'b@t.com', stage: 'Delivered', source: '', property: '', updated_at: new Date(Date.now() - 200 * 3600000).toISOString() };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ id: 'post_delivery_review_request', trigger_key: 'post_delivery_review_request', enabled: 1, delay_hours: 168 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValue({ results: [] });

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it('sends proposal_not_approved_reminder', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com', stage: 'Proposal Sent', source: '', updated_at: new Date(Date.now() - 100 * 3600000).toISOString() };
    const proposal = { id: 'prop1', created_at: new Date(Date.now() - 100 * 3600000).toISOString(), public_url: 'http://x', status: 'sent' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ id: 'proposal_not_approved_reminder', trigger_key: 'proposal_not_approved_reminder', enabled: 1, delay_hours: 72 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [proposal] })
      .mockResolvedValue({ results: [] });

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
});
