/**
 * SEO meta tests — sitemap and canonical tags.
 *
 * Sitemap tests (run locally + CI):
 *  1. sitemap.xml returns 200
 *  2. All sitemap URLs use extension-less paths (no .html)
 *  3. All sitemap URLs use the non-www canonical host
 *  4. sitemap.xml contains exactly the expected 7 public URLs
 *  5. sitemap.xml does not contain private/portal pages
 *
 * Canonical tag tests (run locally + CI):
 *  6–12. Each public page carries a self-referencing <link rel="canonical">
 *        pointing at the non-www, extension-less URL
 */

import { test, expect } from '@playwright/test';

const STATIC_BASE = process.env.BASE_URL || 'http://localhost:9876';

const CANONICAL_BASE = 'https://coastaltravelcompany.com';

const PUBLIC_PAGES = [
  { file: '/index.html',       canonical: `${CANONICAL_BASE}/`            },
  { file: '/about.html',       canonical: `${CANONICAL_BASE}/about`       },
  { file: '/services.html',    canonical: `${CANONICAL_BASE}/services`    },
  { file: '/collections.html', canonical: `${CANONICAL_BASE}/collections` },
  { file: '/walkthroughs.html',canonical: `${CANONICAL_BASE}/walkthroughs`},
  { file: '/contact.html',     canonical: `${CANONICAL_BASE}/contact`     },
  { file: '/privacy.html',     canonical: `${CANONICAL_BASE}/privacy`     },
];

const EXPECTED_SITEMAP_LOCS = PUBLIC_PAGES.map(p => p.canonical);

// ── Sitemap tests ─────────────────────────────────────────────────────────────

test.describe('sitemap.xml', () => {
  let body;

  test.beforeEach(async ({ request }) => {
    const response = await request.get(`${STATIC_BASE}/sitemap.xml`);
    expect(response.status()).toBe(200);
    body = await response.text();
  });

  test('returns 200 with XML content', async ({ request }) => {
    const response = await request.get(`${STATIC_BASE}/sitemap.xml`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/xml/);
  });

  test('contains no .html extensions in URLs', () => {
    const locs = [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
    for (const loc of locs) {
      expect(loc, `${loc} should not have .html extension`).not.toMatch(/\.html/);
    }
  });

  test('all URLs use non-www canonical host', () => {
    const locs = [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
    for (const loc of locs) {
      expect(loc, `${loc} should use non-www host`).toMatch(/^https:\/\/coastaltravelcompany\.com/);
      expect(loc, `${loc} should not use www`).not.toContain('www.');
    }
  });

  test('contains exactly the 7 expected public URLs', () => {
    const locs = [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
    expect(locs.sort()).toEqual(EXPECTED_SITEMAP_LOCS.sort());
  });

  test('does not contain private or portal pages', () => {
    const privatePages = ['login', 'register', 'portal', 'profile', 'invoice', 'contract', 'proposal', 'questionnaire', 'schedule', '404'];
    for (const page of privatePages) {
      expect(body, `sitemap should not list /${page}`).not.toContain(`/${page}`);
    }
  });
});

// ── Canonical tag tests ───────────────────────────────────────────────────────

test.describe('canonical tags', () => {
  for (const { file, canonical } of PUBLIC_PAGES) {
    test(`${file} has canonical → ${canonical}`, async ({ page }) => {
      await page.goto(`${STATIC_BASE}${file}`);
      const canonicalEl = page.locator('link[rel="canonical"]');
      await expect(canonicalEl).toHaveCount(1);
      await expect(canonicalEl).toHaveAttribute('href', canonical);
    });
  }

  test('404.html has no canonical (noindex page)', async ({ page }) => {
    await page.goto(`${STATIC_BASE}/404.html`);
    const canonicalEl = page.locator('link[rel="canonical"]');
    await expect(canonicalEl).toHaveCount(0);
  });
});
