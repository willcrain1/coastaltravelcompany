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
