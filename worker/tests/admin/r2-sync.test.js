import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleAdminGallerySyncR2 } from '../../src/admin/r2-sync.js';
import { createJWT } from '../../src/jwt.js';
import { sidCache } from '../../src/gallery-proxy.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';

function makeKv(galleries = {}) {
  const store = new Map();
  // Seed gallery entries
  for (const [id, g] of Object.entries(galleries)) {
    store.set('gallery:' + id, JSON.stringify(g));
    const raw  = store.get('galleries_list');
    const list = raw ? JSON.parse(raw) : [];
    if (!list.includes(id)) list.unshift(id);
    store.set('galleries_list', JSON.stringify(list));
  }
  return {
    get:    async (k) => store.get(k) ?? null,
    put:    async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };
}

function makeR2(store = new Map()) {
  return {
    get: async (key) => {
      const val = store.get(key);
      return val ? { body: new ReadableStream() } : null;
    },
    put: async (key, body) => { store.set(key, body); },
  };
}

async function adminToken() {
  return createJWT(
    { sub: 'admin@test.com', id: 'aid', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
  );
}

function makeReq(token, galleryId, offset = 0) {
  return new Request(`http://worker/admin/galleries/${galleryId}/sync-r2?offset=${offset}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

const GALLERY = {
  id: 'gal1', eventName: 'Test Gallery', passphrase: 'test-pass',
  sharePassword: null, r2_synced: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  // Clear the module-level NAS session cache so tests don't share state
  for (const key of Object.keys(sidCache)) delete sidCache[key];
});

describe('handleAdminGallerySyncR2', () => {
  it('401 when no auth token', async () => {
    const env = { KV: makeKv(), JWT_SECRET: SECRET };
    const r = await handleAdminGallerySyncR2(new Request('http://w', { method: 'POST' }), env, 'gal1');
    expect(r.status).toBe(401);
  });

  it('403 when caller is not admin', async () => {
    const token = await createJWT(
      { sub: 'c@t.com', id: 'cid', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    const env = { KV: makeKv(), JWT_SECRET: SECRET };
    const r = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    expect(r.status).toBe(403);
  });

  it('503 when ASSETS R2 bucket not bound', async () => {
    const token = await adminToken();
    const env = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET };
    const r = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/R2/i);
  });

  it('404 when gallery does not exist', async () => {
    const token = await adminToken();
    const env = { KV: makeKv(), JWT_SECRET: SECRET, ASSETS: makeR2() };
    const r = await handleAdminGallerySyncR2(makeReq(token, 'missing'), env, 'missing');
    expect(r.status).toBe(404);
  });

  it('502 when NAS session fails', async () => {
    const token = await adminToken();
    const env = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('NAS unreachable')));
    const r = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    expect(r.status).toBe(502);
  });

  it('syncs thumbnails and marks gallery r2_synced when done', async () => {
    const token = await adminToken();
    const r2Store = new Map();
    const env = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2(r2Store) };

    // sid login → list items → thumbnail fetch
    const mockJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ // getSharingSid: NAS share page
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({ // Browse.Item list
        ok: true,
        json: async () => ({ success: true, data: { list: [{ id: 42 }, { id: 43 }], total: 2 } }),
      })
      .mockResolvedValueOnce({ // Thumbnail id=42
        ok: true,
        headers: { get: (h) => h === 'Content-Type' ? 'image/jpeg' : null },
        arrayBuffer: async () => mockJpeg,
      })
      .mockResolvedValueOnce({ // Thumbnail id=43
        ok: true,
        headers: { get: (h) => h === 'Content-Type' ? 'image/jpeg' : null },
        arrayBuffer: async () => mockJpeg,
      }),
    );

    const r    = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    const body = await r.json();

    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.synced).toBe(2);
    expect(body.done).toBe(true);

    // R2 keys written
    expect(r2Store.has('galleries/gal1/thumbs/42.jpg')).toBe(true);
    expect(r2Store.has('galleries/gal1/thumbs/43.jpg')).toBe(true);

    // Gallery marked synced in KV
    const updated = JSON.parse(await env.KV.get('gallery:gal1'));
    expect(updated.r2_synced).toBe(true);
  });

  it('returns next_offset when more pages remain', async () => {
    const token = await adminToken();
    const env = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    const mockJpeg = new Uint8Array([0xff, 0xd8]).buffer;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({ // Browse.Item — 25 total, returning first 20
        ok: true,
        json: async () => ({
          success: true,
          data: { list: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })), total: 25 },
        }),
      })
      .mockResolvedValue({ // All thumbnails succeed
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => mockJpeg,
      }),
    );

    const r    = await handleAdminGallerySyncR2(makeReq(token, 'gal1', 0), env, 'gal1');
    const body = await r.json();

    expect(body.done).toBe(false);
    expect(body.next_offset).toBe(20);
    expect(body.total).toBe(25);
    // Not yet marked synced
    const updated = JSON.parse(await env.KV.get('gallery:gal1'));
    expect(updated.r2_synced).toBeFalsy();
  });

  it('skips failed thumbnail downloads without aborting the batch', async () => {
    const token = await adminToken();
    const env = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    const mockJpeg = new Uint8Array([0xff, 0xd8]).buffer;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { list: [{ id: 1 }, { id: 2 }], total: 2 } }),
      })
      .mockResolvedValueOnce({ ok: false, headers: { get: () => null }, arrayBuffer: async () => null })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => mockJpeg,
      }),
    );

    const r    = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    const body = await r.json();

    expect(body.ok).toBe(true);
    expect(body.synced).toBe(1);
    expect(body.failed).toBe(1);
  });

  it('counts failed when thumbnail fetch throws', async () => {
    const token = await adminToken();
    const env = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { list: [{ id: 1 }, { id: 2 }], total: 2 } }),
      })
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer,
      }),
    );

    const r    = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    const body = await r.json();

    expect(body.ok).toBe(true);
    expect(body.synced).toBe(1);
    expect(body.failed).toBe(1);
  });

  it('syncs video items to R2 videos/ path', async () => {
    const token   = await adminToken();
    const r2Store = new Map();
    const env     = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2(r2Store) };
    const mockJpeg = new Uint8Array([0xff, 0xd8]).buffer;

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { list: [{ id: 10, type: 'video' }], total: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => mockJpeg,
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'video/mp4' },
        body: new ReadableStream(),
      }),
    );

    const r    = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    const body = await r.json();

    expect(r.status).toBe(200);
    expect(body.videosSynced).toBe(1);
    expect(r2Store.has('galleries/gal1/videos/10')).toBe(true);
  });

  it('counts videosFailed when video download does not return video content-type', async () => {
    const token = await adminToken();
    const env   = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { list: [{ id: 11, type: 'video' }], total: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer,
      })
      .mockResolvedValueOnce({
        ok: false,
        headers: { get: () => null },
      }),
    );

    const r    = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    const body = await r.json();

    expect(body.videosFailed).toBe(1);
    expect(body.videosSynced).toBe(0);
  });

  it('returns done:true immediately when NAS returns empty list', async () => {
    const token = await adminToken();
    const env   = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { list: [], total: 5 } }),
      }),
    );

    const r    = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    const body = await r.json();

    expect(r.status).toBe(200);
    expect(body.done).toBe(true);
    expect(body.synced).toBe(0);
  });

  it('counts videosFailed when video download throws', async () => {
    const token = await adminToken();
    const env   = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { list: [{ id: 20, type: 'video' }], total: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer,
      })
      .mockRejectedValueOnce(new Error('video fetch failed')),
    );

    const r    = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    const body = await r.json();

    expect(body.videosFailed).toBe(1);
  });

  it('502 when NAS browse API returns success:false', async () => {
    const token = await adminToken();
    const env   = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, error: { code: 119 } }),
      }),
    );

    const r = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain('119');
  });

  it('counts failed when thumbnail ok=true but Content-Type is not image/', async () => {
    const token = await adminToken();
    const env   = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { list: [{ id: 99 }], total: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new Uint8Array([0]).buffer,
      }),
    );

    const r    = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    const body = await r.json();

    expect(body.failed).toBe(1);
    expect(body.synced).toBe(0);
  });

  it('done=true but nothing synced does not mark gallery as r2_synced', async () => {
    const token = await adminToken();
    const env   = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { list: [{ id: 5 }], total: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        headers: { get: () => null },
      }),
    );

    const r = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    expect((await r.json()).done).toBe(true);
    const updated = JSON.parse(await env.KV.get('gallery:gal1'));
    expect(updated.r2_synced).toBeFalsy();
  });

  it('502 when NAS browse list fetch throws', async () => {
    const token = await adminToken();
    const env   = { KV: makeKv({ gal1: GALLERY }), JWT_SECRET: SECRET, ASSETS: makeR2() };

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        headers: { get: (h) => h === 'set-cookie' ? 'sharing_sid=abc; Path=/' : null },
      })
      .mockRejectedValueOnce(new Error('list fetch failed')),
    );

    const r = await handleAdminGallerySyncR2(makeReq(token, 'gal1'), env, 'gal1');
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain('list fetch failed');
  });
});
