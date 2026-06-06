/**
 * Acceptance tests for admin user management (item 43).
 *
 *  1. User list renders empty state when no accounts exist
 *  2. Creating a user via the form calls POST /admin/users and adds the row
 *  3. User row shows name, email, role, and gallery count
 *  4. Expanding a user row reveals gallery checkboxes
 *  5. Saving gallery assignment calls PUT /admin/users/:id with selected IDs
 *  6. Deleting a user calls DELETE /admin/users/:id and removes the row
 *  7. Client portal shows a gallery assigned to that client account
 *  8. Removing gallery assignment — gallery no longer appears in the portal
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://api.coastaltravelcompany.com';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':      STATIC_BASE,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods':     'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers':     'Content-Type, Authorization',
};

function json(route, data, status = 200) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify(data),
  });
}

const MOCK_GALLERY = {
  id:         'gal1',
  eventName:  'Grand Palms Summer 2026',
  clientName: 'Grand Palms Hotel',
  passphrase: 'abc123',
  pwHash:     'hash',
  watermark:  false,
  createdAt:  new Date(Date.now() - 86_400_000).toISOString(),
};

const MOCK_USER = {
  id:          'usr1',
  name:        'Jane Smith',
  email:       'jane@grandpalms.com',
  role:        'client',
  galleries:   [],
  hasPassword: true,
  verified:    true,
  created:     new Date(Date.now() - 7 * 86_400_000).toISOString(),
};

function mockClients(context, { users = [], galleries = [MOCK_GALLERY], stateful = false } = {}) {
  let userList = [...users];

  return context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req    = route.request();
      const url    = new URL(req.url());
      const method = req.method();

      if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }

      if (url.pathname === '/auth/me')
        return json(route, { id: 'admin1', email: 'admin@test.com', role: 'admin' });

      if (url.pathname === '/admin/galleries' && method === 'GET')
        return json(route, galleries);

      if (url.pathname === '/admin/users' && method === 'GET')
        return json(route, userList);

      if (url.pathname === '/admin/users' && method === 'POST') {
        const body    = JSON.parse(req.postData() || '{}');
        const created = { ...MOCK_USER, id: 'usr-new', name: body.name, email: body.email, role: body.role || 'client', galleries: body.galleries || [] };
        if (stateful) userList = [...userList, created];
        return json(route, created, 201);
      }

      const userIdMatch = url.pathname.match(/^\/admin\/users\/([^/]+)$/);
      if (userIdMatch) {
        const uid = userIdMatch[1];
        if (method === 'DELETE') {
          if (stateful) userList = userList.filter(u => u.id !== uid);
          return json(route, { ok: true });
        }
        if (method === 'PUT') {
          const body = JSON.parse(req.postData() || '{}');
          const idx  = userList.findIndex(u => u.id === uid);
          if (stateful && idx >= 0) userList[idx] = { ...userList[idx], ...body };
          const updated = idx >= 0 ? { ...userList[idx], ...body } : { ...MOCK_USER, id: uid, ...body };
          return json(route, updated);
        }
      }

      const roleMatch = url.pathname.match(/^\/admin\/users\/([^/]+)\/role$/);
      if (roleMatch && method === 'PATCH') {
        const body    = JSON.parse(req.postData() || '{}');
        const idx     = userList.findIndex(u => u.id === roleMatch[1]);
        const updated = { ...(userList[idx] || MOCK_USER), role: body.role };
        if (stateful && idx >= 0) userList[idx] = updated;
        return json(route, updated);
      }

      await route.fulfill({ status: 404, headers: CORS });
    },
  );
}

test.describe('Admin Clients Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-admin'));
  });

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('user list renders empty state when no accounts exist', async ({ page, context }) => {
    await mockClients(context, { users: [] });
    await page.goto(`${STATIC_BASE}/admin/clients.html`);

    await expect(page.locator('#userList')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#userList')).toContainText('No client accounts yet');
  });

  test('creating a user calls POST /admin/users and adds the row', async ({ page, context }) => {
    let createPayload = null;
    await mockClients(context, { users: [], stateful: true });

    await context.route(
      (url) => url.pathname === '/admin/users' && url.toString().startsWith(WORKER_URL),
      async (route) => {
        if (route.request().method() === 'POST') {
          createPayload = JSON.parse(route.request().postData() || '{}');
        }
        await route.fallback();
      },
    );

    await page.goto(`${STATIC_BASE}/admin/clients.html`);
    await expect(page.locator('#userList')).toBeVisible({ timeout: 10_000 });

    await page.fill('#userName', 'Jane Smith');
    await page.fill('#userEmail', 'jane@grandpalms.com');
    await page.fill('#userPassword', 'secret123');
    await page.click('#createUserBtn');

    await expect(page.locator('#userList')).toContainText('jane@grandpalms.com', { timeout: 5_000 });
    expect(createPayload?.email).toBe('jane@grandpalms.com');
    expect(createPayload?.name).toBe('Jane Smith');
  });

  test('user row shows name, email, role and gallery count', async ({ page, context }) => {
    const user = { ...MOCK_USER, galleries: ['gal1'] };
    await mockClients(context, { users: [user] });

    await page.goto(`${STATIC_BASE}/admin/clients.html`);
    await expect(page.locator('#userList')).toBeVisible({ timeout: 10_000 });

    const row = page.locator('.user-row').first();
    await expect(row).toContainText('jane@grandpalms.com');
    await expect(row).toContainText('Client');
    await expect(row).toContainText('1 gallery');
    await expect(row).toContainText('Grand Palms Summer 2026');
  });

  test('expanding a user row reveals gallery checkboxes', async ({ page, context }) => {
    await mockClients(context, { users: [MOCK_USER] });

    await page.goto(`${STATIC_BASE}/admin/clients.html`);
    await expect(page.locator('#userList')).toBeVisible({ timeout: 10_000 });

    // Click the user info area to expand
    await page.click('.ur-info');

    const panel = page.locator(`#udetail-${MOCK_USER.id}`);
    await expect(panel).toHaveClass(/open/, { timeout: 5_000 });
    await expect(panel.locator('.gallery-checks')).toContainText('Grand Palms Summer 2026');
  });

  test('saving gallery assignment calls PUT /admin/users/:id with selected IDs', async ({ page, context }) => {
    let putPayload = null;
    await mockClients(context, { users: [MOCK_USER] });

    await context.route(
      (url) => url.pathname.startsWith('/admin/users/') && !url.pathname.endsWith('/role'),
      async (route) => {
        if (route.request().method() === 'PUT') {
          putPayload = JSON.parse(route.request().postData() || '{}');
        }
        await route.fallback();
      },
    );

    await page.goto(`${STATIC_BASE}/admin/clients.html`);
    await expect(page.locator('#userList')).toBeVisible({ timeout: 10_000 });

    await page.click('.ur-info');
    const panel = page.locator(`#udetail-${MOCK_USER.id}`);
    await expect(panel).toHaveClass(/open/, { timeout: 5_000 });

    // Check the gallery checkbox
    await panel.locator('input[type=checkbox][value="gal1"]').check();
    await panel.locator('button:has-text("Save Gallery Access")').click();

    await expect(async () => {
      expect(putPayload?.galleries).toContain('gal1');
    }).toPass({ timeout: 5_000 });
  });

  test('deleting a user calls DELETE /admin/users/:id and removes the row', async ({ page, context }) => {
    let deleteUrl = null;
    await mockClients(context, { users: [MOCK_USER], stateful: true });

    await context.route(
      (url) => url.pathname.startsWith('/admin/users/'),
      async (route) => {
        if (route.request().method() === 'DELETE') deleteUrl = route.request().url();
        await route.fallback();
      },
    );

    await page.goto(`${STATIC_BASE}/admin/clients.html`);
    await expect(page.locator('.user-row')).toBeVisible({ timeout: 10_000 });

    page.once('dialog', (dialog) => dialog.accept());
    await page.click('.btn-danger');

    await expect(page.locator('.user-row')).not.toBeAttached({ timeout: 5_000 });
    expect(deleteUrl).toContain(`/admin/users/${MOCK_USER.id}`);
  });
});

// ── Client Portal — Gallery Visibility After Assignment ───────────────────────

test.describe('Client Portal — Gallery Visibility Reflects Assignment', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-client'));
  });

  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  function mockPortal(context, { galleries = [] } = {}) {
    return context.route(
      (url) => url.toString().startsWith(WORKER_URL),
      async (route) => {
        const url    = new URL(route.request().url());
        const method = route.request().method();
        if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }

        if (url.pathname === '/auth/me')
          return json(route, { id: 'usr1', email: 'jane@grandpalms.com', role: 'client' });
        if (url.pathname === '/portal/galleries')
          return json(route, galleries);
        if (url.pathname === '/portal/contracts')
          return json(route, []);
        if (url.pathname === '/portal/invoices')
          return json(route, []);

        await route.fulfill({ status: 404, headers: CORS });
      },
    );
  }

  test('client portal shows a gallery when it is assigned to their account', async ({ page, context }) => {
    await mockPortal(context, { galleries: [MOCK_GALLERY] });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('#galleries-content')).not.toContainText('Loading', { timeout: 10_000 });
    await expect(page.locator('#galleries-content')).toContainText('Grand Palms Summer 2026');
  });

  test('client portal shows empty state when no galleries are assigned', async ({ page, context }) => {
    await mockPortal(context, { galleries: [] });

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('#galleries-content')).not.toContainText('Loading', { timeout: 10_000 });
    await expect(page.locator('#galleries-content')).toContainText(/no galleries|not yet/i);
  });
});

// ── Admin → Portal End-to-End Gallery Assignment Flow ─────────────────────────

test.describe('Admin gallery assignment change is reflected in client portal', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('unassigning a gallery in admin removes it from the client portal', async ({ page, context }) => {
    // Shared mutable state — admin PUT updates this; portal mock reads from it
    let assignedGalleries = ['gal1'];

    await context.route(
      (url) => url.toString().startsWith(WORKER_URL),
      async (route) => {
        const req    = route.request();
        const url    = new URL(req.url());
        const method = req.method();
        if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }

        if (url.pathname === '/auth/me')
          return json(route, { id: 'admin1', email: 'admin@test.com', role: 'admin' });
        if (url.pathname === '/admin/galleries' && method === 'GET')
          return json(route, [MOCK_GALLERY]);
        if (url.pathname === '/admin/users' && method === 'GET')
          return json(route, [{ ...MOCK_USER, galleries: assignedGalleries }]);
        if (url.pathname.match(/^\/admin\/users\/[^/]+$/) && method === 'PUT') {
          const body = JSON.parse(req.postData() || '{}');
          if (Array.isArray(body.galleries)) assignedGalleries = body.galleries;
          return json(route, { ...MOCK_USER, galleries: assignedGalleries });
        }
        if (url.pathname === '/portal/galleries')
          return json(route, assignedGalleries.map(id => id === 'gal1' ? MOCK_GALLERY : null).filter(Boolean));
        if (url.pathname === '/portal/contracts')
          return json(route, []);
        if (url.pathname === '/portal/invoices')
          return json(route, []);

        await route.fulfill({ status: 404, headers: CORS });
      },
    );

    // ── Phase 1: Admin opens clients page and removes the gallery ────────────
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-admin'));
    await page.goto(`${STATIC_BASE}/admin/clients.html`);
    await expect(page.locator('#userList')).toBeVisible({ timeout: 10_000 });

    await page.click('.ur-info');
    const panel = page.locator(`#udetail-${MOCK_USER.id}`);
    await expect(panel).toHaveClass(/open/, { timeout: 5_000 });

    const checkbox = panel.locator('input[type=checkbox][value="gal1"]');
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await panel.locator('button:has-text("Save Gallery Access")').click();

    // Wait until the PUT has updated shared state
    await expect(async () => {
      expect(assignedGalleries).toHaveLength(0);
    }).toPass({ timeout: 5_000 });

    // ── Phase 2: Override /auth/me to return client role, navigate to portal ──
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL) && new URL(url).pathname === '/auth/me',
      async (route) => json(route, { id: MOCK_USER.id, email: MOCK_USER.email, role: 'client' }),
    );

    await page.goto(`${STATIC_BASE}/portal.html`);
    await expect(page.locator('#galleries-content')).not.toContainText('Loading', { timeout: 10_000 });
    await expect(page.locator('#galleries-content')).toContainText(/no galleries|not yet/i);
  });
});
