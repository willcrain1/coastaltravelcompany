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
- **Cookie consent:** `site/js/cookie-consent.js` — exposes `window.CTC_Consent.hasAnalytics()` and `hasMarketing()`; persists choice in `localStorage` under `ctc_cookie_consent`.

## Key Flows
- **Gallery:** `/token` (exchange) -> KV(sid:passphrase) -> NAS Proxy
- **Email:** Resend (Trigger: `worker/src/`)
- **Tests:** `worker/tests/` (Unit/Int), `tests/e2e/` (Playwright)

## Deployment
- Prod: `./worker/deploy-worker.sh`
- Preprod: `./worker/deploy-worker-preprod.sh`
