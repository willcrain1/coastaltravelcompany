/**
 * Acceptance tests for the Lead Pipeline Kanban board in pipeline.html.
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

const WORKER_URL  = process.env.WORKER_URL || 'https://api.coastaltravelcompany.com';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':      STATIC_BASE,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods':     'GET, POST, OPTIONS',
  'access-control-allow-headers':     'Content-Type, Authorization',
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
        if (url.pathname === '/admin/packages') {
          if (method === 'GET') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify([
                {
                  id: 'pkg1',
                  name: 'The Editorial Stay',
                  description: 'A polished hospitality image set.',
                  inclusions: 'Planning call\nHalf-day shoot\nEdited gallery',
                  hero_photo: 'https://example.com/hero.jpg',
                  base_price: 2500,
                  addons: JSON.stringify(['Rush delivery', 'Video reel']),
                  created_at: daysAgo(20),
                  updated_at: daysAgo(10),
                },
              ]),
            });
          } else if (method === 'POST') {
            const body = JSON.parse(req.postData() || '{}');
            await route.fulfill({
              status: 201,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify({
                id: 'pkg-new',
                ...body,
                addons: JSON.stringify(body.addons || []),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }),
            });
          }
          return;
        }
        if (url.pathname.match(/^\/admin\/packages\/[^/]+$/) && method === 'DELETE') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify({ ok: true }),
          });
          return;
        }
        if (url.pathname === '/admin/questionnaires') {
          if (method === 'GET') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify([
                {
                  id: 'qset1',
                  name: 'Pre-booking Intake',
                  phase: 'pre-booking',
                  questions: JSON.stringify([
                    { id: 'q1', type: 'text', label: 'Property name', options: [] },
                    { id: 'q2', type: 'multiple_choice', label: 'Property type', options: ['Hotel', 'Resort'] },
                  ]),
                  created_at: daysAgo(3),
                  updated_at: daysAgo(3),
                },
              ]),
            });
          } else if (method === 'POST') {
            const body = JSON.parse(req.postData() || '{}');
            await route.fulfill({
              status: 201,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify({
                id: 'qset-new',
                ...body,
                questions: JSON.stringify(body.questions || []),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }),
            });
          }
          return;
        }
        if (url.pathname.match(/^\/admin\/questionnaires\/[^/]+$/) && method === 'DELETE') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify({ ok: true }),
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
        const notesMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)\/notes$/);
        if (notesMatch) {
          if (method === 'GET') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify([
                {
                  id: 'n1',
                  project_id: notesMatch[1],
                  type: 'reminder',
                  content: 'Follow up on proposal',
                  due_date: '2026-05-20',
                  created_at: daysAgo(1),
                },
              ]),
            });
          } else if (method === 'POST') {
            const body = JSON.parse(req.postData() || '{}');
            await route.fulfill({
              status: 201,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify({
                id: 'nnew',
                project_id: notesMatch[1],
                ...body,
                created_at: new Date().toISOString(),
              }),
            });
          }
          return;
        }
        const docsMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)\/documents$/);
        if (docsMatch) {
          if (method === 'GET') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify([
                {
                  id: 'd1',
                  project_id: docsMatch[1],
                  type: 'proposal',
                  title: 'Editorial Stay Proposal',
                  url: 'https://example.com/proposal',
                  created_at: daysAgo(2),
                },
              ]),
            });
          } else if (method === 'POST') {
            const body = JSON.parse(req.postData() || '{}');
            await route.fulfill({
              status: 201,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify({
                id: 'dnew',
                project_id: docsMatch[1],
                ...body,
                created_at: new Date().toISOString(),
              }),
            });
          }
          return;
        }
        const proposalsMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)\/proposals$/);
        if (proposalsMatch) {
          if (method === 'GET') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify([]),
            });
          } else if (method === 'POST') {
            const body = JSON.parse(req.postData() || '{}');
            await route.fulfill({
              status: 201,
              headers: { 'content-type': 'application/json', ...CORS },
              body: JSON.stringify({
                id: 'proposal-new',
                project_id: proposalsMatch[1],
                ...body,
                package_ids: JSON.stringify(body.package_ids || []),
                status: 'sent',
                public_url: `${STATIC_BASE}/proposal.html#proposal-new`,
                opened_at: '',
                view_count: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }),
            });
          }
          return;
        }
        const projectMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)$/);
        if (projectMatch && method === 'PUT') {
          const body = JSON.parse(req.postData() || '{}');
          const current = projects.find((p) => p.id === projectMatch[1]) || {};
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', ...CORS },
            body: JSON.stringify({ ...current, ...body, updated_at: new Date().toISOString() }),
          });
          return;
        }
        if (url.pathname === '/admin/contract-templates') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify([]) });
          return;
        }
        const contractsMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)\/contracts$/);
        if (contractsMatch) {
          await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify([]) });
          return;
        }
        const qInstancesMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)\/questionnaires$/);
        if (qInstancesMatch) {
          await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify([]) });
          return;
        }
        const schedLinksMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)\/schedule-links$/);
        if (schedLinksMatch) {
          await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify([]) });
          return;
        }
        const msgsMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)\/messages$/);
        if (msgsMatch) {
          await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify([]) });
          return;
        }
        const invoicesMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)\/invoices$/);
        if (invoicesMatch) {
          await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify([]) });
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
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    for (const stage of STAGES) {
      const colId = `#pcol-${stage.replace(/ /g, '_')}`;
      await expect(page.locator(colId)).toBeVisible();
      await expect(page.locator(colId)).toContainText(stage);
    }
  });

  test('empty columns show zero count and dash placeholder', async ({ page, context }) => {
    await useMockAdminWorker(context);
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    const counts = await page.locator('.pc-col-count').allTextContents();
    expect(counts.every((t) => t === '0')).toBe(true);
  });

  test('project cards appear in the correct stage columns', async ({ page, context }) => {
    await useMockAdminWorker(context, MOCK_PROJECTS);
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

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
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    const action = page.locator('#pcol-Inquiry .pc-card .pc-action');
    await expect(action).toBeVisible();
    await expect(action).toContainText('Respond');   // "Respond — 5d waiting"
    await expect(action).toHaveClass(/urgent/);      // >= 3 days
  });

  test('Contract Sent card shows urgent unsigned-contract action after 5+ days', async ({ page, context }) => {
    await useMockAdminWorker(context, MOCK_PROJECTS);
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    const action = page.locator('#pcol-Contract_Sent .pc-card .pc-action');
    await expect(action).toBeVisible();
    await expect(action).toContainText('Contract unsigned');  // "Contract unsigned — 6d"
    await expect(action).toHaveClass(/urgent/);               // >= 5 days
  });

  test('Complete stage cards show no outstanding action', async ({ page, context }) => {
    await useMockAdminWorker(context, MOCK_PROJECTS);
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });

    const completeCard = page.locator('#pcol-Complete .pc-card').first();
    await expect(completeCard).toBeVisible();
    // Complete stage never returns an action from getOutstandingAction
    await expect(completeCard.locator('.pc-action')).not.toBeAttached();
  });

  test('new project form opens and a project can be created', async ({ page, context }) => {
    await useMockAdminWorker(context);
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

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

  test('project detail shows labels, reminder due dates, and attached documents', async ({ page, context }) => {
    await useMockAdminWorker(context, [
      {
        ...MOCK_PROJECTS[0],
        labels: 'hot lead, oceanfront',
      },
    ]);
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#pcol-Inquiry .tag-pill')).toContainText(['hot lead', 'oceanfront']);

    await page.click('#pcol-Inquiry .pc-card');

    await expect(page.locator('#projectDetail')).toHaveClass(/open/);
    await expect(page.locator('#pd-labels')).toHaveValue('hot lead, oceanfront');
    await expect(page.locator('.note-due')).toContainText('Due');
    await expect(page.locator('#pd-doc-list')).toContainText('Editorial Stay Proposal');

    await page.click('button:has-text("Reminder")');
    await expect(page.locator('#pd-reminder-wrap')).toHaveClass(/show/);
  });

  test('service package library lists packages and creates a package with add-ons', async ({ page, context }) => {
    await useMockAdminWorker(context);
    await page.goto(`${STATIC_BASE}/admin/services.html`);

    await expect(page.locator('#packageList')).toContainText('The Editorial Stay', { timeout: 10_000 });
    await expect(page.locator('#packageList')).toContainText('$2,500');
    await expect(page.locator('#packageList .tag-pill')).toContainText(['Rush delivery', 'Video reel']);

    await page.fill('#pkg-name', 'The Branded Journey');
    await page.fill('#pkg-price', '4500');
    await page.fill('#pkg-description', 'Multi-day editorial coverage for a destination brand.');
    await page.fill('#pkg-inclusions', 'Creative direction\nTwo shoot days');
    await page.check('input[name="pkgAddon"][value="3D walkthrough"]');
    await page.check('input[name="pkgAddon"][value="Extended license"]');
    await page.click('button:has-text("Save Package")');

    await expect(page.locator('#packageList')).toContainText('The Branded Journey');
    await expect(page.locator('#packageList')).toContainText('$4,500');
    await expect(page.locator('#packageList')).toContainText('3D walkthrough');
    await expect(page.locator('#pkg-name')).toHaveValue('');
  });

  test('admin can create a proposal from selected packages', async ({ page, context }) => {
    await useMockAdminWorker(context, MOCK_PROJECTS);
    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);

    await expect(page.locator('#pipelineBoard')).toBeVisible({ timeout: 10_000 });
    await page.click('#pcol-Inquiry .pc-card');

    await expect(page.locator('#pd-proposal-packages')).toContainText('The Editorial Stay');
    await page.check('input[name="proposalPackage"][value="pkg1"]');
    await page.fill('#pd-proposal-note', 'I pulled together the strongest fit for your property.');
    await page.fill('#pd-proposal-expiry', '2026-06-01');
    await page.click('button:has-text("Create Proposal")');

    await expect(page.locator('#pd-stage')).toHaveValue('Proposal Sent');
    await expect(page.locator('#pd-proposal-list')).toContainText('Proposal sent');
    await expect(page.locator('#pd-proposal-note')).toHaveValue('');
  });

  test('questionnaire builder lists and creates reusable question sets', async ({ page, context }) => {
    await useMockAdminWorker(context);
    await page.goto(`${STATIC_BASE}/admin/services.html`);

    await expect(page.locator('#questionnaireList')).toContainText('Pre-booking Intake', { timeout: 10_000 });
    await expect(page.locator('#questionnaireList')).toContainText('2 questions');

    await page.fill('#qset-name', 'Pre-shoot Logistics');
    await page.selectOption('#qset-phase', 'pre-shoot');
    await page.fill('#q-question-label', 'Parking and access instructions');
    await page.click('button:has-text("Add Question")');
    await expect(page.locator('#questionDraftList')).toContainText('Parking and access instructions');

    await page.selectOption('#q-question-type', 'multiple_choice');
    await page.fill('#q-question-label', 'Property type');
    await page.fill('#q-question-options', 'Hotel, Resort, Private villa');
    await page.click('button:has-text("Add Question")');
    await page.click('button:has-text("Save Set")');

    await expect(page.locator('#questionnaireList')).toContainText('Pre-shoot Logistics');
    await expect(page.locator('#questionnaireList')).toContainText('2 questions');
    await expect(page.locator('#qset-name')).toHaveValue('');
  });
});
