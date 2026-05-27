import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createJWT } from '../src/jwt.js';

// Mock photon WASM — not available in Node
vi.mock('@cf-wasm/photon', () => ({
  PhotonImage:          { new_from_byteslice: vi.fn() },
  draw_text_with_border: vi.fn(),
}));

// Mock brute-force module
vi.mock('../src/brute-force.js', () => ({
  checkLoginBruteForce:         vi.fn().mockResolvedValue({ locked: false }),
  recordLoginFailure:           vi.fn().mockResolvedValue(undefined),
  clearLoginCounters:           vi.fn().mockResolvedValue(undefined),
  checkResetBruteForce:         vi.fn().mockResolvedValue({ locked: false }),
  recordResetAttempt:           vi.fn().mockResolvedValue(undefined),
  checkGalleryUnlockBruteForce: vi.fn().mockResolvedValue(false),
  recordGalleryUnlockFailure:   vi.fn().mockResolvedValue(undefined),
  clearGalleryUnlockCounter:    vi.fn().mockResolvedValue(undefined),
}));

import { checkRateLimit, handleTokenExchange } from '../src/gallery-proxy.js';
import {
  checkGalleryUnlockBruteForce,
  recordGalleryUnlockFailure,
  clearGalleryUnlockCounter,
} from '../src/brute-force.js';

const SECRET = 'test-secret-32-chars-long-enough!';
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

function makeEnv(kv, overrides = {}) {
  return { KV: kv, JWT_SECRET: SECRET, ...overrides };
}

async function signToken(payload) {
  const now = Math.floor(Date.now() / 1000);
  return createJWT({ iat: now, exp: now + 3600, ...payload }, SECRET);
}

function makeTokenRequest(body = '', token = null, ip = '1.2.3.4') {
  const headers = {
    'Content-Type':     'application/x-www-form-urlencoded',
    'Origin':           ORIGIN,
    'CF-Connecting-IP': ip,
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return new Request('https://worker.example.com/token', {
    method:  'POST',
    headers,
    body,
  });
}

describe('checkRateLimit', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('returns true below the rate limit', async () => {
    const allowed = await checkRateLimit('test-passphrase', kv);
    expect(allowed).toBe(true);
  });

  it('returns false at the rate limit (300)', async () => {
    kv._store.set('rl:test-passphrase', '300');
    const allowed = await checkRateLimit('test-passphrase', kv);
    expect(allowed).toBe(false);
  });

  it('increments the counter on each successful check', async () => {
    await checkRateLimit('test-passphrase', kv);
    const count = kv._store.get('rl:test-passphrase');
    expect(count).toBe('1');
  });

  it('returns true at 299 (one below limit)', async () => {
    kv._store.set('rl:test-passphrase', '299');
    const allowed = await checkRateLimit('test-passphrase', kv);
    expect(allowed).toBe(true);
  });
});

describe('handleTokenExchange', () => {
  let kv;

  beforeEach(() => {
    kv = makeKv();
    vi.mocked(checkGalleryUnlockBruteForce).mockResolvedValue(false);
    vi.mocked(recordGalleryUnlockFailure).mockResolvedValue(undefined);
    vi.mocked(clearGalleryUnlockCounter).mockResolvedValue(undefined);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it('returns 401 when no JWT is present', async () => {
    const req = makeTokenRequest('galleryId=g1');
    const res = await handleTokenExchange(req, makeEnv(kv));
    expect(res.status).toBe(401);
  });

  it('returns 429 when gallery IP is blocked', async () => {
    vi.mocked(checkGalleryUnlockBruteForce).mockResolvedValue(true);
    const token = await signToken({ sub: 'user@test.com', id: 'uid', role: 'client' });
    const req   = makeTokenRequest('galleryId=g1', token);
    const res   = await handleTokenExchange(req, makeEnv(kv));
    expect(res.status).toBe(429);
  });

  it('returns 400 when galleryId is missing', async () => {
    const token = await signToken({ sub: 'user@test.com', id: 'uid', role: 'admin' });
    const req   = makeTokenRequest('', token);
    const res   = await handleTokenExchange(req, makeEnv(kv));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing galleryid/i);
  });

  it('returns 404 when gallery not found', async () => {
    const token = await signToken({ sub: 'user@test.com', id: 'uid', role: 'admin' });
    const req   = makeTokenRequest('galleryId=nonexistent', token);
    const res   = await handleTokenExchange(req, makeEnv(kv));
    expect(res.status).toBe(404);
  });

  it('returns 403 when client user is not assigned to gallery', async () => {
    kv._store.set('gallery:g1', JSON.stringify({
      id: 'g1', passphrase: 'pp', assignedUsers: ['other@test.com'],
    }));
    const token = await signToken({ sub: 'user@test.com', id: 'uid', role: 'client' });
    const req   = makeTokenRequest('galleryId=g1', token);
    const res   = await handleTokenExchange(req, makeEnv(kv));
    expect(res.status).toBe(403);
  });

  it('returns 401 and records failure when getSharingSid throws', async () => {
    kv._store.set('gallery:g1', JSON.stringify({
      id: 'g1', passphrase: 'bad-pp', assignedUsers: [],
    }));
    // Mock getSharingSid via module internals — sidCache miss triggers a fetch call
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('NAS unreachable')));
    const token = await signToken({ sub: 'admin@test.com', id: 'uid', role: 'admin' });
    const req   = makeTokenRequest('galleryId=g1', token);
    const res   = await handleTokenExchange(req, makeEnv(kv));
    vi.unstubAllGlobals();
    expect(res.status).toBe(401);
    expect(vi.mocked(recordGalleryUnlockFailure)).toHaveBeenCalledOnce();
  });

  it('returns 200 with sid and clears counter when admin user accesses assigned gallery', async () => {
    kv._store.set('gallery:g1', JSON.stringify({
      id: 'g1', passphrase: 'valid-pp', assignedUsers: ['admin@test.com'],
    }));
    // Mock getSharingSid to succeed by providing a fake NAS response
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h) => h === 'set-cookie' ? 'sharing_sid=test-sid; Path=/' : null,
      },
    }));
    const token = await signToken({ sub: 'admin@test.com', id: 'uid', role: 'admin' });
    const req   = makeTokenRequest('galleryId=g1', token);
    const res   = await handleTokenExchange(req, makeEnv(kv));
    vi.unstubAllGlobals();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sid).toBeTruthy();
    expect(vi.mocked(clearGalleryUnlockCounter)).toHaveBeenCalledOnce();
  });
});
