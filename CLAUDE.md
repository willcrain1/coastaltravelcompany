# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## What this is

Static website and client photo gallery system for Coastal Travel Company. No build tools, no frameworks, no package manager — all files are plain HTML/CSS/JS served directly by GitHub Pages.

## Repository layout

```
site/          ← GitHub Pages source (only this directory is deployed)
  index.html, about.html, services.html, collections.html,
  contact.html, login.html, portal.html, styles.css, main.js, CNAME
  gallery/     client-gallery.html, gallery.html
  admin/       gallery-admin.html
worker/        ← Cloudflare Worker source and deploy tooling
nas/           ← Docker / Cloudflare Tunnel config for the Synology NAS
tests/e2e/     ← Playwright acceptance tests
playwright.config.js, package.json   ← test tooling (not deployed)
```

## Deployment

**Website changes** — PR merges to the `master` branch; GitHub Pages deploys automatically within ~2 minutes:
```bash
git add <files>
git commit -m "description"
git push
```

**Cloudflare Worker changes** — edit `worker/cloudflare-worker.js`, then the `deploy-worker` github action will push changes.  To make changes manually instead:
```bash
./worker/deploy-worker.sh
```
Requires `worker/.worker-config` (gitignored). Copy from `worker/.worker-config.example` and fill in `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_WORKER_NAME`.

There is no local dev server, linter, or test suite. Manual browser testing is the verification method.

## Content Editor (CMS)

`site/admin/content-editor.html` lets admins edit site copy directly in the browser. It calls the Worker's `/admin/cms/*` endpoints, which read/write files in the GitHub repo via the GitHub Contents API using `GITHUB_TOKEN`.

### `data-content-id` naming convention

Editable text zones are marked with `data-content-id="ZONE_ID"` on the element that contains the text. Rules:
- Zone IDs are **kebab-case** strings, globally unique within a page (not globally unique across pages)
- IDs are defined in the page registry in `worker/src/admin/cms.js` — add the attribute to the HTML **and** add an entry to `PAGES` in `cms.js`
- Only mark elements that contain **plain text only** (no child elements other than inline text); elements with child tags (e.g. `<a>`, `<strong>`, `<br>`) are not safe to use as zones
- Pattern: `page-section-field`, e.g. `hero-eyebrow`, `contact-intro-body`, `service-1-title`
- `GITHUB_TOKEN` must be set as a Worker secret (fine-grained PAT with `contents: write` scope on this repo only)

### Worker secrets required for CMS

**Secret** (set via `wrangler secret put GITHUB_TOKEN [--env preprod]`):
- `GITHUB_TOKEN` — fine-grained PAT, `contents: write` scope on this repo only

**Variable** (set in `wrangler.toml` — already documented in `wrangler.toml.example`):
- `CMS_BRANCH = "master"` for the production Worker
- `CMS_BRANCH = "preprod"` for the preprod Worker

Saves made through the preprod editor land on the `preprod` branch; saves through the prod editor land on `master`.

**Branch protection bypass (one-time GitHub setup):**

The GitHub Contents API respects branch protection rules. If `master` or `preprod` require PR reviews, direct API writes will be rejected with 422 unless the PAT owner is granted bypass rights:

1. GitHub → repo Settings → Branches → protection rule for `master`
2. Enable **"Allow specified actors to bypass required pull requests"**
3. Add the GitHub user account whose PAT is used as `GITHUB_TOKEN`
4. Repeat for the `preprod` branch protection rule

Use a dedicated bot/machine account for the PAT rather than a personal account so bypass rights are scoped tightly.

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
`site/index.html`, `site/about.html`, `site/services.html`, `site/collections.html`, `site/contact.html` share a single stylesheet (`site/styles.css`) and script (`site/main.js`). `main.js` handles nav scroll behavior, mobile nav toggle, fade-up scroll animations, and the (currently placeholder) contact form submit.

### Gallery system
The gallery uses a two-page iframe architecture:

1. **`site/gallery/gallery.html`** — the shareable client-facing URL. Decodes the URL hash to extract config, then renders `client-gallery.html` in a sandboxed `<iframe>`, passing through the same hash.

2. **`site/gallery/client-gallery.html`** — the full gallery UI (lock screen, masonry photo grid, lightbox, download). It reads its own URL hash, shows the lock screen, verifies the password client-side via SHA-256, then fetches photos through the Worker.

3. **`site/admin/gallery-admin.html`** — admin-only tool (not linked from public site). Generates gallery links by encoding a config object as base64 JSON in the URL hash. Stores settings in `localStorage`. Not password-protected currently.

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

**CSS variables** (defined in `site/styles.css` and mirrored inline in `site/gallery/client-gallery.html`):
- `--black: #1C1C1C`, `--green: #2A5C45`, `--teal: #8FBFBE`, `--cream: #F4F1EC`, `--linen: #E8DDD0`

**Typography**: Gilda Display (serif headings), Pinyon Script (script/brand accent), Montserrat (body, weight 300/400/500/600)

**Watermark mode**: when `cfg.watermark` is true, download buttons are hidden and a CSS SVG tiled overlay is applied. Real server-side watermarking (via Synology Photos' XL thumbnail path) is planned but not yet implemented — see TODO.md item 1.

## Key constraints

- `nasClientUrl` in the gallery config points to where `client-gallery.html` is hosted. Since both files are on `coastaltravelcompany.com`, this is always `https://coastaltravelcompany.com/gallery/client-gallery.html`. Changing this URL only affects newly generated links; existing links continue to use whatever URL was embedded at generation time.
- The Worker's CORS policy defaults to `https://coastaltravelcompany.com` (`worker/src/constants.js`). The `ALLOWED_ORIGIN` is overridden per-environment via the `ALLOWED_ORIGIN` variable in `[env.preprod.vars]` of `wrangler.toml` — `initCors(env.ALLOWED_ORIGIN)` is called at the top of every request in `router.js`.
- Do not use QuickConnect (`coastaltravelcompany.us6.quickconnect.to`) in Worker code — it returns an HTML portal page for server-to-server requests. Use `nas.coastaltravelcompany.com` (Cloudflare Tunnel) instead.

## Preprod environment

A staging environment that mirrors production for safe validation before every deploy.

### Infrastructure

| Resource | Production | Preprod |
|---|---|---|
| GitHub Pages branch | `master` | `preprod` |
| Site URL | `https://coastaltravelcompany.com` | `https://preprod.coastaltravelcompany.com` |
| Cloudflare Worker | `coastal-gallery-proxy` | `coastal-gallery-proxy-preprod` |
| KV namespace | `CTC_AUTH` | `CTC_AUTH_PREPROD` |
| D1 database | `CTC_PROJECTS` | `ctc-preprod` |
| Stripe key | live mode | test mode (`sk_test_...`) |

### Deploying to preprod

```bash
# Deploy Worker to preprod (provisions KV + D1, runs all migrations, deploys)
./worker/deploy-worker-preprod.sh

# GitHub Actions deploys the Worker and Pages automatically on push to preprod branch
git push origin preprod
```

Requires `worker/.worker-config` with `CF_WORKER_NAME_PREPROD` set (see `.worker-config.example`).

### Manual setup steps (one-time, done in dashboards)

1. **GitHub Pages** — Settings → Pages → add `preprod` environment pointing at the `preprod` branch
2. **DNS** — Cloudflare dashboard: add CNAME `preprod.coastaltravelcompany.com` → GitHub Pages URL (Proxied)
3. **Worker secrets** — Cloudflare dashboard → `coastal-gallery-proxy-preprod` → Settings → Variables:
   - `JWT_SECRET` (different random value from prod)
   - `RESEND_API_KEY` (can reuse prod key)
   - `GOOGLE_CLIENT_ID` (same as prod; add `preprod.coastaltravelcompany.com` to Google Cloud Console authorized origins)
   - `STRIPE_SECRET_KEY` (use `sk_test_...` test mode key)
   - `STRIPE_WEBHOOK_SECRET` (register separate webhook for preprod Stripe endpoint)
4. **Stripe webhook** — Stripe dashboard: add endpoint `POST https://coastal-gallery-proxy-preprod.thecoastaltravelcompany.workers.dev/stripe/webhook` for `checkout.session.completed`
5. **Branch protection** — GitHub Settings → Branches: require PR review before merging to `preprod`

### Preprod test checklist

Run through these before promoting preprod → master:

- [ ] **Auth flow** — register new account, verify email link works, log in with password, log in with Google, password reset flow end-to-end
- [ ] **Gallery proxy** — create gallery in admin (select Preprod env), open gallery link, enter password, confirm photo grid loads and thumbnails render
- [ ] **Watermarking** — create watermarked gallery, confirm watermark text appears on XL thumbnails, confirm downloads are disabled
- [ ] **Contract signing** — send contract to test email, open signing URL, scroll gate works, type signature, submit; admin countersigns; both parties receive confirmation email
- [ ] **Invoice + Stripe** — create invoice, send to test email, open payment link, pay with Stripe test card `4242 4242 4242 4242`, confirm stage advances to "Retainer Paid" via webhook
- [ ] **D1 migration smoke test** — any new migration file runs cleanly: `wrangler d1 execute ctc-preprod --env preprod --file worker/migrations/<new>.sql`
- [ ] **Scheduling** — set availability windows, open contact page, confirm calendar reflects the windows
- [ ] **Questionnaire** — send questionnaire link, submit responses, confirm admin notification email arrives

### Promotion workflow (preprod → master)

1. Verify all checklist items above pass in preprod
2. Create a PR from `preprod` → `master` in GitHub
3. Wait for CI (acceptance tests) to pass on the PR
4. Merge — GitHub Pages and the production Worker deploy automatically
5. Run any new D1 migrations against the production database:
   ```bash
   wrangler d1 execute CTC_PROJECTS --file worker/migrations/<new>.sql
   ```

### Adding new D1 migrations

Always run migrations against preprod **before** production:
1. Create `worker/migrations/NNN_description.sql`
2. Deploy to preprod: `wrangler d1 execute ctc-preprod --env preprod --file worker/migrations/NNN_description.sql`
3. Verify the feature works end-to-end in preprod
4. Merge to master, then run against production: `wrangler d1 execute CTC_PROJECTS --file worker/migrations/NNN_description.sql`
