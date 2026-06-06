/**
 * Acceptance tests for the admin Content Editor (CMS) — item 18.
 *
 *  1. Unauthenticated visit redirects to /login.html
 *  2. Client JWT redirects to /portal.html
 *  3. Page list renders from GET /admin/cms/pages
 *  4. Selecting a page loads zones via GET /admin/cms/page
 *  5. Editing a zone enables the Save & Publish button
 *  6. Save & Publish calls PUT /admin/cms/page with zone data
 *  7. "No changes" response shows appropriate status message
 *  8. History button fetches GET /admin/cms/history and shows commits
 *  9. Back to Editor button returns to the editor panel
 * 10. Revert button calls POST /admin/cms/revert
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':      STATIC_BASE,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods':     'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers':     'Content-Type, Authorization',
};

const ADMIN_JWT = 'mock-admin-jwt';

function json(route, data, status = 200) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify(data),
  });
}

function mockWorker(context, handlers) {
  return context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req    = route.request();
      const url    = new URL(req.url());
      const method = req.method();
      if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }
      const key     = `${method} ${url.pathname}`;
      const handler = handlers[key] ?? handlers[url.pathname];
      if (handler) {
        await handler(route, req);
      } else {
        await route.fulfill({ status: 404, headers: CORS, body: `No mock for: ${key}` });
      }
    },
  );
}

const MOCK_PAGES = [
  { file: 'index.html',    label: 'Home',     zoneCount: 9 },
  { file: 'about.html',    label: 'About',    zoneCount: 14 },
  { file: 'services.html', label: 'Services', zoneCount: 11 },
  { file: 'contact.html',  label: 'Contact',  zoneCount: 5 },
];

const MOCK_ZONES = [
  { id: 'hero-eyebrow', label: 'Hero eyebrow text', type: 'text',      value: 'Palm Beach, Florida' },
  { id: 'hero-title',   label: 'Hero main title',   type: 'text',      value: 'Travel Company' },
  { id: 'intro-body',   label: 'Intro paragraph',   type: 'multiline', value: 'We create refined visuals.' },
];

const MOCK_COMMITS = [
  {
    sha:     'abc1234567890',
    message: 'Update Hero eyebrow text on Home page',
    author:  'Admin',
    date:    '2026-05-01T10:00:00Z',
    url:     'https://github.com/willcrain1/coastaltravelcompany/commit/abc1234',
  },
  {
    sha:     'def9876543210',
    message: 'Update Intro paragraph on Home page',
    author:  'Admin',
    date:    '2026-04-28T09:00:00Z',
    url:     'https://github.com/willcrain1/coastaltravelcompany/commit/def9876',
  },
];

function cmsSetup(context, overrides = {}) {
  return mockWorker(context, {
    'GET /auth/me': (r) => json(r, { id: 'a1', email: 'admin@test.com', role: 'admin' }),
    'GET /admin/cms/pages': (r) => json(r, MOCK_PAGES),
    'GET /admin/cms/page':  (r) => json(r, { file: 'index.html', label: 'Home', sha: 'sha1', zones: MOCK_ZONES }),
    'PUT /admin/cms/page':  (r) => json(r, { ok: true, message: 'Update Hero eyebrow text on Home page', commit: 'abc123' }),
    'GET /admin/cms/history': (r) => json(r, MOCK_COMMITS),
    'POST /admin/cms/revert': (r) => json(r, { ok: true, message: 'Revert Home page to abc1234' }),
    ...overrides,
  });
}

async function gotoEditor(page) {
  await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), ADMIN_JWT);
  await page.goto(`${STATIC_BASE}/admin/content-editor.html`);
  await page.waitForFunction(
    () => document.getElementById('page-list')?.querySelector('a[data-file]') !== null,
    { timeout: 10_000 },
  );
}

async function selectHomePage(page) {
  await page.click('#page-list a[data-file="index.html"]');
  await page.waitForFunction(
    () => document.getElementById('cms-zones')?.querySelector('[data-zone-id]') !== null,
    { timeout: 10_000 },
  );
}

test.describe('CMS content editor', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('unauthenticated visit redirects to /login.html', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/me': (r) => r.fulfill({ status: 401, headers: CORS, body: '{}' }),
    });
    await page.goto(`${STATIC_BASE}/admin/content-editor.html`);
    await page.waitForURL(/login\.html/, { timeout: 10_000 });
    expect(page.url()).toContain('login.html');
  });

  test('client JWT redirects to /portal.html', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/me': (r) => json(r, { id: 'c1', role: 'client' }),
    });
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-client-jwt'));
    await page.goto(`${STATIC_BASE}/admin/content-editor.html`);
    await page.waitForURL(/portal\.html/, { timeout: 10_000 });
    expect(page.url()).toContain('portal.html');
  });

  test('page list renders all pages from GET /admin/cms/pages', async ({ page, context }) => {
    await cmsSetup(context);
    await gotoEditor(page);

    const links = page.locator('#page-list a[data-file]');
    await expect(links).toHaveCount(MOCK_PAGES.length);
    await expect(page.locator('#page-list')).toContainText('Home');
    await expect(page.locator('#page-list')).toContainText('About');
    await expect(page.locator('#page-list')).toContainText('Services');
    await expect(page.locator('#page-list')).toContainText('Contact');
  });

  test('selecting a page loads its zones via GET /admin/cms/page', async ({ page, context }) => {
    await cmsSetup(context);
    await gotoEditor(page);
    await selectHomePage(page);

    await expect(page.locator('#page-label')).toHaveText('Home');
    await expect(page.locator('#cms-editor')).toBeVisible();
    await expect(page.locator('#cms-empty')).toBeHidden();

    // Zone inputs rendered
    const inputs = page.locator('#cms-zones [data-zone-id]');
    await expect(inputs).toHaveCount(MOCK_ZONES.length);
    await expect(page.locator('[data-zone-id="hero-eyebrow"]')).toHaveValue('Palm Beach, Florida');
    await expect(page.locator('[data-zone-id="hero-title"]')).toHaveValue('Travel Company');
  });

  test('editing a zone enables the Save & Publish button', async ({ page, context }) => {
    await cmsSetup(context);
    await gotoEditor(page);
    await selectHomePage(page);

    await expect(page.locator('#btn-save')).toBeDisabled();
    await page.fill('[data-zone-id="hero-eyebrow"]', 'Updated text');
    await expect(page.locator('#btn-save')).toBeEnabled();
  });

  test('Save & Publish calls PUT /admin/cms/page with zone data', async ({ page, context }) => {
    let putBody = null;
    await cmsSetup(context, {
      'PUT /admin/cms/page': async (route, req) => {
        putBody = req.postDataJSON();
        return json(route, { ok: true, message: 'Update Hero eyebrow text on Home page', commit: 'abc123' });
      },
    });
    await gotoEditor(page);
    await selectHomePage(page);

    await page.fill('[data-zone-id="hero-eyebrow"]', 'New eyebrow text');
    await page.click('#btn-save');
    await page.waitForFunction(
      () => document.getElementById('cms-status')?.classList.contains('success'),
      { timeout: 10_000 },
    );

    expect(putBody).toBeTruthy();
    expect(putBody.zones['hero-eyebrow']).toBe('New eyebrow text');
    await expect(page.locator('#cms-status')).toContainText('Published');
  });

  test('"No changes" response shows appropriate status', async ({ page, context }) => {
    await cmsSetup(context, {
      'PUT /admin/cms/page': (r) => json(r, { ok: true, message: 'No changes' }),
    });
    await gotoEditor(page);
    await selectHomePage(page);

    await page.fill('[data-zone-id="hero-eyebrow"]', 'Same text');
    await page.click('#btn-save');
    await page.waitForFunction(
      () => document.getElementById('cms-status')?.classList.contains('success'),
      { timeout: 10_000 },
    );
    await expect(page.locator('#cms-status')).toContainText('already up to date');
  });

  test('History button shows commit list from GET /admin/cms/history', async ({ page, context }) => {
    await cmsSetup(context);
    await gotoEditor(page);
    await selectHomePage(page);

    await page.click('#btn-history');
    await page.waitForFunction(
      () => document.getElementById('cms-history-panel')?.style.display !== 'none',
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () => document.querySelectorAll('.history-item').length > 0,
      { timeout: 10_000 },
    );

    await expect(page.locator('#cms-history-panel')).toBeVisible();
    await expect(page.locator('#cms-editor')).toBeHidden();
    await expect(page.locator('.history-item')).toHaveCount(MOCK_COMMITS.length);
    await expect(page.locator('#history-list')).toContainText('Update Hero eyebrow text');
    await expect(page.locator('#history-list')).toContainText('abc1234'); // first 7 chars of sha
  });

  test('Back to Editor button returns to the editor panel', async ({ page, context }) => {
    await cmsSetup(context);
    await gotoEditor(page);
    await selectHomePage(page);

    await page.click('#btn-history');
    await page.waitForSelector('#cms-history-panel:not([style*="display: none"])', { timeout: 10_000 });
    await page.click('#btn-back-editor');
    await expect(page.locator('#cms-editor')).toBeVisible();
    await expect(page.locator('#cms-history-panel')).toBeHidden();
  });

  test('Revert button calls POST /admin/cms/revert', async ({ page, context }) => {
    let revertBody = null;
    await cmsSetup(context, {
      'POST /admin/cms/revert': async (route, req) => {
        revertBody = req.postDataJSON();
        return json(route, { ok: true, message: 'Revert Home page to abc1234' });
      },
    });
    await gotoEditor(page);
    await selectHomePage(page);

    await page.click('#btn-history');
    await page.waitForFunction(
      () => document.querySelectorAll('.cms-btn-danger').length > 0,
      { timeout: 10_000 },
    );

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.cms-btn-danger').first().click();

    // Accept the "Reverted" confirmation alert
    page.once('dialog', (dialog) => dialog.accept());
    await expect.poll(() => revertBody, { timeout: 10_000 }).not.toBeNull();

    expect(revertBody.file).toBe('index.html');
    expect(revertBody.sha).toBe('abc1234567890');
  });
});
