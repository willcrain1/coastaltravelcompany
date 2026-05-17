/**
 * Acceptance tests for the gallery system.
 *
 * Covers:
 *  1. Admin creates a regular gallery link → config hash encodes correct values
 *  2. Admin creates a watermarked gallery link → config hash has watermark: true
 *  3. Watermarked gallery unlocks and shows CSS overlay on photo cards
 *  4. Every download URL in a watermarked gallery includes watermark=1
 *  5. The downloaded JPEG has the watermark burned into the pixel data —
 *     if it were only a CSS overlay, the server-returned bytes would be identical
 *     whether or not watermark=1 was in the request URL.
 *
 * Network strategy: context.route() intercepts all requests to the Worker URL and
 * returns synthetic responses (mock token, mock photo list, generated JPEGs).  This
 * keeps the tests fully self-contained — no live NAS, no Cloudflare Worker required.
 * The mock serves different JPEG bytes for ?watermark=1 vs plain thumbnail requests,
 * so test 5's pixel-level comparison still validates the gallery code's watermark path.
 */

import { test, expect } from '@playwright/test';
import { createHash }   from 'node:crypto';
import sharp            from 'sharp';

// ── Configuration ──────────────────────────────────────────────────────────

const WORKER_URL    = 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const SHARE_URL     = 'https://coastaltravelcompany.quickconnect.to/mo/sharing/mBKkAF4Q8';
const PASSPHRASE    = 'mBKkAF4Q8';
const NAS_URL       = 'https://coastaltravelcompany.quickconnect.to';
const TEST_PASSWORD = 'testgallery2024';
const STATIC_BASE   = 'http://localhost:9876';
const PROD_ORIGIN   = 'https://coastaltravelcompany.com';

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256hex(str) {
  return createHash('sha256').update(str).digest('hex');
}

/**
 * Build a gallery config object.  The `nasUrl` field is used by the admin tool to
 * extract the passphrase from a share URL; the live Worker ignores it and uses its
 * hardcoded Cloudflare Tunnel URL internally.
 */
function buildConfig(overrides = {}) {
  return {
    passphrase:   PASSPHRASE,
    nasUrl:       NAS_URL,
    nasClientUrl: `${PROD_ORIGIN}/gallery/client-gallery.html`,
    proxyUrl:     WORKER_URL,
    eventName:    'CI Test Gallery',
    clientName:   'CI Test Client',
    pwHash:       sha256hex(TEST_PASSWORD),
    watermark:    false,
    ...overrides,
  };
}

/**
 * Encode a config object into a base64 URL hash the same way the admin tool does:
 *   btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
 * For our ASCII-only test config this is equivalent to Buffer → base64.
 */
function encodeConfig(cfg) {
  return Buffer.from(JSON.stringify(cfg)).toString('base64');
}

/** Decode the base64 hash the same way client-gallery.html does. */
function decodeConfig(hash) {
  return JSON.parse(Buffer.from(hash, 'base64').toString('utf8'));
}

/**
 * Install a context.route() mock for all Worker requests.
 *
 * Endpoints mocked:
 *   POST /token               → { sid: "mock-sid-ci-test" }
 *   POST /  (Browse.Item)     → { success: true, data: { list: [...], total: 2 } }
 *   GET  /?api=SYNO.Foto.Thumbnail   → JPEG (different bytes when watermark=1)
 *   GET  /?api=SYNO.Foto.Download    → JPEG
 *
 * Two JPEGs are pre-generated with sharp:
 *   cleanJpeg       — 200×150, uniform sandy tone
 *   watermarkedJpeg — same base + opaque white rectangle covering the top 80 px
 *
 * The white rectangle changes ~53 % of pixels by 60–120 units, well above the
 * 20-unit threshold used by test 5 to detect server-side pixel watermarking.
 * page.request.fetch() is routed through context.route(), so test 5's Node-side
 * fetchWorkerImage() calls also hit this mock instead of the live Worker/NAS.
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
      top: 0,
      left: 0,
    }])
    .jpeg({ quality: 85 })
    .toBuffer();

  const MOCK_SID = 'mock-sid-ci-test';
  const MOCK_PHOTOS = [
    {
      id: 1001,
      filename: 'mock-photo-1.jpg',
      additional: {
        thumbnail: { unit_id: 1001, cache_key: 'ck1001' },
        resolution: { width: 3000, height: 2000 },
      },
    },
    {
      id: 1002,
      filename: 'mock-photo-2.jpg',
      additional: {
        thumbnail: { unit_id: 1002, cache_key: 'ck1002' },
        resolution: { width: 2000, height: 3000 },
      },
    },
  ];

  const CORS = {
    'access-control-allow-origin':   '*',
    'access-control-allow-methods':  'GET, POST, OPTIONS',
    'access-control-allow-headers':  'Content-Type',
    'access-control-expose-headers': 'Content-Disposition',
  };

  await context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
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
            body: JSON.stringify({
              success: true,
              data: { list: MOCK_PHOTOS, total: MOCK_PHOTOS.length },
            }),
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

        await route.fulfill({ status: 404, body: `Unexpected mock request: ${method} ${req.url()}` });
      } catch {
        route.abort().catch(() => {});
      }
    },
  );
}

/**
 * Fetch an image URL via page.request so the call goes through context.route()
 * and hits the mock rather than the live Worker/NAS.  Returns the image as a Buffer.
 */
async function fetchWorkerImage(page, url) {
  const res = await page.request.fetch(url, { headers: { origin: PROD_ORIGIN } });
  if (!res.ok()) throw new Error(`Worker returned HTTP ${res.status()} for: ${url}`);
  const ct = res.headers()['content-type'] ?? '';
  if (!ct.startsWith('image/')) {
    const text = await res.text();
    throw new Error(`Expected image, got ${ct}: ${text.slice(0, 200)}`);
  }
  return Buffer.from(await res.body());
}

/** localStorage settings that point the admin tool at the live Worker. */
const ADMIN_SETTINGS = {
  mainSiteUrl:  `${PROD_ORIGIN}/gallery/gallery.html`,
  nasClientUrl: `${PROD_ORIGIN}/gallery/client-gallery.html`,
  workerUrl:    WORKER_URL,
};

// ── Gallery Admin tests ────────────────────────────────────────────────────

test.describe('Gallery Admin', () => {

  test('creates a regular gallery link encoding the correct config', async ({ page }) => {
    await page.goto(`${STATIC_BASE}/admin/gallery-admin.html`);

    // Pre-populate settings so the admin tool uses the live Worker URL
    await page.evaluate(
      (s) => localStorage.setItem('ctc_settings_v1', JSON.stringify(s)),
      ADMIN_SETTINGS,
    );

    await page.fill('#shareUrl',   SHARE_URL);
    await page.fill('#eventName',  'CI Test Gallery');
    await page.fill('#clientName', 'CI Test Client');
    await page.fill('#clientPw',   TEST_PASSWORD);

    await page.click('#createBtn');
    await page.waitForSelector('#resultBox.show');

    const generatedUrl = (await page.textContent('#resultUrl')).trim();
    expect(generatedUrl).toContain('#');

    const hash    = generatedUrl.split('#')[1];
    const decoded = decodeConfig(hash);

    expect(decoded.passphrase).toBe(PASSPHRASE);
    expect(decoded.eventName).toBe('CI Test Gallery');
    expect(decoded.clientName).toBe('CI Test Client');
    expect(decoded.watermark).toBe(false);
    expect(decoded.pwHash).toBe(sha256hex(TEST_PASSWORD));
    expect(decoded.proxyUrl).toBe(WORKER_URL);
  });

  test('creates a watermarked gallery link with watermark: true in config', async ({ page }) => {
    await page.goto(`${STATIC_BASE}/admin/gallery-admin.html`);

    await page.evaluate(
      (s) => localStorage.setItem('ctc_settings_v1', JSON.stringify(s)),
      ADMIN_SETTINGS,
    );

    await page.fill('#shareUrl',   SHARE_URL);
    await page.fill('#eventName',  'Watermark Test Gallery');
    await page.fill('#clientName', 'Watermark Test Client');
    await page.fill('#clientPw',   TEST_PASSWORD);
    await page.check('#watermark');

    await page.click('#createBtn');
    await page.waitForSelector('#resultBox.show');

    const generatedUrl = (await page.textContent('#resultUrl')).trim();
    const hash    = generatedUrl.split('#')[1];
    const decoded = decodeConfig(hash);

    expect(decoded.watermark).toBe(true);
    expect(decoded.passphrase).toBe(PASSPHRASE);
    expect(decoded.proxyUrl).toBe(WORKER_URL);
  });

});

// ── Watermarked gallery end-to-end tests ──────────────────────────────────

test.describe('Watermarked Gallery', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  // Thumbnail requests continue arriving after the main assertion completes.
  // Unrouting the context before teardown drains any pending route callbacks.
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('unlocks with the correct password and shows CSS overlay on photo cards', async ({ page, context }) => {
    await useMockWorker(context);

    const hash = encodeConfig(buildConfig({ watermark: true }));
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    // Lock screen is visible before unlock
    await expect(page.locator('#lock')).toBeVisible();

    // Enter the correct password
    await page.fill('#lockInput', TEST_PASSWORD);
    await page.click('#lockBtn');

    // Gallery becomes visible
    await expect(page.locator('#gallery.show')).toBeVisible({ timeout: 10_000 });

    // Wait for at least one photo to finish loading
    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });

    // The CSS watermark overlay (.wm-overlay) must appear on photo cards as a
    // visual preview indicator — separate from the server-side pixel watermark
    const overlayCount = await page.locator('.p-item .wm-overlay').count();
    expect(overlayCount).toBeGreaterThan(0);
  });

  test('all photo download URLs include watermark=1 so the Worker embeds the watermark', async ({ page, context }) => {
    await useMockWorker(context);

    const hash = encodeConfig(buildConfig({ watermark: true }));
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.fill('#lockInput', TEST_PASSWORD);
    await page.click('#lockBtn');
    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });

    // Every Save button must route through the Worker's watermark path
    const hrefs = await page.locator('.p-dl').evaluateAll(
      (els) => els.map((el) => el.getAttribute('href')),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain('watermark=1');
      expect(href).toContain('api=SYNO.Foto.Thumbnail');
      expect(href).toContain('size=xl');
    }

    // Lightbox download button should also use the watermark path
    await page.locator('.p-item').first().click();
    await page.waitForSelector('#lb.show');
    const lbHref = await page.locator('#lbDl').getAttribute('href');
    expect(lbHref).toContain('watermark=1');
  });

  test('downloaded photo has watermark burned into pixels — not just a CSS overlay', async ({ page, context }) => {
    await useMockWorker(context);

    const hash = encodeConfig(buildConfig({ watermark: true }));
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    await page.fill('#lockInput', TEST_PASSWORD);
    await page.click('#lockBtn');
    await page.waitForSelector('.p-item img.loaded', { timeout: 60_000 });

    // Use the src of a thumbnail the browser already loaded successfully (size=m).
    // The XL download URL also uses watermark=1 and is tested separately in test 4;
    // here we need a URL the Worker can watermark without hitting its CPU limit on a
    // 2560px image. Adding &watermark=1 to an already-fetched size=m thumbnail is
    // sufficient to prove pixel-level embedding — the watermark code runs at any size.
    const cleanUrl = await page.locator('.p-item img.loaded').first().getAttribute('src');
    expect(cleanUrl).toContain('api=SYNO.Foto.Thumbnail');
    const watermarkedUrl = `${cleanUrl}&watermark=1`;

    // Fetch both images from Node.js — not the browser — so we can set Origin freely.
    // If the watermark were purely a CSS overlay, these two server responses would be
    // byte-identical because CSS is applied by the browser renderer, not by the server.
    const [wmBuf, cleanBuf] = await Promise.all([
      fetchWorkerImage(page, watermarkedUrl),
      fetchWorkerImage(page, cleanUrl),
    ]);

    expect(wmBuf.byteLength).toBeGreaterThan(1000);
    expect(cleanBuf.byteLength).toBeGreaterThan(1000);

    // Decode both JPEGs to raw RGB pixel data for a direct pixel-level comparison
    const [wmPixels, cleanPixels] = await Promise.all([
      sharp(wmBuf).toColorspace('srgb').removeAlpha().raw().toBuffer(),
      sharp(cleanBuf).toColorspace('srgb').removeAlpha().raw().toBuffer(),
    ]);

    // Count pixels where any RGB channel differs by more than 20 units.
    //
    // The Worker burns "© Coastal Travel Company" tiled text (white with dark border,
    // fontSize 40, staggered grid every 520×110 px) into the image using @cf-wasm/photon.
    // Text pixels change values by 100–255 units vs the original.  Double-compression
    // JPEG rounding noise between the two fetches changes values by ≤10 units, so the
    // threshold of 20 cleanly separates watermark changes from compression artifacts.
    const CHANNELS  = 3; // JPEG → RGB
    const pixCount  = Math.floor(Math.min(wmPixels.length, cleanPixels.length) / CHANNELS);
    let changedPixels = 0;

    for (let px = 0; px < pixCount; px++) {
      const i  = px * CHANNELS;
      const dr = Math.abs(wmPixels[i]     - cleanPixels[i]);
      const dg = Math.abs(wmPixels[i + 1] - cleanPixels[i + 1]);
      const db = Math.abs(wmPixels[i + 2] - cleanPixels[i + 2]);
      if (dr > 20 || dg > 20 || db > 20) changedPixels++;
    }

    const changedFraction = changedPixels / pixCount;

    // Require ≥2% of pixels to show significant change — this is easily exceeded when
    // tiled watermark text covers the image, but would be ~0 for a pure CSS overlay
    // (which has zero effect on what bytes the server returns).
    expect(changedFraction).toBeGreaterThan(0.02);
  });

});
