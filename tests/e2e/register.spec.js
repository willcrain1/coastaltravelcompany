/**
 * Acceptance tests for the registration page.
 *
 *  1. Registration form renders with name, email, password, and confirm fields
 *  2. Successful registration stores JWT in localStorage and redirects to portal
 *  3. Server error (e.g. email already taken) shows an error message
 *  4. Password mismatch is caught client-side before any API call is made
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

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

test.describe('Registration Page', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('renders the registration form with all required fields', async ({ page }) => {
    await page.goto(`${STATIC_BASE}/register.html`);
    await expect(page.locator('#regName')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#regEmail')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#regPassword')).toBeVisible();
    await expect(page.locator('#regConfirm')).toBeVisible();
    await expect(page.locator('#registerBtn')).toBeVisible();
  });

  test('successful registration stores JWT and redirects to portal', async ({ page, context }) => {
    await mockWorker(context, {
      'POST /auth/register': (route) => json(route, {
        token: 'mock-jwt-new-client',
        user:  { id: 'u-new', email: 'new@example.com', role: 'client' },
      }),
      // portal.html calls /auth/me on load — must succeed so it doesn't redirect back to login
      'GET /auth/me': (route) => json(route, { id: 'u-new', email: 'new@example.com', role: 'client' }),
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/invoices':  (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/register.html`);
    await page.fill('#regName',     'New Client');
    await page.fill('#regEmail',    'new@example.com');
    await page.fill('#regPassword', 'SecurePass1!');
    await page.fill('#regConfirm',  'SecurePass1!');
    await page.click('#registerBtn');

    await page.waitForURL(/\/portal(\.html)?/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/portal(\.html)?/);

    const jwt = await page.evaluate(() => localStorage.getItem('ctc_jwt'));
    expect(jwt).toBe('mock-jwt-new-client');
  });

  test('email-already-taken error shows the error message', async ({ page, context }) => {
    await mockWorker(context, {
      'POST /auth/register': (route) => json(route, { error: 'Email already registered' }, 409),
    });

    await page.goto(`${STATIC_BASE}/register.html`);
    await page.fill('#regName',     'Existing Client');
    await page.fill('#regEmail',    'existing@example.com');
    await page.fill('#regPassword', 'SecurePass1!');
    await page.fill('#regConfirm',  'SecurePass1!');
    await page.click('#registerBtn');

    await expect(page.locator('#registerError')).toHaveClass(/show/, { timeout: 5_000 });
    await expect(page.locator('#registerError')).toContainText(/already|taken|registered/i);
    expect(page.url()).not.toMatch(/\/portal(\.html)?/);
  });

  test('password mismatch is caught client-side without calling the API', async ({ page, context }) => {
    let apiCalled = false;
    await mockWorker(context, {
      'POST /auth/register': (route) => { apiCalled = true; return json(route, {}); },
    });

    await page.goto(`${STATIC_BASE}/register.html`);
    await page.fill('#regName',     'Test Client');
    await page.fill('#regEmail',    'test@example.com');
    await page.fill('#regPassword', 'SecurePass1!');
    await page.fill('#regConfirm',  'DifferentPass2!');
    await page.click('#registerBtn');

    // Error shown, no API call made, no redirect
    await expect(page.locator('#registerError')).toHaveClass(/show/, { timeout: 3_000 });
    expect(apiCalled).toBe(false);
    expect(page.url()).not.toMatch(/\/portal(\.html)?/);
  });
});

// ── Email verification flow ────────────────────────────────────────────────────

test.describe('Email verification', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('valid verify token shows success message on login page', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/verify': (route) => json(route, { ok: true }),
      'GET /auth/setup-status': (route) => json(route, { configured: true }),
    });

    await page.goto(`${STATIC_BASE}/login.html?verify=valid-token-abc`);
    await expect(page.locator('#loginSuccess')).toContainText(/verified|sign in/i, { timeout: 10_000 });
    await expect(page.locator('#loginCard')).toBeVisible();
  });

  test('expired verify token shows error and resend section', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/verify': (route) => json(route, { error: 'Invalid or expired verification link' }, 400),
      'GET /auth/setup-status': (route) => json(route, { configured: true }),
    });

    await page.goto(`${STATIC_BASE}/login.html?verify=expired-token`);
    await expect(page.locator('#loginError')).toContainText(/expired|invalid/i, { timeout: 10_000 });
    await expect(page.locator('#resendSection')).not.toHaveClass(/hidden/);
  });

  test('resend verification calls POST /auth/resend-verify and shows confirmation', async ({ page, context }) => {
    let resendCalled = false;
    await mockWorker(context, {
      'GET /auth/verify': (route) => json(route, { error: 'expired' }, 400),
      'GET /auth/setup-status': (route) => json(route, { configured: true }),
      'POST /auth/resend-verify': (route) => { resendCalled = true; return json(route, { ok: true }); },
    });

    await page.goto(`${STATIC_BASE}/login.html?verify=expired-token`);
    await expect(page.locator('#resendSection')).not.toHaveClass(/hidden/, { timeout: 10_000 });

    await page.fill('#resendEmail', 'user@example.com');
    await page.click('#resendBtn');

    await expect(page.locator('#resendSuccess')).toContainText(/new link has been sent/i, { timeout: 5_000 });
    expect(resendCalled).toBe(true);
  });
});

// ── Password reset flow ────────────────────────────────────────────────────────

test.describe('Password reset flow', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('forgot password form shows success message after submission', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status':  (route) => json(route, { configured: true }),
      'POST /auth/reset-request': (route) => json(route, { ok: true }),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await page.click('#forgotLink');
    await expect(page.locator('#forgotCard')).toBeVisible({ timeout: 5_000 });

    await page.fill('#forgotEmail', 'user@example.com');
    await page.click('#forgotBtn');

    await expect(page.locator('#forgotSuccess')).toContainText(/reset link has been sent/i, { timeout: 5_000 });
  });

  test('reset link URL shows the reset password card', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status': (route) => json(route, { configured: true }),
    });

    await page.goto(`${STATIC_BASE}/login.html?reset=my-reset-token`);
    await expect(page.locator('#resetCard')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#resetPassword')).toBeVisible();
    await expect(page.locator('#resetConfirm')).toBeVisible();
  });

  test('successful password reset shows success and redirects to login', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status':  (route) => json(route, { configured: true }),
      'POST /auth/reset-confirm': (route) => json(route, { ok: true }),
    });

    await page.goto(`${STATIC_BASE}/login.html?reset=valid-reset-token`);
    await expect(page.locator('#resetCard')).toBeVisible({ timeout: 5_000 });

    await page.fill('#resetPassword', 'NewPassword1!');
    await page.fill('#resetConfirm',  'NewPassword1!');
    await page.click('#resetBtn');

    await expect(page.locator('#resetSuccess')).toContainText(/password updated/i, { timeout: 5_000 });
    // After 2s redirect back to loginCard
    await expect(page.locator('#loginCard')).toBeVisible({ timeout: 5_000 });
  });

  test('password mismatch on reset form shows error without calling API', async ({ page, context }) => {
    let apiCalled = false;
    await mockWorker(context, {
      'GET /auth/setup-status':  (route) => json(route, { configured: true }),
      'POST /auth/reset-confirm': (route) => { apiCalled = true; return json(route, { ok: true }); },
    });

    await page.goto(`${STATIC_BASE}/login.html?reset=tok`);
    await expect(page.locator('#resetCard')).toBeVisible({ timeout: 5_000 });
    await page.fill('#resetPassword', 'Password1!');
    await page.fill('#resetConfirm',  'Different1!');
    await page.click('#resetBtn');

    await expect(page.locator('#resetError')).toContainText(/do not match/i, { timeout: 3_000 });
    expect(apiCalled).toBe(false);
  });

  test('invalid reset token shows error from server', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status':  (route) => json(route, { configured: true }),
      'POST /auth/reset-confirm': (route) => json(route, { error: 'Invalid or expired reset link' }, 400),
    });

    await page.goto(`${STATIC_BASE}/login.html?reset=bad-token`);
    await expect(page.locator('#resetCard')).toBeVisible({ timeout: 5_000 });
    await page.fill('#resetPassword', 'Password1!');
    await page.fill('#resetConfirm',  'Password1!');
    await page.click('#resetBtn');

    await expect(page.locator('#resetError')).toContainText(/expired|invalid/i, { timeout: 5_000 });
  });
});
