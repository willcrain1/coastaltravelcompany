# Coastal Travel Company — System Documentation

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Request Routing Map](#request-routing-map)
3. [Infrastructure](#infrastructure)
   - [Name.com](#namecom) · [Cloudflare DNS](#cloudflare-dns) · [Cloudflare Tunnel](#cloudflare-tunnel) · [Cloudflare Worker](#cloudflare-worker) · [GitHub Pages](#github-pages) · [Synology NAS](#synology-nas)
4. [File Structure](#file-structure)
5. [Worker Source Modules](#worker-source-modules)
6. [D1 Database Schema](#d1-database-schema)
7. [Gallery System](#gallery-system)
8. [Admin Workflow](#admin-workflow)
9. [Transactional Emails](#transactional-emails)
10. [Testing](#testing)
11. [Maintenance & Deployment](#maintenance--deployment)

---

## Architecture Overview

```
coastaltravelcompany.com ──────────────► GitHub Pages (static host)
coastal-gallery-proxy.thecoastal        Cloudflare Worker (CORS proxy + API)
  travelcompany.workers.dev ──────────►       │
nas.coastaltravelcompany.com ───────────► Cloudflare Tunnel ──► Synology NAS 192.168.68.2:5001
```

- **Registrar:** Name.com (delegates DNS to Cloudflare)
- **DNS/proxy:** Cloudflare
- **Static hosting:** GitHub Pages (`willcrain1/coastaltravelcompany`, `master` branch)
- **Backend:** Cloudflare Worker — CORS proxy + full CRM/auth/email/payment API
- **Database:** Cloudflare D1 (`CTC_PROJECTS`), KV namespace (`CTC_AUTH`)
- **Email:** Resend (`RESEND_API_KEY`), from `noreply@coastaltravelcompany.com`
- **Payments:** Stripe (live key prod, test key preprod)
- **NAS:** Synology DSM 7.x, exposed via Cloudflare Tunnel

---

## Request Routing Map

| Traffic | Path |
|---------|------|
| Main website | Browser → Cloudflare DNS → GitHub Pages |
| NAS access | Browser/Worker → Cloudflare Tunnel → `192.168.68.2:5001` |
| Gallery proxy | Browser → Cloudflare Worker → `nas.coastaltravelcompany.com` → Synology API |
| QuickConnect | Browser **only** — returns HTML portal for server→server; not used in Worker code |

---

## Infrastructure

### Name.com
- Domain registrar only. DNS is **fully delegated to Cloudflare** — never add DNS records here.
- Action: renew domain annually. Nameservers: `ada.ns.cloudflare.com` / `bob.ns.cloudflare.com`.

### Cloudflare DNS

| Name | Type | Proxied | Purpose |
|------|------|---------|---------|
| `coastaltravelcompany.com` | A/CNAME → GitHub Pages | ✅ | Main site |
| `www` | CNAME → apex | ✅ | www redirect |
| `nas` | CNAME → Tunnel hostname | ✅ | NAS external access (auto-created by Tunnel — do not edit) |
| `preprod` | CNAME → GitHub Pages | ✅ | Preprod site |

### Cloudflare Tunnel
- `cloudflared` package on NAS → persistent encrypted outbound connection to Cloudflare edge.
- Public hostname: `nas.coastaltravelcompany.com` → backend `https://192.168.68.2:5001`
- **TLS verify: disabled** (NAS uses self-signed cert).
- Manage: Cloudflare dashboard → Zero Trust → Networks → Tunnels.
- If down: restart `cloudflared` package in DSM → Package Center.

### Cloudflare Worker
**Production URL:** `https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev`
**Entry point:** `worker/cloudflare-worker.js` → delegates to `worker/src/router.js`

**Required secrets** (Cloudflare dashboard → Worker → Settings → Variables):
- `JWT_SECRET` — signs auth tokens (7-day expiry)
- `RESEND_API_KEY` — transactional email
- `GOOGLE_CLIENT_ID` — OAuth login
- `STRIPE_SECRET_KEY` — invoicing (`sk_test_...` for preprod)
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook validation

**R2 bucket binding** (provisioned automatically by deploy workflows):
- `ASSETS` → `ctc-assets` (prod) / `ctc-assets-preprod` (preprod) — general asset store; signed contract HTML snapshots keyed `contracts/{id}/signed.html`; 3D splats keyed `splats/{slug}/scene.splat`

**Key constants** (`worker/src/constants.js`):
- `ALLOWED_ORIGIN` — defaults to `https://coastaltravelcompany.com`; overridden per-env via `wrangler.toml` `[env.preprod.vars]`
- `CONTACT_TO` — `thecoastaltravelcompany@gmail.com`
- `RATE_LIMIT` — 300 req/60s per passphrase; `CONTACT_RATE_LIMIT` — 5/60s
- `ALLOWED_APIS` — `SYNO.Foto.Browse.Item`, `.Thumbnail`, `.Download`, `.Streaming`
- `JWT_EXPIRY_SECS` — `7 * 24 * 3600`

**Request lifecycle:**
1. OPTIONS → return CORS headers (204), no handler called.
2. Origin/Referer check → 403 if not from `ALLOWED_ORIGIN`.
3. Route match → dispatch to handler.
4. Fallthrough → `handleNasProxy` (gallery proxy).

### GitHub Pages
- Serves `site/` directory from `master` branch at `coastaltravelcompany.com`.
- `CNAME` file in repo root sets custom domain.
- Auto-deploys on push to `master` (~2 min). HTTPS via Cloudflare proxy.
- Preprod: `preprod` branch → `preprod.coastaltravelcompany.com`.

### Synology NAS
- **Local:** `192.168.68.2:5001` | **External:** `nas.coastaltravelcompany.com` | **QuickConnect (browser only):** `coastaltravelcompany.us6.quickconnect.to`
- Gallery uses **Synology Photos sharing**:  album → ··· → Share → passphrase (e.g. `vCsa5XjJH`)
- Key API endpoints:
  - `/mo/sharing/{passphrase}` — sets `sharing_sid` cookie
  - `/mo/sharing/webapi/entry.cgi` — requires `sharing_sid` cookie **and** `X-SYNO-SHARING: {passphrase}` header (both required; cookie alone → error 119)

---

## File Structure

```
coastaltravelcompany/
├── CNAME                          GitHub Pages custom domain
├── DOCS.md                        This file
├── playwright.config.js           Playwright config (port 9876, 30s timeout, 4 shards)
├── package.json                   Test tooling only (not deployed)
│
├── site/
│   ├── config.js                  WORKER_URL (env-aware prod/preprod)
│   ├── main.js                    Public site JS (nav, animations, contact form)
│   ├── styles.css                 Shared styles (CSS vars: --black, --green, --teal, --cream, --linen)
│   ├── index/about/services/collections/contact/privacy.html   Public marketing pages
│   │
│   ├── login.html                 Google OAuth + password login
│   ├── register.html              Self-registration + email verify
│   ├── portal.html                Client portal (galleries, invoices, projects)
│   ├── portal-project.html        Project detail + messaging thread
│   ├── profile.html               Account settings
│   │
│   ├── contract.html              Client contract signing (token in URL hash)
│   ├── invoice.html               Invoice payment + Stripe checkout
│   ├── proposal.html              Proposal view/accept
│   ├── questionnaire.html         Questionnaire submission
│   ├── schedule.html              Booking / scheduling
│   ├── walkthroughs.html          Public walkthrough videos page
│   │
│   ├── gallery/
│   │   ├── gallery.html           Entry point: decodes URL hash → renders client-gallery.html in iframe
│   │   └── client-gallery.html    Full gallery UI: masonry grid, lightbox, download, watermark overlay
│   │
│   └── admin/
│       ├── admin-shared.js        Shared admin JS (JWT auth, nav, apiFetch helper)
│       ├── clients.html           User accounts + gallery assignment
│       ├── galleries.html         Gallery CRUD
│       ├── pipeline.html          Project CRM (Kanban + detail panel)
│       └── services.html          Service packages
│
├── worker/
│   ├── cloudflare-worker.js       Worker entry point (imports router)
│   ├── src/
│   │   ├── router.js              All route dispatch (see Worker Source Modules)
│   │   ├── constants.js           ALLOWED_ORIGIN, CORS, CONTACT_TO, rate limits, allowed APIs
│   │   ├── auth.js                Registration, login, Google OAuth, JWT verify, password reset
│   │   ├── gallery-proxy.js       Token exchange (POST /token) + NAS CORS proxy
│   │   ├── portal.js              Portal endpoints: galleries, contracts, invoices, my-project, messages
│   │   ├── contact.js             Contact form handler (POST /contact)
│   │   ├── walkthroughs.js        Public + admin walkthrough CRUD
│   │   ├── jwt.js                 JWT sign/verify helpers
│   │   ├── kv.js                  KV helpers: getUser, getGallery, stripGallery, rate limiting
│   │   ├── crypto.js              SHA-256, password hash/verify
│   │   ├── utils.js               jsonResponse, authRequired, forbidden, escHtml
│   │   ├── brute-force.js         Login failure tracking + admin alert email
│   │   └── admin/
│   │       ├── galleries.js       Gallery CRUD (D1 + KV passphrase storage)
│   │       ├── users.js           User CRUD + role management
│   │       ├── projects.js        Project pipeline CRUD, notes, documents
│   │       ├── packages.js        Service packages + public proposals
│   │       ├── questionnaires.js  Questionnaire sets + project instances
│   │       ├── scheduling.js      Availability, blocked dates, schedule links, booking
│   │       ├── contracts.js       Contract templates + project contracts + countersign + public signing
│   │       ├── invoices.js        Invoice CRUD, send, Stripe checkout, webhook, portal invoices
│   │       └── automations.js     Automation settings + logs
│   │
│   ├── migrations/                D1 SQL migrations (numbered 001–015)
│   ├── tests/                     Vitest unit + integration + auth-boundary + migration-smoke tests
│   ├── vitest.config.js           95% coverage threshold on src/**/*.js
│   ├── deploy-worker.sh           Deploy to production
│   ├── deploy-worker-preprod.sh   Deploy to preprod (provisions KV + D1, runs all migrations)
│   └── .worker-config.example     Template: CF_ACCOUNT_ID, CF_API_TOKEN, CF_WORKER_NAME[_PREPROD]
│
└── tests/e2e/                     Playwright acceptance tests (static site + mocked Worker)
    ├── auth/register/gallery/portal-project/pipeline/proposal/contract/invoice/
    │   questionnaire/schedule/availability/automations/walkthroughs/contact/
    │   clients/nav/brute-force/webhook.spec.js
    └── scripts/check-route-coverage.js   Verifies every router.js route appears in a spec
```

---

## Worker Source Modules

### Route map (`worker/src/router.js`)

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| GET | `/auth/setup-status` | `handleAuthSetupStatus` | public |
| POST | `/auth/setup` | `handleAuthSetup` | public |
| POST | `/auth/register` | `handleAuthRegister` | public |
| POST | `/auth/login` | `handleAuthLogin` | public |
| POST | `/auth/google` | `handleAuthGoogle` | public |
| POST | `/auth/reset-request` | `handleAuthResetRequest` | public |
| POST | `/auth/reset-confirm` | `handleAuthResetConfirm` | public |
| GET | `/auth/me` | `handleAuthMe` | JWT |
| PATCH | `/auth/me` | `handleAuthUpdateMe` | JWT |
| GET | `/auth/verify` | `handleAuthVerify` | public |
| POST | `/auth/resend-verify` | `handleAuthResendVerify` | public |
| GET | `/proposals/:id` | `handlePublicProposal` | public |
| POST | `/proposals/:id/analytics` | `handlePublicProposalAnalytics` | public |
| POST | `/proposals/:id/select` | `handlePublicProposalSelect` | public |
| GET/POST | `/admin/galleries[/:id]` | `handleAdminList/Create/Update/DeleteGallery` | admin |
| GET/POST | `/admin/users[/:id]` | `handleAdminList/Create/Update/DeleteUser` | admin |
| PATCH | `/admin/users/:id/role` | `handleAdminUpdateUserRole` | admin |
| * | `/admin/packages[/:id]` | `handleAdminPackages/ById` | admin |
| * | `/admin/questionnaires[/:id]` | `handleAdminQuestionnaireSets/ById` | admin |
| * | `/admin/projects[/:id]` | `handleAdminProjects/ById` | admin |
| * | `/admin/projects/:id/notes` | `handleAdminProjectNotes` | admin |
| * | `/admin/projects/:id/documents` | `handleAdminProjectDocuments` | admin |
| * | `/admin/projects/:id/proposals` | `handleAdminProjectProposals` | admin |
| GET | `/portal/galleries` | `handlePortalGalleries` | JWT (KV user record required) |
| GET | `/portal/invoices` | `handlePortalInvoices` | JWT |
| GET | `/portal/contracts` | `handlePortalContracts` | JWT |
| GET/POST | `/portal/my-project` | `handlePortalMyProject` | JWT |
| * | `/admin/projects/:id/questionnaires` | `handleAdminProjectQuestionnaires` | admin |
| GET/POST | `/questionnaire/:id` | `handlePublicQuestionnaire` | public |
| POST | `/admin/projects/:id/portal-link` | `handleAdminProjectPortalLink` | admin |
| * | `/admin/projects/:id/messages` | `handleAdminProjectMessages` | admin |
| GET/POST | `/portal/project/:token` | `handlePublicProjectPortal` | public (portal token) |
| GET | `/public/availability` | `handlePublicAvailability` | public |
| GET/PUT | `/admin/availability` | `handleAdminAvailability` | admin |
| * | `/admin/blocked-dates[/:id]` | `handleAdminBlockedDates` | admin |
| * | `/admin/projects/:id/schedule-links` | `handleAdminProjectScheduleLinks` | admin |
| GET/POST | `/schedule/:id` | `handlePublicSchedule` | public |
| GET/PUT | `/admin/automations` | `handleAdminAutomations` | admin |
| GET | `/admin/automation-logs` | `handleAdminAutomationLogs` | admin |
| * | `/admin/contract-templates[/:id]` | `handleAdminContractTemplates/ById` | admin |
| * | `/admin/projects/:id/contracts` | `handleAdminProjectContracts` | admin |
| POST | `/admin/projects/:id/contracts/:cid/countersign` | `handleAdminProjectContractCountersign` | admin |
| GET | `/contracts/:token` | `handlePublicContractGet` | public |
| POST | `/contracts/:token/view` | `handlePublicContractView` | public |
| POST | `/contracts/:token/sign` | `handlePublicContractSign` | public |
| GET | `/contracts/:token/audit` | `handlePublicContractAudit` | public |
| GET | `/contracts/:token/archive` | `handlePublicContractArchive` | public |
| * | `/admin/projects/:id/invoices` | `handleAdminProjectInvoices` | admin |
| POST | `/admin/invoices/:id/send` | `handleAdminInvoiceSend` | admin |
| GET/PUT | `/admin/invoices/:id` | `handleAdminInvoice` | admin |
| POST | `/invoices/:id/checkout` | `handleInvoiceCheckout` | public |
| GET | `/invoices/:id` | `handlePublicInvoice` | public |
| POST | `/stripe/webhook` | `handleStripeWebhook` | Stripe sig |
| GET | `/public/walkthroughs` | `handlePublicWalkthroughs` | public |
| * | `/admin/walkthroughs[/:id]` | `handleAdminWalkthroughs/ById` | admin |
| POST | `/token` | `handleTokenExchange` | public (gallery token exchange) |
| POST | `/contact` | `handleContact` | public |
| * | `*` (fallthrough) | `handleNasProxy` | public (sid in query) |

---

## D1 Database Schema

Migrations in `worker/migrations/` — apply in order. Run against preprod before production.

| # | File | Tables / Changes |
|---|------|-----------------|
| 001 | `001_projects.sql` | `projects` (id, property, location, collection, client_name, client_email, stage, source, status, budget, event_date, shoot_date, portal_token) |
| 002 | `002_project_documents.sql` | `project_documents` (id, project_id, type, label, url, created_at) |
| 003 | `003_service_packages.sql` | `service_packages` (id, name, description, price_cents, features_json) |
| 004 | `004_proposals.sql` | `proposals` (id, project_id, token, packages_json, selected_package_id, viewed_at, selected_at) |
| 005 | `005_questionnaire_sets.sql` | `questionnaire_sets` (id, name, questions_json) |
| 006 | `006_questionnaire_instances.sql` | `questionnaire_instances` (id, project_id, set_id, token, answers_json, submitted_at) |
| 007 | `007_project_messages.sql` | `project_messages` (id, project_id, sender, content, created_at); `project_portal_tokens` |
| 008 | `008_scheduling.sql` | `availability_windows`, `blocked_dates`, `schedule_links` |
| 009 | `009_automations.sql` | `automation_settings` (6 seed rows), `automation_logs` |
| 010 | `010_contracts.sql` | `contracts` (id, project_id, title, body_html, signing_token, client_email, client_signed_at, admin_signed_at, status, UNIQUE(project_id,token)); `contract_templates` |
| 011 | `011_invoices.sql` | `invoices` (id, project_id, invoice_number, client_email, line_items_json, tax_cents, total_cents, stripe_session_id, paid_at, notes); `invoice_line_items` |
| 012 | `012_user_role_audit.sql` | `user_role_audit` (id, user_id, old_role, new_role, changed_by, changed_at) |
| 013 | `013_walkthroughs.sql` | `walkthroughs` (id, title, description, video_url, thumbnail_url, sort_order, published) |
| 014 | `014_contract_template_seeds.sql` | Default contract template seed rows |
| 015 | `015_contracts_r2_key.sql` | Adds `r2_key` column to `contracts` for signed contract PDF/HTML storage |

**Production DB:** `CTC_PROJECTS` | **Preprod DB:** `ctc-preprod`

Run migration manually:
```bash
wrangler d1 execute CTC_PROJECTS --file worker/migrations/NNN_description.sql
wrangler d1 execute ctc-preprod --env preprod --file worker/migrations/NNN_description.sql
```

---

## Gallery System

### URL hash config (base64-encoded JSON)
```js
{ id, proxyUrl, nasClientUrl, eventName, clientName, watermark }
```
Decoded: `JSON.parse(decodeURIComponent(escape(atob(hash))))`. Passphrase stays server-side in D1 — never in the URL.

### End-to-end flow
1. Admin creates Synology Photos share → copies passphrase → creates gallery in `galleries.html` (passphrase stored in D1).
2. Admin assigns gallery to client in `clients.html` → stored in KV user record (`user.galleries[]`).
3. Client logs in → portal calls `GET /portal/galleries` → returns gallery list from KV.
4. Client opens gallery → `gallery.html` decodes hash → embeds `client-gallery.html` in iframe.
5. `client-gallery.html` calls `POST /token` with `galleryId` → Worker looks up passphrase from D1, stores `tok:{uuid}→passphrase` in KV (4-hr TTL), returns `{sid}`.
6. All subsequent requests send `sid=<uuid>`. Worker resolves `sid→passphrase` from KV, loads `nas.coastaltravelcompany.com/mo/sharing/{passphrase}` for `sharing_sid` cookie (cached 2hr per isolate), forwards to `/mo/sharing/webapi/entry.cgi` with `Cookie: sharing_sid=...` + `X-SYNO-SHARING: {passphrase}`.
7. Gallery renders masonry grid; thumbnails/downloads proxy through Worker with `sid` in query string.

### Watermark mode
`watermark: true` → downloads hidden, CSS SVG tiled overlay applied client-side. Server-side XL thumbnail watermarking (via Synology) planned but not yet implemented (TODO item 1).

---

## Admin Workflow

### One-time setup
1. Copy `worker/.worker-config.example` → `worker/.worker-config`, fill in `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_WORKER_NAME`, `CF_WORKER_NAME_PREPROD`.
2. Run `./worker/deploy-worker.sh`.
3. Add Worker secrets in Cloudflare dashboard.
4. Stripe: add webhook endpoint `POST https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev/stripe/webhook` for `checkout.session.completed`.

### Creating and assigning a gallery
1. Synology Photos → album → ··· → Share → Enable → copy share link (contains passphrase).
2. `admin/galleries.html` → paste share link + event/client name → Save.
3. `admin/clients.html` → find client → expand → check gallery → Save Gallery Access.

### Preprod environments

| Resource | Production | Preprod |
|---|---|---|
| Pages branch | `master` | `preprod` |
| Site URL | `https://coastaltravelcompany.com` | `https://preprod.coastaltravelcompany.com` |
| Worker | `coastal-gallery-proxy` | `coastal-gallery-proxy-preprod` |
| KV namespace | `CTC_AUTH` | `CTC_AUTH_PREPROD` |
| D1 database | `CTC_PROJECTS` | `ctc-preprod` |
| Stripe | live key | `sk_test_...` |

**Deploy to preprod:** `./worker/deploy-worker-preprod.sh` or push to `preprod` branch.

### Promotion workflow (preprod → master)
1. Run preprod checklist (auth, gallery, watermark, contract signing, invoice/Stripe, scheduling, questionnaire).
2. PR: `preprod` → `master`. CI must pass.
3. Merge → auto-deploy. Run any new D1 migrations against production.

---

## Transactional Emails

All sent via Resend. **From:** `Coastal Travel Company <noreply@coastaltravelcompany.com>`. All sends are fire-and-forget (`.catch(() => {})`) **except** `/contact` (returns 502 on Resend failure) and contract-sent/countersign (use `await`, but failure doesn't block response).

| # | Subject | To | Trigger | Source file | Notes |
|---|---------|-----|---------|-------------|-------|
| 1 | `Verify your email` | Client | Self-registration | `auth.js:handleAuthRegister` | Token in KV `verify:{uuid}`, 24hr TTL; link → `/login.html?verify=` |
| 2 | `Verify your email` | Client | Resend verify button | `auth.js:handleAuthResendVerify` | Only sends if `verified===false`; always returns `{ok:true}` |
| 3 | `Reset your password` | Client | Forgot password | `auth.js:handleAuthResetRequest` | Token in KV `reset:{uuid}`, 1hr TTL; rate-limited 3/hr per email, 10/hr per IP |
| 4 | `Inquiry: {name} — {property}` | Admin | Contact form | `contact.js:handleContact` | Only non-fire-and-forget send; also creates D1 project row at stage `Inquiry` |
| 5 | `Your contract is ready to sign` | Client | Admin sends contract | `contracts.js:handleAdminProjectContracts` | Advances project to `Contract Sent`; creates document row |
| 6 | `Contract signed — {client} — {title}` | `thecoastaltravelcompany@gmail.com` (hardcoded) | Client signs | `contracts.js:handlePublicContractSign` | |
| 7 | `Your contract is fully executed` | Client | Admin countersigns | `contracts.js:handleAdminProjectContractCountersign` | Advances project to `Contract Signed` |
| 8 | `Invoice {number}` | Client | Admin sends invoice | `invoices.js:handleAdminInvoiceSend` | Styled HTML with line items, tax, total, notes, pay button |
| 9 | `Payment received — {number}` | Client | Stripe webhook | `invoices.js:handleStripeWebhook` | Only if `inv.client_email` set; advances project to `Retainer Paid` |
| 10 | `Payment received — {number} — {name}` | Admin (`CONTACT_TO`) | Stripe webhook | `invoices.js:handleStripeWebhook` | Sent parallel with #9 |
| 11 | `{questionnaire_set_name}` | Client | Admin sends questionnaire | `questionnaires.js:handleAdminProjectQuestionnaires` | |
| 12 | `Questionnaire submitted — {name}` | Admin (`CONTACT_TO`) | Client submits | `questionnaires.js:handlePublicQuestionnaire` | |
| 13 | `Schedule your {discovery call\|shoot date}` | Client | Admin creates schedule link | `scheduling.js:handleAdminProjectScheduleLinks` | |
| 14 | `Confirmed: {type}` | Client | Client books slot | `scheduling.js:handlePublicSchedule` | Attachment: `invite.ics`; if shoot, updates `projects.shoot_date` |
| 15 | `Confirmed: {type} — {name}` | `thecoastaltravelcompany@gmail.com` (hardcoded) | Client books slot | `scheduling.js:handlePublicSchedule` | Sent parallel with #14; same ICS attachment |
| 16 | `Your account has been updated` | Affected user | Admin changes role | `users.js:handleAdminUpdateUserRole` | Includes old/new role |
| 17 | `[Security] Failed admin login — {email}` | `thecoastaltravelcompany@gmail.com` (hardcoded `ALERT_TO`) | 3+ consecutive failed admin logins | `brute-force.js:sendAdminAlert` | Sent at 3 failures and again at 5; per-email lockout at 5 (15min), per-IP at 20 |
| 18 | `New portal message — {name}` | Admin (`CONTACT_TO`) | Client sends portal message | `portal.js:handlePublicProjectPortal` | |
| 19 | `New project inquiry — {name}` | Admin (`CONTACT_TO`) | Client self-submits inquiry from portal | `portal.js:handlePortalMyProject` | Creates D1 project at stage `Inquiry`, source `client-portal`; adds initial message row if included |

---

## Testing

### Overview

| Layer | Tool | Location | CI trigger |
|-------|------|----------|------------|
| Unit + integration + auth boundaries + migration smoke | Vitest | `worker/tests/` | Every PR + push to preprod/master |
| Migration smoke (separate job) | Vitest | `worker/tests/migration-smoke.test.js` | PRs touching `worker/migrations/**` |
| Playwright acceptance | Playwright | `tests/e2e/` | PRs to `master` only |

**Coverage threshold:** 95% lines/functions/branches/statements on `src/**/*.js` (enforced in CI via `worker/vitest.config.js`).

```bash
# Worker tests
cd worker && npm run test:unit      # all Vitest tests + coverage
npx vitest run                      # no coverage
npx vitest --reporter=verbose

# Playwright
npm test                            # headless Chromium
npm run test:headed
npm run test:ui
BASE_URL=http://localhost:9876 npm test
```

### Worker Unit Tests (`worker/tests/*.test.js` + `worker/tests/admin/*.test.js`)
Each file mirrors a source module. Mocking pattern:
- **KV:** in-memory `Map` with `get/put/delete`
- **D1:** `vi.fn()` stub with `prepare().bind().all/run/first()`
- **fetch:** `vi.stubGlobal('fetch', ...)` for NAS responses
- **env secrets:** set/omit to test 503 paths

### Worker Integration Tests (`worker/tests/integration/`)
Full request/response through `handleRequest()` — no handler imported directly; full middleware stack exercised.
- `integration/auth.test.js` — register → verify → login → `/auth/me` lifecycle
- `integration/crud.test.js` — project/package CRUD; gallery token exchange

**Integration helpers (`worker/tests/integration/helpers.js`):**
- `makeKv()` — in-memory KV with exposed `_store` Map
- `makeSqliteDb()` — in-memory SQLite with all migrations applied (via `better-sqlite3`)
- `makeD1(db)` — wraps SQLite in D1 async API shape
- `makeEnv(kv, d1)` — builds full env object
- `adminToken()` / `clientToken()` — signed JWTs
- `req(method, path, { token, body })` — Request with Origin + Authorization headers

### Auth Boundary Tests (`worker/tests/auth-boundaries.test.js`)
Authoritative record of which routes require which auth level.
- **Admin routes (36 × 3):** no auth → 401, client role → 403, bad JWT → 401 (auto-generated from `ADMIN_ROUTES` array)
- **Portal routes (2 × 2):** no auth → 401, bad JWT → 401
- **Public routes (26):** verified NOT to return 401
- **Origin enforcement (3):** missing Origin → 403, unknown origin → 403, OPTIONS with correct origin → 204
- **JWT tampering (3):** flipped sig → 401, elevated role → 401, expired → 401
- **Router cross-check (1):** reads `router.js` at runtime, counts `/admin/` paths, asserts `ADMIN_ROUTES.length >= count - 5` — fails if new admin route not added to `ADMIN_ROUTES`

### D1 Migration Smoke Tests (`worker/tests/migration-smoke.test.js`)
- All migrations apply without error
- All 20 expected tables exist
- Migration file count matches expectation
- Idempotent re-apply (no duplicate seed rows)
- `automation_settings` seeds 6 rows; `contracts` UNIQUE constraint enforced; `projects` has required columns

### Playwright Acceptance Tests (`tests/e2e/`)
Static site served on `localhost:9876`. Worker calls intercepted via `context.route()` — no live Worker needed.

**`mockWorker` pattern:**
```js
await mockWorker(context, {
  'GET /auth/me':         (route) => json(route, { id: 'u1', role: 'admin' }),
  'GET /admin/galleries': (route) => json(route, []),
});
```

CI: first retry saves video of failing tests; screenshots on failure; artifacts uploaded to GitHub Actions.

**Route coverage check:**
```bash
node tests/e2e/scripts/check-route-coverage.js
```
Parses `router.js`, verifies every path appears in a spec or the `ALLOWLIST` (each entry must have a reason comment). Run manually before PRs that add new routes.

### CI Workflows

| Workflow | Trigger | What runs |
|----------|---------|-----------|
| `worker-unit-tests.yml` | Every PR + pushes to preprod/master | `cd worker && npm run test:unit` (95% coverage) |
| `migration-smoke.yml` | `worker/migrations/**` changes | `npx vitest run tests/migration-smoke.test.js` |
| `acceptance-tests.yml` | PRs to `master` | Full Playwright suite |
| `validate-pr-to-master.yml` | PRs to `master` | Rejects if source branch ≠ `preprod` |
| `deploy-worker-preprod.yml` | Push to `preprod` | Deploy Worker to preprod |
| `deploy-prod.yml` / `create-pages-prod.yml` | Push to `master` | Deploy Worker + Pages to production |
| `run-migrations-prod.yml` | Manual (`workflow_dispatch`) | Run pending D1 migrations on production |

### When to add new tests

**New Worker route:**
1. Unit test in `worker/tests/[admin/]*.test.js` — cover happy path, 401/403, 503 (missing DB/KV), 400 validation.
2. Auth boundary — add to `ADMIN_ROUTES`, `PUBLIC_ROUTES`, or `PORTAL_ROUTES` in `auth-boundaries.test.js`.
3. Playwright reference — add at least one `mockWorker` entry for the path in an appropriate spec. Run `check-route-coverage.js`.

**New D1 migration:**
1. Create `worker/migrations/NNN_description.sql` (next sequential number).
2. Add new tables to `EXPECTED_TABLES` in `migration-smoke.test.js`.
3. Update `expect(files).toHaveLength(N)`.
4. If seeded data, add idempotency test (apply twice, verify no doubled rows).

**New frontend page:**
New `tests/e2e/<feature>.spec.js`. Minimum: unauthenticated redirect, key UI renders, primary action makes expected Worker call.

---

## Maintenance & Deployment

### Deploy Worker
```bash
./worker/deploy-worker.sh          # production
./worker/deploy-worker-preprod.sh  # preprod
```

### Deploy website
```bash
git add <files> && git commit -m "..." && git push   # master → auto-deploy in ~2min
```

### Troubleshoot gallery failure
1. **Tunnel down** → Cloudflare Zero Trust → Tunnels → check health → restart `cloudflared` in DSM.
2. **Passphrase invalid** (share deleted/disabled) → recreate Synology Photos share → update gallery in admin.
3. **Test token exchange:**
   ```bash
   curl -s -X POST https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev/token \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -H "Origin: https://coastaltravelcompany.com" \
     -d 'galleryId=YOUR_GALLERY_ID'
   # Should return {"sid":"..."}
   ```
4. **Test tunnel directly:**
   ```bash
   curl -si "https://nas.coastaltravelcompany.com/mo/sharing/YOUR_PASSPHRASE" | grep -i "set-cookie"
   # Should return sharing_sid cookie
   ```

### Domain renewal
Renew `coastaltravelcompany.com` at Name.com annually. No DNS changes needed.
