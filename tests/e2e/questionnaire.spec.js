/**
 * Acceptance tests for the public questionnaire page (item 5).
 *
 *  1. Questions render from a valid magic token (text, date, multiple-choice)
 *  2. Submitting answers sends the correct payload to the Worker
 *  3. After successful submission the done state is shown
 *  4. A questionnaire that is already completed shows the already-done state
 *  5. Invalid / not-found token shows the error state
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

const TOKEN = 'qn-test-token';

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

const MOCK_QUESTIONS = [
  { type: 'text',            label: 'Property name' },
  { type: 'date',            label: 'Preferred shoot date' },
  { type: 'multiple-choice', label: 'Property type', options: ['Hotel', 'Resort', 'Private villa'] },
];

function makeQuestionnaire(overrides = {}) {
  return {
    id:          TOKEN,
    status:      'pending',
    set_name:    'Pre-booking Intake',
    property:    'Grand Palms Resort',
    collection:  'The Editorial Stay',
    client_name: 'Grand Palms Hotel',
    questions:   MOCK_QUESTIONS,
    ...overrides,
  };
}

test.describe('Questionnaire Page', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('renders all question types from a valid token', async ({ page, context }) => {
    await mockWorker(context, {
      [`GET /questionnaire/${TOKEN}`]: (route) => json(route, makeQuestionnaire()),
    });

    await page.goto(`${STATIC_BASE}/questionnaire.html#${TOKEN}`);
    await expect(page.locator('#qnWrap')).toBeVisible({ timeout: 10_000 });

    // Title and context metadata
    await expect(page.locator('#qnTitle')).toContainText('Pre-booking Intake');
    await expect(page.locator('#qnSubtitle')).toContainText('Grand Palms Resort');

    // One text field, one date input, and radio buttons for multiple-choice
    await expect(page.locator('#q_0')).toBeVisible();
    await expect(page.locator('#q_1')).toBeVisible();
    await expect(page.locator('input[name="q_2"]').first()).toBeVisible();

    // All three radio options present
    for (const opt of ['Hotel', 'Resort', 'Private villa']) {
      await expect(page.locator(`label:has-text("${opt}")`)).toBeVisible();
    }
  });

  test('submitting answers sends the correct payload and shows done state', async ({ page, context }) => {
    let submitted = null;

    await mockWorker(context, {
      [`GET /questionnaire/${TOKEN}`]:  (route) => json(route, makeQuestionnaire()),
      [`POST /questionnaire/${TOKEN}`]: async (route, req) => {
        submitted = JSON.parse(req.postData() || '{}');
        return json(route, { ok: true });
      },
    });

    await page.goto(`${STATIC_BASE}/questionnaire.html#${TOKEN}`);
    await expect(page.locator('#qnWrap')).toBeVisible({ timeout: 10_000 });

    await page.fill('#q_0', 'Grand Palms Resort');
    await page.fill('#q_1', '2026-07-15');
    await page.click('input[name="q_2"][value="Hotel"]');

    await page.click('#submitBtn');

    await expect(page.locator('#doneState')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#qnWrap')).not.toBeVisible();

    expect(submitted?.q_0).toBe('Grand Palms Resort');
    expect(submitted?.q_1).toBe('2026-07-15');
    expect(submitted?.q_2).toBe('Hotel');
  });

  test('already-completed questionnaire shows the already-done state', async ({ page, context }) => {
    await mockWorker(context, {
      [`GET /questionnaire/${TOKEN}`]: (route) => json(route, makeQuestionnaire({ status: 'completed' })),
    });

    await page.goto(`${STATIC_BASE}/questionnaire.html#${TOKEN}`);

    await expect(page.locator('#alreadyDone')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#qnWrap')).not.toBeVisible();
  });

  test('invalid token shows the error state', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /questionnaire/bad-token': (route) => json(route, { error: 'Not found' }, 404),
    });

    await page.goto(`${STATIC_BASE}/questionnaire.html#bad-token`);
    await expect(page.locator('#errorState')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#qnWrap')).not.toBeVisible();
  });
});
