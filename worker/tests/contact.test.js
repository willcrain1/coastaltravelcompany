import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleContact } from '../src/contact.js';

function makeKv() {
  const store = new Map();
  return {
    get:    async (k)      => store.get(k) ?? null,
    put:    async (k, v)   => { store.set(k, v); },
    delete: async (k)      => { store.delete(k); },
  };
}

function makeReq(fields = {}, ip = '1.2.3.4') {
  const data = new URLSearchParams({
    'first-name': 'John', 'last-name': 'Doe',
    email: 'john@test.com', property: 'Beach House',
    location: 'Miami', collection: 'Standard',
    timeline: 'Q1', message: 'Hello there',
    ...fields,
  });
  return new Request('http://t/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip },
    body: data.toString(),
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('handleContact', () => {
  it('429 when rate limit is exhausted', async () => {
    const kv = makeKv();
    await kv.put('contact_rl:1.2.3.4', '5');
    const r = await handleContact(makeReq(), { KV: kv, RESEND_API_KEY: 'key' });
    expect(r.status).toBe(429);
  });

  it('400 when first-name is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const r = await handleContact(makeReq({ 'first-name': '' }), { KV: makeKv(), RESEND_API_KEY: 'key' });
    expect(r.status).toBe(400);
  });

  it('400 when email is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const r = await handleContact(makeReq({ email: '' }), { KV: makeKv(), RESEND_API_KEY: 'key' });
    expect(r.status).toBe(400);
  });

  it('400 when message is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const r = await handleContact(makeReq({ message: '' }), { KV: makeKv(), RESEND_API_KEY: 'key' });
    expect(r.status).toBe(400);
  });

  it('502 when Resend returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const r = await handleContact(makeReq(), { KV: makeKv(), RESEND_API_KEY: 'key' });
    expect(r.status).toBe(502);
  });

  it('200 and increments rate-limit counter on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const kv = makeKv();
    const r  = await handleContact(makeReq(), { KV: kv, RESEND_API_KEY: 'key' });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    expect(await kv.get('contact_rl:1.2.3.4')).toBe('1');
  });

  it('uses IP=unknown when CF-Connecting-IP header absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const kv = makeKv();
    const req = new Request('http://t/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'first-name': 'Jane', email: 'j@t.com', message: 'Hi' }).toString(),
    });
    await handleContact(req, { KV: kv, RESEND_API_KEY: 'key' });
    expect(await kv.get('contact_rl:unknown')).toBe('1');
  });

  it('writes project to DB when DB available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const runMock = vi.fn().mockResolvedValue({});
    const env = {
      KV: makeKv(), RESEND_API_KEY: 'key',
      DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run: runMock }) }) },
    };
    await handleContact(makeReq(), env);
    expect(runMock).toHaveBeenCalled();
  });

  it('does not fail when DB write throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const env = {
      KV: makeKv(), RESEND_API_KEY: 'key',
      DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run: vi.fn().mockRejectedValue(new Error('db err')) }) }) },
    };
    const r = await handleContact(makeReq(), env);
    expect(r.status).toBe(200);
  });

  it('stores clientName without lastName when last-name is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const runMock = vi.fn().mockResolvedValue({});
    const env = {
      KV: makeKv(), RESEND_API_KEY: 'key',
      DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run: runMock }) }) },
    };
    await handleContact(makeReq({ 'last-name': '' }), env);
    expect(runMock).toHaveBeenCalled();
  });

  it('includes escaping of HTML in email body (no XSS)', async () => {
    let capturedBody;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true });
    }));
    await handleContact(makeReq({ 'first-name': '<script>', message: 'hello<script>alert(1)</script>' }), { KV: makeKv(), RESEND_API_KEY: 'key' });
    expect(capturedBody.html).not.toContain('<script>alert');
    expect(capturedBody.html).toContain('&lt;script&gt;');
  });
});
