/**
 * Regression tests for admin masquerade across the client portal.
 *
 * Masquerade state is stored in sessionStorage (ctc_masquerade_token), NOT in
 * the URL query parameter. These tests guard against:
 *
 *  1. Banner appearing from sessionStorage token on portal.html
 *  2. Banner NOT appearing from ?masquerade=1 URL param alone (old broken behaviour)
 *  3. API calls using Authorization: Bearer <masq-token> (not cookies)
 *  4. "Exit Masquerade" calling POST /admin/masquerade/exit and redirecting
 *  5. Expired/missing masquerade token redirecting back to /admin/clients.html
 *  6. Banner surviving navigation to portal-project.html (was broken before fix)
 *  7. Banner surviving navigation to profile.html (was broken before fix)
 *  8. Exit Masquerade working from portal-project.html
 *  9. Exit Masquerade working from profile.html
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://api.coastaltravelcompany.com';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':      STATIC_BASE,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods':     'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers':     'Content-Type, Authorization',
};

const MASQ_TOKEN = 'mock-masquerade-jwt';
const MASQ_USER  = { id: 'usr-client', email: 'jane@test.com', role: 'client', name: 'Jane Client', hasPassword: true };

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
      const key    = `${method} ${url.pathname}`;
      const handler = handlers[key] ?? handlers[url.pathname];
      if (handler) {
        await handler(route, req);
      } else {
        await route.fulfill({ status: 404, headers: CORS, body: `No mock for: ${key}` });
      }
    },
  );
}

function setMasquerade(page, user = MASQ_USER) {
  return page.addInitScript(([token, userData]) => {
    sessionStorage.setItem('ctc_masquerade_token', token);
    sessionStorage.setItem('ctc_masquerade_user', JSON.stringify(userData));
  }, [MASQ_TOKEN, user]);
}

function makePortalData(overrides = {}) {
  return {
    project: {
      id: 'proj1', property: 'Grand Palms Resort', client_name: 'Jane Client',
      collection: 'The Editorial Stay', location: 'Palm Beach, FL',
      shoot_date: '2026-07-20', stage: 'Active',
    },
    documents: [], proposals: [], questionnaires: [],
    messages: [],
    ...overrides,
  };
}

// ── portal.html ───────────────────────────────────────────────────────────────

test.describe('Masquerade: portal.html', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('shows amber banner when sessionStorage has masquerade token', async ({ page, context }) => {
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me':          (route) => json(route, MASQ_USER),
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/contracts': (route) => json(route, []),
      'GET /portal/invoices':  (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);

    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('strong', { hasText: 'Jane Client' })).toBeVisible();
    await expect(page.locator('text=Exit Masquerade')).toBeVisible();
  });

  test('does NOT show banner from ?masquerade=1 URL param alone (regression guard)', async ({ page, context }) => {
    // No sessionStorage — only the URL param that the old code relied on
    await mockWorker(context, {
      'GET /auth/me':          (route) => json(route, MASQ_USER),
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/contracts': (route) => json(route, []),
      'GET /portal/invoices':  (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/portal.html?masquerade=1`);

    await expect(page.locator('#galleries-content .state-empty')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Admin View')).not.toBeVisible();
    await expect(page.locator('text=Exit Masquerade')).not.toBeVisible();
  });

  test('sends Authorization: Bearer header for API calls (not cookies)', async ({ page, context }) => {
    let capturedAuth = null;
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me': async (route, req) => {
        capturedAuth = req.headers()['authorization'] ?? null;
        return json(route, MASQ_USER);
      },
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/contracts': (route) => json(route, []),
      'GET /portal/invoices':  (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });

    expect(capturedAuth).toBe(`Bearer ${MASQ_TOKEN}`);
  });

  test('Exit Masquerade calls POST /admin/masquerade/exit and redirects to clients page', async ({ page, context }) => {
    let exitCalled = false;
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me':               (route) => json(route, MASQ_USER),
      'GET /portal/galleries':      (route) => json(route, []),
      'GET /portal/contracts':      (route) => json(route, []),
      'GET /portal/invoices':       (route) => json(route, []),
      'POST /admin/masquerade/exit': async (route) => { exitCalled = true; return json(route, { ok: true }); },
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('text=Exit Masquerade')).toBeVisible({ timeout: 10_000 });
    await page.click('text=Exit Masquerade');

    await page.waitForURL(/\/admin\/clients(\.html)?/, { timeout: 10_000 });
    expect(exitCalled).toBe(true);
    // Note: addInitScript re-runs on every navigation, so sessionStorage is re-populated
    // on the destination page — the meaningful assertion is that the redirect happened.
  });

  test('redirects to /admin/clients when masquerade token is rejected (expired session)', async ({ page, context }) => {
    let firstAuthCall = true;
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me': async (route) => {
        if (firstAuthCall) {
          firstAuthCall = false;
          // portal.html's masquerade auth check — simulate expired token
          return route.fulfill({ status: 401, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ error: 'Unauthorized' }) });
        }
        // admin/clients.html's own auth check — return valid admin so the page loads
        return json(route, { id: 'admin1', email: 'admin@test.com', role: 'admin' });
      },
      'GET /admin/users':     (route) => json(route, []),
      'GET /admin/galleries': (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await page.waitForURL(/\/admin\/clients(\.html)?/, { timeout: 10_000 });
  });
});

// ── portal-project.html ───────────────────────────────────────────────────────

test.describe('Masquerade: portal-project.html', () => {
  const PROJ_TOKEN = 'masq-proj-token';

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('shows amber banner when sessionStorage has masquerade token', async ({ page, context }) => {
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me':                            (route) => json(route, MASQ_USER),
      [`GET /portal/project/${PROJ_TOKEN}`]:     (route) => json(route, makePortalData()),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${PROJ_TOKEN}`);

    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('strong', { hasText: 'Jane Client' })).toBeVisible();
    await expect(page.locator('text=Exit Masquerade')).toBeVisible();
  });

  test('sends Authorization: Bearer header for API calls', async ({ page, context }) => {
    let capturedAuth = null;
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me': async (route, req) => {
        capturedAuth = req.headers()['authorization'] ?? null;
        return json(route, MASQ_USER);
      },
      [`GET /portal/project/${PROJ_TOKEN}`]: (route) => json(route, makePortalData()),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${PROJ_TOKEN}`);
    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });

    expect(capturedAuth).toBe(`Bearer ${MASQ_TOKEN}`);
  });

  test('Exit Masquerade redirects to /admin/clients from project page', async ({ page, context }) => {
    let exitCalled = false;
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me':                           (route) => json(route, MASQ_USER),
      [`GET /portal/project/${PROJ_TOKEN}`]:    (route) => json(route, makePortalData()),
      'POST /admin/masquerade/exit': async (route) => { exitCalled = true; return json(route, { ok: true }); },
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${PROJ_TOKEN}`);
    await expect(page.locator('text=Exit Masquerade')).toBeVisible({ timeout: 10_000 });
    await page.click('text=Exit Masquerade');

    await page.waitForURL(/\/admin\/clients(\.html)?/, { timeout: 10_000 });
    expect(exitCalled).toBe(true);
  });
});

// ── profile.html ──────────────────────────────────────────────────────────────

test.describe('Masquerade: profile.html', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('shows amber banner when sessionStorage has masquerade token', async ({ page, context }) => {
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me': (route) => json(route, MASQ_USER),
    });

    await page.goto(`${STATIC_BASE}/profile.html`);

    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('strong', { hasText: 'Jane Client' })).toBeVisible();
    await expect(page.locator('text=Exit Masquerade')).toBeVisible();
  });

  test('sends Authorization: Bearer header for API calls', async ({ page, context }) => {
    let capturedAuth = null;
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me': async (route, req) => {
        capturedAuth = req.headers()['authorization'] ?? null;
        return json(route, MASQ_USER);
      },
    });

    await page.goto(`${STATIC_BASE}/profile.html`);
    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });

    expect(capturedAuth).toBe(`Bearer ${MASQ_TOKEN}`);
  });

  test('Exit Masquerade redirects to /admin/clients from profile page', async ({ page, context }) => {
    let exitCalled = false;
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me':                (route) => json(route, MASQ_USER),
      'POST /admin/masquerade/exit': async (route) => { exitCalled = true; return json(route, { ok: true }); },
    });

    await page.goto(`${STATIC_BASE}/profile.html`);
    await expect(page.locator('text=Exit Masquerade')).toBeVisible({ timeout: 10_000 });
    await page.click('text=Exit Masquerade');

    await page.waitForURL(/\/admin\/clients(\.html)?/, { timeout: 10_000 });
    expect(exitCalled).toBe(true);
  });
});

// ── Navigation persistence ────────────────────────────────────────────────────

test.describe('Masquerade: banner persists across tab navigation', () => {
  const NAV_TOKEN = 'masq-nav-proj-token';

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('banner survives navigation from portal.html to portal-project.html', async ({ page, context }) => {
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me':                          (route) => json(route, MASQ_USER),
      'GET /portal/galleries':                 (route) => json(route, []),
      'GET /portal/contracts':                 (route) => json(route, []),
      'GET /portal/invoices':                  (route) => json(route, []),
      'GET /portal/my-project':                (route) => json(route, { token: NAV_TOKEN }),
      [`GET /portal/project/${NAV_TOKEN}`]:    (route) => json(route, makePortalData()),
      'POST /admin/masquerade/exit':           (route) => json(route, { ok: true }),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });

    // Navigate via the "My Project" tab
    await page.click('#projectTabLink');
    await page.waitForURL(/portal-project(\.html)?/, { timeout: 10_000 });

    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Exit Masquerade')).toBeVisible();
  });

  test('banner survives navigation from portal.html to profile.html', async ({ page, context }) => {
    await setMasquerade(page);
    await mockWorker(context, {
      'GET /auth/me':          (route) => json(route, MASQ_USER),
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/contracts': (route) => json(route, []),
      'GET /portal/invoices':  (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });

    // Navigate via the "My Profile" tab
    await page.click('#profileTabLink');
    await page.waitForURL(/\/profile(\.html)?/, { timeout: 10_000 });

    await expect(page.locator('text=Admin View')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Exit Masquerade')).toBeVisible();
  });
});

// ── XSS escaping in masquerade banner (regression for PR #364) ───────────────
//
// The "Admin View — Viewing portal as <name>" banner interpolates the client's
// name/email into innerHTML. `name` is user-supplied at registration and only
// trimmed server-side — never HTML-sanitized — so a malicious client could set
// their display name to an HTML/script payload. If the banner doesn't escape
// it, that payload would execute in the *admin's* authenticated browser the
// moment they masquerade as that client (stored XSS / privilege escalation).
//
// These tests assert the payload is rendered as literal escaped text (and
// therefore never executes) on all three pages that show the banner.

const XSS_NAME = '<img src=x onerror="window.__xss = true">';
const XSS_USER = { id: 'usr-evil', email: 'evil@test.com', role: 'client', name: XSS_NAME, hasPassword: true };

async function expectBannerEscaped(page) {
  const banner = page.locator('text=Admin View');
  await expect(banner).toBeVisible({ timeout: 10_000 });

  // The raw payload must be present as literal text (HTML-escaped), not parsed as markup.
  await expect(page.locator('strong', { hasText: XSS_NAME })).toBeVisible();

  // No <img> element should have been created from the payload, and the
  // onerror handler must never have fired.
  await expect(page.locator(`strong img[src="x"]`)).toHaveCount(0);
  const fired = await page.evaluate(() => window.__xss === true);
  expect(fired).toBe(false);
}

test.describe('Masquerade banner escapes malicious client name (XSS regression)', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('portal.html escapes HTML in masquerade banner name', async ({ page, context }) => {
    await setMasquerade(page, XSS_USER);
    await mockWorker(context, {
      'GET /auth/me':          (route) => json(route, XSS_USER),
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/contracts': (route) => json(route, []),
      'GET /portal/invoices':  (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expectBannerEscaped(page);
  });

  test('portal-project.html escapes HTML in masquerade banner name', async ({ page, context }) => {
    const PROJ_TOKEN = 'masq-xss-proj-token';
    await setMasquerade(page, XSS_USER);
    await mockWorker(context, {
      'GET /auth/me':                        (route) => json(route, XSS_USER),
      [`GET /portal/project/${PROJ_TOKEN}`]: (route) => json(route, makePortalData()),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${PROJ_TOKEN}`);
    await expectBannerEscaped(page);
  });

  test('profile.html escapes HTML in masquerade banner name', async ({ page, context }) => {
    await setMasquerade(page, XSS_USER);
    await mockWorker(context, {
      'GET /auth/me': (route) => json(route, XSS_USER),
    });

    await page.goto(`${STATIC_BASE}/profile.html`);
    await expectBannerEscaped(page);
  });
});
