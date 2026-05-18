import { test, expect } from '@playwright/test';

const WORKER_URL = 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

async function useMockProposalWorker(context, calls) {
  await context.route(
    (url) => url.toString().startsWith(WORKER_URL),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();

      if (method === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS });
        return;
      }

      if (url.pathname === '/proposals/prop1' && method === 'GET') {
        calls.views += 1;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', ...CORS },
          body: JSON.stringify({
            proposal: {
              id: 'prop1',
              project_id: 'p1',
              cover_note: 'A tailored proposal for your coastal property.',
              expires_at: '2026-06-01',
              package_ids: JSON.stringify(['pkg1', 'pkg2']),
              status: 'sent',
              public_url: 'https://coastaltravelcompany.com/proposal.html#prop1',
              opened_at: new Date().toISOString(),
              view_count: 1,
              time_spent_seconds: 0,
              selected_package_id: '',
              selected_addons: '[]',
            },
            project: {
              id: 'p1',
              client_name: 'Grand Palms Hotel',
              property: 'Grand Palms Resort',
              location: 'Palm Beach, FL',
              shoot_date: '2026-06-20',
            },
            packages: [
              {
                id: 'pkg1',
                name: 'The Editorial Stay',
                description: 'A focused half-day shoot for polished listing and editorial use.',
                inclusions: 'Planning call\nHalf-day shoot\nEdited gallery',
                hero_photo: '',
                base_price: 2500,
                addons: JSON.stringify(['Rush delivery', 'Video reel']),
              },
              {
                id: 'pkg2',
                name: 'The Branded Journey',
                description: 'A wider story for campaigns and owned channels.',
                inclusions: 'Creative direction\nTwo shoot days',
                hero_photo: '',
                base_price: 4500,
                addons: JSON.stringify(['3D walkthrough', 'Extended license']),
              },
            ],
          }),
        });
        return;
      }

      if (url.pathname === '/proposals/prop1/select' && method === 'POST') {
        calls.selection = JSON.parse(req.postData() || '{}');
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', ...CORS },
          body: JSON.stringify({ ok: true, status: 'approved' }),
        });
        return;
      }

      if (url.pathname === '/proposals/prop1/analytics' && method === 'POST') {
        calls.analytics += 1;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', ...CORS },
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      await route.fulfill({ status: 404, headers: CORS });
    },
  );
}

test.describe('Proposal Page', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('client opens a proposal, chooses add-ons, and approves a package', async ({ page, context }) => {
    const calls = { views: 0, analytics: 0, selection: null };
    await useMockProposalWorker(context, calls);

    await page.goto(`${STATIC_BASE}/proposal.html#prop1`);

    await expect(page.locator('h1')).toContainText('Grand Palms Resort');
    await expect(page.locator('#coverNote')).toContainText('tailored proposal');
    await expect(page.locator('.package-name')).toContainText(['The Editorial Stay', 'The Branded Journey']);
    await expect(page.locator('.price')).toContainText(['$2,500', '$4,500']);

    await page.click('article[data-package-id="pkg2"] .select-btn');
    await page.check('input[name="addon-pkg2"][value="Extended license"]');
    await page.click('#approveBtn');

    await expect(page.locator('#message')).toContainText('selection has been sent');
    expect(calls.views).toBe(1);
    expect(calls.selection).toEqual({ package_id: 'pkg2', addons: ['Extended license'] });
  });
});

