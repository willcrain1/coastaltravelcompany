/**
 * Acceptance tests for the contact form on contact.html.
 *
 * Covers:
 *  1. Form renders with all required fields visible
 *  2. Successful submission → button shows confirmation, status shows success text
 *  3. Server error response → status shows error message, button re-enabled
 *  4. Network error → status shows network error message, button re-enabled
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':      STATIC_BASE,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods':     'GET, POST, OPTIONS',
  'access-control-allow-headers':     'Content-Type',
};

test.describe('Contact Form', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('renders with all required fields visible', async ({ page }) => {
    await page.goto(`${STATIC_BASE}/contact.html`);
    await expect(page.locator('#first-name')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#message')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('successful submission shows confirmation on the button and a success status message', async ({ page, context }) => {
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL + '/contact'),
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', ...CORS },
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await page.goto(`${STATIC_BASE}/contact.html`);
    await page.fill('#first-name', 'Test');
    await page.fill('#email',      'test@example.com');
    await page.fill('#message',    'This is a test inquiry.');
    await page.click('button[type="submit"]');

    // Button text changes and stays disabled after a successful send
    const btn = page.locator('button[type="submit"]');
    await expect(btn).toContainText('Inquiry Sent', { timeout: 5_000 });
    // Status paragraph shows a success message
    await expect(page.locator('#form-status')).toContainText('received', { timeout: 5_000 });
  });

  test('rate-limit error from server shows error message and re-enables the button', async ({ page, context }) => {
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL + '/contact'),
      async (route) => {
        await route.fulfill({
          status: 429,
          headers: { 'content-type': 'application/json', ...CORS },
          body: JSON.stringify({ error: 'Too many requests. Try again in an hour.' }),
        });
      },
    );

    await page.goto(`${STATIC_BASE}/contact.html`);
    await page.fill('#first-name', 'Test');
    await page.fill('#email',      'test@example.com');
    await page.fill('#message',    'This is a test inquiry.');
    await page.click('button[type="submit"]');

    await expect(page.locator('#form-status')).toContainText('Too many requests', { timeout: 5_000 });
    await expect(page.locator('button[type="submit"]')).toBeEnabled();
  });

  test('network failure shows network error message and re-enables the button', async ({ page, context }) => {
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL + '/contact'),
      async (route) => { await route.abort('failed'); },
    );

    await page.goto(`${STATIC_BASE}/contact.html`);
    await page.fill('#first-name', 'Test');
    await page.fill('#email',      'test@example.com');
    await page.fill('#message',    'This is a test inquiry.');
    await page.click('button[type="submit"]');

    await expect(page.locator('#form-status')).toContainText('Network error', { timeout: 5_000 });
    await expect(page.locator('button[type="submit"]')).toBeEnabled();
  });
});
