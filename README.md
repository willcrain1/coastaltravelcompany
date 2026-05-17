# Coastal Travel Company

Website and client photo gallery system for Coastal Travel Company.

## What's in this repo

| Path | Description |
|------|-------------|
| `site/` | Everything deployed to GitHub Pages |
| `site/index.html` + main pages | Public marketing website |
| `site/gallery/gallery.html` | Client gallery entry point — send this link to clients |
| `site/gallery/client-gallery.html` | Gallery UI (password lock, photo grid, lightbox, downloads) |
| `site/admin/gallery-admin.html` | Admin tool to create and manage gallery links |
| `site/config.js` | Environment config — Worker URL, gallery URLs (swap for preprod) |
| `worker/cloudflare-worker.js` | Cloudflare Worker — CORS proxy between the gallery and the NAS |
| `worker/deploy-worker.sh` | Script to deploy the Worker via the Cloudflare API |
| `DOCS.md` | Full system documentation (architecture, routing, setup, maintenance) |

## Quick links

| | URL |
|-|-----|
| Main site | https://coastaltravelcompany.com |
| Gallery admin | https://coastaltravelcompany.com/admin/gallery-admin.html |
| Worker | https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev |

## Gallery Admin Setup

The gallery admin tool (`/admin/gallery-admin.html`) is used to create client galleries and manage client accounts. It is operated independently from the main website — the person doing this does not need to touch the codebase.

### Step 1 — Deploy the Worker (developer, one time)

The gallery system requires a Cloudflare Worker to be running. This is done once by whoever maintains the codebase.

1. Copy the config file and fill in credentials:
   ```bash
   cp worker/.worker-config.example worker/.worker-config
   # Edit .worker-config — add CF_ACCOUNT_ID, CF_API_TOKEN, CF_WORKER_NAME
   ```
2. Deploy the Worker:
   ```bash
   ./worker/deploy-worker.sh
   ```
3. Set the JWT secret (use any long random string — keep it safe):
   ```bash
   wrangler secret put JWT_SECRET
   ```
4. **Optional** — to enable Google login, add `GOOGLE_CLIENT_ID` in the Cloudflare dashboard under Worker → Settings → Variables.

### Step 2 — Create the first admin account (one time)

1. Visit **https://coastaltravelcompany.com/admin/gallery-admin.html**
2. If no accounts exist yet, you will be prompted to create the first admin account — enter an email and password
3. You are now signed in as the gallery administrator

On all future visits, sign in at **https://coastaltravelcompany.com/login.html** and you will be redirected to the admin panel automatically.

### Step 3 — Creating a client gallery

1. Open the album in Synology Photos, click **···** → **Share** and copy the share link
2. In the admin panel, paste the share link into **Synology Photos Share Link**
3. Fill in the event name, client name, and a password for the client
4. Click **Generate Gallery Link** — copy the link and the password
5. Send the link to the client; share the password separately (not in the same message)

### Step 4 — Creating a client account (optional)

Clients can register themselves at **/register.html**, or you can create an account for them manually in the **Client Accounts** section of the admin panel and assign them galleries directly.

---

## Deploying a Worker update

```bash
./worker/deploy-worker.sh
```

Requires `worker/.worker-config` (copy from `worker/.worker-config.example` and fill in credentials).

## Accounts required for maintenance

| Service | Purpose | Login |
|---------|---------|-------|
| [Name.com](https://www.name.com) | Domain registrar — renew `coastaltravelcompany.com` | Name.com account |
| [Cloudflare](https://dash.cloudflare.com) | DNS, Tunnel, Worker | Cloudflare account |
| [GitHub](https://github.com/willcrain1/coastaltravelcompany) | Website hosting (GitHub Pages) | willcrain1 GitHub account |

### Domain expiration

> ⚠️ **`coastaltravelcompany.com` expires June 12, 2027** — renew at Name.com before that date. If the domain lapses, the website and all client gallery links go offline.

## Full documentation

See **[DOCS.md](DOCS.md)** for architecture, DNS routing, Cloudflare Tunnel setup, the gallery system flow, admin workflow, and troubleshooting.
