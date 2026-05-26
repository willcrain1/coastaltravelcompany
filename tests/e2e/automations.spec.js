/**
 * Acceptance tests for the automation settings panel (item 43).
 *
 *  1. Automation list renders all automation rows from the Worker
 *  2. Toggling a checkbox and saving calls PUT /admin/automations
 *  3. Enabled state is reflected in the checkbox after save
 *  4. Automation log section renders (even when empty)
 *  5. Log entries render when the Worker returns them
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
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

const MOCK_AUTOMATIONS = [
  { id: 'a1', trigger_key: 'inquiry_auto_reply',             label: 'Auto-reply on new inquiry',              enabled: false, delay_hours: 0   },
  { id: 'a2', trigger_key: 'proposal_not_opened_followup',   label: 'Follow up if proposal not opened',       enabled: false, delay_hours: 72  },
  { id: 'a3', trigger_key: 'proposal_not_approved_reminder', label: 'Reminder if proposal not approved',      enabled: true,  delay_hours: 168 },
  { id: 'a4', trigger_key: 'contract_not_signed_reminder',   label: 'Reminder if contract not signed',        enabled: false, delay_hours: 48  },
  { id: 'a5', trigger_key: 'gallery_delivered_notification', label: 'Notify client on gallery delivery',      enabled: false, delay_hours: 0   },
  { id: 'a6', trigger_key: 'post_delivery_review_request',   label: 'Review request 2 weeks after delivery',  enabled: false, delay_hours: 336 },
];

const MOCK_LOGS = [
  {
    id:          'log1',
    project_id:  'proj1',
    trigger_key: 'inquiry_auto_reply',
    action:      'Sent auto-reply email',
    status:      'sent',
    created_at:  '2026-05-20T09:00:00Z',
  },
];

function servicesAdminSetup(context, automations = MOCK_AUTOMATIONS, logs = []) {
  return mockWorker(context, {
    'GET /auth/me':               (r) => json(r, { id: 'a1', email: 'admin@test.com', role: 'admin' }),
    'GET /admin/packages':        (r) => json(r, []),
    'GET /admin/questionnaires':  (r) => json(r, []),
    'GET /admin/availability':    (r) => json(r, []),
    'GET /admin/blocked-dates':   (r) => json(r, []),
    'GET /admin/automations':     (r) => json(r, automations),
    'PUT /admin/automations':     (r) => json(r, { ok: true }),
    'GET /admin/automation-logs': (r) => json(r, logs),
    'GET /admin/contract-templates': (r) => json(r, []),
  });
}

async function gotoServicesAdmin(page) {
  await page.evaluate((jwt) => localStorage.setItem('ctc_jwt', jwt), ADMIN_JWT);
  await page.goto(`${STATIC_BASE}/admin/services.html`);
  // Wait for automations list to render
  await page.waitForFunction(() => {
    const el = document.getElementById('automationList');
    return el && el.querySelectorAll('input[type="checkbox"]').length > 0;
  }, { timeout: 10_000 });
}

test.describe('automation settings panel', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('renders all automation rows', async ({ page, context }) => {
    await servicesAdminSetup(context);
    await gotoServicesAdmin(page);

    const checkboxes = page.locator('#automationList input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(MOCK_AUTOMATIONS.length);
    await expect(page.locator('#automationList')).toContainText('Auto-reply on new inquiry');
    await expect(page.locator('#automationList')).toContainText('Notify client on gallery delivery');
  });

  test('enabled automation has checked checkbox', async ({ page, context }) => {
    await servicesAdminSetup(context);
    await gotoServicesAdmin(page);

    // a3 (proposal_not_approved_reminder) is enabled: true
    const checkbox = page.locator('input[data-automation-id="a3"]');
    await expect(checkbox).toBeChecked();
  });

  test('disabled automation has unchecked checkbox', async ({ page, context }) => {
    await servicesAdminSetup(context);
    await gotoServicesAdmin(page);

    const checkbox = page.locator('input[data-automation-id="a1"]');
    await expect(checkbox).not.toBeChecked();
  });

  test('saving automations calls PUT /admin/automations', async ({ page, context }) => {
    let putCalled = false;
    await servicesAdminSetup(context);
    await context.route(
      (url) => url.toString().includes('/admin/automations') && !url.toString().includes('logs'),
      async (route) => {
        if (route.request().method() === 'PUT') {
          putCalled = true;
          return json(route, { ok: true });
        }
        return json(route, MOCK_AUTOMATIONS);
      },
    );

    await gotoServicesAdmin(page);
    await page.click('button[onclick="saveAutomations()"]');
    await page.waitForTimeout(300);
    expect(putCalled).toBe(true);
  });

  test('automation log section renders even when empty', async ({ page, context }) => {
    await servicesAdminSetup(context, MOCK_AUTOMATIONS, []);
    await gotoServicesAdmin(page);
    await expect(page.locator('#automationLog')).toBeVisible();
  });

  test('enabled state persists after page reload', async ({ page, context }) => {
    // All automations start disabled so the toggle change is unambiguous.
    let currentAutomations = MOCK_AUTOMATIONS.map(a => ({ ...a, enabled: false }));

    // Stateful mock: GET returns currentAutomations; PUT updates it so the
    // next GET (after reload) reflects the saved state.
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL),
      async (route) => {
        const req    = route.request();
        const url    = new URL(req.url());
        const method = req.method();
        if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }
        const key = `${method} ${url.pathname}`;

        if (key === 'GET /auth/me')               return json(route, { id: 'a1', email: 'admin@test.com', role: 'admin' });
        if (key === 'GET /admin/automations')      return json(route, currentAutomations);
        if (key === 'PUT /admin/automations') {
          const body = await req.json();
          if (Array.isArray(body)) currentAutomations = body;
          return json(route, { ok: true });
        }
        if (key === 'GET /admin/automation-logs')  return json(route, []);
        if (key === 'GET /admin/packages')          return json(route, []);
        if (key === 'GET /admin/questionnaires')    return json(route, []);
        if (key === 'GET /admin/availability')      return json(route, []);
        if (key === 'GET /admin/blocked-dates')     return json(route, []);
        if (key === 'GET /admin/contract-templates') return json(route, []);
        await route.fulfill({ status: 404, headers: CORS, body: `No mock for: ${key}` });
      },
    );

    await gotoServicesAdmin(page);

    // a1 starts unchecked
    const a1 = page.locator('input[data-automation-id="a1"]');
    await expect(a1).not.toBeChecked();

    // Toggle a1 on then save; wait for the PUT to complete
    await a1.click();
    await expect(a1).toBeChecked();
    const putDone = page.waitForResponse(
      (r) => r.url().includes('/admin/automations') && r.request().method() === 'PUT',
    );
    await page.click('button[onclick="saveAutomations()"]');
    await putDone;

    // Reload — the page re-fetches GET /admin/automations which now returns
    // the state that was sent in the PUT, so a1 should still be checked.
    await page.reload();
    await page.waitForFunction(() => {
      const el = document.getElementById('automationList');
      return el && el.querySelectorAll('input[type="checkbox"]').length > 0;
    }, { timeout: 10_000 });

    await expect(page.locator('input[data-automation-id="a1"]')).toBeChecked();
    // Sanity: a2 was never toggled — it should still be unchecked
    await expect(page.locator('input[data-automation-id="a2"]')).not.toBeChecked();
  });
});

