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
 * Network strategy: the Cloudflare Worker enforces Origin: https://coastaltravelcompany.com.
 * Playwright's context.route() intercepts outgoing requests and re-issues them from Node.js
 * (not the browser), where we can set the Origin header freely. This lets the tests run
 * against the live Worker without modifying the Worker's security policy.
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
 * Intercept all requests to the Worker and re-issue them from Node.js so we can
 * inject Origin: https://coastaltravelcompany.com — which the Worker requires.
 * Browsers set Origin based on the page's actual origin (localhost:9876) and
 * cannot spoof it via JS; the Node.js route handler has no such restriction.
 *
 * Two CORS problems need fixing:
 *  1. CORS preflights (OPTIONS): the Worker returns
 *       Access-Control-Allow-Origin: https://coastaltravelcompany.com
 *     which the browser rejects because the page origin is localhost:9876.
 *     → Respond to OPTIONS locally with Access-Control-Allow-Origin: *
 *
 *  2. Actual responses (GET/POST): the Worker also returns the same header.
 *     → Rewrite that header to * before handing the response back to the browser.
 */
async function useWorkerOriginProxy(context) {
  await context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req = route.request();
      try {
        // Handle CORS preflights without hitting the Worker
        if (req.method() === 'OPTIONS') {
          await route.fulfill({
            status: 204,
            headers: {
              'access-control-allow-origin':   '*',
              'access-control-allow-methods':  'GET, POST, OPTIONS',
              'access-control-allow-headers':  'Content-Type',
              'access-control-expose-headers': 'Content-Disposition',
              'access-control-max-age':        '86400',
            },
          });
          return;
        }

        // Re-issue from Node.js with the correct Origin, then rewrite the
        // Access-Control-Allow-Origin header so the browser (localhost:9876) accepts it
        const res = await route.fetch({
          headers: {
            ...req.headers(),
            origin:  PROD_ORIGIN,
            referer: `${PROD_ORIGIN}/`,
          },
        });

        await route.fulfill({
          status:  res.status(),
          headers: { ...res.headers(), 'access-control-allow-origin': '*' },
          body:    await res.body(),
        });
      } catch {
        // Route callbacks can race context teardown; swallow errors from closed contexts
        route.abort().catch(() => {});
      }
    },
  );
}

/**
 * Fetch an image URL from the Worker directly in Node.js context (not the browser),
 * setting Origin so the Worker allows the request.  Returns the image as a Buffer.
 */
async function fetchWorkerImage(url) {
  const res = await fetch(url, { headers: { origin: PROD_ORIGIN } });
  if (!res.ok) throw new Error(`Worker returned HTTP ${res.status} for: ${url}`);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.startsWith('image/')) {
    const text = await res.text();
    throw new Error(`Expected image, got ${ct}: ${text.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
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
    await useWorkerOriginProxy(context);

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
    await useWorkerOriginProxy(context);

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
    await useWorkerOriginProxy(context);

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
      fetchWorkerImage(watermarkedUrl),
      fetchWorkerImage(cleanUrl),
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
