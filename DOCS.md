# Coastal Travel Company — Map

## Infrastructure
- Proxy: `coastal-gallery-proxy` (CF Worker)
- Static: `coastaltravelcompany.com` (CF Pages)
- Data: `CTC_PROJECTS` (D1), `CTC_AUTH` (KV)
- NAS: `nas.coastaltravelcompany.com` (CF Tunnel)

## Router (`worker/src/router.js`)
- Auth: `/auth/*`
- Portal: `/portal/*`
- Admin: `/admin/*`
- Public: `/proposals/*`, `/invoices/*`, `/contracts/*`, `/schedule/*`, `/questionnaire/*`
- Proxy: `/*` (fallthrough to `handleNasProxy`)

## D1 Schema
- Source: `worker/migrations/*.sql`
- DB: `CTC_PROJECTS`

## Key Flows
- **Gallery:** `/token` (exchange) -> KV(sid:passphrase) -> NAS Proxy
- **Email:** Resend (Trigger: `worker/src/`)
- **Tests:** `worker/tests/` (Unit/Int), `tests/e2e/` (Playwright)

## Deployment
- Prod: `./worker/deploy-worker.sh`
- Preprod: `./worker/deploy-worker-preprod.sh`
