/**
 * Regression tests for the portal Bearer-fallback fix.
 *
 * Root cause: portal pages used cookie-only auth. After the worker moved to a
 * custom domain, existing cookies were scoped to the old domain and rejected.
 * When /auth/me returned 401, the portal cleared localStorage and redirected
 * the admin to /login.html — effectively logging them out.
 *
 * Fix: authFetch() in portal.html, portal-project.html, and profile.html now
 * sends "Authorization: Bearer <jwt>" from localStorage alongside
 * credentials: 'include', so the request succeeds even when no valid cookie
 * exists for the current domain.
 *
 * These tests guard against that regression by verifying:
 *  1. Each portal page sends Authorization: Bearer when ctc_jwt is in localStorage
 *  2. An admin visiting the portal with a JWT but NO cookie is NOT logged out
 *  3. A request with neither JWT nor cookie still redirects to /login.html
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://api.coastaltravelcompany.com';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':      STATIC_BASE,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods':     'GET, POST, OPTIONS',
  'access-control-allow-headers':     'Content-Type, Authorization',
};

const CLIENT_JWT  = 'mock-client-jwt';
const ADMIN_JWT   = 'mock-admin-jwt';
const PROJ_TOKEN  = 'bearer-test-proj-token';

const CLIENT_USER = { id: 'u-client', email: 'client@test.com', role: 'client', name: 'Test Client', hasPassword: true };
const ADMIN_USER  = { id: 'u-admin',  email: 'admin@test.com',  role: 'admin',  name: 'Admin User',  hasPassword: true };

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

// ── portal.html ───────────────────────────────────────────────────────────────

test.describe('Bearer fallback: portal.html', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('sends Authorization: Bearer header when ctc_jwt is in localStorage', async ({ page, context }) => {
    let capturedAuth = null;
    await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), CLIENT_JWT);
    await mockWorker(context, {
      'GET /auth/me': async (route, req) => {
        capturedAuth = req.headers()['authorization'] ?? null;
        return json(route, CLIENT_USER);
      },
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/invoices':  (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('#galleries-content .state-empty, .gallery-grid')).toBeVisible({ timeout: 10_000 });

    expect(capturedAuth).toBe(`Bearer ${CLIENT_JWT}`);
  });

  test('admin with JWT but no cookie is NOT logged out (does not redirect to /login.html)', async ({ page, context }) => {
    // Simulate the scenario: admin has JWT in localStorage, but /auth/me rejects cookies.
    // The Bearer header in the request should allow /auth/me to succeed.
    await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), ADMIN_JWT);
    await mockWorker(context, {
      // Worker accepts the Bearer JWT even though no cookie is sent
      'GET /auth/me':          (route, req) => {
        const auth = req.headers()['authorization'] ?? '';
        // Simulate: cookie rejected, Bearer accepted
        if (auth === `Bearer ${ADMIN_JWT}`) return json(route, CLIENT_USER);
        return json(route, { error: 'Unauthorized' }, 401);
      },
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/invoices':  (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    // Should reach the portal, NOT /login.html
    await expect(page.locator('#galleries-content .state-empty, .gallery-grid')).toBeVisible({ timeout: 10_000 });
    expect(page.url()).not.toMatch(/\/login(\.html)?/);
  });

  test('redirects to /login.html when neither cookie nor JWT is present', async ({ page, context }) => {
    // No addInitScript — no JWT in localStorage, no cookie
    await mockWorker(context, {
      'GET /auth/me': (route) => json(route, { error: 'Unauthorized' }, 401),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await page.waitForURL(/\/login(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/login(\.html)?/);
  });
});

// ── portal-project.html ───────────────────────────────────────────────────────

test.describe('Bearer fallback: portal-project.html', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('sends Authorization: Bearer header when ctc_jwt is in localStorage', async ({ page, context }) => {
    let capturedAuth = null;
    await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), CLIENT_JWT);
    await mockWorker(context, {
      'GET /auth/me': async (route, req) => {
        capturedAuth = req.headers()['authorization'] ?? null;
        return json(route, CLIENT_USER);
      },
      [`GET /portal/project/${PROJ_TOKEN}`]: (route) => json(route, {
        project: {
          id: 'p1', property: 'Test Resort', client_name: 'Test Client',
          collection: 'Test Stay', location: 'Miami, FL',
          shoot_date: '2026-08-01', stage: 'Active',
        },
        documents: [], proposals: [], questionnaires: [], messages: [],
      }),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${PROJ_TOKEN}`);
    await expect(page.locator('#ppTitle')).toBeVisible({ timeout: 10_000 });

    expect(capturedAuth).toBe(`Bearer ${CLIENT_JWT}`);
  });

  test('admin with JWT but no cookie is NOT logged out on project page', async ({ page, context }) => {
    await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), ADMIN_JWT);
    await mockWorker(context, {
      'GET /auth/me': (route, req) => {
        const auth = req.headers()['authorization'] ?? '';
        if (auth === `Bearer ${ADMIN_JWT}`) return json(route, CLIENT_USER);
        return json(route, { error: 'Unauthorized' }, 401);
      },
      [`GET /portal/project/${PROJ_TOKEN}`]: (route) => json(route, {
        project: {
          id: 'p1', property: 'Test Resort', client_name: 'Test Client',
          collection: 'Test Stay', location: 'Miami, FL',
          shoot_date: '2026-08-01', stage: 'Active',
        },
        documents: [], proposals: [], questionnaires: [], messages: [],
      }),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${PROJ_TOKEN}`);
    await expect(page.locator('#ppTitle')).toBeVisible({ timeout: 10_000 });
    expect(page.url()).not.toMatch(/\/login(\.html)?/);
  });

  test('redirects to /login.html when neither cookie nor JWT is present', async ({ page, context }) => {
    // portal-project.html calls /portal/project/{token} directly (not /auth/me first).
    // A 401 from that endpoint triggers the redirect to /login.html.
    await mockWorker(context, {
      [`GET /portal/project/${PROJ_TOKEN}`]: (route) => json(route, { error: 'Unauthorized' }, 401),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${PROJ_TOKEN}`);
    await page.waitForURL(/\/login(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/login(\.html)?/);
  });
});

// ── profile.html ──────────────────────────────────────────────────────────────

test.describe('Bearer fallback: profile.html', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('sends Authorization: Bearer header when ctc_jwt is in localStorage', async ({ page, context }) => {
    let capturedAuth = null;
    await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), CLIENT_JWT);
    await mockWorker(context, {
      'GET /auth/me': async (route, req) => {
        capturedAuth = req.headers()['authorization'] ?? null;
        return json(route, CLIENT_USER);
      },
    });

    await page.goto(`${STATIC_BASE}/profile.html`);
    await expect(page.locator('#nameInput')).toBeVisible({ timeout: 10_000 });

    expect(capturedAuth).toBe(`Bearer ${CLIENT_JWT}`);
  });

  test('admin with JWT but no cookie is NOT logged out on profile page', async ({ page, context }) => {
    await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), ADMIN_JWT);
    await mockWorker(context, {
      'GET /auth/me': (route, req) => {
        const auth = req.headers()['authorization'] ?? '';
        if (auth === `Bearer ${ADMIN_JWT}`) return json(route, CLIENT_USER);
        return json(route, { error: 'Unauthorized' }, 401);
      },
    });

    await page.goto(`${STATIC_BASE}/profile.html`);
    await expect(page.locator('#nameInput')).toBeVisible({ timeout: 10_000 });
    expect(page.url()).not.toMatch(/\/login(\.html)?/);
  });

  test('redirects to /login.html when neither cookie nor JWT is present', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/me': (route) => json(route, { error: 'Unauthorized' }, 401),
    });

    await page.goto(`${STATIC_BASE}/profile.html`);
    await page.waitForURL(/\/login(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/login(\.html)?/);
  });
});
