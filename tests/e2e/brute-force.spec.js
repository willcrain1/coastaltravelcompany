/**
 * Acceptance tests for brute-force attack protection (TODO item 41).
 *
 * All tests use Playwright's route interception to mock Worker responses,
 * then verify the UI handles each scenario correctly.
 *
 * Login lockout:
 *  1. Shows lockout message when email is blocked (429, email reason)
 *  2. Shows network lockout message when IP is blocked (429, IP reason)
 *  3. Allows login after lockout clears (Worker returns 200 again)
 *  4. Shows account-locked message when admin account is permanently locked
 *
 * Password reset:
 *  5. Shows generic success message even when Worker rate-limits (no enumeration leak)
 *
 * Gallery token exchange:
 *  6. Shows error state when token exchange returns 429
 *  7. Simulates 10 failed exchanges then confirms 429 on the next
 */

import { test, expect } from '@playwright/test';

const WORKER_URL  = process.env.WORKER_URL || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
const STATIC_BASE = process.env.BASE_URL   || 'http://localhost:9876';

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

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

function fulfill429(route, reason, retryAfter = '900') {
  return route.fulfill({
    status:  429,
    headers: { 'content-type': 'application/json', 'retry-after': retryAfter, ...CORS },
    body:    JSON.stringify({ error: reason }),
  });
}

function fulfill200Auth(route) {
  return route.fulfill({
    status:  200,
    headers: { 'content-type': 'application/json', ...CORS },
    body:    JSON.stringify({
      token: 'mock-jwt',
      user:  { id: 'u1', email: 'client@test.com', role: 'client' },
    }),
  });
}

async function submitLoginForm(page, email = 'test@example.com', password = 'wrongpassword') {
  await page.locator('#loginEmail').fill(email);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginBtn').click();
}

// ── Login Lockout ─────────────────────────────────────────────────────────────

test.describe('Login brute-force protection', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('shows email lockout message when Worker returns 429 (per-email block)', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status': (r) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ configured: true }) }),
      'POST /auth/login': (r) => fulfill429(r, 'Too many failed login attempts. Please try again in 15 minutes.'),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await submitLoginForm(page);

    const error = page.locator('#loginError');
    await expect(error).toBeVisible({ timeout: 5_000 });
    await expect(error).toContainText('Too many failed login attempts');
  });

  test('shows network lockout message when Worker returns 429 (per-IP block)', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status': (r) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ configured: true }) }),
      'POST /auth/login': (r) => fulfill429(r, 'Too many requests from your network. Please try again in 15 minutes.'),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await submitLoginForm(page);

    const error = page.locator('#loginError');
    await expect(error).toBeVisible({ timeout: 5_000 });
    await expect(error).toContainText('your network');
  });

  test('shows account-locked message when admin account is permanently locked', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status': (r) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ configured: true }) }),
      'POST /auth/login': (r) => fulfill429(r, 'Account locked due to repeated failed attempts. Please reset your password to regain access.'),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await submitLoginForm(page, 'admin@example.com');

    const error = page.locator('#loginError');
    await expect(error).toBeVisible({ timeout: 5_000 });
    await expect(error).toContainText('reset your password');
  });

  test('allows login after lockout clears (Worker returns 200)', async ({ page, context }) => {
    // Simulate lockout on first attempt, then success on next (TTL expired)
    let attempt = 0;
    let loggedIn = false;
    await mockWorker(context, {
      'GET /auth/setup-status': (r) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ configured: true }) }),
      // Return 401 until login succeeds; once logged in, portal.html needs 200 to stay on the page
      'GET /auth/me': (r) => loggedIn
        ? r.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ id: 'u1', email: 'client@test.com', role: 'client' }) })
        : r.fulfill({ status: 401, headers: CORS, body: '{}' }),
      'POST /auth/login': async (r) => {
        attempt++;
        if (attempt === 1) return fulfill429(r, 'Too many failed login attempts. Please try again in 15 minutes.');
        loggedIn = true;
        return fulfill200Auth(r);
      },
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await submitLoginForm(page);
    await expect(page.locator('#loginError')).toBeVisible({ timeout: 5_000 });
    // Wait for button to re-enable before the second submission
    await page.waitForFunction(() => !document.getElementById('loginBtn').disabled, { timeout: 5_000 });

    // Second attempt (simulating TTL expiry — Worker now returns 200)
    await submitLoginForm(page, 'test@example.com', 'correctpassword');
    await page.waitForURL('**/portal.html', { timeout: 10_000 });
    expect(page.url()).toContain('portal.html');
  });

  test('simulates 6 rapid failed logins: 6th attempt triggers lockout message', async ({ page, context }) => {
    let count = 0;
    await mockWorker(context, {
      'GET /auth/setup-status': (r) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ configured: true }) }),
      'POST /auth/login': async (r) => {
        count++;
        if (count < 6) {
          return r.fulfill({ status: 401, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ error: 'Invalid email or password' }) });
        }
        return fulfill429(r, 'Too many failed login attempts. Please try again in 15 minutes.');
      },
    });

    await page.goto(`${STATIC_BASE}/login.html`);

    // Attempts 1-5: wrong password errors
    for (let i = 0; i < 5; i++) {
      await submitLoginForm(page);
      await expect(page.locator('#loginError')).toBeVisible({ timeout: 5_000 });
      // Re-enable the button between submissions (the handler restores it)
      await page.waitForFunction(() => !document.getElementById('loginBtn').disabled, { timeout: 5_000 });
    }

    // Attempt 6: lockout
    await submitLoginForm(page);
    await expect(page.locator('#loginError')).toContainText('Too many failed login attempts', { timeout: 5_000 });
    expect(count).toBe(6);
  });

  test('simulates IP-level block after 21 failed attempts across different accounts', async ({ page, context }) => {
    let count = 0;
    await mockWorker(context, {
      'GET /auth/setup-status': (r) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ configured: true }) }),
      'POST /auth/login': async (r) => {
        count++;
        if (count <= 20) {
          return r.fulfill({ status: 401, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ error: 'Invalid email or password' }) });
        }
        return fulfill429(r, 'Too many requests from your network. Please try again in 15 minutes.');
      },
    });

    await page.goto(`${STATIC_BASE}/login.html`);

    for (let i = 0; i < 20; i++) {
      await submitLoginForm(page, `user${i}@example.com`);
      await expect(page.locator('#loginError')).toBeVisible({ timeout: 5_000 });
      await page.waitForFunction(() => !document.getElementById('loginBtn').disabled, { timeout: 5_000 });
    }

    // 21st attempt triggers IP lockout
    await submitLoginForm(page, 'another@example.com');
    await expect(page.locator('#loginError')).toContainText('your network', { timeout: 5_000 });
    expect(count).toBe(21);
  });
});

// ── Password Reset ────────────────────────────────────────────────────────────

test.describe('Password reset rate limiting', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('shows generic success message even when Worker rate-limits the reset request', async ({ page, context }) => {
    await mockWorker(context, {
      'GET /auth/setup-status': (r) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ configured: true }) }),
      // Worker returns 429 (rate limited) — UI must still show "check your email"
      'POST /auth/reset-request': (r) => fulfill429(r, 'Too many reset requests.', '3600'),
    });

    await page.goto(`${STATIC_BASE}/login.html`);
    await page.locator('#forgotLink').click();
    await page.locator('#forgotEmail').fill('user@example.com');
    await page.locator('#forgotBtn').click();

    // The login page ignores the Worker response on reset-request and always shows success
    const success = page.locator('#forgotSuccess');
    await expect(success).toBeVisible({ timeout: 5_000 });
    await expect(success).toContainText('reset link has been sent');
    // Confirm no error is shown (no enumeration leak)
    await expect(page.locator('#forgotError')).not.toBeVisible();
  });
});

// ── Gallery Token Exchange ────────────────────────────────────────────────────

test.describe('Gallery brute-force protection', () => {
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  // Minimal valid gallery config to load client-gallery.html
  function buildHash(overrides = {}) {
    const cfg = {
      id:           'gallery-1',
      proxyUrl:     WORKER_URL,
      nasClientUrl: `${STATIC_BASE}/gallery/client-gallery.html`,
      passphrase:   'testPass',
      pwHash:       'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // SHA-256('')
      eventName:    'Test Event',
      clientName:   'Test Client',
      watermark:    false,
      ...overrides,
    };
    return btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
  }

  test('shows error state when gallery token exchange returns 429', async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await mockWorker(context, {
      'GET /auth/me': (r) => r.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify({ id: 'u1', email: 'client@test.com', role: 'client' }),
      }),
      'POST /token': (r) => fulfill429(r, 'Too many failed gallery access attempts from your network. Please try again in 10 minutes.', '600'),
    });

    const hash = buildHash();
    await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);

    // Enter correct password (empty string matches the pwHash above)
    const pwInput = page.locator('#pwInput');
    if (await pwInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await pwInput.fill('');
      await page.locator('#unlockBtn').click();
    }

    const errorState = page.locator('#errorState');
    await expect(errorState).toBeVisible({ timeout: 10_000 });
    await expect(errorState).toContainText('429');
  });

  test('simulates 10 failed token exchanges then confirms 429 on the next', async ({ page, context }) => {
    let count = 0;
    await page.addInitScript(() => localStorage.setItem('ctc_jwt', 'mock-jwt'));
    await mockWorker(context, {
      'GET /auth/me': (r) => r.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', ...CORS },
        body: JSON.stringify({ id: 'u1', email: 'client@test.com', role: 'client' }),
      }),
      'POST /token': async (r) => {
        count++;
        if (count <= 10) {
          // 502 (NAS unreachable) — not 401, which the client treats as "redirect to login"
          return r.fulfill({ status: 502, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ error: 'Gallery session failed' }) });
        }
        return fulfill429(r, 'Too many failed gallery access attempts from your network. Please try again in 10 minutes.', '600');
      },
    });

    // Load gallery page 11 times (each page load triggers one token exchange after unlock)
    for (let i = 0; i <= 10; i++) {
      const hash = buildHash({ id: `gallery-${i}` });
      await page.goto(`${STATIC_BASE}/gallery/client-gallery.html#${hash}`);
      const pwInput = page.locator('#pwInput');
      if (await pwInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await pwInput.fill('');
        await page.locator('#unlockBtn').click();
      }
      await page.waitForSelector('#errorState', { timeout: 5_000 });
    }

    expect(count).toBe(11);
    const errorState = page.locator('#errorState');
    await expect(errorState).toBeVisible();
    await expect(errorState).toContainText('429');
  });
});
