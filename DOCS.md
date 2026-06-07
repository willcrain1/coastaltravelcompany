# Coastal Travel Company — Map

## Infrastructure
- Proxy: `coastal-gallery-proxy` (CF Worker)
- Static: `coastaltravelcompany.com` (CF Pages)
- Data: `CTC_PROJECTS` (D1), `CTC_AUTH` (KV)
- NAS: `nas.coastaltravelcompany.com` (CF Tunnel)

## Router (`worker/src/router.js`)
- Auth: `/auth/*`
- Portal: `/portal/*`
- Admin: `/admin/*` (includes `POST /admin/masquerade`, `POST /admin/masquerade/exit`)
- Public: `/proposals/*`, `/invoices/*`, `/contracts/*`, `/schedule/*`, `/questionnaire/*`
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

## Key Flows
- **Gallery:** `/token` (exchange) -> KV(sid:passphrase) -> NAS Proxy
- **Email:** Resend (Trigger: `worker/src/`)
- **Tests:** `worker/tests/` (Unit/Int), `tests/e2e/` (Playwright)

## Deployment
- Prod: `./worker/deploy-worker.sh`
- Preprod: `./worker/deploy-worker-preprod.sh`
