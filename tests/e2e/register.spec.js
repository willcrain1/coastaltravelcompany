/**
 * Acceptance tests for the registration page.
 *
 *  1. Registration form renders with email, password, and confirm fields
 *  2. Successful registration stores JWT in localStorage and redirects to portal
 *  3. Server error (e.g. email already taken) shows an error message
 *  4. Password mismatch is caught client-side before any API call is made
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = 'http://localhost:9876';

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
    });

    await page.goto(`${STATIC_BASE}/register.html`);
    await page.fill('#regEmail',    'new@example.com');
    await page.fill('#regPassword', 'SecurePass1!');
    await page.fill('#regConfirm',  'SecurePass1!');
    await page.click('#registerBtn');

    await page.waitForURL('**/portal.html', { timeout: 10_000 });
    expect(page.url()).toContain('portal.html');

    const jwt = await page.evaluate(() => localStorage.getItem('ctc_jwt'));
    expect(jwt).toBe('mock-jwt-new-client');
  });

  test('email-already-taken error shows the error message', async ({ page, context }) => {
    await mockWorker(context, {
      'POST /auth/register': (route) => json(route, { error: 'Email already registered' }, 409),
    });

    await page.goto(`${STATIC_BASE}/register.html`);
    await page.fill('#regEmail',    'existing@example.com');
    await page.fill('#regPassword', 'SecurePass1!');
    await page.fill('#regConfirm',  'SecurePass1!');
    await page.click('#registerBtn');

    await expect(page.locator('#registerError')).toHaveClass(/show/, { timeout: 5_000 });
    await expect(page.locator('#registerError')).toContainText(/already|taken|registered/i);
    expect(page.url()).not.toContain('portal.html');
  });

  test('password mismatch is caught client-side without calling the API', async ({ page, context }) => {
    let apiCalled = false;
    await mockWorker(context, {
      'POST /auth/register': (route) => { apiCalled = true; return json(route, {}); },
    });

    await page.goto(`${STATIC_BASE}/register.html`);
    await page.fill('#regEmail',    'test@example.com');
    await page.fill('#regPassword', 'SecurePass1!');
    await page.fill('#regConfirm',  'DifferentPass2!');
    await page.click('#registerBtn');

    // Error shown, no API call made, no redirect
    await expect(page.locator('#registerError')).toHaveClass(/show/, { timeout: 3_000 });
    expect(apiCalled).toBe(false);
    expect(page.url()).not.toContain('portal.html');
  });
});
