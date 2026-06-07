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

  // ── contract_signed_deposit_invoice ──────────────────────────────────────────

  it('auto-creates and sends deposit invoice when contract signed and approved proposal with package exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com', stage: 'Contract Signed', property: 'Beach House', updated_at: new Date(Date.now() - 2 * 3600000).toISOString() };
    const proposal = { id: 'prop1', selected_package_id: 'pkg1' };
    const pkg = { id: 'pkg1', name: 'Premium Package', base_price: 200000 };
    const db = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ trigger_key: 'contract_signed_deposit_invoice', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [] })         // no existing invoices
      .mockResolvedValueOnce({ results: [] })         // not logged
      .mockResolvedValueOnce({ results: [proposal] }) // approved proposal
      .mockResolvedValueOnce({ results: [pkg] })      // service package
      .mockResolvedValueOnce({ results: [{ n: 0 }] }); // COUNT for invoice number

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    const emailBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(emailBody.to[0]).toBe('a@t.com');
    expect(emailBody.subject).toContain('INV-');
    expect(emailBody.html).toContain('$1000.00'); // 50% of $2000
  });

  it('notifies admin when contract signed but no approved proposal available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p2', client_name: 'Bob', client_email: 'b@t.com', stage: 'Contract Signed', property: '', updated_at: new Date(Date.now() - 2 * 3600000).toISOString() };
    const db = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ trigger_key: 'contract_signed_deposit_invoice', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [] })  // no existing invoices
      .mockResolvedValueOnce({ results: [] })  // not logged
      .mockResolvedValueOnce({ results: [] }); // no approved proposal

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    const emailBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(emailBody.subject).toContain('Action needed');
  });

  it('notifies admin when approved proposal exists but package base_price is zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p3', client_name: 'Carol', client_email: 'c@t.com', stage: 'Contract Signed', property: 'Villa', updated_at: new Date(Date.now() - 2 * 3600000).toISOString() };
    const proposal = { id: 'prop2', selected_package_id: 'pkg2' };
    const pkg = { id: 'pkg2', name: 'Complimentary', base_price: 0 };
    const db = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ trigger_key: 'contract_signed_deposit_invoice', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [proposal] })
      .mockResolvedValueOnce({ results: [pkg] }); // base_price = 0 → admin notification

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    const emailBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(emailBody.subject).toContain('Action needed');
  });

  it('skips contract_signed_deposit_invoice when existing invoices are present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p4', client_name: 'Dave', client_email: 'd@t.com', stage: 'Contract Signed', property: '', updated_at: new Date(Date.now() - 2 * 3600000).toISOString() };
    const db = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ trigger_key: 'contract_signed_deposit_invoice', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [{ id: 'inv-existing' }] }); // existing invoice

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('skips contract_signed_deposit_invoice when already logged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p5', client_name: 'Eve', client_email: 'e@t.com', stage: 'Contract Signed', property: '', updated_at: new Date(Date.now() - 2 * 3600000).toISOString() };
    const db = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ trigger_key: 'contract_signed_deposit_invoice', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [] })             // no existing invoices
      .mockResolvedValueOnce({ results: [{ id: 'log1' }] }); // already logged

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  // ── invoice_due_reminder ──────────────────────────────────────────────────────

  it('sends invoice_due_reminder for invoices due within 3 days', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const today = new Date().toISOString().split('T')[0];
    const inv = { id: 'inv-due', project_id: 'p1', invoice_number: 'INV-0001', client_email: 'a@t.com', client_name: 'Alice', total_cents: 100000, magic_token: 'tok1', due_date: today };
    const db = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ trigger_key: 'invoice_due_reminder', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [] })    // no projects match the trigger
      .mockResolvedValueOnce({ results: [inv] }) // due invoices
      .mockResolvedValueOnce({ results: [] });   // not yet logged

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    const emailBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(emailBody.to[0]).toBe('a@t.com');
    expect(emailBody.subject).toContain('Payment reminder');
    expect(emailBody.html).toContain('$1000.00');
  });

  it('skips invoice_due_reminder when already logged for that invoice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const today = new Date().toISOString().split('T')[0];
    const inv = { id: 'inv-dup', project_id: 'p2', invoice_number: 'INV-0002', client_email: 'b@t.com', client_name: 'Bob', total_cents: 50000, magic_token: 'tok2', due_date: today };
    const db = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ trigger_key: 'invoice_due_reminder', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [{ id: 'log1' }] }); // already logged

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('skips invoice_due_reminder for invoices without client_email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const today = new Date().toISOString().split('T')[0];
    const inv = { id: 'inv-noemail', project_id: 'p3', invoice_number: 'INV-0003', client_email: '', client_name: 'Nobody', total_cents: 50000, magic_token: 'tok3', due_date: today };
    const db = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ trigger_key: 'invoice_due_reminder', enabled: 1, delay_hours: 0 }] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [inv] }); // no client_email — skipped before log check

    await handleScheduled({}, { DB: db, RESEND_API_KEY: 'key' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
