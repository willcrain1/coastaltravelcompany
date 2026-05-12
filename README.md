# Coastal Travel Company

Website and client photo gallery system for Coastal Travel Company.

## What's in this repo

| Path | Description |
|------|-------------|
| `index.html` + main pages | Public marketing website |
| `gallery/gallery.html` | Client gallery entry point — send this link to clients |
| `gallery/client-gallery.html` | Gallery UI (password lock, photo grid, lightbox, downloads) |
| `admin/gallery-admin.html` | Admin tool to create and manage gallery links |
| `worker/cloudflare-worker.js` | Cloudflare Worker — CORS proxy between the gallery and the NAS |
| `worker/deploy-worker.sh` | Script to deploy the Worker via the Cloudflare API |
| `DOCS.md` | Full system documentation (architecture, routing, setup, maintenance) |

## Quick links

| | URL |
|-|-----|
| Main site | https://coastaltravelcompany.com |
| Gallery admin | https://coastaltravelcompany.com/admin/gallery-admin.html |
| Worker | https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev |

## Deploying a Worker update

```bash
./worker/deploy-worker.sh
```

Requires `worker/.worker-config` (copy from `worker/.worker-config.example` and fill in credentials).

## Full documentation

See **[DOCS.md](DOCS.md)** for architecture, DNS routing, Cloudflare Tunnel setup, the gallery system flow, admin workflow, and troubleshooting.
