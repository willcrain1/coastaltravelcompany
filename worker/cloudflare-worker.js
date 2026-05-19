// Cloudflare Worker — entry point
// Deploy via: ./worker/deploy-worker.sh  (uses wrangler, which bundles src/ via esbuild)
//
// Security model:
//  1. Origin header validation — rejects requests not from coastaltravelcompany.com
//  2. Session token exchange — POST /token exchanges passphrase for a short-lived sid
//  3. JWT auth (HS256) — 7-day tokens for client and admin sessions
//  4. Synology API allowlist — only Browse.Item, Thumbnail, Download forwarded
//  5. KV rate limiting — 300 req/min per gallery; 5/hour for contact form
//  6. Server-side watermarking — watermark=1 burns text into the image
//
// Required Worker secrets (set in Cloudflare dashboard or via wrangler secret put):
//   JWT_SECRET            — long random string used to sign auth tokens
//   RESEND_API_KEY        — Resend API key for transactional email
//   GOOGLE_CLIENT_ID      — optional; enables Google Sign-In
//   STRIPE_SECRET_KEY     — optional; enables Stripe invoice payment
//   STRIPE_WEBHOOK_SECRET — optional; verifies Stripe webhook signatures
//
// Source layout:
//   src/constants.js          — shared constants (CORS, URLs, etc.)
//   src/utils.js              — jsonResponse, authRequired, forbidden, escHtml
//   src/jwt.js                — createJWT, verifyJWT, getAuth
//   src/crypto.js             — hashPassword, verifyPassword (PBKDF2-SHA256)
//   src/kv.js                 — KV helpers: users and galleries
//   src/auth.js               — /auth/* route handlers
//   src/gallery-proxy.js      — NAS proxy, watermarking, token exchange
//   src/contact.js            — /contact route handler
//   src/portal.js             — portal galleries, project portal, messages
//   src/admin/galleries.js    — admin gallery CRUD
//   src/admin/users.js        — admin user CRUD
//   src/admin/packages.js     — service packages + proposals
//   src/admin/questionnaires.js — questionnaire sets + instances
//   src/admin/projects.js     — project CRUD + notes + documents
//   src/admin/scheduling.js   — availability, blocked dates, schedule links
//   src/admin/contracts.js    — contract templates + signing flow
//   src/admin/invoices.js     — invoices + Stripe Checkout + webhook
//   src/admin/automations.js  — automation settings + cron handler
//   src/router.js             — handleRequest dispatcher

import { handleRequest } from './src/router.js';
import { handleScheduled } from './src/admin/automations.js';

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};
