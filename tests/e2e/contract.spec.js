/**
 * Acceptance tests for the contract signing flow (item 6).
 *
 *  1. Contract loads title, date, and body from a valid token
 *  2. Signature block is hidden on load and a "Please scroll" notice is shown
 *  3. After scrolling to the bottom, the signature block activates
 *  4. Typed name signature — preview updates live as name is entered
 *  5. Submitting a typed signature transitions to client_signed state
 *  6. A contract in client_signed status shows the waiting-for-admin banner
 *  7. A fully_executed contract shows both signatures, audit trail, and print bar
 *  8. Invalid / not-found token renders the error state
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

const TOKEN = 'test-contract-token';

function json(route, data, status = 200) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify(data),
  });
}

// Long enough that the page overflows the 800px test viewport — keeps the
// scroll gate active (scrollNotice stays visible until the user scrolls).
const LONG_BODY = [
  '<p>This agreement is made between Coastal Travel Company and Grand Palms Hotel.</p>',
  ...Array.from({ length: 30 }, (_, i) =>
    `<p>Section ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. ` +
    `Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad ` +
    `minim veniam, quis nostrud exercitation ullamco laboris.</p>`
  ),
].join('');

function makeContract(overrides = {}) {
  return {
    token:              TOKEN,
    title:              'Photography Services Agreement',
    body:               LONG_BODY,
    created_at:         '2026-05-01T10:00:00Z',
    status:             'sent',
    client_name:        'Grand Palms Hotel',
    client_email:       'client@grandpalms.com',
    client_signature:   '',
    client_signed_at:   '',
    admin_signature:    '',
    admin_signed_at:    '',
    ...overrides,
  };
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

test.describe('Contract Signing Page', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('loads contract title, date, and body from a valid token', async ({ page, context }) => {
    const contract = makeContract();
    await mockWorker(context, {
      [`GET /contracts/${TOKEN}`]:        (route) => json(route, contract),
      [`POST /contracts/${TOKEN}/view`]:  (route) => json(route, { ok: true }),
    });

    await page.goto(`${STATIC_BASE}/contract.html#${TOKEN}`);

    await expect(page.locator('#contractWrap')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#contractTitle')).toContainText('Photography Services Agreement');
    await expect(page.locator('#contractBody')).toContainText('Grand Palms Hotel');
  });

  test('scroll notice is shown and submit button is disabled before scrolling', async ({ page, context }) => {
    const contract = makeContract();
    await mockWorker(context, {
      [`GET /contracts/${TOKEN}`]:       (route) => json(route, contract),
      [`POST /contracts/${TOKEN}/view`]: (route) => json(route, { ok: true }),
    });

    await page.goto(`${STATIC_BASE}/contract.html#${TOKEN}`);
    await expect(page.locator('#contractWrap')).toBeVisible({ timeout: 10_000 });

    // sigBlock is shown immediately for 'sent' contracts; scroll gate controls
    // scrollNotice visibility and submit button state
    await expect(page.locator('#sigBlock')).toBeVisible();
    await expect(page.locator('#scrollNotice')).toBeVisible();
    // Submit must be disabled until the user scrolls to the bottom
    await expect(page.locator('#submitBtn')).toBeDisabled();
  });

  test('scroll notice hides after scrolling to the contract bottom', async ({ page, context }) => {
    const contract = makeContract();
    await mockWorker(context, {
      [`GET /contracts/${TOKEN}`]:       (route) => json(route, contract),
      [`POST /contracts/${TOKEN}/view`]: (route) => json(route, { ok: true }),
    });

    await page.goto(`${STATIC_BASE}/contract.html#${TOKEN}`);
    await expect(page.locator('#contractWrap')).toBeVisible({ timeout: 10_000 });

    // Scroll window to bottom so the scroll gate fires
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    await expect(page.locator('#scrollNotice')).not.toBeVisible({ timeout: 5_000 });
    // sigBlock remains visible after scrolling
    await expect(page.locator('#sigBlock')).toBeVisible();
  });

  test('typed name preview updates live as the name is entered', async ({ page, context }) => {
    const contract = makeContract();
    await mockWorker(context, {
      [`GET /contracts/${TOKEN}`]:       (route) => json(route, contract),
      [`POST /contracts/${TOKEN}/view`]: (route) => json(route, { ok: true }),
    });

    await page.goto(`${STATIC_BASE}/contract.html#${TOKEN}`);
    await expect(page.locator('#contractWrap')).toBeVisible({ timeout: 10_000 });

    // Scroll to reveal sig block
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('#sigBlock')).toBeVisible({ timeout: 5_000 });

    await page.fill('#sigTypedInput', 'Rebecca Harper');
    await expect(page.locator('#sigTypedPreview')).toContainText('Rebecca Harper');
  });

  test('submitting a typed signature transitions to client_signed state', async ({ page, context }) => {
    const contract = makeContract();
    let signCalled = false;

    await mockWorker(context, {
      [`GET /contracts/${TOKEN}`]:       (route) => json(route, contract),
      [`POST /contracts/${TOKEN}/view`]: (route) => json(route, { ok: true }),
      [`POST /contracts/${TOKEN}/sign`]: (route) => {
        signCalled = true;
        return json(route, { ok: true });
      },
    });

    await page.goto(`${STATIC_BASE}/contract.html#${TOKEN}`);
    await expect(page.locator('#contractWrap')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('#sigBlock')).toBeVisible({ timeout: 5_000 });

    await page.fill('#sigTypedInput', 'Rebecca Harper');
    await page.check('#agreeCheck');
    await page.click('#submitBtn');

    // Status banner confirms submission
    await expect(page.locator('#statusBanner')).toBeVisible({ timeout: 5_000 });
    expect(signCalled).toBe(true);
  });

  test('client_signed contract shows the waiting-for-admin banner', async ({ page, context }) => {
    const contract = makeContract({
      status:           'client_signed',
      client_signature: 'Rebecca Harper',
      client_signed_at: '2026-05-10T14:30:00Z',
    });
    await mockWorker(context, {
      [`GET /contracts/${TOKEN}`]:       (route) => json(route, contract),
      [`POST /contracts/${TOKEN}/view`]: (route) => json(route, { ok: true }),
    });

    await page.goto(`${STATIC_BASE}/contract.html#${TOKEN}`);
    await expect(page.locator('#contractWrap')).toBeVisible({ timeout: 10_000 });

    // Signature block should not be shown — contract already signed
    await expect(page.locator('#sigBlock')).not.toBeVisible();
    await expect(page.locator('#statusBanner')).toBeVisible();
  });

  test('fully_executed contract shows signatures, audit trail, and print bar', async ({ page, context }) => {
    const contract = makeContract({
      status:           'fully_executed',
      client_signature: 'Rebecca Harper',
      client_signed_at: '2026-05-10T14:30:00Z',
      admin_signature:  'Coastal Travel Co',
      admin_signed_at:  '2026-05-10T16:00:00Z',
    });
    const auditEvents = [
      { event_type: 'created',              actor_email: 'admin@ctc.com',            created_at: '2026-05-01T10:00:00Z', ip_address: '1.2.3.4', body_hash: 'abc123' },
      { event_type: 'client_signed',        actor_email: 'client@grandpalms.com',    created_at: '2026-05-10T14:30:00Z', ip_address: '5.6.7.8', body_hash: 'abc123' },
      { event_type: 'admin_countersigned',  actor_email: 'admin@ctc.com',            created_at: '2026-05-10T16:00:00Z', ip_address: '1.2.3.4', body_hash: 'abc123' },
    ];

    await mockWorker(context, {
      [`GET /contracts/${TOKEN}`]:        (route) => json(route, contract),
      [`POST /contracts/${TOKEN}/view`]:  (route) => json(route, { ok: true }),
      [`GET /contracts/${TOKEN}/audit`]:  (route) => json(route, { events: auditEvents }),
    });

    await page.goto(`${STATIC_BASE}/contract.html#${TOKEN}`);
    await expect(page.locator('#contractWrap')).toBeVisible({ timeout: 10_000 });

    // Fully executed shows signatures panel
    await expect(page.locator('#sigsDisplay')).toBeVisible({ timeout: 5_000 });
    // Audit trail entries present — labelEvent() maps to human-readable labels
    await expect(page.locator('#auditTrail')).toContainText('Client signed');
    await expect(page.locator('#auditTrail')).toContainText('Admin countersigned');
    // Print/download bar visible
    await expect(page.locator('#printBar')).toBeVisible();
    // Signature block not shown for fully executed
    await expect(page.locator('#sigBlock')).not.toBeVisible();
  });

  test('invalid token renders the error state', async ({ page, context }) => {
    await mockWorker(context, {
      [`GET /contracts/bad-token`]:       (route) => json(route, { error: 'Contract not found' }, 404),
      [`POST /contracts/bad-token/view`]: (route) => json(route, { ok: true }),
    });

    await page.goto(`${STATIC_BASE}/contract.html#bad-token`);

    await expect(page.locator('#appState')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#appState')).toContainText(/not found|invalid|error/i);
    await expect(page.locator('#contractWrap')).not.toBeVisible();
  });
});
