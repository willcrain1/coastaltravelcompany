import { describe, it, expect, vi, afterEach } from 'vitest';
import { createJWT } from '../src/jwt.js';
import { handleAuthRegister, handleAuthResendVerify, handleAuthResetRequest } from '../src/auth.js';
import { handleContact } from '../src/contact.js';
import {
  handleAdminProjectContracts,
  handleAdminProjectContractCountersign,
  handlePublicContractSign,
} from '../src/admin/contracts.js';
import { handleAdminInvoiceSend, handleStripeWebhook } from '../src/admin/invoices.js';
import {
  handleAdminProjectQuestionnaires,
  handlePublicQuestionnaire,
} from '../src/admin/questionnaires.js';
import { handleAdminProjectScheduleLinks, handlePublicSchedule } from '../src/admin/scheduling.js';
import { handleAdminUpdateUserRole } from '../src/admin/users.js';
import { recordLoginFailure } from '../src/brute-force.js';
import { handlePublicProjectPortal, handlePortalMyProject } from '../src/portal.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';
const RESEND  = 'https://api.resend.com/emails';

function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get:    async k      => store.get(k) ?? null,
    put:    async (k, v) => { store.set(k, v); },
    delete: async k      => { store.delete(k); },
  };
}

// Each .all() call returns the next result set in sequence; .run() always succeeds.
function makeDb(...allSeq) {
  let idx = 0;
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run:  vi.fn().mockResolvedValue({}),
    all:  vi.fn().mockImplementation(() =>
      Promise.resolve({ results: allSeq[idx++] ?? [] })
    ),
  };
  stmt.bind.mockReturnValue(stmt);
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

async function adminJWT(extra = {}) {
  return createJWT(
    { sub: 'admin@t.com', id: 'admin-id', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600, ...extra },
    SECRET
  );
}

async function clientJWT(email = 'client@t.com', id = 'client-id') {
  return createJWT(
    { sub: email, id, role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET
  );
}

function jsonReq(method, body, extraHeaders = {}) {
  return new Request('http://t', {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

// Stubs global fetch; returns array populated synchronously with each Resend payload.
function captureResend() {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
    if (url === RESEND) calls.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }));
  return calls;
}

async function makeStripeHeader(body, secret) {
  // Must be a current timestamp — the webhook rejects signatures outside the
  // 5-minute replay tolerance window.
  const t   = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + body));
  const v1  = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${v1}`;
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── Email 1: Verify email on registration ─────────────────────────────────────

describe('Email 1 — registration verify email', () => {
  it('sends to registrant with subject and verify link', async () => {
    const calls = captureResend();
    await handleAuthRegister(
      jsonReq('POST', { email: 'new@t.com', password: 'pass1234' }),
      { KV: makeKv(), JWT_SECRET: SECRET, RESEND_API_KEY: 'key' }
    );
    expect(calls[0].to).toEqual(['new@t.com']);
    expect(calls[0].subject).toBe('Verify your email — Coastal Travel Company');
    expect(calls[0].html).toContain('/login.html?verify=');
  });
});

// ── Email 2: Resend verification email ───────────────────────────────────────

describe('Email 2 — resend verify email', () => {
  it('sends new link to unverified user', async () => {
    const calls = captureResend();
    const kv = makeKv({
      'user:unverified@t.com': JSON.stringify({ id: 'u1', email: 'unverified@t.com', verified: false }),
    });
    await handleAuthResendVerify(
      jsonReq('POST', { email: 'unverified@t.com' }),
      { KV: kv, RESEND_API_KEY: 'key' }
    );
    expect(calls[0].to).toEqual(['unverified@t.com']);
    expect(calls[0].subject).toBe('Verify your email — Coastal Travel Company');
    expect(calls[0].html).toContain('new verification link');
  });
});

// ── Email 3: Password reset request ──────────────────────────────────────────

describe('Email 3 — password reset request', () => {
  it('sends reset link to user', async () => {
    const calls = captureResend();
    const kv = makeKv({
      'user:reset@t.com': JSON.stringify({ id: 'u2', email: 'reset@t.com', role: 'client' }),
    });
    await handleAuthResetRequest(
      jsonReq('POST', { email: 'reset@t.com' }),
      { KV: kv, RESEND_API_KEY: 'key' }
    );
    expect(calls[0].to).toEqual(['reset@t.com']);
    expect(calls[0].subject).toBe('Reset your password — Coastal Travel Company');
    expect(calls[0].html).toContain('/login.html?reset=');
  });
});

// ── Email 4: Contact form inquiry to admin ────────────────────────────────────

describe('Email 4 — contact form inquiry', () => {
  it('sends to admin inbox with sender name and message', async () => {
    const calls = captureResend();
    const form = new URLSearchParams({
      'first-name': 'Jane', 'last-name': 'Smith', email: 'jane@t.com',
      property: 'Beach House', location: 'Miami', collection: 'Standard',
      timeline: 'Q2', message: 'Looking forward to it',
    });
    await handleContact(
      new Request('http://t/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '1.2.3.4' },
        body: form.toString(),
      }),
      { KV: makeKv(), RESEND_API_KEY: 'key' }
    );
    expect(calls[0].to).toEqual(['thecoastaltravelcompany@gmail.com']);
    expect(calls[0].subject).toContain('Jane Smith');
    expect(calls[0].html).toContain('Looking forward to it');
  });
});

// ── Email 5: Contract ready to sign → client ─────────────────────────────────

describe('Email 5 — contract ready to sign', () => {
  it('sends to client with contract title in html', async () => {
    const calls = captureResend();
    const project = { id: 'proj-1', client_name: 'Alice', client_email: 'alice@t.com' };
    const db = makeDb([project]);
    await handleAdminProjectContracts(
      jsonReq('POST', { title: 'Spring Shoot Contract', contract_body: 'Terms and conditions.' }),
      'POST',
      { DB: db, RESEND_API_KEY: 'key', JWT_SECRET: SECRET },
      'proj-1',
      { email: 'admin@t.com', role: 'admin' }
    );
    expect(calls[0].to).toEqual(['alice@t.com']);
    expect(calls[0].subject).toBe('Your contract is ready to sign — Coastal Travel Company');
    expect(calls[0].html).toContain('Alice');
    expect(calls[0].html).toContain('Spring Shoot Contract');
  });
});

// ── Email 6: Client signed — admin notification ───────────────────────────────

describe('Email 6 — contract signed notification to admin', () => {
  it('sends to admin inbox with client name and contract title in subject', async () => {
    const calls = captureResend();
    const contract = {
      id: 'c1', status: 'sent', client_name: 'Bob', client_email: 'bob@t.com',
      title: 'Shoot Contract', signing_token: 'tok123', body_hash: 'abc',
    };
    const db = makeDb([contract]);
    await handlePublicContractSign(
      jsonReq('POST', { signature: 'Bob Smith', signature_type: 'typed' }),
      { DB: db, RESEND_API_KEY: 'key' },
      'tok123'
    );
    expect(calls[0].to).toEqual(['thecoastaltravelcompany@gmail.com']);
    expect(calls[0].subject).toContain('Contract signed');
    expect(calls[0].subject).toContain('Bob');
    expect(calls[0].subject).toContain('Shoot Contract');
    expect(calls[0].html).toContain('Bob');
  });
});

// ── Email 7: Contract fully executed → client ─────────────────────────────────

describe('Email 7 — contract fully executed', () => {
  it('sends to client confirming both parties signed', async () => {
    const calls = captureResend();
    const contract = {
      id: 'c1', project_id: 'proj-1', status: 'client_signed',
      client_name: 'Carol', client_email: 'carol@t.com',
      title: 'Beach Shoot', signing_token: 'tok456', body_hash: 'def',
    };
    const project2 = { id: 'proj-1', client_name: 'Carol', client_email: 'carol@t.com' };
    // all() sequence: SELECT contract, SELECT project, SELECT updated contract
    const db = makeDb([contract], [project2], [{ ...contract, status: 'fully_executed' }]);
    await handleAdminProjectContractCountersign(
      jsonReq('POST', { signature: 'Admin Sig', signature_type: 'typed' }),
      { DB: db, RESEND_API_KEY: 'key' },
      'proj-1', 'c1',
      { email: 'admin@t.com' }
    );
    expect(calls[0].to).toEqual(['carol@t.com']);
    expect(calls[0].subject).toBe('Your contract is fully executed — Coastal Travel Company');
    expect(calls[0].html).toContain('Carol');
    expect(calls[0].html).toContain('signed by both parties');
  });
});

// ── Email 8: Invoice sent to client ──────────────────────────────────────────

describe('Email 8 — invoice sent to client', () => {
  it('sends invoice number in subject with pay button in html', async () => {
    const calls = captureResend();
    const inv = {
      id: 'inv-1', project_id: 'proj-1', invoice_number: 'INV-0001', status: 'draft',
      client_name: 'Dave', client_email: 'dave@t.com',
      line_items: JSON.stringify([{ description: 'Photography', quantity: 1, unit_price_cents: 150000 }]),
      subtotal_cents: 150000, tax_cents: 0, total_cents: 150000,
      due_date: '2026-06-01', magic_token: 'mag-tok', notes: '',
    };
    const db = makeDb([inv], [inv]); // SELECT inv, SELECT updated inv
    const token = await adminJWT();
    await handleAdminInvoiceSend(
      new Request('http://t', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
      { DB: db, RESEND_API_KEY: 'key', JWT_SECRET: SECRET },
      'inv-1'
    );
    expect(calls[0].to).toEqual(['dave@t.com']);
    expect(calls[0].subject).toBe('Invoice INV-0001 — Coastal Travel Company');
    expect(calls[0].html).toContain('INV-0001');
    expect(calls[0].html).toContain('View &amp; Pay Invoice');
  });
});

// ── Emails 9 & 10: Stripe webhook — payment received ─────────────────────────

describe('Emails 9 & 10 — Stripe webhook payment received', () => {
  it('sends receipt to client and notification to admin', async () => {
    const calls = captureResend();
    const STRIPE_SECRET = 'whsec_test123';
    const inv = {
      id: 'inv-2', project_id: 'proj-2', invoice_number: 'INV-0002', status: 'draft',
      client_name: 'Eve', client_email: 'eve@t.com',
      total_cents: 200000, magic_token: 'mag2',
    };
    // Provide a second unpaid invoice so this is treated as an intermediate (deposit)
    // payment rather than the final — client email subject stays "Payment received".
    const db = makeDb([inv], [{ id: 'inv-3' }]);
    const event = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { metadata: { invoice_id: 'inv-2' }, payment_status: 'paid', payment_intent: 'pi_123' } },
    });
    const sig = await makeStripeHeader(event, STRIPE_SECRET);
    await handleStripeWebhook(
      new Request('http://t/stripe/webhook', {
        method: 'POST',
        headers: { 'Stripe-Signature': sig },
        body: event,
      }),
      { DB: db, STRIPE_WEBHOOK_SECRET: STRIPE_SECRET, RESEND_API_KEY: 'key' }
    );
    const clientEmail = calls.find(c => c.to[0] === 'eve@t.com');
    const adminEmail  = calls.find(c => c.to[0] === 'thecoastaltravelcompany@gmail.com');
    expect(clientEmail.subject).toContain('Payment received');
    expect(clientEmail.html).toContain('$2000.00');
    expect(adminEmail.subject).toContain('INV-0002');
    expect(adminEmail.subject).toContain('Eve');
  });
});

// ── Email 11: Questionnaire link sent to client ───────────────────────────────

describe('Email 11 — questionnaire link sent to client', () => {
  it('sends questionnaire name in subject with complete button in html', async () => {
    const calls = captureResend();
    const qs   = { id: 'qs-1', name: 'Pre-Booking Survey', phase: 'pre-booking', questions: '[]' };
    const proj = { id: 'proj-3', client_name: 'Frank', client_email: 'frank@t.com' };
    const db   = makeDb([qs], [proj]); // Promise.all: setRes first, projRes second
    const token = await adminJWT();
    await handleAdminProjectQuestionnaires(
      jsonReq('POST', { set_id: 'qs-1' }, { Authorization: `Bearer ${token}` }),
      'POST',
      { DB: db, RESEND_API_KEY: 'key', JWT_SECRET: SECRET },
      'proj-3'
    );
    expect(calls[0].to).toEqual(['frank@t.com']);
    expect(calls[0].subject).toBe('Pre-Booking Survey — Coastal Travel Company');
    expect(calls[0].html).toContain('Complete Questionnaire');
  });
});

// ── Email 12: Questionnaire submitted — admin notification ────────────────────

describe('Email 12 — questionnaire submitted to admin', () => {
  it('sends client name and set name to admin inbox', async () => {
    const calls = captureResend();
    const qi = {
      id: 'qi-1', status: 'sent', set_name: 'Pre-Booking Survey',
      client_name: 'Grace', property: 'Villa', collection: 'Standard',
      questions: '[]', phase: 'pre-booking',
    };
    const db = makeDb([qi]);
    await handlePublicQuestionnaire(
      jsonReq('POST', { q1: 'Answer one' }),
      'POST',
      { DB: db, RESEND_API_KEY: 'key' },
      'tok-qi-1'
    );
    expect(calls[0].to).toEqual(['thecoastaltravelcompany@gmail.com']);
    expect(calls[0].subject).toContain('Questionnaire submitted');
    expect(calls[0].subject).toContain('Grace');
    expect(calls[0].html).toContain('Grace');
    expect(calls[0].html).toContain('Pre-Booking Survey');
  });
});

// ── Email 13: Scheduling link sent to client ──────────────────────────────────

describe('Email 13 — scheduling link sent to client', () => {
  it('sends scheduling link with correct subject and call-to-action', async () => {
    const calls = captureResend();
    const proj = { id: 'proj-4', client_name: 'Henry', client_email: 'henry@t.com' };
    const db   = makeDb([proj]);
    const token = await adminJWT();
    await handleAdminProjectScheduleLinks(
      jsonReq('POST', { link_type: 'discovery-call', duration_mins: 30 }, { Authorization: `Bearer ${token}` }),
      'POST',
      { DB: db, RESEND_API_KEY: 'key', JWT_SECRET: SECRET },
      'proj-4'
    );
    expect(calls[0].to).toEqual(['henry@t.com']);
    expect(calls[0].subject).toContain('Schedule your discovery call');
    expect(calls[0].html).toContain('Choose a Time');
  });
});

// ── Emails 14 & 15: Booking confirmed — client and admin ──────────────────────

describe('Emails 14 & 15 — booking confirmed', () => {
  it('sends calendar invite with iCal attachment to both client and admin', async () => {
    const calls = captureResend();
    const link = {
      id: 'sl-1', project_id: 'proj-5', link_type: 'discovery-call', duration_mins: 30,
      booked_at: '', client_email: 'ivan@t.com', client_name: 'Ivan', magic_token: 'sl-tok',
    };
    const db = makeDb([link]);
    await handlePublicSchedule(
      jsonReq('POST', { slot: '2026-06-15T10:00:00', notes: '' }),
      'POST',
      { DB: db, RESEND_API_KEY: 'key' },
      'sl-tok'
    );
    expect(calls.length).toBe(2);
    const clientEmail = calls.find(c => c.to[0] === 'ivan@t.com');
    const adminEmail  = calls.find(c => c.to[0] === 'thecoastaltravelcompany@gmail.com');
    expect(clientEmail.subject).toContain('Confirmed:');
    expect(clientEmail.html).toContain('confirmed!');
    expect(clientEmail.attachments[0].filename).toBe('invite.ics');
    expect(adminEmail.subject).toContain('Ivan');
    expect(adminEmail.attachments[0].filename).toBe('invite.ics');
  });
});

// ── Email 16: Role changed notification ──────────────────────────────────────

describe('Email 16 — role changed notification', () => {
  it('sends to affected user with old and new role in html', async () => {
    const calls = captureResend();
    const kv = makeKv({
      'user_id:target-id': 'target@t.com',
      'user:target@t.com': JSON.stringify({ id: 'target-id', email: 'target@t.com', role: 'client', galleries: [] }),
      'users_list':        JSON.stringify(['target@t.com']),
    });
    const token = await adminJWT({ id: 'admin-id' });
    await handleAdminUpdateUserRole(
      jsonReq('PUT', { role: 'admin' }, { Authorization: `Bearer ${token}` }),
      { KV: kv, RESEND_API_KEY: 'key', JWT_SECRET: SECRET },
      'target-id'
    );
    expect(calls[0].to).toEqual(['target@t.com']);
    expect(calls[0].subject).toBe('Your account has been updated — Coastal Travel Company');
    expect(calls[0].html).toContain('client');
    expect(calls[0].html).toContain('admin');
  });
});

// ── Email 17: Security alert — failed admin login ─────────────────────────────

describe('Email 17 — security alert', () => {
  it('sends alert to admin inbox with account email and IP address', async () => {
    const calls = captureResend();
    // count=2 → increment makes it 3 → hits ADMIN_ALERT_THRESHOLD
    const kv = makeKv({ 'brute:email:admin@t.com': '2', 'brute:ip:9.9.9.9': '0' });
    await recordLoginFailure('admin@t.com', '9.9.9.9', 'admin', kv, 'key');
    expect(calls[0].to).toEqual(['thecoastaltravelcompany@gmail.com']);
    expect(calls[0].subject).toContain('[Security] Failed admin login');
    expect(calls[0].subject).toContain('admin@t.com');
    expect(calls[0].html).toContain('admin@t.com');
    expect(calls[0].html).toContain('9.9.9.9');
  });
});

// ── Email 18: Portal message — admin notification ─────────────────────────────

describe('Email 18 — portal message to admin', () => {
  it('sends message content to admin inbox', async () => {
    const calls = captureResend();
    const tokenRow = { id: 'tok-portal', project_id: 'proj-6' };
    const proj     = { id: 'proj-6', client_name: 'Julia', client_email: 'julia@t.com', stage: 'Active' };
    // empty KV → getUser returns null → no auth required for unauthenticated portal
    const db = makeDb([tokenRow], [proj]);
    await handlePublicProjectPortal(
      jsonReq('POST', { content: 'When is the shoot?', sender_name: 'Julia' }),
      'POST',
      { DB: db, KV: makeKv(), RESEND_API_KEY: 'key' },
      'tok-portal'
    );
    expect(calls[0].to).toEqual(['thecoastaltravelcompany@gmail.com']);
    expect(calls[0].subject).toContain('New portal message');
    expect(calls[0].subject).toContain('Julia');
    expect(calls[0].html).toContain('When is the shoot?');
  });
});

// ── Email 19: Portal new project inquiry — admin notification ─────────────────

describe('Email 19 — portal project inquiry to admin', () => {
  it('sends property name and message to admin inbox', async () => {
    const calls = captureResend();
    const kv = makeKv({
      'user:kyle@t.com': JSON.stringify({ id: 'kyle-id', email: 'kyle@t.com', name: 'Kyle', role: 'client' }),
    });
    const db = makeDb([]); // no existing project for this client
    const token = await clientJWT('kyle@t.com', 'kyle-id');
    await handlePortalMyProject(
      jsonReq('POST', { property: 'Lake House', location: 'Tahoe', message: 'Ready to book!' }, { Authorization: `Bearer ${token}` }),
      'POST',
      { KV: kv, DB: db, RESEND_API_KEY: 'key', JWT_SECRET: SECRET }
    );
    expect(calls[0].to).toEqual(['thecoastaltravelcompany@gmail.com']);
    expect(calls[0].subject).toContain('New project inquiry');
    expect(calls[0].subject).toContain('Kyle');
    expect(calls[0].html).toContain('Lake House');
    expect(calls[0].html).toContain('Ready to book!');
  });
});
