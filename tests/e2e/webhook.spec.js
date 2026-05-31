/**
 * Stripe webhook end-to-end integration tests (item 43).
 *
 * These tests fire a real Stripe CLI webhook trigger against the preprod Worker
 * and assert that the database state changes correctly. They require live preprod
 * infrastructure and are skipped when the environment variables are absent.
 *
 * Required environment variables (all must be set to run):
 *   STRIPE_CLI_API_KEY   — Stripe test-mode secret key (sk_test_...) used by the CLI
 *   WORKER_URL           — Full URL to the preprod Worker (must differ from the default prod URL)
 *   PREPROD_ADMIN_JWT    — Valid admin JWT for the preprod Worker
 *
 * In CI these are provided by GitHub Actions secrets (see ci-pr.yml).
 * Locally: STRIPE_CLI_API_KEY=... WORKER_URL=... PREPROD_ADMIN_JWT=... npm test -- webhook.spec.js
 *
 * How the test works:
 *   1. Create a project + invoice via the preprod Worker API (admin auth)
 *   2. Send the invoice (status: sent)
 *   3. Use `stripe trigger checkout.session.completed` to fire a signed webhook event
 *      with the invoice_id in metadata, forwarded to the preprod Worker via `stripe listen`
 *   4. Poll the Worker API until the invoice status is `paid` (timeout: 30 s)
 *   5. Assert the project stage advanced to `Retainer Paid`
 *   6. Clean up the test project
 */

import { test, expect } from '@playwright/test';
import { execSync, spawn }  from 'child_process';

const STRIPE_CLI_API_KEY = process.env.STRIPE_CLI_API_KEY;
const WORKER_URL         = process.env.WORKER_URL;
const PREPROD_ADMIN_JWT  = process.env.PREPROD_ADMIN_JWT;
const DEFAULT_PROD_URL   = 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';

const hasRequiredEnv = !!(
  STRIPE_CLI_API_KEY &&
  WORKER_URL &&
  WORKER_URL !== DEFAULT_PROD_URL &&
  PREPROD_ADMIN_JWT
);

test.describe('Stripe Webhook Integration', () => {
  test.beforeAll(() => {
    if (!hasRequiredEnv) {
      // eslint-disable-next-line no-console
      console.log('Skipping Stripe webhook tests — requires STRIPE_CLI_API_KEY, WORKER_URL (preprod), PREPROD_ADMIN_JWT');
    }
  });

  test('checkout.session.completed marks invoice paid and advances project to Retainer Paid', async ({ request }) => {
    test.skip(!hasRequiredEnv, 'requires STRIPE_CLI_API_KEY, WORKER_URL (preprod), PREPROD_ADMIN_JWT');

    const adminHeaders = {
      Authorization:  `Bearer ${PREPROD_ADMIN_JWT}`,
      'Content-Type': 'application/json',
      Origin:         'https://preprod.coastaltravelcompany.com',
    };
    const webhookUrl = `${WORKER_URL}/stripe/webhook`;
    let projectId = null;
    let invoiceId = null;

    try {
      // ── Step 1: Create test project ──────────────────────────────────────────
      const projectRes = await request.post(`${WORKER_URL}/admin/projects`, {
        headers: adminHeaders,
        data: {
          client_name:  'Stripe Webhook Test Client',
          client_email: 'wh-test@example.com',
          property:     'Test Property',
          stage:        'Contract Signed',
          source:       'manual',
        },
      });
      expect(projectRes.ok(), `Create project failed: ${await projectRes.text()}`).toBe(true);
      const project = await projectRes.json();
      projectId = project.id;

      // ── Step 2: Create and send invoice ──────────────────────────────────────
      const invoiceRes = await request.post(`${WORKER_URL}/admin/projects/${projectId}/invoices`, {
        headers: adminHeaders,
        data: {
          line_items: [{ description: 'Test retainer', quantity: 1, unit_price_cents: 50000 }],
          tax_cents:  0,
          due_date:   '2026-12-31',
        },
      });
      expect(invoiceRes.ok(), `Create invoice failed: ${await invoiceRes.text()}`).toBe(true);
      const invoice = await invoiceRes.json();
      invoiceId = invoice.id;

      const sendRes = await request.post(`${WORKER_URL}/admin/invoices/${invoiceId}/send`, {
        headers: adminHeaders,
      });
      expect(sendRes.ok(), `Send invoice failed: ${await sendRes.text()}`).toBe(true);

      // ── Step 3: Fire Stripe CLI webhook trigger ───────────────────────────────
      // `stripe listen` forwards incoming webhook events to our Worker.
      // `stripe trigger` sends a checkout.session.completed event with the
      // invoice_id injected into metadata via --override.
      //
      // covers: POST /stripe/webhook
      const listenProc = spawn('stripe', [
        'listen',
        '--forward-to', webhookUrl,
        '--api-key', STRIPE_CLI_API_KEY,
      ], { detached: true, stdio: 'ignore' });

      // Give the listener a moment to connect before triggering
      await new Promise(r => setTimeout(r, 3_000));

      try {
        execSync(
          `stripe trigger checkout.session.completed` +
          ` --override checkout_session:metadata.invoice_id=${invoiceId}` +
          ` --override checkout_session:payment_status=paid` +
          ` --api-key ${STRIPE_CLI_API_KEY}`,
          { timeout: 20_000, stdio: 'pipe' },
        );
      } finally {
        listenProc.kill();
      }

      // ── Step 4: Poll for paid status (webhook is async) ───────────────────────
      let paidInvoice = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(r => setTimeout(r, 2_000));
        const listRes = await request.get(`${WORKER_URL}/admin/projects/${projectId}/invoices`, {
          headers: adminHeaders,
        });
        if (!listRes.ok()) continue;
        const invoices = await listRes.json();
        paidInvoice = (Array.isArray(invoices) ? invoices : []).find(
          inv => inv.id === invoiceId && inv.status === 'paid',
        );
        if (paidInvoice) break;
      }

      expect(paidInvoice, 'Invoice should be marked paid after webhook fires').not.toBeNull();
      expect(paidInvoice.status).toBe('paid');

      // ── Step 5: Assert project stage advanced ─────────────────────────────────
      const projectsRes = await request.get(`${WORKER_URL}/admin/projects`, { headers: adminHeaders });
      expect(projectsRes.ok()).toBe(true);
      const projects = await projectsRes.json();
      const updated  = (Array.isArray(projects) ? projects : []).find(p => p.id === projectId);
      expect(updated?.stage).toBe('Retainer Paid');

    } finally {
      // ── Cleanup: delete the test project ──────────────────────────────────────
      if (projectId) {
        await request.delete(`${WORKER_URL}/admin/projects/${projectId}`, {
          headers: adminHeaders,
        }).catch(() => {});
      }
    }
  });
});
