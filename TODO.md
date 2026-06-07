# Coastal Travel Company — To-Do

Items ordered by revenue impact. Completed features are in `CHANGELOG.md`.

---

## Configuration & Setup (Remaining from completed features)

### Stripe (required for billing to work in production)
- [ ] Set up Stripe account and configure Worker secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- [ ] Register production Stripe webhook: `POST https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev/stripe/webhook` for `checkout.session.completed`
- [ ] Register preprod Stripe webhook: `POST https://coastal-gallery-proxy-preprod.thecoastaltravelcompany.workers.dev/stripe/webhook`
- [ ] Run D1 migration `worker/migrations/011_invoices.sql` against production (if not yet applied)

---

## 11. 3D Property Walkthroughs (Gaussian Splatting)

**Goal:** Offer immersive, photorealistic 3D walkthroughs of hotel rooms, lobbies, and outdoor spaces as a premium deliverable — captured via Gaussian Splatting and embedded on the client portal and public portfolio.

### Capture

- [ ] **Camera and settings** — shoot at 4K/30fps minimum; use a gimbal or steady hand movement; set fixed exposure (manual mode) so frames don't auto-brighten mid-pass.
- [ ] **Movement pattern per scene** — plan 3 types of passes per room:
  1. **Primary orbit** — slow horizontal arc (2 m/s max) around the hero subject; keep camera level, overlap each position by ~60%
  2. **Vertical sweep** — move camera up/down in the corners to capture ceiling and floor detail
  3. **Detail passes** — slow close-up walks along counters, headboards, and architectural features
  Aim for 3–5 min of raw footage per room at steady walking pace; that extracts to ~300–500 frames at 2 fps.
- [ ] **Lighting requirements** — turn on all room lights; avoid dusk/dawn; angle past mirrors and glass; wait for stillness before each pass.
- [ ] **Test shoot first** — do one practice room with the RTX 3070 pipeline before a client shoot.

### Processing — In-House GPU Pipeline (RTX 3070)

#### One-time machine setup

- [ ] **Install prerequisites** — CUDA Toolkit 11.8 or 12.x, Anaconda or `uv`, Git with Git LFS, COLMAP, ffmpeg
- [ ] **Install nerfstudio**:
  ```
  conda create -n nerfstudio python=3.10 -y
  conda activate nerfstudio
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118
  pip install nerfstudio
  ```
- [ ] **Install Postshot** as a GUI alternative (~$50 one-time) — evaluate against nerfstudio on 2–3 test scenes
- [ ] **Install SuperSplat CLI** — `npm install -g supersplat`

#### Per-scene workflow

- [ ] **Frame extraction** — `ffmpeg -i shoot.mp4 -vf "fps=3,scale=3840:-1" -q:v 2 frames/%05d.jpg`
- [ ] **COLMAP reconstruction** — `ns-process-data images --data ./frames --output-dir ./colmap_out`; verify ≥80% of frames register in the sparse point cloud
- [ ] **3DGS training** — `ns-train splatfacto --data ./colmap_out` (30k iterations, ~45 min on RTX 3070; cap Gaussians with `--pipeline.model.max-num-gaussians 1500000` if VRAM exceeds 7.5 GB)
- [ ] **Export** — `ns-export gaussian-splat --load-config outputs/.../config.yml --output-dir ./export`
- [ ] **Quality check in SuperSplat** — trim floaters, check for black patches or blurry textures, export as `.splat` (5–10× smaller than PLY)
- [ ] **Save to NAS** — `point_cloud.ply` → `3d-walkthroughs/{slug}/export/`; `scene.splat` → `3d-walkthroughs/splats-incoming/{slug}.splat` (triggers R2 upload)

#### NAS folder structure and naming convention

- [ ] Establish `{YYYY-MM}_{ClientName}_{PropertyName}/` naming convention and document in `3d-walkthroughs/README.txt` on the NAS
- [ ] Keep raw video and `scene.splat` permanently; prune `frames/`, `colmap_out/`, and `outputs/` after the scene is approved and uploaded

#### Output and delivery

- [ ] Once `scene.splat` passes quality check, copy to NAS watch folder — automated pipeline handles R2 upload within 2 minutes
- [ ] For client portal delivery, set `splat_url` on the gallery record via admin edit panel
- [ ] Include note in client delivery email that 3D walkthrough requires a desktop or high-end mobile browser (WebGL 2)

### NAS → R2 Automated Upload Pipeline

#### One-time setup

- [ ] **Create R2 Access Keys** — Cloudflare dashboard → R2 → Manage API tokens → Create API token (Object Read & Write, scoped to `ctc-assets`)
- [ ] **Install rclone on the NAS** — `curl -fsSL https://rclone.org/install.sh | sudo bash`
- [ ] **Configure rclone R2 remote** — `rclone config`, type `s3`, provider `Cloudflare`, store config at `/volume1/.config/rclone/rclone.conf`; test with `rclone ls r2:ctc-assets`
- [ ] **Create NAS watch folders** — `splats-incoming/`, `splats-uploaded/`, `splats-failed/` under `/volume1/Coastal Travel Company/3d-walkthroughs/`
- [ ] **Deploy `nas/sync-splats.sh`** to `/volume1/scripts/sync-splats.sh` and `chmod +x`
- [ ] **Store admin JWT** at `/volume1/scripts/.ctc-admin-token` with `chmod 600`

#### Synology Task Scheduler setup

- [ ] DSM → Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script:
  - Task name: `Sync splats to R2`; User: `root`; Schedule: every 2 minutes
  - Run command: `/bin/bash /volume1/scripts/sync-splats.sh`
- [ ] Test by dropping a small `.splat` file into `splats-incoming/` and waiting 2 minutes

#### Worker endpoint: `POST /admin/splats/notify`

- [ ] Add `POST /admin/splats/notify` to `worker/src/router.js` (admin-auth required): accepts `{ slug, r2_key }`, derives public URL, inserts row into `walkthroughs` D1 table with `published = 0`
- [ ] Add `assets.coastaltravelcompany.com` as a custom domain on the `ctc-assets` R2 bucket in Cloudflare dashboard

### Services & Portfolio
- [ ] Add walkthrough pricing to `faq.html` alongside print pricing (defer until FAQ page is built in item 21)

---

## 12. Print Ordering

**Goal:** Clients can order prints directly from their gallery.

- [ ] Evaluate print lab integrations: WHCC and Printful both have APIs; Pixieset and Pic-Time are all-in-one solutions
- [ ] If building custom: add "Order Print" button to the lightbox and photo hover state in `client-gallery.html`
- [ ] Build a print product selection flow — size, paper type, quantity — before handing off to the print lab
- [ ] Handle payment via Stripe (same account as billing/invoices)
- [ ] Print lab fulfills and ships directly to client — no inventory needed
- [ ] Add print pricing to `faq.html` and `services.html`

---

## 13. Individual Photo Purchase (Digital Licensing Store)

**Goal:** Let anyone purchase a digital license for specific portfolio photos — generating passive revenue from the back catalog.

### Admin curation
- [ ] Add a "List for sale" toggle to each photo in `gallery-admin.html`
- [ ] Per-photo store settings: title, description, and price per license tier
- [ ] License tiers: Personal use, Commercial digital, Commercial print, Exclusive commercial
- [ ] Store listing data in a `store_photos` D1 table

### Storefront
- [ ] Build `/shop.html` — public-facing photo store with masonry grid and watermarked thumbnails
- [ ] Filter bar: collection type, subject, orientation
- [ ] Individual photo page at `/shop/{photo-id}`: larger preview, license tier selector, price
- [ ] Cart and Stripe Checkout for multiple photos in one transaction
- [ ] Link from `collections.html` and footer

### Purchase & delivery flow
- [ ] Stripe Checkout session created by Worker on purchase
- [ ] On payment: generate 72-hour signed R2 download URL for full-resolution file from NAS
- [ ] Confirmation email via Resend with download link, license type, and attached license certificate PDF
- [ ] Download link re-sendable from client portal for authenticated users
- [ ] `photo_purchases` D1 table

### License certificate
- [ ] Auto-generate PDF license certificate on purchase: buyer name, date, photo title, license scope, Coastal Travel Company signature
- [ ] Exclusive purchases trigger admin notification and set photo status to `sold-exclusive`

---

## 14. Email Capture / Mailing List

**Goal:** Collect visitor emails for newsletters and seasonal campaigns.

- [ ] Choose a provider — Mailchimp or ConvertKit (both have free tiers)
- [ ] Add email capture section to `index.html`
- [ ] Optionally add slide-in or footer capture on `contact.html`
- [ ] Connect form to provider embed code or API
- [ ] Set up a welcome email in the provider dashboard

---

## 15. Video Reel / Showreel

**Goal:** Feature short-form video work prominently on the site.

- [ ] Upload reel to Vimeo
- [ ] Add a full-width video hero or reel section to `index.html` — autoplay muted loop or play-button overlay for the full reel
- [ ] Add video examples to `services.html` per collection
- [ ] Ensure video does not autoplay with sound

---

## 16. Testimonials Page

**Goal:** Dedicated page and homepage section showing client reviews.

- [ ] Build `testimonials.html` — quotes, client name, property name, optional photo
- [ ] Add a testimonials preview section to `index.html` (2–3 featured quotes with "Read More" link)
- [ ] Add "Testimonials" to main nav and footer links
- [ ] Populate with real client quotes

---

## 17. Enhanced SEO & AI Search Visibility

**Goal:** Rank in traditional search and surface in AI-powered search engines.

### Technical SEO foundations
- [ ] Add `<meta name="description">` to every page
- [ ] Add Open Graph tags to every page: `og:title`, `og:description`, `og:image`, `og:type`, `og:url`
- [ ] Add Twitter/X card meta tags
- [ ] Create `robots.txt` — allow all crawlers, reference sitemap URL
- [ ] Create `sitemap.xml` and submit to Google Search Console and Bing Webmaster Tools
- [ ] Audit and fix image `alt` attributes across all HTML pages
- [ ] Audit heading hierarchy on all pages — one `<h1>` per page, logical `<h2>`/`<h3>` structure
- [ ] Add canonical `<link rel="canonical">` tags

### Structured data (JSON-LD Schema.org)
- [ ] Add `LocalBusiness` + `Photographer` schema to `index.html`
- [ ] Add `Service` schema to `services.html` and `collections.html`
- [ ] Add `FAQPage` schema to `faq.html` (item 21)
- [ ] Add `Review` / `AggregateRating` schema to `testimonials.html` (item 16)
- [ ] Add `ImageGallery` / `CreativeWork` schema to `collections.html`
- [ ] Add `BreadcrumbList` schema to all non-home pages

### AI search optimization
- [ ] Create `llms.txt` in the repo root
- [ ] Structure key page content to directly answer common questions AI models surface
- [ ] Add an editorial blog or "Journal" section (`/journal/`) with long-form, authoritative content
- [ ] Establish entity consistency across Google Business Profile, photography directories, and the website
- [ ] Set up Google Search Console and Bing Webmaster Tools; submit sitemap
- [ ] Monitor AI search appearance periodically in Perplexity and ChatGPT

---

## 19. Licensing Information

**Goal:** Make usage rights clear for commercial hotel/property clients.

- [ ] Build `/licensing.html`: personal vs. commercial use, print vs. digital, exclusivity, duration, geographic scope, sub-licensing
- [ ] Define license tiers per collection
- [ ] Add license summary to each collection on `collections.html`
- [ ] Include licensing terms in FAQ (item 21)
- [ ] Add licensing details to client delivery emails and client portal
- [ ] Consider a simple license certificate PDF generated per delivery

---

## 20. Before/After Editing Sliders

**Goal:** Demonstrate editing quality to commercial clients directly on the website.

- [ ] Choose 3–5 strong before/after pairs from real shoots
- [ ] Build or use a lightweight CSS-only or JS drag slider (range input over two stacked images)
- [ ] Add a "The Edit" section to `services.html` or standalone `/editing.html`
- [ ] Optionally embed one slider on the homepage

---

## 23. Admin Photo Editing

**Goal:** Browser-based, non-destructive photo editor in the gallery admin tool. Edit parameters stored in D1 and applied at serve time; original NAS files never modified.

### Editing interface
- [ ] Add an "Edit" button per photo in `gallery-admin.html` (full-screen editing panel)
- [ ] Add a "Global Adjustments" mode for gallery-wide edits
- [ ] Real-time preview using WebGL (via `glfx.js` or custom GLSL on a `<canvas>`)
- [ ] Before/after toggle (split-screen or A/B)

### Controls
- [ ] Tone & exposure: Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Clarity, Dehaze
- [ ] Color: White balance (Temperature, Tint), Vibrance, Saturation, HSL mixer (8 channels), Split toning
- [ ] Tone curve: RGB + per-channel curves; preset shapes (Linear, Contrast S, Film, Matte)
- [ ] B&W conversion, luminosity mixer, film grain, selenium/sepia tone
- [ ] Effects: Vignette, Sharpening, Noise reduction, Texture
- [ ] Crop & transform: aspect ratio lock, straighten, perspective correction, flip

### Presets
- [ ] Save/load named presets per admin in D1
- [ ] Ship branded starting presets: "Coastal Clean", "Editorial Dark", "Golden Hour", "B&W Architecture"

### Storage & rendering pipeline
- [ ] `photo_edits` D1 table: `(gallery_id, photo_id, edit_params JSON, created_at, updated_at)`
- [ ] `gallery_edits` D1 table for gallery-wide baseline adjustments
- [ ] Worker thumbnail/download endpoints read edit params from D1, apply via Sharp (Docker container on NAS), return processed image
- [ ] Cache processed thumbnails in R2 keyed by `{photo_id}:{hash_of_edit_params}`; invalidate on edit update

---

## 24. AI-Powered Auto Edit

**Goal:** Analyze each photo with vision AI and auto-generate tailored edit parameters.

### Analysis approach
- [ ] Use Claude API (claude-opus-4-8 with vision) — send 800px JPEG, return structured JSON edit recommendation
- [ ] Implement deterministic algorithmic fallback (histogram auto-exposure, gray world white balance) for fast batch processing
- [ ] Run both in parallel when available; prefer Claude recommendation

### Scene & subject detection
- [ ] Detect scene type (bedroom/suite, lobby, poolside/oceanfront, golden hour, detail/macro, aerial/drone) and bias edit profile accordingly
- [ ] Detect and correct common problems: mixed tungsten/daylight, vignetting, converging verticals, overexposed windows

### Edit parameter output
- [ ] Claude returns JSON matching `edit_params` schema with a `confidence` field (0–1) per parameter group and a `reasoning` field (1–2 sentences)
- [ ] Low-confidence parameters flagged in UI

### Admin review workflow
- [ ] "Auto Edit" per photo and "Auto Edit All" at gallery level in `gallery-admin.html`
- [ ] "Auto Edit All" runs in batches of 5 with progress indicator
- [ ] Side-by-side diff view with reasoning text; admin clicks Apply, Tweak, or Discard
- [ ] "Auto Edit confidence" badge per photo card (green/amber/red)
- [ ] Store `auto_edit_params`, `auto_edit_reasoning`, `auto_edit_confidence`, `auto_edit_reviewed` in `photo_edits` table

### Cost & performance
- [ ] Downscale to 800px before sending to API; cache results in D1 per `photo_id`
- [ ] Display estimated cost (~$0.003–0.006/photo) to admin before "Auto Edit All"
- [ ] Add `ANTHROPIC_API_KEY` to Cloudflare Worker secrets

---

## 25. Photo License Enforcement & Monitoring

**Goal:** Deter misuse and enable discovery of violations through invisible watermarking, metadata embedding, a license lookup URL, and automated reverse image search monitoring.

### Invisible watermarking
- [ ] Inject invisible watermark (buyer `license_id` + `user_email`) via `invisible-watermark` Python library in the NAS Docker container before download
- [ ] Add Worker endpoint `POST /licenses/extract-watermark` (admin-only) to extract watermark from an uploaded image

### EXIF/XMP metadata injection
- [ ] Inject via Sharp before download: `IPTC:CopyrightNotice`, `IPTC:RightsUsageTerms`, `XMP:WebStatement` → `https://coastaltravelcompany.com/verify/[license-id]`, `XMP:UsageTerms`

### License lookup page
- [ ] Build public `/verify/{license-id}` page: buyer display name, purchase date, license type, permitted uses, current status
- [ ] Add `GET /verify/{license-id}` JSON endpoint for programmatic verification

### Automated reverse image search monitoring
- [ ] Weekly Worker cron: submit active store photos to TinEye API; flag unmatched licenses as potential violations and email admin via Resend
- [ ] Evaluate Pixsy or Copytrack as managed alternatives
- [ ] `license_monitoring` D1 table
- [ ] "License monitoring" panel in `gallery-admin.html`

---

## 26. Employee Email Addresses (@coastaltravelcompany.com)

**Goal:** Professional email addresses on the company domain.

- [ ] Choose an email host: Google Workspace (~$6/user/month), Cloudflare Email Routing (free forwarding), or Microsoft 365
- [ ] Add required DNS records (MX, SPF, DKIM, DMARC) in Cloudflare DNS dashboard
- [ ] Create addresses for each employee/role
- [ ] Update contact form delivery address and Resend sending addresses to use the new domain emails
- [ ] Add DMARC reporting (`rua=mailto:...`)

---

## 27. Update Gallery Admin Form

**Goal:** Update form values in the Gallery Admin page.

- [ ] Remove 'Client Name' in 'Create New Gallery' (not required — admin links albums to client accounts)
- [ ] Add Name to the 'Client Accounts' creation section; add Name to required fields on the register account page

---

## 28. Enhance Watermark Capabilities

**Goal:** Once a gallery is created with watermark enabled, queue all items to be watermarked. A worker processes the queue, watermarks items, and uploads them to a new Synology album as a watermarked version.

---

## 30. Customer Photo Sharing

**Goal:** Allow customers to share photo albums with up to 5 users via email invite. Only the primary album user (set by the admin) can share. Primary user can revoke shares and see pending vs. accepted status. All activity visible in `gallery-admin.html`.

---

## 31. Physical/Digital Business Cards

**Goal:** Create physical and digital business cards for Coastal Travel Company employees.

- [ ] Physical cards created
- [ ] Digital cards created
- [ ] QR codes on cards route through the site where traffic can be tracked via website analytics

---

## 32. Website Analytics — Remaining Manual Setup

**Goal:** Understand how people find the site, what actions they take, and where they drop off.

First-party tracking, conversion events, scroll depth, and traffic-source/UTM
capture now ship in code (see CHANGELOG "Website & Clickstream Analytics").
What remains requires creating external accounts/dashboards by hand:

- [ ] **Google Analytics 4 (GA4)** — create a GA4 property; add tracking snippet to `<head>` of every HTML page (optional, complements the first-party pipeline)
- [ ] **Cloudflare Web Analytics** — enable in Cloudflare dashboard (privacy-friendly, no cookies)
- [ ] **Google Search Console** — set up and link to GA4
- [ ] Generate a QR code linking to `https://coastaltravelcompany.com/?utm_source=businesscard&utm_medium=qr&utm_campaign=networking` for printed materials

---


## 38. Add Real Estate Client Type

**Goal:** Expand the platform to support real estate agents with per-property virtual tour pages, photo gallery integration, 3D splat walkthrough embeds, Zillow/Redfin linking, and privacy-compliant aggregate analytics.

### Phase 1 — Data model (D1 migrations)

- [ ] `NNN_client_type.sql` — add `client_type TEXT NOT NULL DEFAULT 'standard'` to `users` table
- [ ] `NNN_properties.sql` — create `properties` table (agent_user_id, address, mls_number, zillow_url, redfin_url, splat_r2_key, hotspots_json, lead_gate_enabled, status)
- [ ] `NNN_property_galleries.sql` — create `property_galleries` join table
- [ ] `NNN_property_analytics.sql` — create `property_events` table (session_id UUID, event_type, room_label, duration_ms; no IP or device stored)
- [ ] `NNN_property_leads.sql` — create `property_leads` table; email is PII — only insert after explicit opt-in

### Phase 2 — Worker API endpoints

- [ ] `POST /re/properties`, `GET /re/properties`, `PATCH /re/properties/:id`
- [ ] `GET /re/properties/:id/analytics` — room engagement breakdown with aggregating SQL query
- [ ] `POST /re/properties/:id/events` — ingest analytics; rate-limited 60 events/session/minute via KV; no freeform data
- [ ] `POST /re/properties/:id/leads` — requires `{ email, consent: true }`; sends notification email to agent
- [ ] `GET /re/properties/:id/report` — returns HTML with print CSS for PDF generation

### Phase 3 — Property page (`site/property/property-page.html`)

- [ ] Build property page template: hero photo, splat viewer iframe, photo gallery grid, Zillow/Redfin embed, agent branding footer
- [ ] Property page URL scheme: `https://coastaltravelcompany.com/property/{id}`
- [ ] Analytics tracking: `session_id = crypto.randomUUID()` on load; `IntersectionObserver` for `room_enter` events; `hotspot_click` events
- [ ] Consent gate before sending any events; store consent in `sessionStorage`
- [ ] Lead capture gate: show modal after 30s of browsing if `lead_gate_enabled`

### Phase 4 — Agent portal dashboard (`site/portal/real-estate.html`)

- [ ] Property list view with Pulse metrics (total views, avg dwell, engagement rate)
- [ ] Property detail view: Room Engagement Table, Actionable Insight text block
- [ ] Hotspot Manager: draggable pins on property hero photo
- [ ] Embed Link Generator and QR Code Generator (using `qrcode.js`)

### Phase 5 — Privacy & compliance (prerequisite for public launch)

- [ ] Complete item 39 (privacy policy) before any real estate pages go live
- [ ] `property_events` must never store IP addresses, user agents, or device fingerprints
- [ ] "Do Not Sell or Share My Personal Information" link in every property page footer

---

## 40. Create Full Real Estate Portal

**Goal:** Deliver the complete agent portal and public property page as a shippable product. Items 38 and 39 are hard prerequisites.

### Integration checklist

- [ ] End-to-end flow: agent creates property → adds photos → publishes → shares URL → visitor views → analytics appear in dashboard within 60 seconds
- [ ] Lead capture gate flow: visitor submits email with consent → agent receives Resend notification → lead appears in portal
- [ ] R2 splat file upload: file upload field in portal; `PUT` directly to R2 via pre-signed URL; store key in `properties.splat_r2_key`

### PDF report

- [ ] `GET /re/properties/:id/report` returns styled HTML with `@media print` CSS (Coastal Travel Co. branding, property address, hero photo, Pulse metrics, Room Engagement Table, Actionable Insight)
- [ ] Print CSS hides nav and interactive controls; sets page size to Letter; `break-inside: avoid` on each section
- [ ] Test print-to-PDF in Chrome and Safari

### QR code generator

- [ ] Load `qrcode.min.js` from CDN; render into `<canvas>`; "Download PNG" button via `canvas.toBlob()`

### Acceptance tests (Playwright)

- [ ] Agent login → property creation → publish → confirm public property page renders
- [ ] Analytics event ingest: load property page, confirm `POST /re/properties/:id/events` returns 200
- [ ] Lead capture: trigger gate, submit email, confirm agent receives Resend notification
- [ ] Agent dashboard: property analytics tab renders Room Engagement Table with seeded data
- [ ] Embed & Share tab: QR code canvas renders and Download PNG produces a non-empty file

---

## 42. End-to-End Email Testing via Mailbox Capture Service

**Goal:** Verify every Resend email is actually delivered with correct content — something unit tests cannot do because they stub `fetch`.

### Setup steps

- [ ] **Choose and configure the service** — sign up for Mailosaur (or Mailtrap); create a preprod server/inbox; store `MAILOSAUR_API_KEY` as a GitHub Actions secret and Cloudflare Worker secret on preprod
- [ ] **Route preprod emails to capture inbox** — in the Worker, check `env.EMAIL_CAPTURE_DOMAIN`; if set, rewrite all `to` addresses to `<original-local-part>@<EMAIL_CAPTURE_DOMAIN>` before calling Resend
- [ ] **Add `EMAIL_CAPTURE_DOMAIN` to preprod Worker secrets** — set to the Mailosaur server inbox domain
- [ ] **Install Mailosaur Node SDK** — `npm install --save-dev mailosaur` in `tests/e2e` package

### Playwright test coverage

- [ ] **Verification email** — register with a `@<server>.mailosaur.net` address; poll until verify email arrives; click link; assert account is loginable
- [ ] **Password reset email** — trigger reset; poll for reset email; follow link; set new password; log in
- [ ] **Invoice send** — admin sends invoice to capture address; poll for email; assert total and payment link URL
- [ ] **Contract send** — admin sends contract to capture address; poll for email; assert signing link URL
- [ ] **Contact form** — submit public form; poll for notification email; assert subject and sender name

### CI integration

- [ ] Pass `MAILOSAUR_API_KEY` and `EMAIL_CAPTURE_DOMAIN` to acceptance-tests job via `env:` (from repository secrets)
- [ ] Gate email assertions on `!!process.env.MAILOSAUR_API_KEY` so local runs without the secret skip gracefully

---

## 46. Advanced Clickstream Analytics — Remaining Manual Setup

**Goal:** Understand what visitors are looking at on each page, how long they spend in specific sections, where attention drops off, and what content drives inquiry.

Section-dwell instrumentation, scroll-depth milestones, and click-path/conversion
tracking now ship in code as a first-party pipeline (see CHANGELOG "Website &
Clickstream Analytics") — no GA4/Clarity dependency required to use them. What
remains is optional and requires creating external accounts by hand:

- [x] **Microsoft Clarity** (optional, for session-recording heatmaps) — create a project at clarity.microsoft.com; add its tracking snippet to `<head>`; allow 24–48 hours for recordings to populate
- [x] Mirror `section_dwell`/`scroll_depth`/`conversion`/`click` events into GA4 (`site/js/analytics.js::mirrorToGA4`, no-op until `window.gtag` loads post-consent)
- [ ] Build a GA4 Exploration report grouping `section_dwell` by `section_id` (manual setup in the GA4 UI)

---

## 48. Set Up Mailosaur and Activate Email Capture Tests

**Goal:** Create a Mailosaur account, wire the API key into GitHub Actions and the preprod Worker, and activate the email capture Playwright tests already written and gated on `MAILOSAUR_API_KEY` (items 42 and 43).

### One-time account and secret setup

- [ ] **Create Mailosaur account** — sign up at mailosaur.com; create a server named `ctc-preprod`; note the server ID
- [ ] **Add `MAILOSAUR_API_KEY` to GitHub Actions secrets**
- [ ] **Add `EMAIL_CAPTURE_DOMAIN` to GitHub Actions secrets** — value is `<server-id>.mailosaur.net`
- [ ] **Add `EMAIL_CAPTURE_DOMAIN` as a preprod Worker secret** — `wrangler secret put EMAIL_CAPTURE_DOMAIN --env preprod`

### Worker change (one file)

- [ ] **Implement email capture rewriting in the Worker** — in `worker/src/utils.js`, check `env.EMAIL_CAPTURE_DOMAIN`; if set, rewrite every `to` address to `<local-part>@<EMAIL_CAPTURE_DOMAIN>` before the `fetch` to Resend

### Install Mailosaur SDK

- [ ] **`npm install --save-dev mailosaur`** in the root `package.json`; commit the updated `package-lock.json`

### CLAUDE.md cleanup (after tests pass)

- [ ] **Update preprod test checklist in `CLAUDE.md`** — remove manual email verification steps; replace with a note that these are automated via Mailosaur

---

## 49. Expand Admin Analytics Page — Additional Metrics & Integrations

**Goal:** Build out the admin Analytics page (`site/admin/analytics.html`) beyond the current pageviews/conversions/sources/dwell/scroll-depth panels, adding more first-party breakdowns, business/CRM-linked metrics, and links to additional third-party dashboards — all consent-gated and privacy-preserving like the existing pipeline.

### A. Extend the first-party pipeline (builds on existing D1 schema + `/admin/analytics/summary`)

- [x] **Referrer / landing-page breakdown** — surface which page visitors landed on first per session; added `landingPages` query/panel to `worker/src/analytics.js` and `site/admin/analytics.html` (referrer/UTM breakdown already shipped as "Traffic Sources")
- [ ] **Device / browser / viewport breakdown** — coarse buckets only (e.g. "mobile/tablet/desktop", browser family, viewport width ranges) — no fingerprinting; capture at event-ingest time in `site/js/analytics.js` and add a summary aggregation + panel
- [ ] **Funnel / path analysis** — common navigation sequences (e.g. home → services → contact); requires sequencing pageview events by `session_id` and `created_at` in a new query
- [x] **Bounce rate** — single- vs. multi-pageview session ratio, surfaced as a stat panel (`an-bounce`) in `worker/src/analytics.js`/`site/admin/analytics.html`; per-page exit-rate breakdown still open
- [ ] **Geographic breakdown (country/region)** — pull from Cloudflare's `cf-ipcountry`/`cf.country` request properties at ingest time rather than storing raw IPs; aggregate and display as a table or simple map
- [ ] **New vs. returning visitor counts** — based on whether a `session_id` (or longer-lived anonymous identifier) has been seen before; needs a privacy-conscious design decision on how "returning" is determined without persistent cross-session identifiers
- [x] **Time-of-day traffic pattern** — pageviews bucketed by hour (UTC), added `timeOfDay` query/panel (`an-tod`); day-of-week breakdown still open
- [ ] **404 / error-page hit tracking** — log when visitors land on broken/missing pages so dead links can be found and fixed

### B. Business/CRM-linked metrics (pull from existing D1 tables, not visitor tracking)

- [ ] **Lead-to-booking conversion rate** — join `contact_click`/`form_submit` analytics events against `projects`/`proposals` creation timestamps to estimate inquiry → booking conversion
- [ ] **Gallery engagement stats** — views, favorites, and downloads per client gallery, sourced from existing gallery session/favorites tables
- [ ] **Email engagement** — open/click rates, if/when Resend's API exposes that data for transactional sends
- [ ] **Proposal/contract funnel** — sent → viewed → signed conversion rates, sourced from `proposals`, `contracts`, and `contract_signing_events` tables

### C. Additional third-party dashboard links (same pattern as existing GA4/Clarity/Search Console/Cloudflare links)

- [x] **Stripe dashboard link** — added to `site/admin/analytics.html` header links
- [x] **Resend dashboard link** — added to `site/admin/analytics.html` header links
- [ ] Consider surfacing a Core Web Vitals trend inline (data already available via Cloudflare/GA4 — mainly a UI/aggregation decision, not a new data source)

### Notes

- All new first-party metrics must remain anonymous/aggregate and respect the existing cookie-consent gate — no IP storage, no fingerprinting, no PII
- Prioritize section A items that reuse the existing `analytics_events` table/shape (referrer, device, time-of-day, 404s) before tackling items that need schema changes (funnel/path analysis, new-vs-returning)
- Section B items depend on joining analytics data with operational tables — confirm timestamp formats and indexing are compatible before writing cross-table queries

---

## 50. Bump vitest to v4 (resolve transitive dev-dependency advisories)

**Goal:** Resolve 3 low-severity advisories surfaced by an OSV dependency scan, all in dev-tooling pulled in transitively through `vitest@2.1.9` in `worker/package.json`. None of these reach production — they're dev-server-only issues (only exploitable if the dev/test server is explicitly exposed to the network) — but they're cheap to fix once a proper Node environment is available to regenerate the lockfile and verify the major-version bump.

| Package | Advisory | Issue |
|---|---|---|
| `vite@5.4.21` | GHSA-4w7w-66w2-5vf9 | Dev server path traversal via `.map` requests |
| `esbuild@0.21.5` | GHSA-67mh-4wv8-2f99 | Dev server CORS allows any site to read responses |
| `vitest@2.1.9` | GHSA-5xrq-8626-4rwp | Vitest UI server arbitrary file read (Windows / network-exposed) |

- [ ] **Bump `vitest` and `@vitest/coverage-v8`** from `^2.1.9` to `^4.1.0` in `worker/package.json` (pulls in patched `vite`/`esbuild` transitively, resolving all three advisories at once)
- [ ] **Regenerate the lockfile** — run `npm install` inside `worker/` and commit the updated `worker/package-lock.json` (this is a major version bump, 2.x → 4.x — `npm ci` will reject a stale lockfile)
- [ ] **Run the full worker test suite** — `npm run test:unit` — and fix any vitest 2→4 config/API breakage (e.g. changes to mocking, coverage config, or matcher behavior) before merging
- [ ] **Re-scan to confirm** — re-run an OSV/`npm audit` scan and confirm GHSA-4w7w-66w2-5vf9, GHSA-67mh-4wv8-2f99, and GHSA-5xrq-8626-4rwp no longer appear

---

