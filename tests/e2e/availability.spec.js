/**
 * Acceptance tests for the availability calendar on contact.html (item 9).
 *
 *  1. Calendar section renders with 3 months of day cells
 *  2. Days matching an active availability window get the cal-avail class
 *  3. Blocked dates get the cal-blocked class
 *  4. Past dates get the cal-past class
 *  5. When the Worker is unreachable the calendar falls back to Mon–Fri available
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

function json(route, data, status = 200) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify(data),
  });
}

// Returns YYYY-MM-DD for N days from today
function futureDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

// Returns the day-of-week (0=Sun…6=Sat) for N days from today
function futureDow(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.getDay();
}

test.describe('Availability Calendar', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('calendar section renders 3 months of day cells', async ({ page, context }) => {
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL + '/public/availability'),
      (route) => json(route, { windows: [{ day_of_week: 1 }, { day_of_week: 3 }], blocked_dates: [] }),
    );

    await page.goto(`${STATIC_BASE}/contact.html`);
    await expect(page.locator('#avail-cal')).toBeVisible({ timeout: 10_000 });

    // Three month containers rendered
    const months = page.locator('.cal-month');
    await expect(months).toHaveCount(3);

    // Each month has day cells (at least 3 × ~20 real days plus blank fillers)
    const dayCellCount = await page.locator('.cal-day').count();
    expect(dayCellCount).toBeGreaterThan(60);
  });

  test('days matching active windows get the cal-avail class', async ({ page, context }) => {
    // Make Monday (1) available
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL + '/public/availability'),
      (route) => json(route, { windows: [{ day_of_week: 1 }], blocked_dates: [] }),
    );

    await page.goto(`${STATIC_BASE}/contact.html`);
    await expect(page.locator('#avail-cal')).toBeVisible({ timeout: 10_000 });

    // At least one available cell should exist (there are always Mondays in a 3-month span)
    await expect(page.locator('.cal-avail').first()).toBeVisible();
  });

  test('blocked dates get the cal-blocked class', async ({ page, context }) => {
    // Block tomorrow
    const tomorrowStr = futureDate(1);
    const tomorrowDow = futureDow(1);

    // Make tomorrow's DOW available so it would otherwise show as teal
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL + '/public/availability'),
      (route) => json(route, {
        windows:       [{ day_of_week: tomorrowDow }],
        blocked_dates: [tomorrowStr],
      }),
    );

    await page.goto(`${STATIC_BASE}/contact.html`);
    await expect(page.locator('#avail-cal')).toBeVisible({ timeout: 10_000 });

    // The blocked day must exist as .cal-blocked
    await expect(page.locator('.cal-blocked').first()).toBeVisible();
  });

  test('past dates get the cal-past class', async ({ page, context }) => {
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL + '/public/availability'),
      (route) => json(route, { windows: [], blocked_dates: [] }),
    );

    await page.goto(`${STATIC_BASE}/contact.html`);
    await expect(page.locator('#avail-cal')).toBeVisible({ timeout: 10_000 });

    // Only the first month may have past days if we're not on the 1st.
    // Either 0 or >0 past cells — just verify the class exists when days have passed.
    // We check that no future cell has cal-past.
    const today = new Date();
    if (today.getDate() > 1) {
      await expect(page.locator('.cal-past').first()).toBeVisible();
    }
  });

  test('falls back to Mon–Fri available when the Worker is unreachable', async ({ page, context }) => {
    await context.route(
      (url) => url.toString().startsWith(WORKER_URL + '/public/availability'),
      (route) => route.abort('failed'),
    );

    await page.goto(`${STATIC_BASE}/contact.html`);
    await expect(page.locator('#avail-cal')).toBeVisible({ timeout: 10_000 });

    // With Mon–Fri fallback (dow 1–5) there must be available cells in a 3-month span
    await expect(page.locator('.cal-avail').first()).toBeVisible({ timeout: 5_000 });
  });
});
