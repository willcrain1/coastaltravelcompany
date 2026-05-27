import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { handleContact } from '../src/contact.js';

const ORIGIN = 'https://coastaltravelcompany.com';

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    get:    (k)           => Promise.resolve(store.has(k) ? store.get(k) : null),
    put:    (k, v, _opts) => { store.set(k, v); return Promise.resolve(); },
    delete: (k)           => { store.delete(k); return Promise.resolve(); },
  };
}

function makeContactRequest(formData = {}, ip = '1.2.3.4') {
  const defaults = {
    'first-name': 'Alice',
    'last-name':  'Smith',
    email:        'alice@test.com',
    property:     'Beach House',
    location:     'Malibu',
    collection:   'Luxury',
    timeline:     '2025-06',
    message:      'I would like to book a shoot.',
  };
  const params = new URLSearchParams({ ...defaults, ...formData });
  const headers = {
    'Content-Type':     'application/x-www-form-urlencoded',
    'Origin':           ORIGIN,
    'CF-Connecting-IP': ip,
  };
  return new Request('https://worker.example.com/contact', {
    method:  'POST',
    headers,
    body:    params.toString(),
  });
}

describe('handleContact', () => {
  let kv;

  beforeEach(() => {
    kv = makeKv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns 429 when rate limit exceeded', async () => {
    kv._store.set('contact_rl:1.2.3.4', '5');
    const req = makeContactRequest();
    const res = await handleContact(req, { KV: kv, RESEND_API_KEY: 'key' });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/too many submissions/i);
  });

  it('returns 400 when first-name is missing', async () => {
    const req = makeContactRequest({ 'first-name': '' });
    const res = await handleContact(req, { KV: kv, RESEND_API_KEY: 'key' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required fields/i);
  });

  it('returns 400 when email is missing', async () => {
    const req = makeContactRequest({ email: '' });
    const res = await handleContact(req, { KV: kv, RESEND_API_KEY: 'key' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when message is missing', async () => {
    const req = makeContactRequest({ message: '' });
    const res = await handleContact(req, { KV: kv, RESEND_API_KEY: 'key' });
    expect(res.status).toBe(400);
  });

  it('returns 502 when Resend API fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const req = makeContactRequest();
    const res = await handleContact(req, { KV: kv, RESEND_API_KEY: 'key' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/failed to send/i);
  });

  it('returns 200 and calls Resend on success', async () => {
    const req = makeContactRequest();
    const res = await handleContact(req, { KV: kv, RESEND_API_KEY: 'key' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('increments rate-limit counter on success', async () => {
    const req = makeContactRequest();
    await handleContact(req, { KV: kv, RESEND_API_KEY: 'key' });
    expect(kv._store.get('contact_rl:1.2.3.4')).toBe('1');
  });

  it('attempts DB insert when env.DB is present', async () => {
    const mockRun = vi.fn().mockResolvedValue({ success: true });
    const mockBind = vi.fn().mockReturnValue({ run: mockRun });
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
    const db = { prepare: mockPrepare };
    const req = makeContactRequest();
    const res = await handleContact(req, { KV: kv, RESEND_API_KEY: 'key', DB: db });
    expect(res.status).toBe(200);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO projects'));
  });

  it('does not fail when DB insert throws', async () => {
    const mockRun = vi.fn().mockRejectedValue(new Error('DB error'));
    const mockBind = vi.fn().mockReturnValue({ run: mockRun });
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
    const db = { prepare: mockPrepare };
    const req = makeContactRequest();
    const res = await handleContact(req, { KV: kv, RESEND_API_KEY: 'key', DB: db });
    expect(res.status).toBe(200);
  });
});
