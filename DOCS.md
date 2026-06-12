# Coastal Travel Company — Map

## Infrastructure
- Proxy: `coastal-gallery-proxy` (CF Worker)
- Static: `coastaltravelcompany.com` (CF Pages)
- Data: `CTC_PROJECTS` (D1), `CTC_AUTH` (KV)
- NAS: `nas.coastaltravelcompany.com` (CF Tunnel)
- DNS/registrar: registered at name.com, DNS managed/proxied through Cloudflare
- SEO: Google Search Console (https://search.google.com/search-console) verified for `coastaltravelcompany.com` via DNS TXT record on Cloudflare — used to monitor search queries, rankings, CTR, and indexing/crawl errors (item 32)
- Analytics: Cloudflare Web Analytics enabled for `coastaltravelcompany.com` (Cloudflare dashboard → Analytics → Web analytics) — Core Web Vitals, visits, page views, no cookies; complements the first-party `/admin/analytics.html` pipeline (item 32/46)

## Router (`worker/src/router.js`)
- Auth: `/auth/*`
- Portal: `/portal/*`
- Admin: `/admin/*` (includes `POST /admin/masquerade`, `POST /admin/masquerade/exit`)
- Public: `/proposals/*`, `/invoices/*`, `/contracts/*`, `/schedule/*`, `/questionnaire/*`
- Gallery favorites: `GET /gallery/:id/admin-stars` and `POST /gallery/:id/submit-selections` require any valid JWT **plus** gallery assignment (admin or `assignedUsers`); `PUT /gallery/:id/admin-stars/:photoId` is admin-only
- Stripe: `POST /stripe/webhook` — HMAC signature verified with constant-time compare and a 5-minute timestamp tolerance (replay protection)
- Proxy: `/*` (fallthrough to `handleNasProxy`)

## D1 Schema
- Source: `worker/migrations/*.sql`
- DB: `CTC_PROJECTS`
- `masquerade_log`: audit trail for admin masquerade sessions (016_masquerade_log.sql)

## Authentication Flow
- **Login/Google/Setup:** Worker sets `auth_token` as `HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800` cookie; response body also returns `{ token, user }` for Playwright/API clients during transition.
- **getAuth priority:** Authorization header first (masquerade, API clients), then `auth_token` cookie.
- **Sliding window:** `/auth/me` re-issues cookie on every authenticated call (non-masquerade).
- **Logout:** `POST /auth/logout` clears cookie via `Max-Age=0`.
- **Frontend:** All browser fetches use `credentials: 'include'`. No JWT in `localStorage`. Masquerade sessions still use explicit `Authorization: Bearer <masq_token>` header from `sessionStorage`.
- **CORS:** `Access-Control-Allow-Credentials: true` required; `Access-Control-Allow-Origin` must never be `*`.
- **Cookie consent:** `site/js/cookie-consent.js` — exposes `window.CTC_Consent.hasAnalytics()` and `hasMarketing()`; persists choice in `localStorage` under `ctc_cookie_consent`. Fires `window` `CustomEvent('ctc-consent-changed')` on save so dependent scripts can react live.
- **GA4:** `site/js/ga4.js` — loads Google Analytics (`G-CWYCF3H9YY`) only after `CTC_Consent.hasAnalytics()` is true (checked on load and on `ctc-consent-changed`); `anonymize_ip: true`. Wired via `<script src="js/ga4.js" defer></script>` (or `/js/ga4.js` on `invoice.html`) after `cookie-consent.js` on all 17 public/portal pages. Item 46: `site/js/analytics.js` additionally mirrors `conversion`/`click`/`scroll_depth`/`section_dwell` events into GA4 via `window.gtag` (no-op if `gtag` isn't loaded yet/consent not given) so a GA4 Exploration report can group `section_dwell` by `section_id`.
- **Microsoft Clarity:** `site/js/clarity.js` — loads Clarity (project `x3do0vxltp`) only after `CTC_Consent.hasAnalytics()` is true (checked on load and on `ctc-consent-changed`). Wired via `<script src="js/clarity.js" defer></script>` (or `/js/clarity.js` on `invoice.html`) after `cookie-consent.js` on all 17 public/portal pages.

## R2 Hybrid Asset Serving (item 37)
- **Bucket bindings:** `ASSETS` → `ctc-assets` (prod), `ctc-assets-preprod` (preprod) in `wrangler.toml`.
- **R2 key layout:** `galleries/{galleryId}/thumbs/{photoId}.jpg` (photo thumbnails); `galleries/{galleryId}/videos/{itemId}` (full video files, original quality).
- **Token exchange:** `tok:{sid}` now stores `{ passphrase, sharePassword, galleryId, r2Synced }`.
- **Thumbnail routing:** `handleNasProxy` checks R2 first when `r2Synced=true`; serves with `Cache-Control: public, max-age=86400` and `X-Asset-Source: r2`. Falls back to NAS with `X-Asset-Source: nas`.
- **Video routing:** `handleNasProxy` serves full videos from R2 (`galleries/{galleryId}/videos/{unitId}`) when present, with HTTP Range request support for in-browser seeking; falls back to streaming directly from the NAS (`Content-Type: video/*` is streamed, not buffered, to stay within Worker memory limits).
- **Sync endpoint:** `POST /admin/galleries/:id/sync-r2?offset=N` (admin-auth). Paginates via `offset`; syncs both photo thumbnails (`thumbs/`) and full video files (`videos/`, streamed directly via `vidRes.body` to avoid buffering); sets `gallery.r2_synced=true` in KV when `done=true`.
- **Sync script:** `worker/scripts/sync-gallery-to-r2.sh` — calls the Worker endpoint; loops over offset until `done`. Reads `ADMIN_JWT` and `WORKER_URL` from env.
- **GHA workflow:** `.github/workflows/sync-gallery-to-r2.yml` — manual dispatch, targets preprod or prod, single gallery or all.

## Security Invariants
- **Contract signatures:** `signature_type === 'drawn'` must be a `data:image/` URL — enforced at client sign, admin countersign, and again when rendering the executed-contract snapshot.
- **CMS zones:** plain text only — the Worker escapes `<`/`>` in zone values before committing, so the editor can never introduce markup into published pages. Zone insertion uses a function replacement so `$` characters in content are literal.

## Ocean UI Layer (frontend)
- `site/css/ocean.css` + `site/js/ocean.js`, loaded on the 5 public marketing pages (index, about, services, contact, collections) after `styles.css`/`main.js`.
- Scroll/pointer-reactive water theme: layered sine-wave canvases + bubbles in heroes (`.hero`, `.page-hero`, `[data-ocean-waves]`), pointer-tracking caustic light, hero photo drift/parallax (replaces CSS Ken Burns), wave dividers (`.ocean-divider` with `data-top`/`data-bottom` color names, SVG generated by JS, drift driven by time + scroll), scroll-depth teal tint, photo parallax + hover tilt/sheen, click ripples, liquid-fill buttons.
- One rAF loop; pointer/scroll state published as `--mx`/`--my`/`--sp` custom properties on `<html>`. Effects only attach when their targets exist, so the files are shared across pages.
- `prefers-reduced-motion: reduce` disables the engine entirely (`.ocean-on` class never added; site renders as before). Pointer effects gated on `pointer: fine`.
- CMS note: ocean markup never touches `data-content-id` zone elements — dividers are siblings, attributes added only to non-zone elements.

## Key Flows
- **Gallery:** `/token` (exchange) -> KV(sid:passphrase) -> NAS Proxy
- **Email:** Resend (Trigger: `worker/src/`)
- **Tests:** `worker/tests/` (Unit/Int), `tests/e2e/` (Playwright)

## Deployment
- Prod: `./worker/deploy-worker.sh`
- Preprod: `./worker/deploy-worker-preprod.sh`
