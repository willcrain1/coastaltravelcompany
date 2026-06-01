# Changelog

Completed features and improvements, in order of implementation.

---

### 29 — Fix Auth Method Display in Admin Clients Page

The "Auth Method" pill in the admin clients panel incorrectly labeled any user without a password hash as "Google Only" — including accounts created by an admin with no password set and no Google login on record.

**Root cause:** `stripSensitive` in `worker/src/kv.js` only emitted `hasPassword` (derived from `passwordHash`). No field tracked whether the user had ever authenticated via Google, so the UI had no way to distinguish "Google Only" from "No auth set."

**Fix:**
- `worker/src/auth.js` — `handleAuthGoogle` now sets `googleLinked: true` on the user record whenever a Google sign-in succeeds (both on new-user creation and on subsequent logins). The flag persists in KV alongside the user object.
- `worker/src/kv.js` — `stripSensitive` now includes `hasGoogle: !!u.googleLinked` in the sanitized user shape returned to admin endpoints.
- `site/admin/clients.html` — auth label/class logic updated to handle all four states:
  - **Password + Google** → `auth-both` pill (teal) when both `hasPassword` and `hasGoogle`
  - **Password** → `auth-password` pill (dim) when only `hasPassword`
  - **Google Only** → `auth-google` pill (blue) when only `hasGoogle`
  - **No Auth Set** → `auth-none` pill (red) when neither — e.g. admin-created accounts with no password and no Google login yet
  - Unverified password accounts retain the `(unverified)` suffix.
- `site/admin/admin.css` — added `.ud-pill.auth-none` style (red tint) for the new "No Auth Set" state.

---

### 36 — Resolve npm Dependency Vulnerabilities in Worker

Upgraded wrangler 3.75.0 → 4.95.0, pulling in a patched miniflare that eliminates the `undici` CRLF injection (high: GHSA-4992-7rv2-5pvq) and `ws` uninitialized memory disclosure (moderate: GHSA-58qx-3vcg-4xpx). vitest stays at 2.1.9 to avoid a breaking change in coverage counting from the 4.x major bump. Added unit tests as part of the upgrade: full masquerade start/exit coverage (`worker/tests/admin/masquerade.test.js`), cookie auth tests for `getAuth`/`makeAuthCookie`/`clearAuthCookie` in `jwt.test.js`, and `handleAuthLogout`/Set-Cookie assertions in `auth.test.js`. Result: 885/885 tests pass, 98.9% statement coverage (all thresholds ≥95%).

---

### 49 — Cookie Consent & HttpOnly Auth Cookie

**Cookie consent banner:** `site/js/cookie-consent.js` — lightweight first-party consent manager included in `<head>` of every public page. On first visit (or after 12 months) shows a fixed-bottom banner with "Accept All", "Essential Only", and "Manage Preferences" options. Preferences persisted in `localStorage` under `ctc_cookie_consent`. Exposes `window.CTC_Consent.hasAnalytics()` and `window.CTC_Consent.hasMarketing()` for gating GA4/Clarity scripts.

**HttpOnly auth cookie:** Auth tokens migrated from `localStorage` to a server-set `HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800` cookie. `POST /auth/login`, `POST /auth/google`, and `POST /auth/setup` all set the `auth_token` cookie in the response. `getAuth()` checks the `Authorization` header first (for masquerade sessions and Playwright/API clients), then falls back to the cookie. `/auth/me` implements a sliding session window by re-issuing the cookie on every authenticated call. `POST /auth/logout` clears the cookie with `Max-Age=0`. All browser `fetch` calls updated to use `credentials: 'include'`; `Authorization` header injection removed from frontend helpers. CORS updated with `Access-Control-Allow-Credentials: true`.

**Files changed:** `worker/src/jwt.js`, `worker/src/auth.js`, `worker/src/constants.js`, `worker/src/router.js`, `site/js/cookie-consent.js` (new), `site/admin/admin-shared.js`, `site/login.html`, `site/portal.html`, `site/portal-project.html`, `site/profile.html`, all public `site/*.html` pages.

---

### 50 — Admin Masquerade (View as Client)
Admins can impersonate any client account from `clients.html` and see the portal exactly as that client sees it. "View as Client" button calls `POST /admin/masquerade` (admin-auth required), which issues a short-lived (30-minute) masquerade JWT scoped to the target user's identity. The masquerade JWT is stored in `sessionStorage` and used for all portal API calls. A persistent amber banner on `portal.html` shows the client name and a one-click "Exit Masquerade" link that calls `POST /admin/masquerade/exit`, clears the session, and returns the admin to `clients.html`. Mutating actions (POST/PATCH/PUT/DELETE) are blocked at the Worker router level for any masquerade token, returning 403. Masquerade is non-recursive and cannot target admin accounts. Every session start and exit is written to the `masquerade_log` D1 table (`016_masquerade_log.sql`).

---

## 2026

### P0 — Fix & Expand Acceptance Tests
All Playwright acceptance tests pass with full coverage: contact form, gallery auth flow, admin panel auth, client portal, and lead pipeline. Tests run reliably in CI with no flaky waits.

---

### 0 — Capture Live NAS Configuration
Documented `cloudflared` container setup and tunnel ingress in `nas/cloudflare-tunnel/config.example.yml` and `nas/README.md`. Single route: `nas.coastaltravelcompany.com` → `https://192.168.68.2:5001`.

---

### 1 — Functional Contact Form
Worker `POST /contact` → Resend → `thecoastaltravelcompany@gmail.com`. Reply-to set to submitter's email; rate-limited 5/hour per IP.

---

### 2 — Real Watermarking
Server-side watermarking via `@cf-wasm/photon` (WASM) in the Cloudflare Worker. Tiled "© Coastal Travel Company" text composited over XL thumbnails and all downloads. Worker converted to ES modules; deployed via `wrangler deploy`.

---

### 3 — Synology-Level Album Password Protection
Gallery password set in the admin tool is enforced at the Synology Photos share level via API. Passphrase management is transparent to the end user.

---

### 4 — OAuth Login & Per-User Gallery Access
Full auth system: email/password + Google Sign-In, email verification, password reset, 7-day JWTs stored in `localStorage`. Client portal shows only assigned galleries. User management (create, assign galleries, reset password, delete) in admin panel. Users and assignments in D1; session state in KV (`CTC_AUTH`).

---

### 6 — Document Signing & Contracts
Contract template builder with merge fields (`{{client_name}}`, `{{shoot_date}}`, etc.) and three default per-collection templates. Admin sends contracts from the pipeline; clients sign via unique URL with type/draw/upload signature options. Admin countersigns; both parties receive fully-executed copies with download links. Full audit trail (timestamp, IP, user-agent, SHA-256 body hash) per signing event. Signed contracts archived in Cloudflare R2 (`contracts/{id}/signed.html`).

*Deferred: Dropbox Sign API evaluation as an alternative.*

---

### 7 — Billing & Invoicing
Invoice creation with line items, tax, and due date. Branded client-facing invoice page (`/invoice.html`) with Stripe Checkout payment flow. Stripe webhook marks invoice paid and advances project stage to "Retainer Paid". Invoice history in client portal.

*Remaining setup: Stripe account, Worker secrets, webhook registration, D1 migration — see Configuration & Setup in TODO.*

---

### 8 — Video Support in Client Gallery
Video items included alongside photos in client galleries. Play-icon badge overlay on video cards; HTML `<video>` element in lightbox with pause/clear on nav or close. Video download via `SYNO.Foto.Download` with correct extension. `ReadableStream` passthrough for large files; `Range` headers forwarded for seeking.

---

### 9 — Availability Calendar
`GET /public/availability` Worker endpoint reads `availability_windows` and `blocked_dates` from D1. 3-month rolling calendar on `contact.html` with teal (available) / linen (unavailable) day coloring. Graceful fallback to Mon–Fri if Worker is unreachable.

---

### 10 — Preprod Environment
Full staging environment: `preprod` branch, Cloudflare Pages subdomain (`preprod.coastaltravelcompany.com`), isolated Worker (`coastal-gallery-proxy-preprod`), separate KV (`CTC_AUTH_PREPROD`), D1 (`ctc-preprod`), and R2 (`ctc-assets-preprod`). GitHub Actions CI/CD on push to `preprod`. Branch protection rule on `preprod`. Admin environment switcher in `admin/galleries.html`.

*Remaining: Register preprod Stripe webhook — see Configuration & Setup in TODO.*

---

### 33 — Admin User Role Management
Role toggle (client ↔ admin) per user row in admin panel. Worker `PATCH /admin/users/:userId/role` endpoint with self-demotion guard. Audit log entry in D1 (`012_user_role_audit.sql`). Email notification to affected user via Resend on role change.

---

### 34 — Migrate Production Hosting to Cloudflare Pages
Production static site moved from GitHub Pages to Cloudflare Pages on the `master` branch. Custom domains configured (`coastaltravelcompany.com`, `www`). Removed `CNAME` file from `site/`. CI `deploy-site` job using `wrangler pages deploy`; acceptance tests run after deploy.

---

### 35 — Fix Mobile Menu Focus on Scroll
Mobile nav overlay fixed: body scroll-lock on open, `openMobileMenu()` / `closeMobileMenu()` helpers, hamburger → X CSS animation. Root cause (`backdrop-filter: blur` on `nav.scrolled` creating a containing block that clipped the fixed overlay) resolved by clearing backdrop-filter while the menu is open.

---

### 41 — Expand Automated Test Coverage
- **Integration tests** (`worker/tests/integration/`) using `better-sqlite3` as in-memory D1 adapter — real Worker handlers, real schema, no mocks. Covers full auth flow, gallery proxy, and D1 CRUD paths for projects, packages, and tokens.
- **Migration smoke tests** (`worker/tests/migration-smoke.test.js`) — applies all migrations against fresh SQLite, asserts 20 expected tables, verifies idempotency.
- **Auth boundary tests** (`worker/tests/auth-boundaries.test.js`) — 777 tests covering every route's 401/403 rejection behavior, JWT tampering, and cross-check against `router.js`.
- All run in CI at ≥95% coverage via `worker-unit-tests.yml`.

---

### 43 (partial) — Close e2e Coverage Gaps
Completed sub-items (remaining gaps tracked in TODO item 43):
- **Google OAuth login** — Playwright stub via `context.route()`; asserts JWT stored and redirect to `/portal.html`; failed credential test asserts error without redirect.
- **Walkthrough CRUD** — admin panel list, create, delete; public page card grid and empty state; modal opens on card click.
- **Automation settings** — all rows render with correct count; enabled/disabled state persists after reload via stateful mock.
- **Router-based coverage enforcement** — `tests/e2e/scripts/check-route-coverage.js` parses `router.js` routes and cross-checks all spec files; runs as a CI step before the Playwright suite.

---

### 44 — Brute-Force Attack Protection
Per-email and per-IP rate limiting on `POST /auth/login` (5 email / 20 IP failures → 15-min lockout), `POST /auth/reset-request` (3/hour per email, 10/hour per IP), and gallery unlock `POST /token` (10 wrong passphrases → 10-min IP block). Admin accounts locked after 3 failures with email alert to `thecoastaltravelcompany@gmail.com`; require password reset to unlock. Generic error messages prevent account enumeration.

---

### 45 — Windows 11 Splatting Workstation Setup Script
`workstation/splatting/setup-windows.ps1`: installs CUDA-enabled COLMAP, ffmpeg, Node.js, Miniconda + nerfstudio (splatfacto) via winget. Preflight checks for NVIDIA driver, winget, and disk space. Creates `CTC-Splatting\` working directory (incoming, frames, colmap_out, outputs, export, done).

`workstation/splatting/process-scene.ps1`: full per-scene pipeline wrapper — ffmpeg frame extraction → `ns-process-data` (COLMAP) → `ns-train splatfacto` → `ns-export gaussian-splat` → opens export folder and SuperSplat in browser with copy-to-NAS instructions.

---

### 37 — R2 Hybrid Data Load for Gallery Thumbnails & Videos

Gallery thumbnails and videos are now served from Cloudflare R2 instead of the NAS, reducing NAS load and enabling global CDN caching. NAS remains the primary archive; R2 is a transparent cache layer.

**Sync — `worker/src/admin/r2-sync.js` + `POST /admin/galleries/:id/sync-r2`**
Admin-authenticated endpoint that paginates through a gallery's Synology Photos album in batches of 20. For each item it uploads the `xl` thumbnail to `galleries/{id}/thumbs/{photoId}.jpg`. For video items it also streams the original file (via `SYNO.Foto.Download`) directly to `galleries/{id}/videos/{itemId}` using `ReadableStream` → R2 `put()` to avoid buffering large files in Worker memory. Sets `gallery.r2_synced = true` in KV when all pages complete.

**Auto-sync on creation — `site/admin/galleries.html`**
After a gallery is saved the admin page automatically drives the paginated sync loop and shows live progress ("Syncing… N / total") in the result box. No separate manual step required.

**Resync button — `site/admin/galleries.html`**
Each gallery row in the admin list has a **Resync R2** button. Clicking it re-runs the full sync (overwriting existing R2 keys), shows live progress on the button itself, and toasts on completion with a photo/video count. A **CDN ✓** badge appears in the row meta when `r2_synced` is true.

**Worker routing — `worker/src/gallery-proxy.js`**
- `SYNO.Foto.Thumbnail` GET on r2-synced galleries: checks `galleries/{id}/thumbs/{photoId}.jpg` in R2 first; serves with `Cache-Control: public, max-age=86400` and `X-Asset-Source: r2`. Falls back to NAS on miss.
- `SYNO.Foto.Download` GET (video playback/download): checks `galleries/{id}/videos/{unitId}` in R2; serves with full HTTP Range request support (206 partial content) for video seeking. Falls back to NAS transparently. No flag check required — a key miss is fast.

**Session token** — `tok:{sid}` now stores `galleryId` and `r2Synced` so the proxy avoids an extra KV lookup per thumbnail request.

**GitHub Actions workflow** — `.github/workflows/sync-gallery-to-r2.yml` manual-dispatch workflow for re-syncing existing galleries; accepts gallery ID (or blank for all) and target environment (preprod / prod). Shell script `worker/scripts/sync-gallery-to-r2.sh` drives the pagination loop.
