/**
 * Routing acceptance tests — ACTION-PLAN items 2 (soft 404s) and 3 (www redirect).
 *
 * Content tests (run locally + CI):
 *  1. /404.html renders branded heading and nav
 *  2. /404.html carries <meta name="robots" content="noindex">
 *  3. "Return Home" button links to the homepage
 *  4. sitemap.xml does not list /404.html
 *
 * Status-code tests (deployed Pages only — skipped locally):
 *  5. A random non-existent path returns HTTP 404
 *  6. /llms.txt returns HTTP 200 with real llms.txt content (action item 9)
 *  7. A nested non-existent path returns HTTP 404
 *  8. The 404 response body is the branded 404 page, not the homepage
 *  9. Known-good public pages still return HTTP 200 (no over-blocking)
 *
 * www redirect tests (deployed Pages only — always against the live www domain):
 * 10. https://www.<domain>/ → 301 → https://<domain>/
 * 11. https://www.<domain>/about → 301 → https://<domain>/about
 * 12. Path and query string are preserved through the www redirect
 * 13. Non-www homepage is not itself redirected (no redirect loop)
 * 14. www redirect destination is reachable and returns 200
 */

import { test, expect } from '@playwright/test';

const STATIC_BASE  = process.env.BASE_URL || 'http://localhost:9876';
const IS_DEPLOYED  = !!process.env.BASE_URL;

// Derive www/non-www origins from BASE_URL so tests work for any deployed environment.
// e.g. https://preprod.coastaltravelcompany.com → www.preprod.coastaltravelcompany.com
// e.g. https://coastaltravelcompany.com         → www.coastaltravelcompany.com
const _base        = IS_DEPLOYED ? new URL(STATIC_BASE) : new URL('https://coastaltravelcompany.com');
const NONWWW_ORIGIN = _base.origin;
const WWW_ORIGIN    = `${_base.protocol}//www.${_base.hostname}`;

// ── Content tests (local + CI) ────────────────────────────────────────────────

test('404 page renders branded heading and nav', async ({ page }) => {
  await page.goto(`${STATIC_BASE}/404.html`);

  await expect(page).toHaveTitle(/Page Not Found/);
  await expect(page.locator('h1')).toHaveText("This page doesn't exist.");
  await expect(page.locator('.error-script')).toContainText('lost at sea');

  const navLinks = page.locator('#main-nav .nav-links li a');
  await expect(navLinks).toHaveText(['Home', 'About', 'Services', 'Collections', 'Contact', 'Account']);
});

test('404 page carries noindex robots meta tag', async ({ page }) => {
  await page.goto(`${STATIC_BASE}/404.html`);
  const robots = page.locator('meta[name="robots"]');
  await expect(robots).toHaveAttribute('content', 'noindex');
});

test('"Return Home" button links to the homepage', async ({ page }) => {
  await page.goto(`${STATIC_BASE}/404.html`);
  const btn = page.locator('a.btn', { hasText: 'Return Home' });
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('href', '/index.html');
});

test('sitemap.xml does not include /404.html', async ({ request }) => {
  const response = await request.get(`${STATIC_BASE}/sitemap.xml`);
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).not.toContain('404');
});

// ── Status-code tests (deployed Pages only) ───────────────────────────────────

test.describe('HTTP 404 for unmatched routes', () => {
  test.skip(!IS_DEPLOYED, 'Status-code tests require a deployed Cloudflare Pages environment (set BASE_URL)');

  test('random non-existent path returns 404', async ({ request }) => {
    const response = await request.get(`${STATIC_BASE}/this-page-does-not-exist-xyz123`);
    expect(response.status()).toBe(404);
  });

  test('/llms.txt returns 200 with real llms.txt content (action item 9)', async ({ request }) => {
    const response = await request.get(`${STATIC_BASE}/llms.txt`);
    expect(response.status()).toBe(200);
    const body = await response.text();
    // Real llms.txt starts with the site title, not homepage HTML
    expect(body).toContain('# Coastal Travel Company');
    expect(body).not.toContain('<html');
  });

  test('nested non-existent path returns 404', async ({ request }) => {
    const response = await request.get(`${STATIC_BASE}/does/not/exist/at/all`);
    expect(response.status()).toBe(404);
  });

  test('404 response body is the branded page, not the homepage', async ({ request }) => {
    const response = await request.get(`${STATIC_BASE}/this-page-does-not-exist-xyz123`);
    const body = await response.text();
    // Branded 404 page contains this heading
    expect(body).toContain("This page doesn't exist.");
    // Homepage hero section should not be present
    expect(body).not.toContain('class="hero"');
  });

  test.describe('known-good pages still return 200', () => {
    const PUBLIC_PAGES = ['/', '/about', '/services', '/collections', '/walkthroughs', '/contact', '/privacy'];

    for (const path of PUBLIC_PAGES) {
      test(`${path} returns 200`, async ({ request }) => {
        const response = await request.get(`${STATIC_BASE}${path}`);
        expect(response.status()).toBe(200);
      });
    }
  });
});

// ── www redirect tests (deployed Pages only) ──────────────────────────────────

test.describe('www → non-www 301 redirect', () => {
  test.skip(!IS_DEPLOYED, 'Redirect tests require a deployed Cloudflare Pages environment (set BASE_URL)');

  test('www root redirects to non-www root with 301', async ({ request }) => {
    const response = await request.get(`${WWW_ORIGIN}/`, { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers()['location']).toBe(`${NONWWW_ORIGIN}/`);
  });

  test('www /about redirects to non-www /about with 301', async ({ request }) => {
    const response = await request.get(`${WWW_ORIGIN}/about`, { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers()['location']).toBe(`${NONWWW_ORIGIN}/about`);
  });

  test('www redirect preserves path and query string', async ({ request }) => {
    const response = await request.get(`${WWW_ORIGIN}/collections?ref=test`, { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    const location = response.headers()['location'];
    expect(location).toContain(`${NONWWW_ORIGIN}/collections`);
    expect(location).toContain('ref=test');
  });

  test('non-www homepage is not redirected (no redirect loop)', async ({ request }) => {
    const response = await request.get(`${NONWWW_ORIGIN}/`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
  });

  test('www redirect destination is reachable and returns 200', async ({ request }) => {
    const redirected = await request.get(`${WWW_ORIGIN}/`);
    expect(redirected.status()).toBe(200);
    const body = await redirected.text();
    expect(body).toContain('Coastal');
  });
});
