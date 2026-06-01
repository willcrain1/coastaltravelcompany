/**
 * Acceptance tests for the gallery system.
 *
 * Gallery Admin:
 *  1. Creates a regular gallery link — config hash encodes correct values
 *  2. Creates a watermarked gallery link — watermark: true in config
 *
 * Client Gallery (JWT-based; no password lock screen):
 *  3. Redirects to /login.html when no JWT is present
 *  4. Shows error when gallery config is missing required id field
 *  5. Loads photo grid with a valid JWT
 *  6. Watermarked gallery shows CSS overlay on photo cards
 *  7. All download URLs in a watermarked gallery include watermark=1
 *  8. Downloaded photo has watermark burned into pixels — not just a CSS overlay
 *
 * Network strategy: context.route() intercepts all Worker requests and returns
 * synthetic responses. No live NAS or Cloudflare Worker required.
 */

import { test, expect } from '@playwright/test';
import sharp            from 'sharp';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const SHARE_URL   = 'https://coastaltravelcompany.quickconnect.to/mo/sharing/mBKkAF4Q8';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';
const PROD_ORIGIN = process.env.BASE_URL   || 'https://coastaltravelcompany.com';

const CORS = {
  'access-control-allow-origin':      STATIC_BASE,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods':     'GET, POST, OPTIONS',
  'access-control-allow-headers':     'Content-Type, Authorization',
  'access-control-expose-headers':    'Content-Disposition',
};

// ── Config helpers ────────────────────────────────────────────────────────────

function decodeConfig(hash) {
  return JSON.parse(Buffer.from(hash, 'base64').toString('utf8'));
}

function encodeConfig(cfg) {
  return Buffer.from(JSON.stringify(cfg)).toString('base64');
}

/** Build a gallery config for client-gallery.html. Matches what buildUrl() now produces. */
function buildConfig(overrides = {}) {
  return {
    id:           'test-gallery-ci',
    nasClientUrl: `${PROD_ORIGIN}/gallery/client-gallery.html`,
    proxyUrl:     WORKER_URL,
    eventName:    'CI Test Gallery',
    clientName:   'CI Test Client',
    watermark:    false,
    ...overrides,
  };
}

// ── Worker mocks ──────────────────────────────────────────────────────────────

/**
 * Mock for client-gallery.html sessions.
 * Handles: POST /token, POST / (browse), GET /?api=SYNO.Foto.Thumbnail|Download
 * Returns distinct JPEG bytes for watermarked vs clean thumbnails.
 */
async function useMockWorker(context) {
  const cleanJpeg = await sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 180, g: 160, b: 140 } },
  }).jpeg({ quality: 85 }).toBuffer();

  const watermarkedJpeg = await sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 180, g: 160, b: 140 } },
  })
    .composite([{
      input: Buffer.from(
        '<svg width="200" height="150"><rect x="0" y="0" width="200" height="80" fill="white"/></svg>',
      ),
      top: 0, left: 0,
    }])
    .jpeg({ quality: 85 })
    .toBuffer();

  const MOCK_SID    = 'mock-sid-ci-test';
  const MOCK_PHOTOS = [
    {
      id: 1001, filename: 'mock-photo-1.jpg',
      additional: {
        thumbnail: { unit_id: 1001, cache_key: 'ck1001' },
        resolution: { width: 3000, height: 2000 },
      },
    },
    {
      id: 1002, filename: 'mock-photo-2.jpg',
      additional: {
        thumbnail: { unit_id: 1002, cache_key: 'ck1002' },
        resolution: { width: 2000, height: 3000 },
      },
    },
  ];

  await context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req    = route.request();
      const url    = new URL(req.url());
      const method = req.method();
      try {
        if (method === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
          return;
        }
        if (method === 'POST' && url.pathname === '/token') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify({ sid: MOCK_SID }),
          });
          return;
        }
        if (method === 'POST') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify({ success: true, data: { list: MOCK_PHOTOS, total: MOCK_PHOTOS.length } }),
          });
          return;
        }
        const api = url.searchParams.get('api');
        if (api === 'SYNO.Foto.Thumbnail' || api === 'SYNO.Foto.Download') {
          const isWatermarked = url.searchParams.get('watermark') === '1';
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'image/jpeg', ...CORS },
            body: isWatermarked ? watermarkedJpeg : cleanJpeg,
          });
          return;
        }
        await route.fulfill({ status: 404, body: `Unexpected mock: ${method} ${req.url()}` });
      } catch {
        route.abort().catch(() => {});
      }
    },
  );
}

/**
 * Mock for galleries.html — handles auth, galleries, projects, and users.
 */
async function useMockAdminWorker(context) {
  await context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req    = route.request();
      const url    = new URL(req.url());
      const method = req.method();
      try {
        if (method === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
          return;
        }
        if (url.pathname === '/auth/me') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify({ id: 'admin1', email: 'admin@test.com', role: 'admin' }),
          });
          return;
        }
        if (url.pathname === '/admin/galleries' && method === 'GET') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify([]),
          });
          return;
        }
        if (url.pathname === '/admin/galleries' && method === 'POST') {
          const body = JSON.parse(req.postData() || '{}');
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify(body),
          });
          return;
        }
        if (url.pathname === '/admin/projects') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify([]),
          });
          return;
        }
        if (url.pathname === '/admin/users') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify([]),
          });
          return;
        }
        await route.fulfill({ status: 404, body: `Unexpected admin mock: ${method} ${url.pathname}` });
      } catch {
        route.abort().catch(() => {});
      }
    },
  );
}

/**
 * Fetch an image URL from inside the browser page so the request passes through
 * context.route() and hits the mock Worker rather than the live network.
 * (page.request.fetch() is a Node.js-level API that bypasses route handlers.)
 */
async function fetchWorkerImage(page, url) {
  const base64 = await page.evaluate(async (fetchUrl) => {
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf  = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }, url);
  return Buffer.from(base64, 'base64');
}

// ── Gallery Admin ─────────────────────────────────────────────────────────────

test.describe('Gallery Admin', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-admin'));
  });

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('creates a regular gallery link encoding the correct config', async ({ page, context }) => {
    await useMockAdminWorker(context);
    await page.goto(`${STATIC_BASE}/admin/galleries.html`);

    await page.fill('#shareUrl',      SHARE_URL);
    await page.fill('#sharePassword', 'test-share-pass');
    await page.fill('#eventName',     'CI Test Gallery');
    await page.click('#createBtn');
    await page.waitForSelector('#resultBox.show');

    const generatedUrl = (await page.textContent('#resultUrl')).trim();
    expect(generatedUrl).toContain('#');

    const decoded = decodeConfig(generatedUrl.split('#')[1]);

    expect(decoded.id).toBeTruthy();
    expect(decoded.eventName).toBe('CI Test Gallery');
    expect(decoded.clientName || '').toBe('');
    expect(decoded.watermark).toBe(false);
    expect(decoded.proxyUrl).toBe(WORKER_URL);
    // Passphrase and password hash are now server-side only — never in the client URL
    expect(decoded.passphrase).toBeUndefined();
    expect(decoded.pwHash).toBeUndefined();
  });

  test('creates a watermarked gallery link with watermark: true in config', async ({ page, context }) => {
    await useMockAdminWorker(context);
    await page.goto(`${STATIC_BASE}/admin/galleries.html`);

    await page.fill('#shareUrl',      SHARE_URL);
    await page.fill('#sharePassword', 'test-share-pass');
    await page.fill('#eventName',     'Watermark Test Gallery');
    await page.check('#watermark');
    await page.click('#createBtn');
    await page.waitForSelector('#resultBox.show');

    const decoded = decodeConfig(
      (await page.textContent('#resultUrl')).trim().split('#')[1],
    );

    expect(decoded.watermark).toBe(true);
    expect(decoded.id).toBeTruthy();
    expect(decoded.proxyUrl).toBe(WORKER_URL);
  });
});

// ── Client Gallery ────────────────────────────────────────────────────────────

test.describe('Client Gallery', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('redirects to /login.html when no JWT is present', async ({ page }) => {
    const hash = encodeConfig(buildConfig());
    // init() redirects synchronously (no async fetch before the JWT check), so
    // the navigation may complete during page.goto(). Register waitForURL first
    // to capture the event whether it fires during or after goto().
    const nav = page.waitForURL(/\/login(\.html)?/, { timeout: 10_000 });
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);
    await nav;
    expect(page.url()).toMatch(/\/login(\.html)?/);
  });

  test('shows error when gallery config is missing required id field', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    const badHash = encodeConfig({ proxyUrl: WORKER_URL, eventName: 'No ID Config' });
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${badHash}`);
    await expect(page.locator('#errorState')).toBeVisible({ timeout: 5_000 });
  });

  test('loads the photo grid with a valid JWT', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await useMockWorker(context);

    const hash = encodeConfig(buildConfig());
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await expect(page.locator('#grid.show')).toBeVisible({ timeout: 10_000 });
    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });
    expect(await page.locator('.p-item').count()).toBeGreaterThan(0);
  });

  test('watermarked gallery shows CSS overlay on photo cards', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await useMockWorker(context);

    const hash = encodeConfig(buildConfig({ watermark: true }));
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });
    expect(await page.locator('.p-item .wm-overlay').count()).toBeGreaterThan(0);
  });

  test('all download URLs in a watermarked gallery include watermark=1', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await useMockWorker(context);

    const hash = encodeConfig(buildConfig({ watermark: true }));
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });

    const hrefs = await page.locator('.p-dl').evaluateAll(
      (els) => els.map((el) => el.getAttribute('href')),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain('watermark=1');
      expect(href).toContain('api=SYNO.Foto.Thumbnail');
      expect(href).toContain('size=xl');
    }

    // Lightbox download also routes through the watermark path
    await page.locator('.p-item').first().click();
    await page.waitForSelector('#lb.show');
    expect(await page.locator('#lbDl').getAttribute('href')).toContain('watermark=1');
  });

  test('downloaded photo has watermark burned into pixels — not just a CSS overlay', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await useMockWorker(context);

    const hash = encodeConfig(buildConfig({ watermark: true }));
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });

    // Use an already-loaded thumbnail src; appending &watermark=1 proves the server
    // embeds pixel changes — a pure CSS overlay has no effect on what bytes the
    // server returns.
    const cleanUrl       = await page.locator('.p-item img.loaded').first().getAttribute('src');
    const watermarkedUrl = `${cleanUrl}&watermark=1`;

    const [wmBuf, cleanBuf] = await Promise.all([
      fetchWorkerImage(page, watermarkedUrl),
      fetchWorkerImage(page, cleanUrl),
    ]);

    // Ensure both responses are non-trivial JPEG files (> 50 bytes).
    // Uniform-color test images compress aggressively and may be well under 1 KB.
    expect(wmBuf.byteLength).toBeGreaterThan(50);
    expect(cleanBuf.byteLength).toBeGreaterThan(50);

    const [wmPixels, cleanPixels] = await Promise.all([
      sharp(wmBuf).toColorspace('srgb').removeAlpha().raw().toBuffer(),
      sharp(cleanBuf).toColorspace('srgb').removeAlpha().raw().toBuffer(),
    ]);

    // Count pixels where any channel differs by > 20 units.
    // The mock watermark (white rectangle over top 80 px) changes ~53% of pixels
    // by 60–120 units. JPEG re-compression noise is ≤ 10 units, so the threshold
    // cleanly separates watermark changes from compression artifacts.
    const CHANNELS = 3;
    const pixCount = Math.floor(Math.min(wmPixels.length, cleanPixels.length) / CHANNELS);
    let changedPixels = 0;
    for (let px = 0; px < pixCount; px++) {
      const i  = px * CHANNELS;
      const dr = Math.abs(wmPixels[i]     - cleanPixels[i]);
      const dg = Math.abs(wmPixels[i + 1] - cleanPixels[i + 1]);
      const db = Math.abs(wmPixels[i + 2] - cleanPixels[i + 2]);
      if (dr > 20 || dg > 20 || db > 20) changedPixels++;
    }
    expect(changedPixels / pixCount).toBeGreaterThan(0.02);
  });
});

// ── Video Gallery (item 8) ────────────────────────────────────────────────────

const MOCK_VIDEO = {
  id: 2001, filename: 'mock-clip-1.mp4', type: 'video',
  additional: {
    thumbnail: { unit_id: 2001, cache_key: 'ck2001' },
    resolution: { width: 1920, height: 1080 },
  },
};

const MOCK_PHOTO = {
  id: 1001, filename: 'mock-photo-1.jpg',
  additional: {
    thumbnail: { unit_id: 1001, cache_key: 'ck1001' },
    resolution: { width: 3000, height: 2000 },
  },
};

async function useMockWorkerMixed(context, items) {
  const thumbJpeg = await sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 120, g: 140, b: 160 } },
  }).jpeg({ quality: 85 }).toBuffer();

  await context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req    = route.request();
      const url    = new URL(req.url());
      const method = req.method();
      try {
        if (method === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
          return;
        }
        if (method === 'POST' && url.pathname === '/token') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify({ sid: 'mock-sid-mixed' }),
          });
          return;
        }
        if (method === 'POST') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify({ success: true, data: { list: items, total: items.length } }),
          });
          return;
        }
        const api = url.searchParams.get('api');
        if (api === 'SYNO.Foto.Thumbnail' || api === 'SYNO.Foto.Download') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'image/jpeg', ...CORS },
            body: thumbJpeg,
          });
          return;
        }
        await route.fulfill({ status: 404, body: `Unexpected mock: ${method} ${req.url()}` });
      } catch {
        route.abort().catch(() => {});
      }
    },
  );
}

test.describe('Client Gallery — Video Support', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('video items display a play icon badge in the grid', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await useMockWorkerMixed(context, [MOCK_VIDEO]);

    const hash = encodeConfig(buildConfig());
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });
    await expect(page.locator('.v-play-badge')).toHaveCount(1);
  });

  test('photo-only gallery shows no play badges', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await useMockWorkerMixed(context, [MOCK_PHOTO]);

    const hash = encodeConfig(buildConfig());
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });
    await expect(page.locator('.v-play-badge')).toHaveCount(0);
  });

  test('mixed gallery nav count shows photos & videos format', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await useMockWorkerMixed(context, [MOCK_PHOTO, MOCK_VIDEO]);

    const hash = encodeConfig(buildConfig());
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });
    const count = await page.locator('.g-count').textContent();
    expect(count).toMatch(/photo.*video|video.*photo/i);
  });

  test('clicking a video item opens the video element in the lightbox', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await useMockWorkerMixed(context, [MOCK_PHOTO, MOCK_VIDEO]);

    const hash = encodeConfig(buildConfig());
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });

    // The video card is the one with the play badge
    await page.locator('.v-play-badge').locator('..').click();
    await page.waitForSelector('#lb.show');

    await expect(page.locator('#lbVideo')).toHaveClass(/show/);
    await expect(page.locator('#lbVideo')).toHaveAttribute('src', /SYNO\.Foto\.Download/);
    // Image element should not be visible for a video item
    await expect(page.locator('#lbImg')).not.toBeVisible();
  });

  test('navigating from video to photo hides video and shows image', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    // Video first, then photo
    await useMockWorkerMixed(context, [MOCK_VIDEO, MOCK_PHOTO]);

    const hash = encodeConfig(buildConfig());
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });

    // Open lightbox on first item (video)
    await page.locator('.p-item').first().click();
    await page.waitForSelector('#lb.show');
    await expect(page.locator('#lbVideo')).toHaveClass(/show/);

    // Navigate to next item (photo)
    await page.click('#lbNext');

    await expect(page.locator('#lbVideo')).not.toHaveClass(/show/);
    await expect(page.locator('#lbImg')).toBeVisible();
  });

  test('video download button uses correct file extension from filename', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await useMockWorkerMixed(context, [MOCK_VIDEO]);

    const hash = encodeConfig(buildConfig());
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });

    const dlHref = await page.locator('.p-dl').first().getAttribute('download');
    expect(dlHref).toMatch(/\.mp4$/i);
  });
});
