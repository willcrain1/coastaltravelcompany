# Coastal Travel Company — System Documentation

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Request Routing Map](#request-routing-map)
3. [Name.com](#namecom)
4. [Cloudflare](#cloudflare)
   - [DNS](#cloudflare-dns)
   - [Tunnel](#cloudflare-tunnel)
   - [Worker](#cloudflare-worker)
5. [GitHub Pages](#github-pages)
6. [Synology NAS](#synology-nas)
7. [File Structure](#file-structure)
8. [Gallery System — How It Works](#gallery-system--how-it-works)
9. [Admin Workflow](#admin-workflow)
10. [Maintenance & Deployment](#maintenance--deployment)
11. [Testing](#testing)
    - [Overview](#testing-overview)
    - [Worker Unit Tests](#worker-unit-tests)
    - [Worker Integration Tests](#worker-integration-tests)
    - [Auth Boundary Tests](#auth-boundary-tests)
    - [D1 Migration Smoke Tests](#d1-migration-smoke-tests)
    - [Playwright Acceptance Tests](#playwright-acceptance-tests)
    - [Route Coverage Enforcement](#route-coverage-enforcement)
    - [CI Workflows](#ci-workflows)
    - [Coverage Requirements](#coverage-requirements)
    - [When to Add New Tests](#when-to-add-new-tests)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         INTERNET                                │
│                                                                 │
│  coastaltravelcompany.com ──────────────► GitHub Pages          │
│  (main website, gallery pages)           (static host)         │
│                                                                 │
│  coastal-gallery-proxy.thecoastal        Cloudflare Worker      │
│  travelcompany.workers.dev  ──────────► (CORS proxy)           │
│                                              │                  │
│  nas.coastaltravelcompany.com ─────────► Cloudflare Tunnel     │
│  (NAS API / sharing sessions)               │                  │
└─────────────────────────────────────────────┼──────────────────┘
                                              │ encrypted tunnel
                                    ┌─────────▼──────────┐
                                    │  Local Network      │
                                    │  Synology NAS       │
                                    │  192.168.68.2:5001  │
                                    └─────────────────────┘
```

**Domain registrar:** Name.com
**DNS & proxy:** Cloudflare
**Static hosting:** GitHub Pages (willcrain1/coastaltravelcompany repo)
**NAS:** Synology DSM at 192.168.68.2 (local), exposed via Cloudflare Tunnel
**CORS proxy:** Cloudflare Worker (no server required)

---

## Request Routing Map

### Main website (`coastaltravelcompany.com/*`)
```
Browser → Cloudflare DNS → GitHub Pages → serves static HTML/CSS/JS
```
Cloudflare proxies this (orange cloud). GitHub Pages handles the actual file serving.

### NAS direct access (`nas.coastaltravelcompany.com`)
```
Browser / Worker → Cloudflare DNS → Cloudflare Tunnel daemon on NAS
                                  → https://192.168.68.2:5001 (Synology DSM)
```
Used for: Synology Photos sharing sessions, thumbnail and download requests routed through the Worker.

### Gallery CORS proxy (`coastal-gallery-proxy.thecoastaltravelcompany.workers.dev`)
```
Browser (gallery page) → Cloudflare Worker → nas.coastaltravelcompany.com
                                           → Synology Photos API
```
The Worker adds session cookies and the `X-SYNO-SHARING` header that Synology requires — headers the browser cannot set on cross-origin image/API requests.

### Synology QuickConnect (`coastaltravelcompany.us6.quickconnect.to`)
```
Browser only → Synology relay servers → NAS (via relay)
```
**Browser-only.** QuickConnect is a relay service provided by Synology for browser access. Server-to-server calls (e.g. from the Worker) return an HTML portal page, not API responses. The gallery system does not use QuickConnect.

---

## Name.com

Name.com is the **domain registrar** for `coastaltravelcompany.com`. It does not handle DNS — that is fully delegated to Cloudflare.

### What Name.com manages
- Domain registration and renewal
- Nameserver records (pointing to Cloudflare)

### Nameserver delegation
In the Name.com dashboard under DNS, the nameservers are set to Cloudflare's nameservers (something like `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`). Once delegated, **all DNS records are managed in Cloudflare** — changes in Name.com DNS will have no effect.

### What to do in Name.com
- Renew the domain annually
- Nothing else — do not add DNS records here

---

## Cloudflare

### Cloudflare DNS

All DNS for `coastaltravelcompany.com` is managed in the Cloudflare dashboard under the domain zone.

| Name | Type | Value | Proxied | Purpose |
|------|------|-------|---------|---------|
| `coastaltravelcompany.com` | A / CNAME | GitHub Pages | ✅ Yes | Main website |
| `www` | CNAME | `coastaltravelcompany.com` | ✅ Yes | www redirect |
| `nas` | CNAME | Tunnel hostname | ✅ Yes | NAS external access |

The `nas` record is created automatically by Cloudflare when the Tunnel is configured with a public hostname. **Do not change or delete it manually.**

The Cloudflare proxy (orange cloud) is enabled on all records. This means:
- Real server IPs are hidden from the public
- Cloudflare handles SSL termination (HTTPS)
- DDoS protection is active

### Cloudflare Tunnel

The Tunnel creates an encrypted outbound connection from the NAS to Cloudflare's network, making the NAS reachable externally without opening firewall ports.

**How it works:**
1. `cloudflared` daemon runs on the Synology NAS as a package
2. It maintains a persistent encrypted connection to Cloudflare's edge
3. Incoming requests to `nas.coastaltravelcompany.com` are routed through this tunnel to the NAS

**Tunnel configuration:**
- Public hostname: `nas.coastaltravelcompany.com`
- Backend: `https://192.168.68.2:5001`
- TLS verification: **disabled** (No TLS Verify = on) — required because the NAS uses a self-signed certificate internally

**To manage the Tunnel:**
Cloudflare dashboard → Zero Trust → Networks → Tunnels → select the tunnel

**If the tunnel goes down:**
- Check that the `cloudflared` package is running in DSM → Package Center
- Check the tunnel status in Cloudflare Zero Trust dashboard
- Restarting the package in DSM usually restores the connection

### Cloudflare Worker

The Worker (`coastal-gallery-proxy`) acts as a CORS proxy between the gallery page (hosted on `coastaltravelcompany.com`) and the Synology Photos API (on `nas.coastaltravelcompany.com`). Browsers block cross-origin API requests, so all gallery data fetches go through the Worker.

**Worker URL:** `https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev`

**What the Worker does on each request:**

1. **OPTIONS preflight** → returns CORS headers immediately (no NAS call)
2. **POST `/token` (token exchange — called once per gallery session):**
   - Receives `galleryId` from the browser
   - Looks up the gallery record in D1 to retrieve the passphrase
   - Validates the request originates from `coastaltravelcompany.com`
   - Issues a short-lived `sid` (UUID stored in KV with 4-hour TTL) and returns it to the browser
3. **POST (JSON API calls — photo list):**
   - Receives `sid` from the browser (never the passphrase)
   - Resolves `sid` → passphrase from KV
   - Loads `https://nas.coastaltravelcompany.com/mo/sharing/{passphrase}` to get a `sharing_sid` session cookie (cached per isolate for 2 hours)
   - Forwards the POST to `/mo/sharing/webapi/entry.cgi` with:
     - `Cookie: sharing_sid=...`
     - `X-SYNO-SHARING: {passphrase}` ← required by Synology to activate the session
   - Returns the JSON response with CORS headers
4. **GET (thumbnails, downloads):**
   - Receives `sid` from URL query string
   - Same passphrase resolution and session establishment as above
   - Forwards the GET to `/mo/sharing/webapi/entry.cgi?{original query string}`
   - Returns image data or file with CORS headers

**Why X-SYNO-SHARING is required:**
The Synology Photos sharing API requires this header in addition to the `sharing_sid` cookie. The `sharing_sid` alone (even obtained from the correct sharing page) returns error 119 (session not found). This header is what the real Synology Photos browser app sends, discovered by inspecting browser DevTools network requests.

**Session caching:**
The Worker caches `sharing_sid` per passphrase in memory for 2 hours per Worker isolate. Cloudflare may spin up new isolates over time, causing a fresh sharing page load — this is transparent and takes ~200ms.

**CORS configuration:**
The Worker only accepts requests from `https://coastaltravelcompany.com`. Requests from other origins are blocked.

**Worker source:** `worker/cloudflare-worker.js` (entry point); logic lives in `worker/src/`
**Required secrets** (set in Cloudflare dashboard → Worker → Settings → Variables):
- `JWT_SECRET` — signs auth tokens
- `RESEND_API_KEY` — transactional email
- `GOOGLE_CLIENT_ID` — OAuth login
- `STRIPE_SECRET_KEY` — invoicing
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook validation

---

## GitHub Pages

The main website and gallery pages are hosted on GitHub Pages from the repository `willcrain1/coastaltravelcompany`.

**Branch:** `master`
**Custom domain:** `coastaltravelcompany.com` (set in repo Settings → Pages, enforced by the `CNAME` file in the repo root)

GitHub Pages serves all static files directly. Any file in the repo is publicly accessible at its path:
- `index.html` → `coastaltravelcompany.com/`
- `gallery/gallery.html` → `coastaltravelcompany.com/gallery/gallery.html`
- `admin/gallery-admin.html` → `coastaltravelcompany.com/admin/gallery-admin.html`

**Deployment:** Automatic on every push to `master`. Changes are live within ~2 minutes.

**HTTPS:** Handled by Cloudflare (not GitHub Pages' own certificate). The Cloudflare proxy sits in front of GitHub Pages.

---

## Synology NAS

**Model:** Synology NAS running DSM 7.x
**Local address:** `192.168.68.2:5001`
**External address:** `nas.coastaltravelcompany.com` (via Cloudflare Tunnel)
**QuickConnect:** `coastaltravelcompany.us6.quickconnect.to` (browser admin access only)

### Synology Photos sharing

The gallery system uses Synology Photos' built-in sharing feature:
1. In Synology Photos, open an album → ··· menu → Share → create a share link
2. The share link contains a **passphrase** (e.g. `vCsa5XjJH`) — an 8-10 character token
3. The passphrase is what the Worker uses to establish a session and fetch photos

### Sharing API endpoints

| Endpoint | Purpose |
|----------|---------|
| `/mo/sharing/{passphrase}` | Sharing page — sets `sharing_sid` cookie |
| `/mo/sharing/webapi/entry.cgi` | Sharing API — requires `sharing_sid` + `X-SYNO-SHARING` header |
| `/webapi/entry.cgi` | General DSM API — requires admin auth (not used by gallery) |

### cloudflared package
The Cloudflare Tunnel daemon runs as a package on the NAS. It can be found in DSM → Package Center → Installed. It should be set to auto-start and should always be running for the gallery to work.

---

## File Structure

```
coastaltravelcompany/
│
├── CNAME                          GitHub Pages custom domain
├── .gitignore
├── DOCS.md                        This file
│
└── site/
    ├── index.html                 Main website — home page
    ├── about.html                 Main website — about
    ├── services.html              Main website — services
    ├── collections.html           Main website — collections
    ├── contact.html               Main website — contact
    ├── styles.css                 Main website styles (shared)
    ├── main.js                    Main website JavaScript
    ├── config.js                  Shared config (Worker URL, site URLs)
    │
    ├── login.html                 Client login (Google OAuth + password)
    ├── register.html              New client registration
    ├── portal.html                Client portal — galleries, invoices, projects
    ├── profile.html               Client profile / account settings
    │
    ├── contract.html              Contract signing page (client-facing)
    ├── invoice.html               Invoice payment page (client-facing)
    ├── proposal.html              Proposal view page (client-facing)
    ├── questionnaire.html         Questionnaire submission page (client-facing)
    ├── schedule.html              Availability / booking page (client-facing)
    ├── portal-project.html        Project detail page in client portal
    │
    ├── gallery/
    │   ├── gallery.html           Client-facing gallery entry point
    │   │                          Decodes URL hash, renders client-gallery.html
    │   │                          in a sandboxed iframe
    │   └── client-gallery.html    Full gallery UI — masonry photo grid,
    │                              lightbox, download — fetches photos via Worker
    │
    ├── admin/
    │   ├── admin.css              Admin shared styles
    │   ├── admin-shared.js        Admin shared JS (auth, nav)
    │   ├── clients.html           Manage client accounts, assign galleries
    │   ├── galleries.html         Create and manage galleries
    │   ├── pipeline.html          Project pipeline / CRM
    │   └── services.html          Manage service packages
    │
    └── worker/
        ├── cloudflare-worker.js   Worker entry point — deploy this to Cloudflare
        ├── src/                   Worker source modules
        │   ├── router.js          Request routing
        │   ├── auth.js            JWT auth middleware
        │   ├── gallery-proxy.js   Synology Photos CORS proxy + token exchange
        │   ├── portal.js          Client portal API endpoints
        │   ├── kv.js              KV helpers (sessions, rate limiting)
        │   └── admin/             Admin API endpoints
        ├── migrations/            D1 SQL migration files
        ├── deploy-worker.sh       Deploy to production
        ├── deploy-worker-preprod.sh Deploy to preprod
        └── .worker-config.example Template for deploy credentials
```

---

## Gallery System — How It Works

### End-to-end flow

```
1. Admin creates a Synology Photos share link
   └─► Synology Photos → album → share → copy link
       e.g. https://nas.coastaltravelcompany.com/mo/sharing/vCsa5XjJH
                                                              └── passphrase

2. Admin opens galleries.html, creates the gallery
   └─► Admin sets event name, client name, and pastes the share link
   └─► Gallery record is saved to D1 (passphrase stored server-side)
   └─► A config object is base64-encoded as the gallery's URL hash:
       {
         id: "<gallery-uuid>",
         nasClientUrl: "https://coastaltravelcompany.com/gallery/client-gallery.html",
         proxyUrl: "https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev",
         eventName: "...", clientName: "...", watermark: false
       }

3. Admin assigns the gallery to a client account
   └─► Admin → Clients page → find the client → expand → check the gallery checkbox
   └─► The gallery now appears in the client's portal automatically — no link to send

4. Client logs in to their portal
   └─► coastaltravelcompany.com/portal → sign in with Google or password
   └─► Portal fetches assigned galleries from the Worker (/portal/galleries)
   └─► Client clicks a gallery card to open it

5. gallery.html loads
   └─► JavaScript decodes the hash → config object
   └─► gallery.html embeds client-gallery.html in a full-screen iframe,
       passing the same hash: client-gallery.html#eyJ...

6. client-gallery.html loads inside the iframe
   └─► Decodes the hash → config
   └─► Gallery loads automatically — no password prompt

7. Gallery fetches photos via the Worker
   └─► POST /token with galleryId → Worker returns short-lived sid
   └─► POST to Worker: api=SYNO.Foto.Browse.Item, sid=<uuid>
   └─► Worker resolves sid → passphrase from KV
   └─► Worker loads nas.coastaltravelcompany.com/mo/sharing/{passphrase}
       → gets sharing_sid cookie
   └─► Worker POSTs to /mo/sharing/webapi/entry.cgi with:
       Cookie: sharing_sid=...
       X-SYNO-SHARING: {passphrase}
   └─► NAS returns photo list JSON
   └─► Worker returns JSON to gallery with CORS headers

8. Gallery renders photos
   └─► Masonry grid with lazy-loaded thumbnails
   └─► Each thumbnail: GET request to Worker with sid in query string
   └─► Worker proxies thumbnail image from NAS → browser
   └─► Client can click photos to open lightbox, download individually,
       or use Download All (up to 20 at once)
```

### Authentication

The client never enters a password to access a gallery. Authentication is handled entirely by the OAuth/login flow — the client logs in with Google or a password they set for their account, and the gallery opens automatically from their portal.

The gallery passphrase is generated by Synology Photos when the admin creates a share link. It is stored in the gallery's server-side config (D1) and never shown to the client. When the gallery page loads, it calls `POST /token` with the gallery ID; the Worker retrieves the passphrase from D1, verifies the request originates from `coastaltravelcompany.com` (via the `Origin` header — browsers enforce this and cannot spoof it via JS), and issues a short-lived `sid`. This ensures photo access can only be initiated through the website, not by direct API calls.

If no JWT is present in `localStorage`, the gallery page immediately redirects to `/login.html`. The portal calls `GET /portal/galleries` (authenticated) to return only the galleries assigned to that account.

### Config encoded in URL

The URL hash contains a base64-encoded JSON object. It is decoded client-side by:
```javascript
JSON.parse(decodeURIComponent(escape(atob(hash))))
```

The config now contains only non-sensitive routing and display fields:
```js
{
  id,           // gallery ID — used by the Worker to look up the passphrase server-side
  proxyUrl,     // Cloudflare Worker URL
  nasClientUrl, // URL of client-gallery.html
  eventName, clientName,
  watermark,    // bool — disables downloads and shows CSS watermark overlay
}
```

The passphrase and any credential material stay server-side. The URL hash is effectively a bookmark — it carries just enough info to render the page and identify which gallery to request a token for.

---

## Admin Workflow

### One-time setup

1. **Deploy the Cloudflare Worker**
   - Copy `worker/.worker-config.example` → `worker/.worker-config`
   - Fill in `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_WORKER_NAME`
   - Run `./worker/deploy-worker.sh`
   - Note the worker URL: `https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev`

2. **Add required Worker secrets** in the Cloudflare dashboard → Worker → Settings → Variables:
   - `JWT_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

### Creating a gallery and assigning it to a client

1. In Synology Photos, open the album → ··· → Share → Enable sharing → copy the share link
   - The share link contains a passphrase (e.g. `vCsa5XjJH`) — this is what the Worker uses
   - The NAS share URL will be under `nas.coastaltravelcompany.com`
2. Open `https://coastaltravelcompany.com/admin/galleries.html`
3. Paste the share link, fill in event name and client name
4. Save the gallery
5. Go to `https://coastaltravelcompany.com/admin/clients.html`
6. Find the client, expand their row, and check the gallery checkbox under **Gallery Access**
7. Click **Save Gallery Access** — the gallery now appears in the client's portal immediately

---

## Maintenance & Deployment

### Updating the Cloudflare Worker

Edit `worker/cloudflare-worker.js`, then:
```bash
./worker/deploy-worker.sh
```

Requires `worker/.worker-config` to be configured (see one-time setup above).

### Deploying website changes

Push to the `master` branch — GitHub Pages deploys automatically within ~2 minutes:
```bash
git add .
git commit -m "description of changes"
git push
```

### If the gallery stops working

1. **Check the Cloudflare Tunnel** — Cloudflare Zero Trust → Networks → Tunnels. If it shows as unhealthy, restart the `cloudflared` package in DSM → Package Center.

2. **Check the Synology Photos share** — the passphrase becomes invalid if the share is deleted or disabled in Synology Photos. Recreate the share, update the gallery record in the admin, and reassign it to the client.

3. **Test the token exchange:**
   ```bash
   curl -s -X POST https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev/token \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -H "Origin: https://coastaltravelcompany.com" \
     -d 'galleryId=YOUR_GALLERY_ID'
   ```
   Should return `{"sid":"..."}`. Use the returned sid to test photo fetching.

4. **Test the Tunnel directly:**
   ```bash
   curl -si "https://nas.coastaltravelcompany.com/mo/sharing/YOUR_PASSPHRASE" | grep -i "set-cookie"
   ```
   Should return a `sharing_sid` cookie.

### Renewing the domain

Renew `coastaltravelcompany.com` at Name.com before it expires. No DNS changes are needed — nameservers stay pointed at Cloudflare.

---

## Testing

### Testing Overview

There are four distinct test layers in this repository. Each has a different scope, toolchain, and CI trigger.

| Layer | Tool | Location | Runs in CI |
|---|---|---|---|
| Worker unit tests | Vitest | `worker/tests/` | Every PR and push to preprod/master |
| Worker integration tests | Vitest | `worker/tests/integration/` | Every PR and push to preprod/master |
| Auth boundary tests | Vitest | `worker/tests/auth-boundaries.test.js` | Every PR and push to preprod/master |
| D1 migration smoke tests | Vitest | `worker/tests/migration-smoke.test.js` | PRs that touch `worker/migrations/**` |
| Playwright acceptance tests | Playwright | `tests/e2e/` | PRs to `master` only |

All Vitest tests (unit, integration, auth boundaries, and migration smoke) are run by the same command — `cd worker && npm run test:unit` — and share the same 95% coverage threshold.

---

### Worker Unit Tests

**Location:** `worker/tests/*.test.js` and `worker/tests/admin/*.test.js`

**What they test:** Individual handler functions in isolation. Each file mirrors a source module under `worker/src/`:

| Test file | Source module |
|---|---|
| `auth.test.js` | `src/auth.js` |
| `constants.test.js` | `src/constants.js` |
| `contact.test.js` | `src/contact.js` |
| `crypto.test.js` | `src/crypto.js` |
| `gallery-proxy.test.js` | `src/gallery-proxy.js` |
| `jwt.test.js` | `src/jwt.js` |
| `kv.test.js` | `src/kv.js` |
| `portal.test.js` | `src/portal.js` |
| `router.test.js` | `src/router.js` |
| `utils.test.js` | `src/utils.js` |
| `walkthroughs.test.js` | `src/walkthroughs.js` |
| `admin/automations.test.js` | `src/admin/automations.js` |
| `admin/contracts.test.js` | `src/admin/contracts.js` |
| `admin/galleries.test.js` | `src/admin/galleries.js` |
| `admin/invoices.test.js` | `src/admin/invoices.js` |
| `admin/packages.test.js` | `src/admin/packages.js` |
| `admin/projects.test.js` | `src/admin/projects.js` |
| `admin/questionnaires.test.js` | `src/admin/questionnaires.js` |
| `admin/scheduling.test.js` | `src/admin/scheduling.js` |
| `admin/users.test.js` | `src/admin/users.js` |

**How dependencies are mocked:**

- **KV:** An in-memory `Map` wrapped with `get/put/delete` methods
- **D1:** A `vi.fn()` stub with `prepare().bind().all/run/first()` methods that return configurable results
- **`fetch` (outbound HTTP):** `vi.stubGlobal('fetch', ...)` used in gallery-proxy tests that simulate NAS responses
- **`env.RESEND_API_KEY` / `env.GOOGLE_CLIENT_ID`:** Set or omitted to test 503 error paths

**Running locally:**
```bash
cd worker
npm run test:unit          # run all tests with coverage report
npx vitest run             # run without coverage
npx vitest --reporter=verbose  # verbose per-test output
```

---

### Worker Integration Tests

**Location:** `worker/tests/integration/`

**What they test:** Full request/response cycles through `handleRequest()` (the router entry point). Unlike unit tests, no individual handler is imported — requests go through the complete middleware stack (CORS check → origin validation → auth → handler → response).

| Test file | Coverage |
|---|---|
| `integration/auth.test.js` | Full register → verify-email → login → `/auth/me` lifecycle; setup flow; duplicate registration; verify/token edge cases |
| `integration/crud.test.js` | Project and package CRUD through the router; DB route auth enforcement; gallery token exchange (`POST /token`) |

**Infrastructure helpers (`worker/tests/integration/helpers.js`):**

```js
makeKv()         // in-memory KV with an exposed _store Map for test inspection
makeSqliteDb()   // in-memory SQLite DB with all migrations applied (via better-sqlite3)
makeD1(db)       // wraps the SQLite DB in the D1 async API shape (prepare/bind/all/run/first)
makeEnv(kv, d1)  // builds the env object handed to every Worker handler
adminToken()     // creates a signed JWT with role:admin
clientToken()    // creates a signed JWT with role:client
req(method, path, { token, body })  // builds a Request with Origin + Authorization headers
SECRET           // the JWT secret used in tests
ORIGIN           // 'https://coastaltravelcompany.com'
```

The `better-sqlite3` package provides a synchronous SQLite engine for Node.js. All 13 D1 migration files are applied to the in-memory DB at construction time, so integration tests run against the real schema.

---

### Auth Boundary Tests

**Location:** `worker/tests/auth-boundaries.test.js`

**What they test:** Systematic security enforcement across every route. This file is the authoritative record of which routes require which level of auth.

**Admin routes (36 routes × 3 checks = 108 tests):**
Every route in the `ADMIN_ROUTES` array is checked for:
1. **No auth → 401** — request with no `Authorization` header
2. **Client role → 403** — valid JWT but `role: 'client'`
3. **Tampered JWT → 401** — JWT signed with the wrong secret

**Portal routes (2 routes × 2 checks = 4 tests):**
1. **No auth → 401**
2. **Tampered JWT → 401**

**Public routes (26 routes, 1 check each):**
Every route that requires no auth is verified to NOT return 401. The routes are exercised with a full env (KV + D1) so that handlers that unconditionally access `env.DB` don't crash.

**Origin enforcement (3 tests):**
- Missing `Origin` header → 403
- Unknown origin → 403
- Correct origin on OPTIONS preflight → 204

**JWT tampering (3 tests):**
- Signature character flipped → 401
- Payload modified to elevate role → 401
- Expired token → 401

**Portal client access (2 tests):**
- `GET /portal/galleries` with valid client JWT and matching KV record → 200
- Same request with no KV record for the user → 401

**Router cross-check (1 test):**
Reads `router.js` at test time and counts the number of distinct `/admin/` path definitions. Asserts that `ADMIN_ROUTES.length >= definedAdminPaths.size - 5` (tolerance for regex-only paths). If a new admin route is added to `router.js` without being added to `ADMIN_ROUTES`, this test fails.

---

### D1 Migration Smoke Tests

**Location:** `worker/tests/migration-smoke.test.js`

**What they test:** That the SQL migration files are correct, sequential, and idempotent.

| Test | What it checks |
|---|---|
| All migrations apply without throwing | No syntax errors in any `.sql` file |
| All 20 expected tables exist | Schema matches the `EXPECTED_TABLES` list |
| Covers all 13 migration files | No migration file was added without updating the count |
| Idempotent re-apply | Running all migrations twice does not throw |
| `automation_settings` seeds 6 rows | Default automation configuration is correct |
| No duplicate seeds | Re-applying migrations does not double-insert seed rows |
| `projects` has required columns | Schema has `status`, `budget`, `event_date` columns |
| `contracts` UNIQUE constraint | `(project_id, token)` is enforced |

The test uses `better-sqlite3` to apply all files in `worker/migrations/` to an in-memory database.

**When these tests run in CI:** Only when files in `worker/migrations/**` change (or when `worker/tests/migration-smoke.test.js` itself changes). This keeps CI fast for non-migration PRs.

---

### Playwright Acceptance Tests

**Location:** `tests/e2e/*.spec.js`

**What they test:** End-to-end user journeys in a real browser (Chromium). The static site is served locally on `localhost:9876` by `http-server`. All Worker API calls are intercepted by Playwright's `context.route()` and fulfilled with mock responses — no real Worker or network is required.

| Spec file | Feature area |
|---|---|
| `auth.spec.js` | Login page, portal redirect, admin redirect, Google OAuth stub |
| `register.spec.js` | Registration form, email verification, password reset flow |
| `gallery.spec.js` | Gallery lock screen, photo grid, token exchange |
| `portal-project.spec.js` | Client portal project detail page |
| `pipeline.spec.js` | Admin pipeline/CRM board |
| `proposal.spec.js` | Public proposal page |
| `contract.spec.js` | Contract signing flow |
| `invoice.spec.js` | Invoice payment page |
| `questionnaire.spec.js` | Questionnaire submission |
| `schedule.spec.js` | Public scheduling/booking page |
| `availability.spec.js` | Admin availability settings |
| `automations.spec.js` | Admin automation settings panel |
| `walkthroughs.spec.js` | Admin walkthrough CRUD and public walkthroughs page |
| `contact.spec.js` | Contact form |

**The `mockWorker` helper pattern:**

Each spec file uses a shared `mockWorker(context, handlers)` function that intercepts requests to `WORKER_URL` and dispatches them to per-endpoint handler callbacks:

```js
await mockWorker(context, {
  'GET /auth/me':          (route) => json(route, { id: 'u1', role: 'admin' }),
  'GET /admin/galleries':  (route) => json(route, []),
});
```

This means acceptance tests are not coupled to the live Worker — they test only the frontend behavior and can run in CI without Worker deployment.

**Running locally:**
```bash
npm test                   # headless Chromium, list reporter
npm run test:headed        # headed browser (watch what's happening)
npm run test:ui            # Playwright interactive UI mode

BASE_URL=http://localhost:9876 npm test   # use an already-running server
```

**CI behavior:** On first retry (CI only), Playwright saves a video of failing tests. Screenshots are captured on failure. Reports are uploaded as GitHub Actions artifacts.

---

### Route Coverage Enforcement

**Location:** `tests/e2e/scripts/check-route-coverage.js`

**What it does:** Parses `worker/src/router.js` to extract every route pattern, then verifies each one is referenced in at least one Playwright spec file or is in the explicit allowlist.

**Running it:**
```bash
node tests/e2e/scripts/check-route-coverage.js
```

Output example:
```
Route coverage: 24/24 routes referenced in e2e specs

All routes are covered. ✓
```

**How coverage is determined:** The script checks whether the route's path (or its static prefix before `/:id`) appears anywhere in any spec file. This catches direct string references like `'/admin/galleries'` as well as template literals like `` `/admin/projects/${id}` ``.

**The ALLOWLIST:** Routes excluded from the spec-file requirement have an entry in `ALLOWLIST` inside the script, with a comment explaining why (e.g. "tested via Stripe CLI trigger in preprod, not via Playwright page interaction"). Every ALLOWLIST entry must have a reason.

**Note:** This script is not currently wired into CI and must be run manually. It is intended as a development tool — run it before opening a PR that adds new routes.

---

### CI Workflows

| Workflow file | Trigger | What runs |
|---|---|---|
| `worker-unit-tests.yml` | Every PR; pushes to `preprod` and `master` | `cd worker && npm run test:unit` — all Vitest tests with 95% coverage check |
| `migration-smoke.yml` | PRs or pushes that touch `worker/migrations/**` | `npx vitest run tests/migration-smoke.test.js` |
| `acceptance-tests.yml` | PRs to `master` only | `npm test` — full Playwright suite against static site |
| `validate-pr-to-master.yml` | PRs to `master` | Rejects if source branch is not `preprod` |
| `deploy-worker-preprod.yml` | Pushes to `preprod` | Deploys Worker to preprod environment |
| `deploy-prod.yml` / `create-pages-prod.yml` | Pushes to `master` | Deploys Worker and GitHub Pages to production |
| `run-migrations-prod.yml` | Manual (`workflow_dispatch`) | Runs pending D1 migrations against production database |

**Key point:** Acceptance tests only run on PRs to `master`, not on every PR. This is intentional — they require a full browser environment and take ~5 minutes. Worker unit tests run on every PR so regressions are caught early.

---

### Coverage Requirements

The Vitest coverage threshold is configured in `worker/vitest.config.js` and enforced in CI:

```
lines:      95%
functions:  95%
branches:   95%
statements: 95%
```

If any metric falls below 95%, `npm run test:unit` exits non-zero and the CI job fails. Coverage is measured only over `src/**/*.js` (the Worker source) — test helpers and migration files are excluded.

There is no numeric coverage requirement for Playwright acceptance tests. Coverage there is enforced structurally: the `check-route-coverage.js` script verifies that every route defined in `router.js` is referenced in at least one spec.

---

### When to Add New Tests

#### Adding a new Worker API route

1. **Unit test** — create or extend a test file in `worker/tests/` (or `worker/tests/admin/` for admin handlers) that imports and calls the handler function directly. Cover the happy path, auth failure (401/403), missing `DB`/`KV` (503), and any validation errors (400).

2. **Auth boundary** — update `worker/tests/auth-boundaries.test.js`:
   - If the route is admin-only: add it to the `ADMIN_ROUTES` array. The three auth checks (no auth → 401, client → 403, bad JWT → 401) are generated automatically from that array.
   - If the route is public (no auth required): add it to the `PUBLIC_ROUTES` array in the `public routes do not require auth` describe block.
   - If the route is portal-accessible (any authenticated user): add it to `PORTAL_ROUTES`.
   - If the route is a new admin route, the `router cross-check` test will detect the count discrepancy and fail if you forget this step.

3. **Playwright reference** — add at least one reference to the route path in an appropriate spec file under `tests/e2e/`. This can be as simple as a `mockWorker` entry like `'POST /admin/new-feature': (r) => json(r, {})` inside an existing spec that exercises the surrounding UI. Run `node tests/e2e/scripts/check-route-coverage.js` to verify the route is covered before opening a PR.

#### Adding a new D1 migration

1. Create `worker/migrations/NNN_description.sql` with the next sequential number.
2. Update `EXPECTED_TABLES` in `worker/tests/migration-smoke.test.js` to include any new tables.
3. Update the migration file count assertion: `expect(files).toHaveLength(N)` where `N` is the new total.
4. If the migration includes seed data (e.g. `INSERT OR IGNORE`), add a test that applies all migrations twice and verifies the row count is not doubled.

#### Adding a new frontend page

Add a new Playwright spec file in `tests/e2e/<feature>.spec.js`. At minimum, test:
- Unauthenticated access redirects to `/login.html` (for protected pages)
- The page renders its key UI elements for an authenticated user
- Any primary user action (form submission, button click) makes the expected Worker API call and handles success and error responses
