/**
 * Acceptance tests for authentication and page-level access control.
 *
 * Login page:
 *  1. Renders sign-in form with email, password, and forgot-password link
 *  2. Shows first-time setup card when no admin account exists
 *  3. Already-logged-in client is redirected to /portal.html
 *  4. Already-logged-in admin is redirected to /admin/pipeline.html
 *
 * Client Portal:
 *  5. Unauthenticated visit redirects to /login.html
 *  6. Authenticated client sees their gallery grid
 *  7. Authenticated client with no galleries sees empty state
 *
 * Admin Panel:
 *  8. Unauthenticated visit redirects to /login.html
 *  9. Client JWT redirects to /portal.html (admin panel is admin-only)
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':      STATIC_BASE,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods':     'GET, POST, OPTIONS',
  'access-control-allow-headers':     'Content-Type, Authorization',
};

/**
 * Register per-endpoint handlers against the Worker URL on this context.
 * Keys can be 'METHOD /path' (e.g. 'GET /auth/me') or just '/path' for any method.
 */
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
        // Return a harmless 404 for unmocked endpoints so pages don't hang
        await route.fulfill({ status: 404, headers: CORS, body: `No mock for: ${key}` });
      }
    },
  );
}

function adminResponse(route) {
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify({ id: 'u1', email: 'admin@test.com', role: 'admin' }),
  });
}

function clientResponse(route) {
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify({ id: 'u2', email: 'client@test.com', role: 'client' }),
  });
}

// ── Login Page ────────────────────────────────────────────────────────────────

test.describe('Login Page', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('renders sign-in form with email, password, and forgot-password link', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status': (route) => route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify({ configured: true }),
      }),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await expect(page.locator('#loginEmail')).toBeVisible();
    await expect(page.locator('#loginPassword')).toBeVisible();
    await expect(page.locator('#loginBtn')).toBeVisible();
    await expect(page.locator('#forgotLink')).toBeVisible();
  });

  test('successful login redirects to portal/admin', async ({ page, context }) => {
    let authenticated = false;
    await mockWorker(context, {
      'GET /auth/setup-status': (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify({ configured: true }),
      }),
      'POST /auth/login': async (route) => {
        authenticated = true;
        await route.fulfill({
          status: 200, headers: { 'content-type': 'application/json', ...CORS },
          body: JSON.stringify({ token: 'mock-login-jwt', user: { id: 'u1', email: 'admin@test.com', role: 'admin' } }),
        });
      },
      'GET /auth/me': (route) => authenticated
        ? adminResponse(route)
        : route.fulfill({ status: 401, headers: { 'content-type': 'application/json', ...CORS }, body: '{"error":"Unauthorized"}' }),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await page.fill('#loginEmail',    'admin@test.com');
    await page.fill('#loginPassword', 'password123');
    await page.click('#loginBtn');

    await page.waitForURL(/\/(admin\/pipeline|portal)(\.html)?/, { timeout: 10_000 });
  });

  test('shows first-time setup card when no admin account exists yet', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status': (route) => route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify({ configured: false }),
      }),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await expect(page.locator('#setupCard')).not.toHaveClass(/hidden/, { timeout: 5_000 });
    await expect(page.locator('#loginCard')).toHaveClass(/hidden/);
  });

  test('already-logged-in client is redirected to the portal', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-client'));
    await mockWorker(context, {
      // login.html verifies the JWT; portal.html re-verifies on load and redirects
      // back to /login.html if any of these calls fail, so all three must be mocked.
      'GET /auth/me':          (route) => clientResponse(route),
      'GET /portal/galleries': (route) => route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify([]),
      }),
      'GET /portal/invoices': (route) => route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify([]),
      }),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await page.waitForURL(/\/portal(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/portal(\.html)?/);
  });

  test('already-logged-in admin is redirected to the admin panel', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-admin'));
    await mockWorker(context, {
      'GET /auth/me': (route) => adminResponse(route),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await page.waitForURL(/\/pipeline(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/pipeline(\.html)?/);
  });
});

// ── Client Portal ─────────────────────────────────────────────────────────────

test.describe('Client Portal', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('redirects to /login.html when no JWT is present', async ({ page }) => {
    await page.goto(`${STATIC_BASE}/portal.html`);
    await page.waitForURL(/\/login(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/login(\.html)?/);
  });

  test('renders gallery grid for an authenticated client', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-client'));
    await mockWorker(context, {
      'GET /auth/me':          (route) => clientResponse(route),
      'GET /portal/galleries': (route) => route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify([
          {
            id: 'g1',
            eventName:  'Grand Palms Resort · March 2024',
            clientName: 'Test Client',
            watermark:  false,
            created:    '2024-03-15',
          },
        ]),
      }),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('.gallery-grid')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.card-event')).toContainText('Grand Palms Resort');
  });

  test('shows empty state when client has no assigned galleries', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-client'));
    await mockWorker(context, {
      'GET /auth/me':          (route) => clientResponse(route),
      'GET /portal/galleries': (route) => route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify([]),
      }),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('.state-empty')).toBeVisible({ timeout: 10_000 });
  });
});

// ── Admin Panel Auth ──────────────────────────────────────────────────────────

test.describe('Admin Panel Auth', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('redirects to /login.html when no JWT is present', async ({ page }) => {
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);
    await page.waitForURL(/\/login(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/login(\.html)?/);
  });

  test('redirects to /portal.html when JWT belongs to a non-admin client', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-client'));
    await mockWorker(context, {
      'GET /auth/me': (route) => clientResponse(route),
    });

    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);
    await page.waitForURL(/\/portal(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/portal(\.html)?/);
  });
});

// ── Google OAuth (stubbed via page.route) ─────────────────────────────────────
// These tests verify the frontend wiring — that a successful /auth/google
// response stores the JWT and redirects to /portal.html. They do NOT test
// Cloudflare ↔ Google token verification (that requires a real Google account).

test.describe('Google OAuth login (stubbed)', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('successful Google credential redirects to portal', async ({ page, context }) => {
    let authenticated = false;
    await mockWorker(context, {
      'POST /auth/google': async (route) => {
        authenticated = true;
        await route.fulfill({
          status:  200,
          headers: { 'content-type': 'application/json', ...CORS },
          body: JSON.stringify({
            token: 'mock-google-jwt',
            user:  { id: 'gu1', email: 'google@example.com', role: 'client' },
          }),
        });
      },
      'GET /auth/me': (route) => authenticated
        ? clientResponse(route)
        : route.fulfill({ status: 401, headers: { 'content-type': 'application/json', ...CORS }, body: '{"error":"Unauthorized"}' }),
      'GET /portal/galleries': (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: '[]',
      }),
      'GET /portal/invoices': (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: '[]',
      }),
    });

    await page.goto(`${STATIC_BASE}/login.html`);

    // Directly invoke handleGoogleCredential — bypasses the GSI button (requires real Google account)
    await page.evaluate((workerUrl) => {
      window.google = { accounts: { id: { initialize: () => {}, renderButton: () => {} } } };
      window.handleGoogleCredential({ credential: 'fake-google-id-token' });
    }, WORKER_URL);

    await page.waitForURL(/\/portal(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/portal(\.html)?/);
  });

  test('failed Google credential shows error message', async ({ page, context }) => {
    await mockWorker(context, {
      'POST /auth/google': (route) => route.fulfill({
        status:  401,
        headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify({ error: 'Invalid Google token' }),
      }),
    });

    await page.goto(`${STATIC_BASE}/login.html`);

    await page.evaluate(() => {
      window.google = { accounts: { id: { initialize: () => {}, renderButton: () => {} } } };
      window.handleGoogleCredential({ credential: 'bad-token' });
    });

    await expect(page.locator('#loginError')).toContainText(/Google sign-in failed|Invalid/i, { timeout: 5_000 });
    expect(page.url()).not.toMatch(/\/portal(\.html)?/);
  });

  test('worker 500 with non-JSON body shows error instead of silently failing', async ({ page, context }) => {
    // Simulates Cloudflare returning an HTML error page when the Worker throws an
    // unhandled exception — previously res.json() threw, the GSI callback swallowed
    // the rejection, and the user was left on the login page with no feedback.
    await mockWorker(context, {
      'POST /auth/google': (route) => route.fulfill({
        status:  500,
        headers: { 'content-type': 'text/html', ...CORS },
        body:    '<html><body>Error 1101: Worker threw an exception</body></html>',
      }),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await page.evaluate(() => {
      window.google = { accounts: { id: { initialize: () => {}, renderButton: () => {} } } };
      window.handleGoogleCredential({ credential: 'fake-token' });
    });

    await expect(page.locator('#loginError')).toContainText(/Google sign-in failed/i, { timeout: 5_000 });
    expect(page.url()).not.toMatch(/\/portal(\.html)?/);
  });

  test('network error during Google auth shows error instead of silently failing', async ({ page, context }) => {
    await mockWorker(context, {
      'POST /auth/google': (route) => route.abort(),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await page.evaluate(() => {
      window.google = { accounts: { id: { initialize: () => {}, renderButton: () => {} } } };
      window.handleGoogleCredential({ credential: 'fake-token' });
    });

    await expect(page.locator('#loginError')).toContainText(/Google sign-in failed/i, { timeout: 5_000 });
    expect(page.url()).not.toMatch(/\/portal(\.html)?/);
  });
});

// ── JWT localStorage fallback (cross-origin cookie regression guard) ──────────
// Regression guard for the fix that restores localStorage JWT storage so that
// browsers which block cross-origin (.workers.dev) cookies still stay logged in.

test.describe('JWT localStorage fallback', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('successful password login stores JWT token in localStorage', async ({ page, context }) => {
    let loggedIn = false;
    await mockWorker(context, {
      'GET /auth/setup-status': (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify({ configured: true }),
      }),
      'POST /auth/login': async (route) => {
        loggedIn = true;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', ...CORS },
          body: JSON.stringify({ token: 'stored-admin-jwt', user: { id: 'u1', email: 'admin@test.com', role: 'admin' } }),
        });
      },
      'GET /auth/me': (route) => loggedIn
        ? adminResponse(route)
        : route.fulfill({ status: 401, headers: CORS, body: '{"error":"Unauthorized"}' }),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await page.fill('#loginEmail',    'admin@test.com');
    await page.fill('#loginPassword', 'password123');
    await page.click('#loginBtn');

    await page.waitForURL(/pipeline/, { timeout: 10_000 });

    const stored = await page.evaluate(() => localStorage.getItem('ctc_jwt'));
    expect(stored).toBe('stored-admin-jwt');
  });

  test('admin panel loads via Bearer token when cross-origin cookie is blocked', async ({ page, context }) => {
    // Simulates third-party cookie blocking: /auth/me only returns 200 for requests
    // that carry Authorization: Bearer — no cookie accepted.
    await mockWorker(context, {
      'GET /auth/me': async (route, req) => {
        const auth = req.headers()['authorization'] || '';
        if (auth.startsWith('Bearer mock-admin-jwt')) return adminResponse(route);
        return route.fulfill({ status: 401, headers: CORS, body: '{"error":"cookie blocked"}' });
      },
    });

    // Simulate post-login state: storeAuth() wrote the JWT to localStorage
    await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), 'mock-admin-jwt');
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    // apiFetch must send Authorization: Bearer so authGate passes without a cookie
    await expect(page.locator('#adminEmail')).toHaveText('admin@test.com', { timeout: 10_000 });
    expect(page.url()).toContain('pipeline.html');
  });

  test('sign-out removes JWT from localStorage', async ({ page, context }) => {
    let loggedIn = true;
    await mockWorker(context, {
      'GET /auth/me': (route) => loggedIn
        ? adminResponse(route)
        : route.fulfill({ status: 401, headers: CORS, body: '{"error":"Unauthorized"}' }),
      'POST /auth/logout': async (route) => {
        loggedIn = false;
        await route.fulfill({ status: 200, headers: CORS, body: '{"ok":true}' });
      },
      'GET /auth/setup-status': (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify({ configured: true }),
      }),
    });

    await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), 'pre-logout-jwt');
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#adminEmail')).toHaveText('admin@test.com', { timeout: 10_000 });

    // Trigger sign-out
    await page.click('.sign-out-btn');
    await page.waitForURL(/\/login(\.html)?/, { timeout: 10_000 });

    // ctc_jwt must be cleared from localStorage by signOut()
    const stored = await page.evaluate(() => localStorage.getItem('ctc_jwt'));
    expect(stored).toBeNull();
  });
});

// ── Google Sign-In double-init prevention ─────────────────────────────────────
// Regression guard for the googleInitialized flag added to initGoogle().
// Without the guard, the script onload, window.load, and init() all call
// initGoogle() simultaneously — renderButton() on the same container crashes
// with "removeChild: node is no longer a child of this node".

test.describe('Google Sign-In double-init prevention', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('google.accounts.id.initialize called exactly once regardless of init trigger order', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status': (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify({ configured: true }),
      }),
      'GET /auth/me': (r) => r.fulfill({ status: 401, headers: CORS, body: '{}' }),
    });

    // Return an empty stub for the GSI script so the onload fires but nothing overrides our mock
    await context.route('https://accounts.google.com/gsi/client', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }),
    );

    // Inject a counting mock BEFORE the page scripts run
    await page.addInitScript(() => {
      window.__googleInitCount   = 0;
      window.__googleRenderCount = 0;
      window.google = {
        accounts: {
          id: {
            initialize:   () => { window.__googleInitCount++;   },
            renderButton: () => { window.__googleRenderCount++; },
          },
        },
      };
    });

    await page.goto(`${STATIC_BASE}/login.html`);

    // Allow all async init sequences (script onload, window.load, init()) to settle
    await page.waitForLoadState('networkidle');

    const initCount   = await page.evaluate(() => window.__googleInitCount);
    const renderCount = await page.evaluate(() => window.__googleRenderCount);

    expect(initCount).toBe(1);
    expect(renderCount).toBe(1);
  });
});
