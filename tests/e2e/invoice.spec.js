/**
 * Acceptance tests for billing & invoicing (item 7).
 *
 * Public invoice page (invoice.html):
 *  1. Renders invoice number, line items, and total from a valid token
 *  2. Shows PAID banner and hides Pay Now button for paid invoices
 *  3. Shows Pay Now button for sent invoices when Stripe is enabled
 *  4. Clicking Pay Now redirects to the Stripe checkout URL
 *  5. Shows void state message for voided invoices
 *  6. Shows an error message when the token is invalid
 *
 * Admin pipeline — invoice section:
 *  7. Invoice section renders with the Add Line Item form when a project opens
 *  8. Creating an invoice adds it to the list as Draft with the correct total
 *  9. Sending an invoice changes the status badge to Sent
 * 10. Marking an invoice paid changes the badge to Paid
 *
 * Client portal — invoice history:
 * 11. Client sees the invoice section with a sent invoice and a Pay button
 * 12. Paid invoices render with a View link instead of a Pay button
 * 13. Invoice section is hidden when no invoices exist
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

function now() { return new Date().toISOString(); }
function daysAgo(n) { return new Date(Date.now() - n * 86_400_000).toISOString(); }

// ── Shared mock data ──────────────────────────────────────────────────────────

const MOCK_PROJECT = {
  id:          'proj1',
  client_name: 'Grand Palms Hotel',
  client_email: 'client@grandpalms.com',
  property:    'Grand Palms Resort',
  collection:  'The Editorial Stay',
  location:    'Palm Beach, FL',
  stage:       'Contract Signed',
  source:      'manual',
  labels:      '',
  shoot_date:  null,
  created_at:  daysAgo(10),
  updated_at:  daysAgo(2),
};

const MOCK_LINE_ITEMS = [
  { description: 'Editorial Stay deposit', quantity: 1, unit_price_cents: 125000 },
  { description: 'Rush delivery add-on',  quantity: 1, unit_price_cents:  25000 },
];

function makeInvoice(overrides = {}) {
  return {
    id:                       'inv1',
    project_id:               'proj1',
    invoice_number:           'INV-0001',
    status:                   'sent',
    line_items:               JSON.stringify(MOCK_LINE_ITEMS),
    subtotal_cents:           150000,
    tax_cents:                0,
    total_cents:              150000,
    due_date:                 '2026-06-15',
    magic_token:              'test-token-abc',
    stripe_session_id:        '',
    stripe_payment_intent_id: '',
    client_name:              'Grand Palms Hotel',
    client_email:             'client@grandpalms.com',
    notes:                    'Deposit due before shoot date.',
    sent_at:                  daysAgo(1),
    paid_at:                  '',
    created_at:               daysAgo(2),
    updated_at:               daysAgo(1),
    ...overrides,
  };
}

// ── Mock worker helpers ───────────────────────────────────────────────────────

/** Lightweight per-endpoint router — pass a map of "METHOD /path" → handler. */
function mockWorker(context, handlers) {
  return context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req    = route.request();
      const url    = new URL(req.url());
      const method = req.method();
      if (method === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS });
        return;
      }
      const key     = `${method} ${url.pathname}`;
      const handler = handlers[key] ?? handlers[url.pathname];
      if (handler) {
        await handler(route, req, url);
      } else {
        await route.fulfill({ status: 404, headers: CORS, body: `No mock for: ${key}` });
      }
    },
  );
}

function json(route, data, status = 200) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify(data),
  });
}

/**
 * Full admin mock covering every endpoint that pipeline.html's openProject
 * triggers, with configurable invoice data.
 */
async function mockAdminPipeline(context, { invoices = [], projects = [MOCK_PROJECT] } = {}) {
  let invoiceList = [...invoices];

  await context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req    = route.request();
      const url    = new URL(req.url());
      const method = req.method();

      try {
        if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }

        if (url.pathname === '/auth/me')
          return json(route, { id: 'admin1', email: 'admin@test.com', role: 'admin' });

        if (url.pathname === '/admin/projects') {
          if (method === 'GET')  return json(route, projects);
          if (method === 'POST') {
            const body = JSON.parse(req.postData() || '{}');
            return json(route, { id: 'pnew', ...body, stage: 'Inquiry', source: 'manual', created_at: now(), updated_at: now() }, 201);
          }
        }

        if (url.pathname === '/admin/packages')          return json(route, []);
        if (url.pathname === '/admin/questionnaires')    return json(route, []);
        if (url.pathname === '/admin/contract-templates') return json(route, []);

        const projectIdMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)$/);
        if (projectIdMatch && method === 'PUT') {
          const body = JSON.parse(req.postData() || '{}');
          const proj = projects.find(p => p.id === projectIdMatch[1]) || {};
          return json(route, { ...proj, ...body, updated_at: now() });
        }

        // Project sub-resources that return empty lists
        for (const pattern of [
          /^\/admin\/projects\/([^/]+)\/notes$/,
          /^\/admin\/projects\/([^/]+)\/documents$/,
          /^\/admin\/projects\/([^/]+)\/proposals$/,
          /^\/admin\/projects\/([^/]+)\/questionnaires$/,
          /^\/admin\/projects\/([^/]+)\/schedule-links$/,
          /^\/admin\/projects\/([^/]+)\/messages$/,
          /^\/admin\/projects\/([^/]+)\/contracts$/,
        ]) {
          if (url.pathname.match(pattern) && method === 'GET') return json(route, []);
          if (url.pathname.match(pattern) && method === 'POST') return json(route, { id: 'new', created_at: now() }, 201);
        }

        // Invoices list + create
        const projectInvoicesMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)\/invoices$/);
        if (projectInvoicesMatch) {
          if (method === 'GET') return json(route, invoiceList);
          if (method === 'POST') {
            const body = JSON.parse(req.postData() || '{}');
            const items = body.line_items || [];
            const subtotal = items.reduce((s, i) => s + Math.round((i.quantity || 1) * (i.unit_price_cents || 0)), 0);
            const tax = Math.round(body.tax_cents || 0);
            const created = makeInvoice({
              id:             'inv-new',
              invoice_number: `INV-000${invoiceList.length + 1}`,
              status:         'draft',
              line_items:     JSON.stringify(items),
              subtotal_cents: subtotal,
              tax_cents:      tax,
              total_cents:    subtotal + tax,
              due_date:       body.due_date || '',
              magic_token:    'tok-new',
              notes:          body.notes || '',
              sent_at:        '',
              paid_at:        '',
              created_at:     now(),
              updated_at:     now(),
            });
            invoiceList = [created, ...invoiceList];
            return json(route, created, 201);
          }
        }

        // Invoice send
        const invoiceSendMatch = url.pathname.match(/^\/admin\/invoices\/([^/]+)\/send$/);
        if (invoiceSendMatch && method === 'POST') {
          const idx = invoiceList.findIndex(i => i.id === invoiceSendMatch[1]);
          if (idx >= 0) {
            invoiceList[idx] = { ...invoiceList[idx], status: 'sent', sent_at: now(), updated_at: now() };
            return json(route, { ...invoiceList[idx], public_url: `${STATIC_BASE}/invoice.html#tok-new` });
          }
          return json(route, { error: 'Not found' }, 404);
        }

        // Invoice update (mark paid, void)
        const invoiceUpdateMatch = url.pathname.match(/^\/admin\/invoices\/([^/]+)$/);
        if (invoiceUpdateMatch && method === 'PUT') {
          const body = JSON.parse(req.postData() || '{}');
          const idx  = invoiceList.findIndex(i => i.id === invoiceUpdateMatch[1]);
          if (idx >= 0) {
            invoiceList[idx] = { ...invoiceList[idx], ...body, updated_at: now() };
            return json(route, invoiceList[idx]);
          }
          return json(route, { error: 'Not found' }, 404);
        }

        await route.fulfill({ status: 404, headers: CORS });
      } catch {
        route.abort().catch(() => {});
      }
    },
  );
}

// ── Tests: Public Invoice Page ─────────────────────────────────────────────────

test.describe('Public Invoice Page', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('renders invoice number, line items, and total from a valid token', async ({ page, context }) => {
    const inv = makeInvoice({ status: 'sent' });
    await mockWorker(context, {
      [`GET /invoices/${inv.magic_token}`]: (route) => json(route, { ...inv, stripe_enabled: false }),
    });

    await page.goto(`${STATIC_BASE}/invoice.html#${inv.magic_token}`);
    await expect(page.locator('#inv-number')).toContainText('INV-0001', { timeout: 10_000 });

    // Both line items appear in the table
    await expect(page.locator('#inv-line-items')).toContainText('Editorial Stay deposit');
    await expect(page.locator('#inv-line-items')).toContainText('Rush delivery add-on');
    await expect(page.locator('#inv-line-items')).toContainText('$1,250.00');
    await expect(page.locator('#inv-line-items')).toContainText('$250.00');

    // Total row
    await expect(page.locator('.totals-block')).toContainText('$1,500.00');
  });

  test('shows PAID banner and hides Pay Now button for paid invoices', async ({ page, context }) => {
    const inv = makeInvoice({ status: 'paid', paid_at: daysAgo(1) });
    await mockWorker(context, {
      [`GET /invoices/${inv.magic_token}`]: (route) => json(route, { ...inv, stripe_enabled: true }),
    });

    await page.goto(`${STATIC_BASE}/invoice.html#${inv.magic_token}`);
    await expect(page.locator('#paid-banner')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#paid-banner')).toContainText('Payment received');
    await expect(page.locator('#pay-btn')).not.toBeAttached();
    await expect(page.locator('.status-badge')).toContainText('Paid');
  });

  test('shows Pay Now button for sent invoices when Stripe is enabled', async ({ page, context }) => {
    const inv = makeInvoice({ status: 'sent' });
    await mockWorker(context, {
      [`GET /invoices/${inv.magic_token}`]: (route) => json(route, { ...inv, stripe_enabled: true }),
    });

    await page.goto(`${STATIC_BASE}/invoice.html#${inv.magic_token}`);
    await expect(page.locator('#pay-btn')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#pay-btn')).toContainText('Pay $1,500.00 Now');
    await expect(page.locator('#paid-banner')).not.toBeVisible();
  });

  test('clicking Pay Now redirects to the Stripe checkout URL', async ({ page, context }) => {
    const inv = makeInvoice({ status: 'sent' });
    const stripeUrl = 'https://checkout.stripe.com/pay/cs_test_abc123';

    await mockWorker(context, {
      [`GET /invoices/${inv.magic_token}`]:            (route) => json(route, { ...inv, stripe_enabled: true }),
      [`POST /invoices/${inv.magic_token}/checkout`]:  (route) => json(route, { url: stripeUrl }),
    });

    // Route the Stripe domain so Playwright doesn't error on external navigation
    await context.route('https://checkout.stripe.com/**', (route) =>
      route.fulfill({ status: 200, body: '<html><body>Stripe</body></html>' })
    );

    await page.goto(`${STATIC_BASE}/invoice.html#${inv.magic_token}`);
    await expect(page.locator('#pay-btn')).toBeVisible({ timeout: 10_000 });

    const [navigation] = await Promise.all([
      page.waitForNavigation({ timeout: 15_000 }),
      page.click('#pay-btn'),
    ]);
    expect(navigation.url()).toContain('checkout.stripe.com');
  });

  test('shows void state message for voided invoices', async ({ page, context }) => {
    const inv = makeInvoice({ status: 'void' });
    await mockWorker(context, {
      [`GET /invoices/${inv.magic_token}`]: (route) => json(route, { ...inv, stripe_enabled: false }),
    });

    await page.goto(`${STATIC_BASE}/invoice.html#${inv.magic_token}`);
    await expect(page.locator('.status-badge')).toContainText('Void', { timeout: 10_000 });
    await expect(page.locator('#inv-footer')).toContainText('voided');
    await expect(page.locator('#pay-btn')).not.toBeAttached();
  });

  test('shows an error message when the token is invalid', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /invoices/bad-token': (route) => json(route, { error: 'Invoice not found' }, 404),
    });

    await page.goto(`${STATIC_BASE}/invoice.html#bad-token`);
    await expect(page.locator('#error-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#error-view')).toContainText('not found');
    await expect(page.locator('#invoice-view')).not.toBeVisible();
  });
});

// ── Tests: Admin Pipeline — Invoice Section ───────────────────────────────────

test.describe('Admin Pipeline — Invoice Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-admin'));
  });

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('invoice section renders with Add Line Item form when a project opens', async ({ page, context }) => {
    await mockAdminPipeline(context);
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('.pc-card');
    await expect(page.locator('#projectDetail')).toHaveClass(/open/);

    // Invoice section heading and Add Line Item button are visible
    await expect(page.locator('#pd-invoice-list')).toBeVisible();
    await expect(page.locator('#pd-invoice-items-container')).toBeVisible();
    await expect(page.locator('button:has-text("+ Add Line Item")')).toBeVisible();
    await expect(page.locator('#pd-invoice-list')).toContainText('No invoices yet');
  });

  test('creating an invoice adds it to the list as Draft with correct total', async ({ page, context }) => {
    await mockAdminPipeline(context);
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('.pc-card');
    await expect(page.locator('#projectDetail')).toHaveClass(/open/);

    // Fill in the first line item
    const descInput = page.locator('#pd-invoice-items-container input[placeholder*="deposit"]').first();
    await descInput.fill('Editorial Stay deposit');
    const priceInput = page.locator('#pd-invoice-items-container input[placeholder="0.00"]').first();
    await priceInput.fill('1250');

    // Add a second line item
    await page.click('button:has-text("+ Add Line Item")');
    const desc2 = page.locator('#pd-invoice-items-container input[placeholder*="deposit"]').nth(1);
    await desc2.fill('Rush delivery add-on');
    const price2 = page.locator('#pd-invoice-items-container input[placeholder="0.00"]').nth(1);
    await price2.fill('250');

    await page.fill('#pd-invoice-due', '2026-06-15');
    await page.click('button:has-text("Create Invoice")');

    // Invoice appears in list as Draft
    await expect(page.locator('#pd-invoice-list')).toContainText('INV-0001', { timeout: 5_000 });
    await expect(page.locator('#pd-invoice-list')).toContainText('$1,500.00');
    await expect(page.locator('#pd-invoice-list')).toContainText('Draft');
    // Form resets — only one item row remains
    await expect(page.locator('#pd-invoice-items-container > div')).toHaveCount(1);
  });

  test('sending an invoice changes the status badge to Sent', async ({ page, context }) => {
    const draftInv = makeInvoice({ id: 'inv-draft', status: 'draft', magic_token: 'tok-draft', sent_at: '' });
    await mockAdminPipeline(context, { invoices: [draftInv] });
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('.pc-card');
    await expect(page.locator('#pd-invoice-list')).toContainText('Draft', { timeout: 5_000 });

    await page.click('#pd-invoice-list button:has-text("Send")');

    await expect(page.locator('#pd-invoice-list')).toContainText('Sent', { timeout: 5_000 });
    await expect(page.locator('#pd-invoice-list button:has-text("Send")')).not.toBeAttached();
    await expect(page.locator('#pd-invoice-list button:has-text("Mark Paid")')).toBeVisible();
  });

  test('marking an invoice paid changes the badge to Paid', async ({ page, context }) => {
    const sentInv = makeInvoice({ id: 'inv-sent', status: 'sent', magic_token: 'tok-sent' });
    await mockAdminPipeline(context, { invoices: [sentInv] });
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('.pc-card');
    await expect(page.locator('#pd-invoice-list')).toContainText('Sent', { timeout: 5_000 });

    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#pd-invoice-list button:has-text("Mark Paid")');

    await expect(page.locator('#pd-invoice-list')).toContainText('Paid', { timeout: 5_000 });
    await expect(page.locator('#pd-invoice-list button:has-text("Mark Paid")')).not.toBeAttached();
  });
});

// ── Tests: Client Portal — Invoice History ────────────────────────────────────

test.describe('Client Portal — Invoice History', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-client'));
  });

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  function mockPortal(context, { invoices = [] } = {}) {
    return mockWorker(context, {
      'GET /auth/me': (route) =>
        json(route, { id: 'u1', email: 'client@grandpalms.com', role: 'client' }),
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/invoices':  (route) =>
        json(route, invoices.map(inv => ({
          ...inv,
          public_url: `${STATIC_BASE}/invoice.html#${inv.magic_token}`,
        }))),
    });
  }

  test('client sees the invoice section with a sent invoice and a Pay button', async ({ page, context }) => {
    const sentInv = makeInvoice({
      status:       'sent',
      magic_token:  'tok-portal-sent',
      total_cents:  150000,
      due_date:     '2026-06-15',
    });
    await mockPortal(context, { invoices: [sentInv] });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('#invoices-section')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#invoices-content')).toContainText('INV-0001');
    await expect(page.locator('#invoices-content')).toContainText('$1,500.00');

    // Sent invoice shows a Pay button
    const payBtn = page.locator('.invoice-pay-btn');
    await expect(payBtn).toBeVisible();
    await expect(payBtn).toContainText('Pay $1,500.00');
  });

  test('paid invoices render with a View link instead of a Pay button', async ({ page, context }) => {
    const paidInv = makeInvoice({
      status:      'paid',
      magic_token: 'tok-portal-paid',
      paid_at:     daysAgo(3),
    });
    await mockPortal(context, { invoices: [paidInv] });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('#invoices-section')).toBeVisible({ timeout: 10_000 });

    // No Pay button — only a View link
    await expect(page.locator('.invoice-pay-btn')).not.toBeAttached();
    await expect(page.locator('.invoice-view-link')).toBeVisible();
    await expect(page.locator('.invoice-view-link')).toContainText('View');
    await expect(page.locator('.badge-paid')).toBeVisible();
  });

  test('invoice section is hidden when no invoices exist', async ({ page, context }) => {
    await mockPortal(context, { invoices: [] });

    await page.goto(`${STATIC_BASE}/portal.html`);
    // Give the page time to finish loading
    await expect(page.locator('#galleries-content')).not.toContainText('Loading', { timeout: 10_000 });
    await expect(page.locator('#invoices-section')).not.toBeVisible();
  });
});
