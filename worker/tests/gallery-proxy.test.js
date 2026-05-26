import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@cf-wasm/photon', () => ({
  PhotonImage: {
    new_from_byteslice: vi.fn(() => ({
      get_width:       () => 200,
      get_height:      () => 200,
      get_bytes_jpeg:  () => new Uint8Array([0xff, 0xd8, 0xff]),
      free:            vi.fn(),
    })),
  },
  draw_text_with_border: vi.fn(),
}));

import {
  extractPassphrase, checkRateLimit, getSharingSid,
  applyWatermark, handleTokenExchange, handleNasProxy, sidCache,
} from '../src/gallery-proxy.js';
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

beforeEach(() => {
  Object.keys(sidCache).forEach(k => delete sidCache[k]);
});
afterEach(() => { vi.unstubAllGlobals(); });

// ── extractPassphrase ─────────────────────────────────────────────────────────

describe('extractPassphrase', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(extractPassphrase(null)).toBe('');
    expect(extractPassphrase(undefined)).toBe('');
    expect(extractPassphrase('')).toBe('');
  });
  it('unquotes JSON-string passphrase', () => {
    expect(extractPassphrase('"vCsa5XjJH"')).toBe('vCsa5XjJH');
  });
  it('returns raw value when not JSON-quoted', () => {
    expect(extractPassphrase('vCsa5XjJH')).toBe('vCsa5XjJH');
  });
  it('returns as-is when JSON parse would fail', () => {
    expect(extractPassphrase('"unclosed')).toBe('"unclosed');
  });
});

// ── checkRateLimit ────────────────────────────────────────────────────────────

describe('checkRateLimit', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('allows the first request', async () => {
    expect(await checkRateLimit('p1', kv)).toBe(true);
  });
  it('increments counter on each call', async () => {
    for (let i = 0; i < 5; i++) await checkRateLimit('p2', kv);
    expect(Number(await kv.get('rl:p2'))).toBe(5);
  });
  it('blocks when count is exactly RATE_LIMIT (300)', async () => {
    await kv.put('rl:p3', '300');
    expect(await checkRateLimit('p3', kv)).toBe(false);
  });
  it('allows when count is 299', async () => {
    await kv.put('rl:p4', '299');
    expect(await checkRateLimit('p4', kv)).toBe(true);
  });
});

// ── getSharingSid ─────────────────────────────────────────────────────────────

describe('getSharingSid', () => {
  it('returns cached entry without fetching', async () => {
    sidCache['cached-pass'] = { cookie: 'sharing_sid=abc', sid: 'abc', exp: Date.now() + 9999999 };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await getSharingSid('cached-pass');
    expect(result.sid).toBe('abc');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches NAS page when no cache and no sharePassword', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=xyz123; Path=/' : null },
    }));
    const result = await getSharingSid('uncached-pass');
    expect(result.sid).toBe('xyz123');
    expect(sidCache['uncached-pass']).toBeTruthy();
  });

  it('throws when NAS page returns no session cookie', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      headers: { get: () => null },
    }));
    await expect(getSharingSid('noSid-pass')).rejects.toThrow('no session cookie');
  });

  it('uses login API when sharePassword is provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=loginSid; Path=/' : null },
    }));
    const result = await getSharingSid('locked-pass', 'pw123');
    expect(result.sid).toBe('loginSid');
  });

  it('falls back to JSON body when set-cookie is empty during password login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json:   async () => ({ success: true, data: { sid: 'jsonSid' } }),
    }));
    const result = await getSharingSid('locked-pass2', 'pw456');
    expect(result.sid).toBe('jsonSid');
  });

  it('throws when password login returns no session at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json:   async () => ({ success: false, error: { code: 403 } }),
    }));
    await expect(getSharingSid('locked-fail', 'badpw')).rejects.toThrow('Share login returned no session');
  });
});

// ── applyWatermark ────────────────────────────────────────────────────────────

describe('applyWatermark', () => {
  it('returns a Uint8Array', async () => {
    const result = await applyWatermark(new ArrayBuffer(100));
    expect(result).toBeInstanceOf(Uint8Array);
  });
});

// ── handleTokenExchange ───────────────────────────────────────────────────────

describe('handleTokenExchange', () => {
  it('401 when not authenticated', async () => {
    const r = await handleTokenExchange(new Request('http://t/token', { method: 'POST', body: 'galleryId=g1' }), { KV: makeKv() });
    expect(r.status).toBe(401);
  });

  it('400 when galleryId is missing', async () => {
    const kv    = makeKv();
    const token = await createJWT({ sub: 'a@b.com', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t/token', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '' });
    const r     = await handleTokenExchange(req, { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(400);
  });

  it('404 when gallery not found', async () => {
    const kv    = makeKv();
    const token = await createJWT({ sub: 'a@b.com', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t/token', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'galleryId=nope' });
    const r     = await handleTokenExchange(req, { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(404);
  });

  it('403 when client is not assigned to gallery', async () => {
    const kv = makeKv();
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', passphrase: 'pass', assignedUsers: [] }));
    const token = await createJWT({ sub: 'client@test.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t/token', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'galleryId=g1' });
    const r     = await handleTokenExchange(req, { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(403);
  });

  it('500 when gallery has no passphrase configured', async () => {
    const kv = makeKv();
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', passphrase: '', assignedUsers: [] }));
    const token = await createJWT({ sub: 'admin@test.com', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t/token', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'galleryId=g1' });
    const r     = await handleTokenExchange(req, { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(500);
  });

  it('returns sid when admin exchanges valid gallery token', async () => {
    const kv = makeKv();
    sidCache['validpass'] = { cookie: 'sharing_sid=sid1', sid: 'sid1', exp: Date.now() + 9999999 };
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', passphrase: 'validpass', assignedUsers: [] }));
    const token = await createJWT({ sub: 'admin@test.com', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t/token', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'galleryId=g1' });
    const r     = await handleTokenExchange(req, { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    expect((await r.json()).sid).toBeTruthy();
  });

  it('401 when getSharingSid throws', async () => {
    const kv = makeKv();
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', passphrase: 'failpass', assignedUsers: [] }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ headers: { get: () => null } }));
    const token = await createJWT({ sub: 'admin@test.com', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t/token', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'galleryId=g1' });
    const r     = await handleTokenExchange(req, { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(401);
  });

  it('allows assigned client to exchange token', async () => {
    const kv = makeKv();
    sidCache['clientpass'] = { cookie: 'sharing_sid=s2', sid: 's2', exp: Date.now() + 9999999 };
    await kv.put('gallery:g2', JSON.stringify({ id: 'g2', passphrase: 'clientpass', assignedUsers: ['client@test.com'] }));
    const token = await createJWT({ sub: 'client@test.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req   = new Request('http://t/token', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'galleryId=g2' });
    const r     = await handleTokenExchange(req, { KV: kv, JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
  });
});

// ── handleNasProxy ────────────────────────────────────────────────────────────

describe('handleNasProxy', () => {
  it('400 when no passphrase or sid', async () => {
    const r = await handleNasProxy(new Request('http://t?api=SYNO.Foto.Browse.Item'), { KV: makeKv() });
    expect(r.status).toBe(400);
  });

  it('401 when sid not found in KV', async () => {
    const r = await handleNasProxy(new Request('http://t?sid=deadbeef&api=SYNO.Foto.Browse.Item'), { KV: makeKv() });
    expect(r.status).toBe(401);
  });

  it('403 when API method not on allowlist', async () => {
    const kv = makeKv();
    await kv.put('rl:pp', '0');
    const r = await handleNasProxy(new Request('http://t?passphrase=pp&api=SYNO.Foto.Delete'), { KV: kv });
    expect(r.status).toBe(403);
  });

  it('429 when rate limit exceeded', async () => {
    const kv = makeKv();
    await kv.put('rl:ratedpass', '300');
    const r = await handleNasProxy(new Request('http://t?passphrase=ratedpass&api=SYNO.Foto.Browse.Item'), { KV: kv });
    expect(r.status).toBe(429);
  });

  it('502 when NAS session fails', async () => {
    const kv = makeKv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ headers: { get: () => null } }));
    const r = await handleNasProxy(new Request('http://t?passphrase=failnaspass&api=SYNO.Foto.Browse.Item'), { KV: kv });
    expect(r.status).toBe(502);
  });

  it('proxies a successful GET response from NAS', async () => {
    const kv = makeKv();
    sidCache['proxypass'] = { cookie: 'sharing_sid=s3', sid: 's3', exp: Date.now() + 9999999 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: (h) => h === 'Content-Type' ? 'application/json' : null },
      arrayBuffer: async () => new ArrayBuffer(10),
    }));
    const r = await handleNasProxy(new Request('http://t?passphrase=proxypass&api=SYNO.Foto.Browse.Item'), { KV: kv });
    expect(r.status).toBe(200);
  });

  it('streams video responses', async () => {
    const kv = makeKv();
    sidCache['videopass'] = { cookie: 'sharing_sid=s4', sid: 's4', exp: Date.now() + 9999999 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      body:    new ReadableStream(),
      headers: { get: (h) => h === 'Content-Type' ? 'video/mp4' : null },
    }));
    const r = await handleNasProxy(new Request('http://t?passphrase=videopass&api=SYNO.Foto.Streaming'), { KV: kv });
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('video/mp4');
  });

  it('applies watermark for watermark=1 on image response', async () => {
    const kv = makeKv();
    sidCache['wmpass'] = { cookie: 'sharing_sid=s5', sid: 's5', exp: Date.now() + 9999999 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: (h) => h === 'Content-Type' ? 'image/jpeg' : null },
      arrayBuffer: async () => new ArrayBuffer(50),
    }));
    const r = await handleNasProxy(new Request('http://t?passphrase=wmpass&api=SYNO.Foto.Thumbnail&watermark=1'), { KV: kv });
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('502 when fetch to NAS throws', async () => {
    const kv = makeKv();
    sidCache['errpass'] = { cookie: 'sharing_sid=s6', sid: 's6', exp: Date.now() + 9999999 };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const r = await handleNasProxy(new Request('http://t?passphrase=errpass&api=SYNO.Foto.Browse.Item'), { KV: kv });
    expect(r.status).toBe(502);
  });

  it('handles POST request with sid from KV', async () => {
    const kv = makeKv();
    await kv.put('tok:mysid', JSON.stringify({ passphrase: 'storedpass', sharePassword: null }));
    sidCache['storedpass'] = { cookie: 'sharing_sid=s7', sid: 's7', exp: Date.now() + 9999999 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: (h) => h === 'Content-Type' ? 'application/json' : null },
      arrayBuffer: async () => new ArrayBuffer(5),
    }));
    const r = await handleNasProxy(
      new Request('http://t', { method: 'POST', body: 'sid=mysid&api=SYNO.Foto.Browse.Item', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
      { KV: kv },
    );
    expect(r.status).toBe(200);
  });

  it('handles legacy plaintext passphrase stored in tok: key', async () => {
    const kv = makeKv();
    await kv.put('tok:oldsid', 'legacypass');
    sidCache['legacypass'] = { cookie: 'sharing_sid=s8', sid: 's8', exp: Date.now() + 9999999 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: (h) => h === 'Content-Type' ? 'application/json' : null },
      arrayBuffer: async () => new ArrayBuffer(5),
    }));
    const r = await handleNasProxy(
      new Request('http://t?sid=oldsid&api=SYNO.Foto.Browse.Item'),
      { KV: kv },
    );
    expect(r.status).toBe(200);
  });

  it('passes Range header to NAS', async () => {
    const kv = makeKv();
    sidCache['rangepass'] = { cookie: 'sharing_sid=s9', sid: 's9', exp: Date.now() + 9999999 };
    let capturedHeaders;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      capturedHeaders = opts.headers;
      return Promise.resolve({
        status: 206,
        headers: { get: (h) => h === 'Content-Type' ? 'image/jpeg' : null },
        arrayBuffer: async () => new ArrayBuffer(5),
      });
    }));
    await handleNasProxy(
      new Request('http://t?passphrase=rangepass&api=SYNO.Foto.Thumbnail', { headers: { Range: 'bytes=0-1023' } }),
      { KV: kv },
    );
    expect(capturedHeaders['Range']).toBe('bytes=0-1023');
  });

  it('falls through to plain response when applyWatermark throws', async () => {
    const { PhotonImage } = await import('@cf-wasm/photon');
    vi.mocked(PhotonImage.new_from_byteslice).mockImplementationOnce(() => { throw new Error('photon failed'); });
    const kv = makeKv();
    sidCache['throwpass'] = { cookie: 'sharing_sid=s99', sid: 's99', exp: Date.now() + 9999999 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: (h) => h === 'Content-Type' ? 'image/jpeg' : null },
      arrayBuffer: async () => new ArrayBuffer(50),
    }));
    const r = await handleNasProxy(new Request('http://t?passphrase=throwpass&api=SYNO.Foto.Thumbnail&watermark=1'), { KV: kv });
    expect(r.status).toBe(200);
  });
});
