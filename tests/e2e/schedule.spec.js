/**
 * Acceptance tests for the scheduling page (item 5).
 *
 *  1. Available time slots render from a valid magic token
 *  2. Discovery call link shows correct duration label
 *  3. Clicking a slot highlights it and reveals the confirmation panel
 *  4. Confirming a booking shows the success message with the booked time
 *  5. Already-booked link shows the booked time and hides the slot picker
 *  6. Invalid / not-found token shows the error state
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

const TOKEN = 'sched-test-token';

function json(route, data, status = 200) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify(data),
  });
}

// Build a set of ISO slot strings starting tomorrow
function futureSlots(count = 3) {
  const slots = [];
  const base  = new Date();
  base.setDate(base.getDate() + 1);
  base.setHours(9, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setHours(9 + i);
    slots.push(d.toISOString().slice(0, 19));
  }
  return slots;
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

test.describe('Scheduling Page', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('renders available time slots from a valid magic token', async ({ page, context }) => {
    const slots = futureSlots(3);
    await mockWorker(context, {
      [`GET /schedule/${TOKEN}`]: (route) => json(route, {
        link_type:       'discovery-call',
        duration_mins:   30,
        client_name:     'Grand Palms Hotel',
        booked:          false,
        booked_slot:     '',
        available_slots: slots,
      }),
    });

    await page.goto(`${STATIC_BASE}/schedule.html#${TOKEN}`);
    await expect(page.locator('#scWrap')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#scSlots')).toBeVisible();

    const slotBtns = page.locator('.sc-slot');
    await expect(slotBtns).toHaveCount(slots.length);
  });

  test('discovery call shows a 30-minute duration label', async ({ page, context }) => {
    await mockWorker(context, {
      [`GET /schedule/${TOKEN}`]: (route) => json(route, {
        link_type:       'discovery-call',
        duration_mins:   30,
        client_name:     'Grand Palms Hotel',
        booked:          false,
        booked_slot:     '',
        available_slots: futureSlots(2),
      }),
    });

    await page.goto(`${STATIC_BASE}/schedule.html#${TOKEN}`);
    await expect(page.locator('#scWrap')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#scSubtitle')).toContainText('30');
  });

  test('clicking a slot highlights it and reveals the confirmation panel', async ({ page, context }) => {
    await mockWorker(context, {
      [`GET /schedule/${TOKEN}`]: (route) => json(route, {
        link_type:       'discovery-call',
        duration_mins:   30,
        client_name:     'Grand Palms Hotel',
        booked:          false,
        booked_slot:     '',
        available_slots: futureSlots(2),
      }),
    });

    await page.goto(`${STATIC_BASE}/schedule.html#${TOKEN}`);
    await expect(page.locator('.sc-slot').first()).toBeVisible({ timeout: 10_000 });

    await page.locator('.sc-slot').first().click();

    await expect(page.locator('.sc-slot').first()).toHaveClass(/selected/);
    await expect(page.locator('#scConfirmPanel')).toBeVisible();
    await expect(page.locator('#scConfirmTime')).not.toBeEmpty();
  });

  test('confirming a slot booking shows the success message', async ({ page, context }) => {
    const slots  = futureSlots(2);
    let booked   = null;

    await mockWorker(context, {
      [`GET /schedule/${TOKEN}`]: (route) => json(route, {
        link_type:       'discovery-call',
        duration_mins:   30,
        client_name:     'Grand Palms Hotel',
        booked:          false,
        booked_slot:     '',
        available_slots: slots,
      }),
      [`POST /schedule/${TOKEN}`]: async (route, req) => {
        booked = JSON.parse(req.postData() || '{}');
        return json(route, { ok: true, booked_slot: booked.slot, booked_at: new Date().toISOString() });
      },
    });

    await page.goto(`${STATIC_BASE}/schedule.html#${TOKEN}`);
    await expect(page.locator('.sc-slot').first()).toBeVisible({ timeout: 10_000 });

    await page.locator('.sc-slot').first().click();
    await expect(page.locator('#scConfirmPanel')).toBeVisible();
    await page.click('#scBookBtn');

    await expect(page.locator('#scSuccess')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#scSlots')).not.toBeVisible();
    expect(booked?.slot).toBeTruthy();
  });

  test('already-booked link shows booked time and hides the slot picker', async ({ page, context }) => {
    const bookedSlot = futureSlots(1)[0];
    await mockWorker(context, {
      [`GET /schedule/${TOKEN}`]: (route) => json(route, {
        link_type:       'discovery-call',
        duration_mins:   30,
        client_name:     'Grand Palms Hotel',
        booked:          true,
        booked_slot:     bookedSlot,
        available_slots: [],
      }),
    });

    await page.goto(`${STATIC_BASE}/schedule.html#${TOKEN}`);
    await expect(page.locator('#scWrap')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('#alreadyBooked')).toBeVisible();
    await expect(page.locator('#scSlots')).not.toBeVisible();
  });

  test('invalid token renders the error state', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /schedule/bad-token': (route) => json(route, { error: 'Scheduling link not found' }, 404),
    });

    await page.goto(`${STATIC_BASE}/schedule.html#bad-token`);
    await expect(page.locator('#scError')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#scWrap')).not.toBeVisible();
  });
});
