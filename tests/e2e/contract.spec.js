/**
 * Acceptance tests for the contract signing flow (item 6) and admin
 * countersigning flow (item 43).
 *
 * Client-facing contract.html:
 *  1. Contract loads title, date, and body from a valid token
 *  2. Signature block is hidden on load and a "Please scroll" notice is shown
 *  3. After scrolling to the bottom, the signature block activates
 *  4. Typed name signature — preview updates live as name is entered
 *  5. Submitting a typed signature transitions to client_signed state
 *  6. A contract in client_signed status shows the waiting-for-admin banner
 *  7. A fully_executed contract shows both signatures, audit trail, and print bar
 *  8. Invalid / not-found token renders the error state
 *
 * Admin pipeline — countersigning (item 43):
 *  9.  Countersign block appears when a contract has client_signed status
 * 10. Admin types name and clicks Countersign — countersign endpoint is called
 * 11. Countersign block hides after successful countersign (contract reloads as fully_executed)
 * 12. Empty admin signature is rejected without calling the API
 * 13. Countersign block is hidden when contract is already fully_executed
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

// ── Admin Pipeline — Contract Countersigning (item 43) ────────────────────────

const ADMIN_PROJ = {
  id:          'proj1',
  client_name: 'Grand Palms Hotel',
  client_email: 'client@grandpalms.com',
  property:    'Grand Palms Resort',
  collection:  'The Editorial Stay',
  location:    'Palm Beach, FL',
  stage:       'Contract Sent',
  source:      'manual',
  labels:      '',
  shoot_date:  null,
  created_at:  new Date(Date.now() - 10 * 86_400_000).toISOString(),
  updated_at:  new Date(Date.now() - 86_400_000).toISOString(),
};

const CLIENT_SIGNED_CONTRACT = {
  id:               'con1',
  title:            'Photography Services Agreement',
  status:           'client_signed',
  signing_token:    'tok-con1',
  client_signed_at: new Date(Date.now() - 3_600_000).toISOString(),
  admin_signed_at:  null,
  created_at:       new Date(Date.now() - 86_400_000).toISOString(),
};

const FULLY_EXECUTED_CONTRACT = {
  ...CLIENT_SIGNED_CONTRACT,
  status:          'fully_executed',
  admin_signed_at: new Date().toISOString(),
};

/**
 * Mocks every admin pipeline endpoint needed to open a project and reach the
 * contracts section. `contractCallResponses` is an array of arrays — each GET
 * to the contracts endpoint returns the next entry (the last entry repeats).
 */
function mockAdminWithContracts(context, { contractCallResponses = [[]] } = {}) {
  const adminCors = {
    'access-control-allow-origin':  '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
  };
  let contractsCallIdx = 0;

  return context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req    = route.request();
      const url    = new URL(req.url());
      const method = req.method();

      if (method === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: adminCors });
        return;
      }

      function ok(data, status = 200) {
        return route.fulfill({
          status,
          headers: { 'content-type': 'application/json', ...adminCors },
          body: JSON.stringify(data),
        });
      }

      if (url.pathname === '/auth/me')
        return ok({ id: 'a1', email: 'admin@test.com', role: 'admin' });

      if (url.pathname === '/admin/projects' && method === 'GET')
        return ok([ADMIN_PROJ]);

      for (const p of ['/admin/packages', '/admin/questionnaires', '/admin/contract-templates'])
        if (url.pathname === p) return ok([]);

      for (const pattern of [
        /^\/admin\/projects\/[^/]+\/notes$/,
        /^\/admin\/projects\/[^/]+\/documents$/,
        /^\/admin\/projects\/[^/]+\/proposals$/,
        /^\/admin\/projects\/[^/]+\/questionnaires$/,
        /^\/admin\/projects\/[^/]+\/schedule-links$/,
        /^\/admin\/projects\/[^/]+\/messages$/,
        /^\/admin\/projects\/[^/]+\/invoices$/,
      ]) {
        if (url.pathname.match(pattern)) return ok([]);
      }

      if (url.pathname.match(/^\/admin\/projects\/[^/]+\/contracts$/) && method === 'GET') {
        const idx  = Math.min(contractsCallIdx, contractCallResponses.length - 1);
        contractsCallIdx++;
        return ok(contractCallResponses[idx]);
      }

      if (url.pathname.match(/^\/admin\/projects\/[^/]+\/contracts$/) && method === 'POST')
        return ok({ id: 'con-new', created_at: new Date().toISOString() }, 201);

      if (url.pathname.match(/^\/admin\/projects\/[^/]+\/contracts\/[^/]+\/countersign$/) && method === 'POST')
        return ok({ ok: true, updated_at: new Date().toISOString() });

      await route.fulfill({ status: 404, headers: adminCors });
    },
  );
}

test.describe('Admin Pipeline — Contract Countersigning', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-admin'));
  });

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('countersign block appears when a contract has client_signed status', async ({ page, context }) => {
    await mockAdminWithContracts(context, {
      contractCallResponses: [[CLIENT_SIGNED_CONTRACT]],
    });

    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);
    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('.pc-card');
    await expect(page.locator('#projectDetail')).toHaveClass(/open/);

    await expect(page.locator('#pd-countersign-block')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#pd-countersign-block')).toContainText('Client has signed');
  });

  test('admin types name and clicks Countersign — endpoint called with typed signature', async ({ page, context }) => {
    let countersignPayload = null;

    await mockAdminWithContracts(context, {
      contractCallResponses: [[CLIENT_SIGNED_CONTRACT], [FULLY_EXECUTED_CONTRACT]],
    });

    // Override just the countersign route to capture the payload
    await context.route(
      (url) => url.pathname.includes('/contracts/con1/countersign'),
      async (route) => {
        countersignPayload = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status:  200,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          body:    JSON.stringify({ ok: true }),
        });
      },
    );

    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);
    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('.pc-card');
    await expect(page.locator('#pd-countersign-block')).toBeVisible({ timeout: 5_000 });

    await page.fill('#adminSigTyped', 'Coastal Travel Co');
    await page.click('#pd-countersign-block button:has-text("Countersign")');

    await expect(async () => {
      expect(countersignPayload).not.toBeNull();
    }).toPass({ timeout: 5_000 });

    expect(countersignPayload.signature).toBe('Coastal Travel Co');
    expect(countersignPayload.signature_type).toBe('type');
  });

  test('countersign block hides after successful countersign', async ({ page, context }) => {
    await mockAdminWithContracts(context, {
      contractCallResponses: [[CLIENT_SIGNED_CONTRACT], [FULLY_EXECUTED_CONTRACT]],
    });

    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);
    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('.pc-card');
    await expect(page.locator('#pd-countersign-block')).toBeVisible({ timeout: 5_000 });

    await page.fill('#adminSigTyped', 'Coastal Travel Co');
    await page.click('#pd-countersign-block button:has-text("Countersign")');

    // Contracts reload with fully_executed — no client_signed found → block hides
    await expect(page.locator('#pd-countersign-block')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#pd-contract-list')).toContainText('Photography Services Agreement');
  });

  test('empty admin signature is rejected without calling the API', async ({ page, context }) => {
    let countersignCalled = false;

    await context.route(
      (url) => url.pathname.includes('/countersign'),
      async (route) => {
        countersignCalled = true;
        await route.continue();
      },
    );

    await mockAdminWithContracts(context, {
      contractCallResponses: [[CLIENT_SIGNED_CONTRACT]],
    });

    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);
    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('.pc-card');
    await expect(page.locator('#pd-countersign-block')).toBeVisible({ timeout: 5_000 });

    // Submit with no signature typed
    await page.click('#pd-countersign-block button:has-text("Countersign")');
    await page.waitForTimeout(500);

    expect(countersignCalled).toBe(false);
    // Block remains open — validation error surfaced via toast, not API
    await expect(page.locator('#pd-countersign-block')).toBeVisible();
  });

  test('countersign block is hidden when contract is already fully_executed', async ({ page, context }) => {
    await mockAdminWithContracts(context, {
      contractCallResponses: [[FULLY_EXECUTED_CONTRACT]],
    });

    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);
    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('.pc-card');
    await expect(page.locator('#projectDetail')).toHaveClass(/open/);

    await expect(page.locator('#pd-countersign-block')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#pd-contract-list')).toContainText('Photography Services Agreement');
  });
});
