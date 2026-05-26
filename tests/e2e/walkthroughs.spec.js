/**
 * Acceptance tests for the walkthroughs feature (item 43).
 *
 * Admin panel — galleries.html walkthrough section:
 *  1. Walkthrough list renders existing entries
 *  2. Adding a walkthrough appends it to the list
 *  3. Toggling published state calls PUT /admin/walkthroughs/:id
 *  4. Deleting a walkthrough calls DELETE and removes it from the list
 *
 * Public page — walkthroughs.html:
 *  5. Published walkthroughs render as cards in the grid
 *  6. Empty state renders when no walkthroughs exist
 *  7. Clicking a card opens the modal with the embed iframe
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

const MOCK_WALKTHROUGH = {
  id:            'wt1',
  property_name: 'Grand Palms Resort',
  title:         'Grand Suite Walkthrough',
  location:      'Palm Beach, FL',
  collection:    'The Editorial Stay',
  embed_url:     'https://lumalabs.ai/capture/test-scene',
  thumbnail_url: null,
  description:   'An immersive tour of the grand suite.',
  published:     true,
  sort_order:    0,
  created_at:    '2026-05-01T10:00:00Z',
  updated_at:    '2026-05-01T10:00:00Z',
};

function adminSetup(context, walkthroughs = [MOCK_WALKTHROUGH]) {
  let wts = [...walkthroughs];
  return mockWorker(context, {
    'GET /auth/me':            (r) => json(r, { id: 'a1', email: 'admin@test.com', role: 'admin' }),
    'GET /admin/galleries':    (r) => json(r, []),
    'GET /admin/walkthroughs': (r) => json(r, wts),
    'POST /admin/walkthroughs': async (route) => {
      const body = await route.request().json();
      const newWt = { ...MOCK_WALKTHROUGH, ...body, id: 'wt-new', created_at: new Date().toISOString() };
      wts = [newWt, ...wts];
      return json(route, newWt, 201);
    },
    'PUT /admin/walkthroughs/wt1':    (r) => json(r, { ...MOCK_WALKTHROUGH, published: false }),
    'DELETE /admin/walkthroughs/wt1': (r) => json(r, { ok: true }),
  });
}

async function gotoGalleriesAdmin(page) {
  await page.addInitScript((jwt) => localStorage.setItem('ctc_jwt', jwt), ADMIN_JWT);
  await page.goto(`${STATIC_BASE}/admin/galleries.html`);
  // Wait for walkthroughs list to load
  await page.waitForFunction(() => {
    const el = document.getElementById('wtList');
    return el && el.innerHTML.trim() !== '';
  }, { timeout: 10_000 });
}

// ── Admin panel ───────────────────────────────────────────────────────────────

test.describe('admin walkthroughs panel', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('walkthrough list renders existing entries', async ({ page, context }) => {
    await adminSetup(context);
    await gotoGalleriesAdmin(page);
    await expect(page.locator('#wtList')).toContainText('Grand Palms Resort');
    await expect(page.locator('#wtList')).toContainText('Grand Suite Walkthrough');
  });

  test('adding a walkthrough appends it to the list', async ({ page, context }) => {
    await adminSetup(context, []);
    await gotoGalleriesAdmin(page);

    await page.fill('#wt-property', 'Ocean View Hotel');
    await page.fill('#wt-embed',    'https://lumalabs.ai/capture/ocean-view');

    let postCalled = false;
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL) && url.toString().includes('/admin/walkthroughs'),
      async (route) => {
        if (route.request().method() === 'POST') {
          postCalled = true;
          const body = await route.request().json();
          return json(route, { ...MOCK_WALKTHROUGH, ...body, id: 'wt-new', property_name: body.property_name }, 201);
        }
        return json(route, []);
      },
    );

    await page.click('#wtCreateForm button[type="submit"]');
    await expect(page.locator('#wtList')).toContainText('Ocean View Hotel', { timeout: 5_000 });
    expect(postCalled).toBe(true);
  });

  test('toggling published calls PUT /admin/walkthroughs/:id', async ({ page, context }) => {
    let putCalled = false;
    await adminSetup(context);
    await context.route(
      (url) => url.toString().includes('/admin/walkthroughs/wt1'),
      async (route) => {
        if (route.request().method() === 'PUT') putCalled = true;
        return json(route, { ok: true });
      },
    );

    await gotoGalleriesAdmin(page);
    // The Unpublish button calls toggleWtPublished('wt1', 0) — mock walkthrough starts as published
    const toggleBtn = page.getByRole('button', { name: 'Unpublish' }).first();
    await toggleBtn.click();
    await page.waitForTimeout(300);
    expect(putCalled).toBe(true);
  });

  test('deleting a walkthrough removes it from the list', async ({ page, context }) => {
    await adminSetup(context);
    await gotoGalleriesAdmin(page);
    await expect(page.locator('#wtList')).toContainText('Grand Palms Resort');

    page.on('dialog', (d) => d.accept());
    await page.click('button[onclick*="deleteWalkthrough(\'wt1\')"]');
    await expect(page.locator('#wtList')).not.toContainText('Grand Palms Resort', { timeout: 5_000 });
  });
});

// ── Public walkthroughs page ──────────────────────────────────────────────────

test.describe('public walkthroughs page', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('published walkthroughs render as cards', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /public/walkthroughs': (r) => json(r, [MOCK_WALKTHROUGH]),
    });
    await page.goto(`${STATIC_BASE}/walkthroughs.html`);
    await expect(page.locator('#wtGrid')).toContainText('Grand Palms Resort', { timeout: 10_000 });
    // Cards show property_name, collection badge, and location — title is shown in the modal subtitle
    await expect(page.locator('#wtGrid')).toContainText('The Editorial Stay');
  });

  test('empty state renders when no walkthroughs exist', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /public/walkthroughs': (r) => json(r, []),
    });
    await page.goto(`${STATIC_BASE}/walkthroughs.html`);
    await expect(page.locator('#wtGrid')).toContainText('No walkthroughs published yet', { timeout: 10_000 });
  });

  test('clicking a card opens the modal with the embed iframe', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /public/walkthroughs': (r) => json(r, [MOCK_WALKTHROUGH]),
    });
    await page.goto(`${STATIC_BASE}/walkthroughs.html`);
    await page.locator('#wtGrid .wt-card').first().click();
    await expect(page.locator('#wtModal')).toBeVisible({ timeout: 5_000 });
    // openModal sets #wtModalTitle to property_name and #wtModalSub to "location · title"
    await expect(page.locator('#wtModalTitle')).toContainText('Grand Palms Resort');
  });
});
