# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## What this is

Static website and client photo gallery system for Coastal Travel Company. No build tools, no frameworks, no package manager — all files are plain HTML/CSS/JS served directly by GitHub Pages.

## Deployment

**Website changes** — push to the `master` branch; GitHub Pages deploys automatically within ~2 minutes:
```bash
git add <files>
git commit -m "description"
git push
```

**Cloudflare Worker changes** — edit `worker/cloudflare-worker.js`, then:
```bash
./worker/deploy-worker.sh
```
Requires `worker/.worker-config` (gitignored). Copy from `worker/.worker-config.example` and fill in `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_WORKER_NAME`.

There is no local dev server, linter, or test suite. Manual browser testing is the verification method.

## Architecture

```
coastaltravelcompany.com  →  GitHub Pages (static files)
                                    │
           gallery page JS  ─POST/GET──►  Cloudflare Worker (CORS proxy)
                                                   │
                                    nas.coastaltravelcompany.com
                                    (Cloudflare Tunnel → Synology NAS)
```

### Public website
`index.html`, `about.html`, `services.html`, `collections.html`, `contact.html` share a single stylesheet (`styles.css`) and script (`main.js`). `main.js` handles nav scroll behavior, mobile nav toggle, fade-up scroll animations, and the (currently placeholder) contact form submit.

### Gallery system
The gallery uses a two-page iframe architecture:

1. **`gallery/gallery.html`** — the shareable client-facing URL. Decodes the URL hash to extract config, then renders `client-gallery.html` in a sandboxed `<iframe>`, passing through the same hash.

2. **`gallery/client-gallery.html`** — the full gallery UI (lock screen, masonry photo grid, lightbox, download). It reads its own URL hash, shows the lock screen, verifies the password client-side via SHA-256, then fetches photos through the Worker.

3. **`admin/gallery-admin.html`** — admin-only tool (not linked from public site). Generates gallery links by encoding a config object as base64 JSON in the URL hash. Stores settings in `localStorage`. Not password-protected currently.

### Gallery config in the URL hash

All gallery configuration lives in the URL hash as `base64(JSON)`. The config object contains:
```js
{
  passphrase,    // Synology Photos share passphrase (e.g. "vCsa5XjJH")
  nasUrl,        // e.g. "https://coastaltravelcompany.us6.quickconnect.to"
  nasClientUrl,  // URL of client-gallery.html
  proxyUrl,      // Cloudflare Worker URL
  eventName, clientName,
  pwHash,        // SHA-256 of the client password — verified in browser, never transmitted
  watermark,     // bool — disables downloads and shows CSS watermark overlay
}
```

Decoded with: `JSON.parse(decodeURIComponent(escape(atob(hash))))`

The URL hash is never sent in HTTP requests, so the config and pwHash are never logged by GitHub Pages or Cloudflare.

### Cloudflare Worker (`worker/cloudflare-worker.js`)

Acts as a CORS proxy because the browser cannot set the headers Synology requires for cross-origin requests.

**Security hardening** (four layers):
1. **Origin header validation** — rejects all requests not from `https://coastaltravelcompany.com`; browsers enforce this and cannot spoof it via JS.
2. **Session token exchange** — `POST /token {passphrase}` returns a short-lived `sid` (stored in KV, 4-hour TTL). All subsequent requests use `?sid=...`; the passphrase never appears in GET URLs and is never written to Cloudflare's request logs.
3. **Synology API allowlist** — only `SYNO.Foto.Browse.Item`, `SYNO.Foto.Thumbnail`, and `SYNO.Foto.Download` are forwarded; all other API methods are rejected with 403.
4. **KV rate limiting** — 300 requests per 60 seconds per gallery passphrase; excess requests return 429.

**Request flow for each gallery session:**
1. After password unlock, `client-gallery.html` calls `POST /token` → Worker validates passphrase, stores `tok:{uuid}` → `passphrase` in KV, returns `{sid}`
2. All photo list, thumbnail, and download requests send `sid=<uuid>` instead of `passphrase=...`
3. Worker resolves sid → passphrase from KV, gets a `sharing_sid` session cookie (cached per isolate for 2 hours), forwards the request to `/mo/sharing/webapi/entry.cgi` with `Cookie: sharing_sid=...` and `X-SYNO-SHARING: {passphrase}` — **both are required**; `sharing_sid` alone returns Synology error 119
4. Returns the NAS response with CORS headers restricted to `https://coastaltravelcompany.com`

The `CTC_AUTH` KV namespace is bound as `KV` and used by both the token exchange and rate limiting. No other Worker secrets are required for the gallery proxy.

## Design conventions

**CSS variables** (defined in `styles.css` and mirrored inline in `client-gallery.html`):
- `--black: #1C1C1C`, `--green: #2A5C45`, `--teal: #8FBFBE`, `--cream: #F4F1EC`, `--linen: #E8DDD0`

**Typography**: Gilda Display (serif headings), Pinyon Script (script/brand accent), Montserrat (body, weight 300/400/500/600)

**Watermark mode**: when `cfg.watermark` is true, download buttons are hidden and a CSS SVG tiled overlay is applied. Real server-side watermarking (via Synology Photos' XL thumbnail path) is planned but not yet implemented — see TODO.md item 1.

## Key constraints

- `nasClientUrl` in the gallery config points to where `client-gallery.html` is hosted. Since both files are on `coastaltravelcompany.com`, this is always `https://coastaltravelcompany.com/gallery/client-gallery.html`. Changing this URL only affects newly generated links; existing links continue to use whatever URL was embedded at generation time.
- The Worker's CORS policy is hardcoded to `https://coastaltravelcompany.com`. If the site ever moves domains, `CORS['Access-Control-Allow-Origin']` in `cloudflare-worker.js` must be updated and redeployed.
- Do not use QuickConnect (`coastaltravelcompany.us6.quickconnect.to`) in Worker code — it returns an HTML portal page for server-to-server requests. Use `nas.coastaltravelcompany.com` (Cloudflare Tunnel) instead.
