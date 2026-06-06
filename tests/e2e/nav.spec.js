/**
 * Navigation header acceptance tests.
 *
 * Public pages (no auth):
 *  1–6. Each main page shows exactly: Home, About, Services, Collections, Contact, Account
 *
 * Client portal (authenticated client):
 *  7. portal.html tab nav shows exactly: My Account, My Project
 *  8. portal-project.html tab nav shows exactly: My Account, My Project
 *
 * Admin panel (authenticated admin):
 *  9. pipeline.html admin nav shows exactly: Pipeline, Galleries, Clients, Services, Customer Portal
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

const PUBLIC_NAV = ['Home', 'About', 'Services', 'Collections', 'Contact', 'Account'];
const PORTAL_TABS = ['My Account', 'My Project', 'My Profile'];
const ADMIN_NAV = ['Pipeline', 'Galleries', 'Clients', 'Services', 'Customer Portal'];

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

function json(route, data, status = 200) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify(data),
  });
}

// ── Public page nav ───────────────────────────────────────────────────────────

const PUBLIC_PAGES = [
  { label: 'Home',        path: 'index.html' },
  { label: 'About',       path: 'about.html' },
  { label: 'Services',    path: 'services.html' },
  { label: 'Collections', path: 'collections.html' },
  { label: 'Contact',     path: 'contact.html' },
  { label: 'Privacy',     path: 'privacy.html' },
];

for (const { label, path } of PUBLIC_PAGES) {
  test(`${label} page nav shows exactly: ${PUBLIC_NAV.join(', ')}`, async ({ page }) => {
    await page.goto(`${STATIC_BASE}/${path}`);
    const links = page.locator('#main-nav .nav-links li a');
    await expect(links).toHaveText(PUBLIC_NAV);
  });
}

// ── Client portal tab nav ─────────────────────────────────────────────────────

test.describe('Client portal tab nav', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test(`portal.html tab nav shows exactly: ${PORTAL_TABS.join(', ')}`, async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-client'));
    await mockWorker(context, {
      'GET /auth/me':          (route) => json(route, { id: 'u1', email: 'client@test.com', role: 'client' }),
      'GET /portal/galleries': (route) => json(route, []),
      'GET /portal/contracts': (route) => json(route, []),
      'GET /portal/invoices':  (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/portal.html`);
    // .portal-tab-link elements are in static HTML; toHaveText also confirms auth
    // succeeded (a redirect to /login.html would leave 0 elements → test fails).
    // Use .portal-tab-link directly — the container class differs between branches.
    const tabs = page.locator('.portal-tab-link');
    await expect(tabs).toHaveText(PORTAL_TABS, { timeout: 10_000 });
  });

  test(`portal-project.html tab nav shows exactly: ${PORTAL_TABS.join(', ')}`, async ({ page, context }) => {
    const TOKEN = 'test-project-token';
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-client'));
    await mockWorker(context, {
      'GET /auth/me': (route) => json(route, { id: 'u1', email: 'client@test.com', role: 'client' }),
      [`GET /portal/project/${TOKEN}`]: (route) => json(route, {
        project:        { id: 'proj1', property: 'Grand Palms Resort', client_name: 'Test Client', collection: 'The Editorial Stay', location: 'Palm Beach, FL', shoot_date: null, stage: 'Active' },
        documents:      [],
        proposals:      [],
        messages:       [],
        questionnaires: [],
      }),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${TOKEN}`);
    const tabs = page.locator('.portal-tab-link');
    await expect(tabs).toHaveText(PORTAL_TABS, { timeout: 10_000 });
  });

  test(`profile.html tab nav shows exactly: ${PORTAL_TABS.join(', ')}`, async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-client'));
    await mockWorker(context, {
      'GET /auth/me': (route) => json(route, { id: 'u1', email: 'client@test.com', role: 'client', name: 'Test Client', hasPassword: true }),
    });

    await page.goto(`${STATIC_BASE}/profile.html`);
    const tabs = page.locator('.portal-tab-link');
    await expect(tabs).toHaveText(PORTAL_TABS, { timeout: 10_000 });
  });
});

// ── Admin nav ─────────────────────────────────────────────────────────────────

test.describe('Admin nav', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test(`pipeline.html admin nav shows exactly: ${ADMIN_NAV.join(', ')}`, async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt-admin'));
    await mockWorker(context, {
      'GET /auth/me':       (route) => json(route, { id: 'u1', email: 'admin@test.com', role: 'admin' }),
      'GET /admin/projects': (route) => json(route, []),
    });

    await page.goto(`${STATIC_BASE}/admin/pipeline.html`);
    // GitHub Pages may strip .html from URLs — wait for nav links to confirm auth succeeded.
    const links = page.locator('.admin-nav .admin-nav-link');
    await expect(links).toHaveCount(ADMIN_NAV.length, { timeout: 10_000 });
    // Strip the external link arrow suffix from "Customer Portal ↗"
    const texts = await links.allTextContents();
    const normalized = texts.map(t => t.replace(/\s*↗\s*$/, '').trim());
    expect(normalized).toEqual(ADMIN_NAV);
  });
});
