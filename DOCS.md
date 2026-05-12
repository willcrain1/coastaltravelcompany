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
2. **POST (JSON API calls — photo list):**
   - Extracts `passphrase` from the POST body
   - Loads `https://nas.coastaltravelcompany.com/mo/sharing/{passphrase}` to get a `sharing_sid` session cookie (cached per isolate)
   - Forwards the POST to `/mo/sharing/webapi/entry.cgi` with:
     - `Cookie: sharing_sid=...`
     - `X-SYNO-SHARING: {passphrase}` ← required by Synology to activate the session
   - Returns the JSON response with CORS headers
3. **GET (thumbnails, downloads):**
   - Extracts `passphrase` from URL query string
   - Same session establishment as above
   - Forwards the GET to `/mo/sharing/webapi/entry.cgi?{original query string}`
   - Returns image data or file with CORS headers

**Why X-SYNO-SHARING is required:**
The Synology Photos sharing API requires this header in addition to the `sharing_sid` cookie. The `sharing_sid` alone (even obtained from the correct sharing page) returns error 119 (session not found). This header is what the real Synology Photos browser app sends, discovered by inspecting browser DevTools network requests.

**Session caching:**
The Worker caches `sharing_sid` per passphrase in memory for 2 hours per Worker isolate. Cloudflare may spin up new isolates over time, causing a fresh sharing page load — this is transparent and takes ~200ms.

**CORS configuration:**
The Worker only accepts requests from `https://coastaltravelcompany.com`. Requests from other origins are blocked.

**Worker source:** `worker/cloudflare-worker.js`
**No secrets or environment variables required.**

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
├── index.html                     Main website — home page
├── about.html                     Main website — about
├── services.html                  Main website — services
├── collections.html               Main website — collections
├── contact.html                   Main website — contact
├── styles.css                     Main website styles (shared)
├── main.js                        Main website JavaScript
│
├── gallery/
│   ├── gallery.html               Client-facing gallery entry point
│   │                              Decodes URL hash, shows loading screen,
│   │                              renders client-gallery.html in an iframe
│   └── client-gallery.html        Full gallery UI
│                                  Password lock screen + masonry photo grid +
│                                  lightbox + download — fetches photos via Worker
│
├── admin/
│   └── gallery-admin.html         Admin tool (not linked from public site)
│                                  Create gallery links, manage settings,
│                                  view active galleries — runs entirely in
│                                  the browser, stores data in localStorage
│
└── worker/
    ├── cloudflare-worker.js       Worker source — deploy this to Cloudflare
    ├── deploy-worker.sh           Deployment script (uses Cloudflare REST API)
    └── .worker-config.example     Template for deploy credentials
        (.worker-config is gitignored — copy and fill in locally)
```

---

## Gallery System — How It Works

### End-to-end flow

```
1. Admin creates a Synology Photos share link
   └─► Synology Photos → album → share → copy link
       e.g. https://coastaltravelcompany.us6.quickconnect.to/mo/sharing/vCsa5XjJH
                                                                          └── passphrase

2. Admin opens gallery-admin.html, pastes share link
   └─► Admin sets event name, client name, password
   └─► Admin clicks Generate Gallery Link
   └─► Admin tool creates a config object:
       {
         passphrase: "vCsa5XjJH",
         nasUrl: "https://coastaltravelcompany.us6.quickconnect.to",
         nasClientUrl: "https://coastaltravelcompany.com/gallery/client-gallery.html",
         proxyUrl: "https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev",
         eventName: "...", clientName: "...", pwHash: "sha256...", ...
       }
   └─► Config is base64-encoded and appended as a URL hash
   └─► Result: https://coastaltravelcompany.com/gallery/gallery.html#eyJ...

3. Admin sends the link + password to the client (separately)

4. Client opens the link in their browser
   └─► gallery.html loads
   └─► JavaScript decodes the hash → config object
   └─► gallery.html embeds client-gallery.html in a full-screen iframe,
       passing the same hash: client-gallery.html#eyJ...

5. client-gallery.html loads inside the iframe
   └─► Decodes the hash → config
   └─► Shows a branded lock screen with event name
   └─► Client enters the password
   └─► SHA-256 hash of password is compared to pwHash in config
   └─► If correct: lock screen fades out, gallery loads

6. Gallery fetches photos via the Worker
   └─► POST to Worker: api=SYNO.Foto.Browse.Item, passphrase="vCsa5XjJH"
   └─► Worker loads nas.coastaltravelcompany.com/mo/sharing/vCsa5XjJH
       → gets sharing_sid cookie
   └─► Worker POSTs to /mo/sharing/webapi/entry.cgi with:
       Cookie: sharing_sid=...
       X-SYNO-SHARING: vCsa5XjJH
   └─► NAS returns photo list JSON
   └─► Worker returns JSON to gallery with CORS headers

7. Gallery renders photos
   └─► Masonry grid with lazy-loaded thumbnails
   └─► Each thumbnail: GET request to Worker with passphrase in query string
   └─► Worker proxies thumbnail image from NAS → browser
   └─► Client can click photos to open lightbox, download individually,
       or use Download All (up to 20 at once)
```

### Password security

The client password never leaves the browser. The admin tool hashes it with SHA-256 before embedding in the URL. When the client enters their password, it is hashed in the browser and compared locally — no server involved, no password transmitted.

The URL hash (after `#`) is never sent to the server in HTTP requests, so the config (including pwHash) is not logged by GitHub Pages or Cloudflare.

### Config encoded in URL

The URL hash contains a base64-encoded JSON object. It is decoded client-side by:
```javascript
JSON.parse(decodeURIComponent(escape(atob(hash))))
```

The config includes `proxyUrl` (the Worker URL) and `nasClientUrl` (where client-gallery.html lives). These are set from Gallery Admin settings at the time the link is generated, so changing settings only affects newly generated links.

---

## Admin Workflow

### One-time setup

1. **Deploy the Cloudflare Worker**
   - Copy `worker/.worker-config.example` → `worker/.worker-config`
   - Fill in `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_WORKER_NAME`
   - Run `./worker/deploy-worker.sh`
   - Note the worker URL: `https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev`

2. **Configure Gallery Admin settings**
   - Open `https://coastaltravelcompany.com/admin/gallery-admin.html`
   - Set Main Site Gallery URL: `https://coastaltravelcompany.com/gallery/gallery.html`
   - Set Client Gallery URL: `https://coastaltravelcompany.com/gallery/client-gallery.html`
   - Set Worker URL: `https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev`
   - Click Save Settings

### Creating a gallery link

1. In Synology Photos, open the album → ··· → Share → Enable sharing → copy the link
2. Open `https://coastaltravelcompany.com/admin/gallery-admin.html`
3. Paste the share link, fill in event name, client name, and set a password
4. Click **Generate Gallery Link**
5. Copy the link — send it to the client
6. Send the password separately (different email, text message, etc.)

### Sharing the link with clients

- Send the gallery link via email
- Send the password via a separate channel (text message recommended)
- The link does not expire unless you delete the Synology Photos share

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

2. **Check the Synology Photos share** — the passphrase in old gallery links becomes invalid if the share is deleted or disabled in Synology Photos. Recreate the share and generate a new gallery link.

3. **Test the Worker directly:**
   ```bash
   curl -s -X POST https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d 'api=SYNO.Foto.Browse.Item&method=list&version=4&offset=0&limit=1&additional=%5B%22thumbnail%22%5D&passphrase=%22YOUR_PASSPHRASE%22'
   ```
   Should return `{"success":true,"data":{"list":[...]}}`.

4. **Test the Tunnel directly:**
   ```bash
   curl -si "https://nas.coastaltravelcompany.com/mo/sharing/YOUR_PASSPHRASE" | grep -i "set-cookie"
   ```
   Should return a `sharing_sid` cookie.

### Renewing the domain

Renew `coastaltravelcompany.com` at Name.com before it expires. No DNS changes are needed — nameservers stay pointed at Cloudflare.
