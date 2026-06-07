import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleAdminProjectInvoices, handleAdminInvoice, handleAdminInvoiceSend,
  handlePublicInvoice, handleInvoiceCheckout, handleStripeWebhook, handlePortalInvoices,
} from '../../src/admin/invoices.js';
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

describe('handleAdminProjectInvoices', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminProjectInvoices(new Request('http://t'), 'GET', env(), 'p1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminProjectInvoices(await clientReq('GET'), 'GET', env(), 'p1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminProjectInvoices(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET }, 'p1')).status).toBe(503);
  });
  it('returns invoices on GET', async () => {
    const r = await handleAdminProjectInvoices(await adminReq('GET'), 'GET', env(makeDb([{ id: 'inv1' }])), 'p1');
    expect(r.status).toBe(200);
  });
  it('400 on POST when line_items missing or empty', async () => {
    const r = await handleAdminProjectInvoices(await adminReq('POST', { line_items: [] }), 'POST', env(), 'p1');
    expect(r.status).toBe(400);
  });
  it('404 on POST when project not found', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    const r = await handleAdminProjectInvoices(
      await adminReq('POST', { line_items: [{ description: 'Service', quantity: 1, unit_price_cents: 10000 }] }),
      'POST', { JWT_SECRET: SECRET, DB: db }, 'p1',
    );
    expect(r.status).toBe(404);
  });
  it('201 on POST with quantity 0 (|| 1 branch), unit_price 0 (|| 0 branch), and empty project fields', async () => {
    const proj = { id: 'p1', client_name: null, client_email: null };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [{ n: 0 }] });
    const r = await handleAdminProjectInvoices(
      await adminReq('POST', { line_items: [
        { description: 'S', quantity: 0, unit_price_cents: 10000 },
        { description: 'T', quantity: 1, unit_price_cents: 0 },
      ] }),
      'POST', { JWT_SECRET: SECRET, DB: db }, 'p1',
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.subtotal_cents).toBe(10000);
    expect(b.client_name).toBe('');
    expect(b.client_email).toBe('');
  });
  it('201 on POST with valid data', async () => {
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [proj] })
      .mockResolvedValueOnce({ results: [{ n: 0 }] });
    const r = await handleAdminProjectInvoices(
      await adminReq('POST', { line_items: [{ description: 'Shoot', quantity: 1, unit_price_cents: 50000 }], tax_cents: 500 }),
      'POST', { JWT_SECRET: SECRET, DB: db }, 'p1',
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.status).toBe('draft');
    expect(b.subtotal_cents).toBe(50000);
    expect(b.tax_cents).toBe(500);
    expect(b.total_cents).toBe(50500);
  });
});

describe('handleAdminInvoice', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminInvoice(new Request('http://t'), 'GET', env(), 'inv1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminInvoice(await clientReq('GET'), 'GET', env(), 'inv1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminInvoice(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET }, 'inv1')).status).toBe(503);
  });
  it('404 when invoice not found', async () => {
    const r = await handleAdminInvoice(await adminReq('GET'), 'GET', env(makeDb([])), 'inv1');
    expect(r.status).toBe(404);
  });
  it('200 on GET returns invoice', async () => {
    const inv = { id: 'inv1', status: 'draft', line_items: '[]', tax_cents: 0 };
    const r   = await handleAdminInvoice(await adminReq('GET'), 'GET', env(makeDb([inv])), 'inv1');
    expect(r.status).toBe(200);
  });
  it('200 on PUT updates invoice', async () => {
    const inv = { id: 'inv1', status: 'draft', line_items: '[]', tax_cents: 0, due_date: '', notes: '', paid_at: '', project_id: 'p1' };
    const db  = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })     // initial fetch
      .mockResolvedValueOnce({ results: [{ ...inv, status: 'sent' }] }); // after update
    const r = await handleAdminInvoice(
      await adminReq('PUT', { status: 'sent' }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'inv1',
    );
    expect(r.status).toBe(200);
  });
  it('200 on PUT marks project Retainer Paid when status becomes paid', async () => {
    const inv = { id: 'inv1', status: 'draft', line_items: '[]', tax_cents: 0, due_date: '', notes: '', paid_at: '', project_id: 'p1' };
    const db  = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [{ ...inv, status: 'paid' }] });
    const r = await handleAdminInvoice(
      await adminReq('PUT', { status: 'paid' }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'inv1',
    );
    expect(r.status).toBe(200);
  });
  it('200 on PUT sends booking-confirmed email when final payment received', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const inv = { id: 'inv1', status: 'draft', line_items: '[]', tax_cents: 0, due_date: '', notes: '', paid_at: '', project_id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const db  = makeDb([]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [{ ...inv, status: 'paid' }] });
    const r = await handleAdminInvoice(
      await adminReq('PUT', { status: 'paid' }),
      'PUT', { JWT_SECRET: SECRET, DB: db, RESEND_API_KEY: 'key' }, 'inv1',
    );
    expect(r.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('https://api.resend.com/emails', expect.any(Object));
  });
  it('200 on PUT with line_items updates totals', async () => {
    const inv = { id: 'inv1', status: 'draft', line_items: '[]', tax_cents: 0, due_date: '', notes: '', paid_at: '', project_id: 'p1' };
    const db  = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [inv] });
    const r = await handleAdminInvoice(
      await adminReq('PUT', { line_items: [{ description: 'S', quantity: 2, unit_price_cents: 5000 }], tax_cents: 100 }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'inv1',
    );
    expect(r.status).toBe(200);
  });
  it('200 on PUT with due_date, notes, paid_at in body and null line_items in inv', async () => {
    const inv = { id: 'inv1', status: 'draft', line_items: null, tax_cents: 0, due_date: '', notes: '', paid_at: '', project_id: 'p1' };
    const db  = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [inv] });
    const r = await handleAdminInvoice(
      await adminReq('PUT', { due_date: '2025-12-31', notes: 'Pay promptly', paid_at: '2025-12-31' }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'inv1',
    );
    expect(r.status).toBe(200);
  });
  it('200 on PUT with line_items but no tax_cents uses stored tax (fallback branch)', async () => {
    const inv = { id: 'inv1', status: 'draft', line_items: '[]', tax_cents: 250, due_date: '', notes: '', paid_at: '', project_id: 'p1' };
    const db  = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [inv] });
    const r = await handleAdminInvoice(
      await adminReq('PUT', { line_items: [{ description: 'S', quantity: 1, unit_price_cents: 10000 }] }),
      'PUT', { JWT_SECRET: SECRET, DB: db }, 'inv1',
    );
    expect(r.status).toBe(200);
  });
});

describe('handleAdminInvoiceSend', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminInvoiceSend(new Request('http://t'), env(), 'inv1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminInvoiceSend(await clientReq('POST'), env(), 'inv1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminInvoiceSend(await adminReq('POST'), { JWT_SECRET: SECRET }, 'inv1')).status).toBe(503);
  });
  it('404 when invoice not found', async () => {
    const r = await handleAdminInvoiceSend(await adminReq('POST'), env(makeDb([])), 'inv1');
    expect(r.status).toBe(404);
  });
  it('200 sends invoice and returns public_url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const inv = {
      id: 'inv1', invoice_number: 'INV-0001', status: 'draft',
      line_items: '[{"description":"S","quantity":1,"unit_price_cents":10000}]',
      subtotal_cents: 10000, tax_cents: 0, total_cents: 10000,
      client_name: 'Alice', client_email: 'a@t.com', notes: '',
      due_date: '2025-12-01', magic_token: 'tok', project_id: 'p1',
    };
    const db   = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [{ ...inv, status: 'sent' }] });
    const r = await handleAdminInvoiceSend(
      await adminReq('POST'),
      { JWT_SECRET: SECRET, DB: db, RESEND_API_KEY: 'key' }, 'inv1',
    );
    expect(r.status).toBe(200);
    expect((await r.json()).public_url).toContain('/invoice.html#');
  });
  it('200 without email when no RESEND_API_KEY or no client_email', async () => {
    const inv = {
      id: 'inv2', invoice_number: 'INV-0002', status: 'draft',
      line_items: '[]', subtotal_cents: 0, tax_cents: 0, total_cents: 0,
      client_name: 'Bob', client_email: '', notes: '',
      due_date: '', magic_token: 'tok2', project_id: 'p2',
    };
    const db   = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [inv] });
    const r = await handleAdminInvoiceSend(await adminReq('POST'), { JWT_SECRET: SECRET, DB: db }, 'inv2');
    expect(r.status).toBe(200);
  });
  it('200 when invoice has null line_items (uses empty array fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const inv = {
      id: 'inv4', invoice_number: 'INV-0004', status: 'draft',
      line_items: null, subtotal_cents: 0, tax_cents: 0, total_cents: 0,
      client_name: 'Dave', client_email: 'd@t.com', notes: '',
      due_date: '', magic_token: 'tok4', project_id: 'p4',
    };
    const db   = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [inv] });
    const r = await handleAdminInvoiceSend(
      await adminReq('POST'),
      { JWT_SECRET: SECRET, DB: db, RESEND_API_KEY: 'key' }, 'inv4',
    );
    expect(r.status).toBe(200);
  });
  it('200 sends invoice with tax, notes, and empty due_date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const inv = {
      id: 'inv3', invoice_number: 'INV-0003', status: 'draft',
      line_items: '[{"description":"","quantity":0,"unit_price_cents":0}]',
      subtotal_cents: 0, tax_cents: 1000, total_cents: 1000,
      client_name: 'Carol', client_email: 'c@t.com', notes: 'Please pay promptly',
      due_date: '', magic_token: 'tok3', project_id: 'p3',
    };
    const db   = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [inv] })
      .mockResolvedValueOnce({ results: [inv] });
    const r = await handleAdminInvoiceSend(
      await adminReq('POST'),
      { JWT_SECRET: SECRET, DB: db, RESEND_API_KEY: 'key' }, 'inv3',
    );
    expect(r.status).toBe(200);
  });
});

describe('handlePublicInvoice', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicInvoice(new Request('http://t'), {}, 'tok')).status).toBe(503);
  });
  it('404 when invoice not found', async () => {
    const r = await handlePublicInvoice(new Request('http://t'), { DB: makeDb([]) }, 'tok');
    expect(r.status).toBe(404);
  });
  it('200 returns invoice with stripe_enabled flag', async () => {
    const inv = { id: 'inv1', status: 'sent' };
    const r   = await handlePublicInvoice(new Request('http://t'), { DB: makeDb([inv]), STRIPE_SECRET_KEY: 'sk_test' }, 'tok');
    expect(r.status).toBe(200);
    expect((await r.json()).stripe_enabled).toBe(true);
  });
  it('200 stripe_enabled false without key', async () => {
    const inv = { id: 'inv1', status: 'sent' };
    const r   = await handlePublicInvoice(new Request('http://t'), { DB: makeDb([inv]) }, 'tok');
    expect(r.status).toBe(200);
    expect((await r.json()).stripe_enabled).toBe(false);
  });
});

describe('handleInvoiceCheckout', () => {
  it('503 when DB missing', async () => {
    expect((await handleInvoiceCheckout(new Request('http://t'), {}, 'tok')).status).toBe(503);
  });
  it('503 when no Stripe key', async () => {
    expect((await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb() }, 'tok')).status).toBe(503);
  });
  it('404 when invoice not found', async () => {
    const r = await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb([]), STRIPE_SECRET_KEY: 'sk' }, 'tok');
    expect(r.status).toBe(404);
  });
  it('400 when invoice already paid', async () => {
    const inv = { id: 'inv1', status: 'paid', line_items: '[]', tax_cents: 0 };
    const r   = await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb([inv]), STRIPE_SECRET_KEY: 'sk' }, 'tok');
    expect(r.status).toBe(400);
  });
  it('400 when invoice is void', async () => {
    const inv = { id: 'inv1', status: 'void', line_items: '[]', tax_cents: 0 };
    const r   = await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb([inv]), STRIPE_SECRET_KEY: 'sk' }, 'tok');
    expect(r.status).toBe(400);
  });
  it('200 creates checkout session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' }),
    }));
    const inv = {
      id: 'inv1', status: 'draft',
      line_items: '[{"description":"Shoot","quantity":1,"unit_price_cents":50000}]',
      tax_cents: 500, client_email: 'c@t.com',
    };
    const r   = await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb([inv]), STRIPE_SECRET_KEY: 'sk' }, 'tok');
    expect(r.status).toBe(200);
    expect((await r.json()).url).toContain('checkout.stripe.com');
  });
  it('502 on Stripe error with message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, json: () => Promise.resolve({ error: { message: 'Card declined' } }),
    }));
    const inv = {
      id: 'inv1', status: 'draft',
      line_items: '[{"description":"S","quantity":1,"unit_price_cents":5000}]',
      tax_cents: 0, client_email: 'c@t.com',
    };
    const r = await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb([inv]), STRIPE_SECRET_KEY: 'sk' }, 'tok');
    expect(r.status).toBe(502);
  });
  it('502 on Stripe error without message (fallback text)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, json: () => Promise.resolve({ error: {} }),
    }));
    const inv = {
      id: 'inv1', status: 'draft',
      line_items: '[{"description":"Item","quantity":0,"unit_price_cents":0}]',
      tax_cents: 500, client_email: '',
    };
    const r = await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb([inv]), STRIPE_SECRET_KEY: 'sk' }, 'tok');
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe('Stripe error');
  });
  it('200 creates checkout with no client_email (no customer_email param)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ id: 'cs_2', url: 'https://checkout.stripe.com/pay/cs_2' }),
    }));
    const inv = {
      id: 'inv2', status: 'draft',
      line_items: '[]',
      tax_cents: 0, client_email: '',
    };
    const r = await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb([inv]), STRIPE_SECRET_KEY: 'sk' }, 'tok');
    expect(r.status).toBe(200);
  });
  it('200 checkout with null line_items uses empty array fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ id: 'cs_3', url: 'https://checkout.stripe.com/pay/cs_3' }),
    }));
    const inv = {
      id: 'inv3', status: 'draft',
      line_items: null,
      tax_cents: 0, client_email: 'x@t.com',
    };
    const r = await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb([inv]), STRIPE_SECRET_KEY: 'sk' }, 'tok');
    expect(r.status).toBe(200);
  });
  it('200 checkout with item missing description uses "Service" fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ id: 'cs_4', url: 'https://checkout.stripe.com/pay/cs_4' }),
    }));
    const inv = {
      id: 'inv4', status: 'draft',
      line_items: '[{"description":"","quantity":1,"unit_price_cents":5000}]',
      tax_cents: 0, client_email: 'x@t.com',
    };
    const r = await handleInvoiceCheckout(new Request('http://t'), { DB: makeDb([inv]), STRIPE_SECRET_KEY: 'sk' }, 'tok');
    expect(r.status).toBe(200);
  });
});

describe('handleStripeWebhook', () => {
  it('200 ok when DB or secret missing', async () => {
    const r = await handleStripeWebhook(new Request('http://t', { method: 'POST', body: '{}' }), {});
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  async function makeStripeSignature(rawBody, secret) {
    const t   = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + rawBody));
    const v1  = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `t=${t},v1=${v1}`;
  }

  it('400 on invalid signature', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed' });
    const r    = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body, headers: { 'Stripe-Signature': 't=1,v1=bad' } }),
      { DB: makeDb(), STRIPE_WEBHOOK_SECRET: 'whsec_test' },
    );
    expect(r.status).toBe(400);
  });

  it('200 on valid checkout.session.completed marks invoice paid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const inv = {
      id: 'inv1', status: 'sent', project_id: 'p1',
      client_name: 'Alice', client_email: 'a@t.com',
      invoice_number: 'INV-0001', total_cents: 10000, magic_token: 'tok',
    };
    const db   = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [inv] });

    const event    = { type: 'checkout.session.completed', data: { object: { metadata: { invoice_id: 'inv1' }, payment_status: 'paid', payment_intent: 'pi_1' } } };
    const rawBody  = JSON.stringify(event);
    const secret   = 'whsec_test_at_least_32_chars_long_enough!!';
    const sigHeader = await makeStripeSignature(rawBody, secret);

    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: rawBody, headers: { 'Stripe-Signature': sigHeader } }),
      { DB: db, STRIPE_WEBHOOK_SECRET: secret, RESEND_API_KEY: 'key' },
    );
    expect(r.status).toBe(200);
  });

  it('200 on unknown event type', async () => {
    const secret   = 'whsec_test_at_least_32_chars_long_enough!!';
    const rawBody  = JSON.stringify({ type: 'customer.created' });
    const sigHeader = await makeStripeSignature(rawBody, secret);
    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: rawBody, headers: { 'Stripe-Signature': sigHeader } }),
      { DB: makeDb(), STRIPE_WEBHOOK_SECRET: secret },
    );
    expect(r.status).toBe(200);
  });

  it('200 skips when invoice already paid', async () => {
    const inv = { id: 'inv1', status: 'paid' };
    const db  = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [inv] });
    const secret    = 'whsec_test_at_least_32_chars_long_enough!!';
    const event     = { type: 'checkout.session.completed', data: { object: { metadata: { invoice_id: 'inv1' }, payment_status: 'paid' } } };
    const rawBody   = JSON.stringify(event);
    const sigHeader = await makeStripeSignature(rawBody, secret);
    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: rawBody, headers: { 'Stripe-Signature': sigHeader } }),
      { DB: db, STRIPE_WEBHOOK_SECRET: secret },
    );
    expect(r.status).toBe(200);
  });

  it('400 on invalid signature when t= is missing', async () => {
    const rawBody = JSON.stringify({ type: 'checkout.session.completed' });
    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: rawBody, headers: { 'Stripe-Signature': 'v1=abc' } }),
      { DB: makeDb(), STRIPE_WEBHOOK_SECRET: 'whsec_test' },
    );
    expect(r.status).toBe(400);
  });

  it('400 on invalid signature when v1= is missing', async () => {
    const rawBody = JSON.stringify({ type: 'checkout.session.completed' });
    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: rawBody, headers: { 'Stripe-Signature': 't=12345' } }),
      { DB: makeDb(), STRIPE_WEBHOOK_SECRET: 'whsec_test' },
    );
    expect(r.status).toBe(400);
  });

  it('400 on valid sig but invalid JSON body', async () => {
    const rawBody   = 'not-json';
    const secret    = 'whsec_test_at_least_32_chars_long_enough!!';
    const sigHeader = await makeStripeSignature(rawBody, secret);
    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: rawBody, headers: { 'Stripe-Signature': sigHeader } }),
      { DB: makeDb(), STRIPE_WEBHOOK_SECRET: secret },
    );
    expect(r.status).toBe(400);
  });

  it('200 on webhook with no payment_intent (uses empty string)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const inv = {
      id: 'inv2', status: 'sent', project_id: 'p2',
      client_name: 'Bob', client_email: '',
      invoice_number: 'INV-0002', total_cents: 5000, magic_token: 'tok2',
    };
    const db   = makeDb([inv]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [inv] });
    const event     = { type: 'checkout.session.completed', data: { object: { metadata: { invoice_id: 'inv2' }, payment_status: 'paid' } } };
    const rawBody   = JSON.stringify(event);
    const secret    = 'whsec_test_at_least_32_chars_long_enough!!';
    const sigHeader = await makeStripeSignature(rawBody, secret);
    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: rawBody, headers: { 'Stripe-Signature': sigHeader } }),
      { DB: db, STRIPE_WEBHOOK_SECRET: secret, RESEND_API_KEY: 'key' },
    );
    expect(r.status).toBe(200);
  });

  it('200 on checkout.session.completed with unpaid payment_status skips processing', async () => {
    const secret    = 'whsec_test_at_least_32_chars_long_enough!!';
    const event     = { type: 'checkout.session.completed', data: { object: { metadata: { invoice_id: 'inv1' }, payment_status: 'unpaid' } } };
    const rawBody   = JSON.stringify(event);
    const sigHeader = await makeStripeSignature(rawBody, secret);
    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: rawBody, headers: { 'Stripe-Signature': sigHeader } }),
      { DB: makeDb(), STRIPE_WEBHOOK_SECRET: secret },
    );
    expect(r.status).toBe(200);
  });

  it('200 on checkout.session.completed with no invoice_id skips processing', async () => {
    const secret    = 'whsec_test_at_least_32_chars_long_enough!!';
    const event     = { type: 'checkout.session.completed', data: { object: { metadata: {}, payment_status: 'paid' } } };
    const rawBody   = JSON.stringify(event);
    const sigHeader = await makeStripeSignature(rawBody, secret);
    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: rawBody, headers: { 'Stripe-Signature': sigHeader } }),
      { DB: makeDb(), STRIPE_WEBHOOK_SECRET: secret },
    );
    expect(r.status).toBe(200);
  });
  it('400 when Stripe-Signature header is missing', async () => {
    const r = await handleStripeWebhook(
      new Request('http://t', { method: 'POST', body: '{}' }),
      { DB: makeDb(), STRIPE_WEBHOOK_SECRET: 'whsec_test_at_least_32_chars_long_enough!!' },
    );
    expect(r.status).toBe(400);
  });
});

describe('handlePortalInvoices', () => {
  it('401 when unauthenticated', async () => {
    expect((await handlePortalInvoices(new Request('http://t'), env())).status).toBe(401);
  });
  it('503 when DB missing', async () => {
    const token = await createJWT({ sub: 'c@t.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t', { headers: { Authorization: `Bearer ${token}` } });
    expect((await handlePortalInvoices(req, { JWT_SECRET: SECRET })).status).toBe(503);
  });
  it('200 returns invoices with public_url', async () => {
    const token = await createJWT({ sub: 'c@t.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t', { headers: { Authorization: `Bearer ${token}` } });
    const inv   = { id: 'inv1', magic_token: 'tok', invoice_number: 'INV-0001' };
    const r     = await handlePortalInvoices(req, { JWT_SECRET: SECRET, DB: makeDb([inv]) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body[0].public_url).toContain('/invoice.html#');
  });
});
