/**
 * Acceptance tests for the Lead Pipeline Kanban board in gallery-admin.html.
 *
 * Covers:
 *  1. All 8 stage columns render on the board
 *  2. Empty columns show the dash placeholder and zero count badge
 *  3. Project cards appear in their correct stage column
 *  4. Inquiry card shows an outstanding action label (urgent after 3+ days)
 *  5. Contract Sent card shows "Contract unsigned" action (urgent after 5+ days)
 *  6. Complete stage cards show no outstanding action
 *  7. New project form opens and a project can be submitted
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

const STAGES = [
  'Inquiry', 'Proposal Sent', 'Contract Sent', 'Contract Signed',
  'Retainer Paid', 'Active', 'Delivered', 'Complete',
];

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

const MOCK_PROJECTS = [
  {
    id:          'p1',
    client_name: 'Grand Palms Hotel',
    property:    'Grand Palms Resort',
    collection:  'The Editorial Stay',
    location:    'Palm Beach, FL',
    source:      'inquiry',
    stage:       'Inquiry',
    created_at:  daysAgo(5),   // 5 days old → urgent (>= 3)
    updated_at:  daysAgo(5),
    shoot_date:  null,
  },
  {
    id:          'p2',
    client_name: 'Ocean View Boutique',
    property:    'Ocean View Hotel',
    collection:  'The Fashioned Weekend',
    location:    'Miami, FL',
    source:      'manual',
    stage:       'Contract Sent',
    created_at:  daysAgo(10),
    updated_at:  daysAgo(6),   // 6 days without signing → urgent (>= 5)
    shoot_date:  null,
  },
  {
    id:          'p3',
    client_name: 'Beachside Villa',
    property:    'Beachside Villas',
    collection:  'The Editorial Stay',
    location:    'Key West, FL',
    source:      'manual',
    stage:       'Complete',
    created_at:  daysAgo(60),
    updated_at:  daysAgo(30),
    shoot_date:  null,
  },
];

async function useMockAdminWorker(context, projects = []) {
  await context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req    = route.request();
      const url    = new URL(req.url());
      const method = req.method();
      try {
        if (method === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: { ...CORS } });
          return;
        }
        if (url.pathname === '/auth/me') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify({ id: 'admin1', email: 'admin@test.com', role: 'admin' }),
          });
          return;
        }
        if (url.pathname === '/admin/galleries') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify([]),
          });
          return;
        }
        if (url.pathname === '/admin/users') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify([]),
          });
          return;
        }
        if (url.pathname === '/admin/projects') {
          if (method === 'GET') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify(projects),
            });
          } else if (method === 'POST') {
            const body = JSON.parse(req.postData() || '{}');
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify({
                id: 'pnew', ...body,
                source:     'manual',
                stage:      'Inquiry',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }),
            });
          }
          return;
        }
        await route.fulfill({ status: 404, headers: CORS });
      } catch {
        route.abort().catch(() => {});
      }
    },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Lead Pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-admin'));
  });

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('renders all 8 stage columns on the Kanban board', async ({ page, context }) => {
    await useMockAdminWorker(context);
    await page.goto(`${STATIC_BASE}/admin/gallery-admin.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    for (const stage of STAGES) {
      const colId = `#pcol-${stage.replace(/ /g, '_')}`;
      await expect(page.locator(colId)).toBeVisible();
      await expect(page.locator(colId)).toContainText(stage);
    }
  });

  test('empty columns show zero count and dash placeholder', async ({ page, context }) => {
    await useMockAdminWorker(context);
    await page.goto(`${STATIC_BASE}/admin/gallery-admin.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    const counts = await page.locator('.pc-col-count').allTextContents();
    expect(counts.every((t) => t === '0')).toBe(true);
  });

  test('project cards appear in the correct stage columns', async ({ page, context }) => {
    await useMockAdminWorker(context, MOCK_PROJECTS);
    await page.goto(`${STATIC_BASE}/admin/gallery-admin.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    // Inquiry column
    const inquiryCol = page.locator('#pcol-Inquiry');
    await expect(inquiryCol.locator('.pc-card')).toHaveCount(1);
    await expect(inquiryCol.locator('.pc-name')).toContainText('Grand Palms Hotel');

    // Contract Sent column
    const contractCol = page.locator('#pcol-Contract_Sent');
    await expect(contractCol.locator('.pc-card')).toHaveCount(1);
    await expect(contractCol.locator('.pc-name')).toContainText('Ocean View Boutique');

    // Complete column
    const completeCol = page.locator('#pcol-Complete');
    await expect(completeCol.locator('.pc-card')).toHaveCount(1);
    await expect(completeCol.locator('.pc-name')).toContainText('Beachside Villa');
  });

  test('Inquiry card shows urgent outstanding action after 3+ days with no response', async ({ page, context }) => {
    await useMockAdminWorker(context, MOCK_PROJECTS);
    await page.goto(`${STATIC_BASE}/admin/gallery-admin.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    const action = page.locator('#pcol-Inquiry .pc-card .pc-action');
    await expect(action).toBeVisible();
    await expect(action).toContainText('Respond');   // "Respond — 5d waiting"
    await expect(action).toHaveClass(/urgent/);      // >= 3 days
  });

  test('Contract Sent card shows urgent unsigned-contract action after 5+ days', async ({ page, context }) => {
    await useMockAdminWorker(context, MOCK_PROJECTS);
    await page.goto(`${STATIC_BASE}/admin/gallery-admin.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    const action = page.locator('#pcol-Contract_Sent .pc-card .pc-action');
    await expect(action).toBeVisible();
    await expect(action).toContainText('Contract unsigned');  // "Contract unsigned — 6d"
    await expect(action).toHaveClass(/urgent/);               // >= 5 days
  });

  test('Complete stage cards show no outstanding action', async ({ page, context }) => {
    await useMockAdminWorker(context, MOCK_PROJECTS);
    await page.goto(`${STATIC_BASE}/admin/gallery-admin.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    const completeCard = page.locator('#pcol-Complete .pc-card').first();
    await expect(completeCard).toBeVisible();
    // Complete stage never returns an action from getOutstandingAction
    await expect(completeCard.locator('.pc-action')).not.toBeAttached();
  });

  test('new project form opens and a project can be created', async ({ page, context }) => {
    await useMockAdminWorker(context);
    await page.goto(`${STATIC_BASE}/admin/gallery-admin.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    // Open the form
    await page.click('button:has-text("+ New Project")');
    await expect(page.locator('#newProjectForm')).toHaveClass(/open/);

    // Fill required fields
    await page.fill('#np-clientName', 'Test Client');
    await page.fill('#np-email',      'test@example.com');

    // Submit
    await page.click('button:has-text("Create Project")');

    // Form closes and new card appears in Inquiry column
    await expect(page.locator('#newProjectForm')).not.toHaveClass(/open/);
    await expect(page.locator('#pcol-Inquiry .pc-card')).toHaveCount(1, { timeout: 5_000 });
  });
});
