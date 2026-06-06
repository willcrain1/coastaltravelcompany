/**
 * Acceptance tests for the client project portal page (item 5).
 *
 *  1. Project info and timeline render from a valid magic token
 *  2. Completed stages are marked done; current stage is active
 *  3. Documents section renders linked document cards
 *  4. Messages thread renders existing messages
 *  5. Client can send a new message
 *  6. Questionnaire section shows sent/completed statuses
 *  7. Invalid / not-found token shows the error state
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

const TOKEN = 'portal-proj-token';

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

function makePortalData(overrides = {}) {
  return {
    project: {
      id:          'proj1',
      property:    'Grand Palms Resort',
      client_name: 'Rebecca Harper',
      collection:  'The Editorial Stay',
      location:    'Palm Beach, FL',
      shoot_date:  '2026-07-20',
      stage:       'Contract Signed',
    },
    documents: [
      { type: 'proposal', title: 'Editorial Stay Proposal', url: `${STATIC_BASE}/proposal.html#p1` },
      { type: 'contract', title: 'Photography Services Agreement', url: `${STATIC_BASE}/contract.html#c1` },
    ],
    proposals: [
      { status: 'approved', public_url: `${STATIC_BASE}/proposal.html#p1` },
    ],
    questionnaires: [
      {
        status:       'sent',
        phase:        'pre-booking',
        magic_token:  'qn-tok-1',
        sent_at:      '2026-05-01T10:00:00Z',
        completed_at: '',
      },
    ],
    messages: [
      {
        sender:      'admin',
        sender_name: 'Coastal Travel Company',
        content:     'Looking forward to working with you!',
        created_at:  '2026-05-02T09:00:00Z',
      },
    ],
    ...overrides,
  };
}

test.describe('Client Project Portal', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('renders project info and timeline from a valid token', async ({ page, context }) => {
    const data = makePortalData();
    await mockWorker(context, {
      [`GET /portal/project/${TOKEN}`]: (route) => json(route, data),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${TOKEN}`);
    await expect(page.locator('#ppWrap')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('#ppTitle')).toContainText('Grand Palms Resort');
    await expect(page.locator('#ppMeta')).toContainText('The Editorial Stay');
    await expect(page.locator('#ppMeta')).toContainText('Palm Beach, FL');
    await expect(page.locator('#ppTimeline')).toBeVisible();
  });

  test('completed stages are marked done and current stage is active', async ({ page, context }) => {
    const data = makePortalData(); // stage = 'Contract Signed'
    await mockWorker(context, {
      [`GET /portal/project/${TOKEN}`]: (route) => json(route, data),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${TOKEN}`);
    await expect(page.locator('#ppTimeline')).toBeVisible({ timeout: 10_000 });

    // done/active classes are on .tl-dot and .tl-label, not the .tl-step wrapper
    await expect(page.locator('.tl-dot.done').first()).toBeVisible();
    await expect(page.locator('.tl-dot.active')).toBeVisible();
  });

  test('documents section renders linked document cards', async ({ page, context }) => {
    const data = makePortalData();
    await mockWorker(context, {
      [`GET /portal/project/${TOKEN}`]: (route) => json(route, data),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${TOKEN}`);
    await expect(page.locator('#ppDocs')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('.doc-card')).toHaveCount(2);
    await expect(page.locator('.doc-card').first()).toContainText('Proposal');
  });

  test('messages thread renders existing messages', async ({ page, context }) => {
    const data = makePortalData();
    await mockWorker(context, {
      [`GET /portal/project/${TOKEN}`]: (route) => json(route, data),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${TOKEN}`);
    await expect(page.locator('#ppMessages')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('.msg-item')).toHaveCount(1);
    await expect(page.locator('.msg-bubble')).toContainText('Looking forward to working with you!');
  });

  test('client can send a new message', async ({ page, context }) => {
    let sent = null;
    const data = makePortalData();

    await mockWorker(context, {
      [`GET /portal/project/${TOKEN}`]:  (route) => json(route, data),
      [`POST /portal/project/${TOKEN}`]: async (route, req) => {
        sent = JSON.parse(req.postData() || '{}');
        return json(route, {
          sender:      'client',
          sender_name: 'Rebecca Harper',
          content:     sent.content,
          created_at:  new Date().toISOString(),
        }, 201);
      },
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${TOKEN}`);
    await expect(page.locator('#ppMessages')).toBeVisible({ timeout: 10_000 });

    await page.fill('#msgInput', 'What time should we start on shoot day?');
    await page.click('#msgSendBtn');

    // New message appears in thread
    await expect(page.locator('.msg-item')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.msg-item').last()).toContainText('What time should we start');

    // Input cleared after send
    await expect(page.locator('#msgInput')).toHaveValue('');
    expect(sent?.content).toContain('What time should we start');
  });

  test('questionnaire section shows sent and completed status badges', async ({ page, context }) => {
    const data = makePortalData({
      questionnaires: [
        { status: 'sent',      phase: 'pre-booking', magic_token: 'qt1', sent_at: '2026-05-01T10:00:00Z', completed_at: '' },
        { status: 'completed', phase: 'pre-shoot',   magic_token: 'qt2', sent_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-05T14:00:00Z' },
      ],
    });
    await mockWorker(context, {
      [`GET /portal/project/${TOKEN}`]: (route) => json(route, data),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#${TOKEN}`);
    await expect(page.locator('#ppQnSection')).toBeVisible({ timeout: 10_000 });

    const badges = page.locator('.qn-status-badge');
    await expect(badges).toHaveCount(2);
    await expect(badges.nth(0)).toContainText(/sent|pending/i);
    await expect(badges.nth(1)).toContainText(/completed/i);
  });

  test('invalid token shows the error state', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /portal/project/bad-token': (route) => json(route, { error: 'Not found' }, 404),
    });

    await page.goto(`${STATIC_BASE}/portal-project.html#bad-token`);
    await expect(page.locator('#ppError')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#ppWrap')).not.toBeVisible();
  });
});
