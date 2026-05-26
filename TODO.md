# Coastal Travel Company — To-Do

Items are ordered: necessary website fixes first, then by highest revenue impact.

---

## ~~P0. Fix & Expand Acceptance Tests 🔴~~ ✅ Done

**Goal:** All Playwright acceptance tests pass, and every piece of existing functionality is covered — contact form, gallery auth flow, admin panel auth, portal, and pipeline.

- [x] Audit existing tests in `tests/e2e/` — identify which are broken and what errors they produce
- [x] Fix all broken tests so the full suite passes cleanly
- [x] Add missing coverage for contact form submission (success path, validation errors, rate limit response)
- [x] Add missing coverage for gallery auth flow: lock screen, wrong password, correct password → photo grid loads
- [x] Add missing coverage for admin panel: unauthenticated redirect to login, authenticated access, gallery creation, gallery expansion/edit
- [x] Add missing coverage for client portal: login, gallery list, gallery access via JWT token
- [x] Add missing coverage for lead pipeline: Kanban board renders, cards show outstanding action labels, stage progression
- [x] Ensure all tests run reliably in CI (no flaky waits or environment-specific assumptions)

---

## ~~0. Capture Live NAS Configuration~~ ✅ Done

- `cloudflared` container: standalone token-based container, no Docker Compose
- Tunnel ingress documented in `nas/cloudflare-tunnel/config.example.yml` and `nas/README.md` (single route: `nas.coastaltravelcompany.com` → `https://192.168.68.2:5001`, `noTLSVerify`)

---

## ~~1. Functional Contact Form~~ ✅ Done

- Worker `POST /contact` endpoint → Resend → `thecoastaltravelcompany@gmail.com`
- Reply-to set to submitter's email; rate limited 5/hour per IP
- Worker URL: `https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev`

---

## ~~2. Real Watermarking~~ ✅ Done

- Synology Photos does not expose watermarking on this DSM version
- Implemented server-side watermarking in the Cloudflare Worker using `@cf-wasm/photon` (WASM):
  - Client passes `watermark=1` on XL thumbnail requests; Worker strips it before forwarding to Synology, composites tiled "© Coastal Travel Company" text (staggered grid, 0.4 opacity) via `draw_text_with_transparency`, returns a processed JPEG — the clean image bytes never cross the network
  - Per-photo Save, lightbox Download, and Download All all route through the Worker watermark path for watermark galleries
  - CSS overlay on thumbnails/lightbox preserved as a visual preview indicator
  - Worker converted to ES modules format; deployment switched from raw curl PUT to `wrangler deploy` (bundles WASM + npm dependencies); `worker/package.json` and `worker/wrangler.toml.example` added

---

## 3. ~~Synology-Level Album Password Protection~~ ✅ Done

**Goal:** Gallery password set in the admin tool is enforced at the Synology Photos share level, not just client-side in the browser.

- [x] Research Synology Photos sharing API — check if password protection can be set on a share via API (`SYNO.Foto.Sharing.Passphrase` or share creation endpoint)
- [x] If API supports it: update Worker or `gallery-admin.html` to set the share password which was created in synology photos when generating a gallery link.  Given album allocations are covered with JWT, make the synology album password protection in the background to the end user, so it's set in the gallery admin page and never referenced anywhere else.
- [x] Verify that the Worker's session establishment (`/mo/sharing/{passphrase}`) works correctly when a share has a password set (may need to pass the password during session init)

---

## 4. ~~OAuth Login & Per-User Gallery Access~~ ✅ Done

**Goal:** Clients log in with email/password or Google, and see only their own galleries — no shared password links.

- [x] Verify if user creates initially with password flow then they can do google login later and it merges the local account with the google login and they can login with either the password or the google token. (Works by design — `/auth/google` does email lookup so both methods work for the same account.)
- [x] Send verification email when a client creates their own account (self-service signup only — admin-created accounts skip verification since the admin already controls the email address). Client cannot access galleries until verified. Verification link expires after 24 hours; resend option on the login page if the link expires.
- [x] Verify email functionality works for forgot password flow.
- [x] Create Resend account, verify `coastaltravelcompany.com` domain for transactional email
- [x] Get Google Client ID from Google Cloud Console (authorized JS origin: `https://coastaltravelcompany.com`)
- [x] Set Worker secrets in Cloudflare dashboard: `JWT_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`
- [x] Build login page (`/login.html`) — email/password form + Google Sign-In button, forgot/reset password flow, first-time setup card
- [x] Build client portal page (`/portal.html`) — shows galleries assigned to the logged-in user
- [x] Add Worker auth endpoints: `POST /auth/login`, `POST /auth/google`, `POST /auth/reset-request`, `POST /auth/reset-confirm`, `GET /auth/me`, `GET /auth/setup-status`, `POST /auth/setup` (logout handled client-side by clearing localStorage — stateless JWT needs no server-side invalidation)
- [x] Store users, gallery assignments, and reset tokens in Cloudflare KV (`CTC_AUTH` namespace)
- [x] Add user management to `gallery-admin.html` — create user, set password, assign galleries, manage gallery access per user, send password reset, delete user
- [x] Protect `gallery-admin.html` behind admin auth — redirects to `/login.html` if no JWT, to `/portal.html` if non-admin role
- [x] Session tokens: 7-day JWT, stored in `localStorage`, validated by Worker on each request

---

## 5. Online Booking / Inquiry Workflow

**Goal:** Mirror HoneyBook's end-to-end client workflow — lead capture, pipeline management, branded proposals, intake questionnaires, scheduling, client portal, and automations — built custom on the existing Worker + D1 infrastructure so everything stays in one system.

### Lead & project pipeline
- [x] Contact form submissions (item 1) feed into a lead inbox in `gallery-admin.html` with unread count badge
- [x] Build a Kanban-style pipeline view with stages: **Inquiry → Proposal Sent → Contract Sent → Contract Signed → Retainer Paid → Active → Delivered → Complete**
- [x] Each project card shows: client name, property, collection, shoot date, last activity, current stage, outstanding action (e.g. "Contract unsigned — 3 days")
- [x] Per-project detail page: notes, activity log, labels/tags UI, and associated documents (proposal, contract, invoice, gallery links)
- [x] Admin can add manual notes, log call/email outcomes, and create follow-up reminders with due dates surfaced in the UI
- [x] Store projects in D1 `projects` table — table + CRUD done; FK relationships to `users`, `bookings`, `galleries` not yet built

### Service packages & proposals
- [x] Build a package library in `gallery-admin.html`: create reusable packages (The Editorial Stay, The Fashioned Weekend, The Branded Journey, etc.) each with name, description, inclusions list, hero photo, base price, and available add-ons
- [x] Add-on options admin can attach to any package: rush delivery, extra edited images, video reel, 3D walkthrough (item 8), extended license, additional half-day
- [x] Send a branded proposal to a lead: select 1–3 packages for side-by-side comparison, add a personalized cover note, set an expiry date
- [x] Client opens proposal at `/proposal/{id}` — sees branded layout (Coastal design system), browses packages, selects one, checks desired add-ons, and clicks "Let's do this"
- [x] Track proposal analytics: opened timestamp, time spent, number of views — stored in D1, shown in admin pipeline view
- [x] On client selection, automatically advance project stage to "Contract Sent" and trigger contract workflow (item 6)

### Intake questionnaires
- [x] Build a questionnaire builder in `gallery-admin.html`: create reusable question sets with text, multiple choice, date, and file-upload field types
- [x] Pre-booking questionnaire (sent with or after proposal): property name, address, property type (hotel / boutique / resort / vacation rental / private villa), number of spaces to shoot, key must-have shots, style references, logistics notes
- [x] Post-booking / pre-shoot questionnaire (sent after contract signed): refined shot list, venue contact name/number, parking/access instructions, mood board upload, any restrictions
- [x] Client completes questionnaires at `/questionnaire/{id}` — accessible via magic link, no login required
- [x] Responses stored per project in D1, displayed on the project detail page; admin receives email notification via Resend when a questionnaire is submitted

### Scheduling
- [x] Admin sets weekly availability windows in `gallery-admin.html` (e.g. Mon–Fri, 9am–5pm, blocked dates synced from availability calendar item 13)
- [x] Discovery call scheduling: send client a link to pick a 30-minute slot; on confirmation, both parties receive a calendar invite via email (ICS attachment via Resend)
- [x] Shoot date confirmation: admin selects confirmed shoot date(s) on the project, client receives confirmation email with date, address, and pre-shoot questionnaire link
- [x] Shoot dates automatically block the availability calendar (item 16)

### Client portal
- [x] Every project has a dedicated portal at `/portal/{project-id}` — accessible via auth (item 4) or a single-use magic link emailed to the client
- [x] Portal shows a visual timeline of the project lifecycle: Proposal → Contract → Invoice → Gallery — each step shows status (pending / action required / complete) and a direct link to the relevant document or action
- [x] Messaging thread per project: client and admin exchange messages directly in the portal; admin receives email notification of new messages; full thread history stored in D1
- [x] Client can view and download all signed documents, paid invoices, and the final gallery from one URL — no hunting through emails

### Automations
- [x] Build a workflow engine in `gallery-admin.html`: admin can enable/disable pre-built automation triggers per project or globally
- [x] **Inquiry received** → auto-reply email acknowledging receipt, send proposal within X hours (configurable delay) or queue for manual send
- [x] **Proposal not opened** → follow-up email after 3 days ("Just checking in — I wanted to make sure you received the proposal for...")
- [x] **Proposal not approved** → reminder after 7 days with a soft deadline ("The dates are filling up — happy to answer any questions before deciding")
- [x] **Proposal approved** → auto-advance to "Contract Sent", send contract link (item 6)
- [x] **Contract not signed** → reminder after 2 days
- [ ] **Contract signed** → auto-send deposit invoice (item 7), advance stage to "Retainer Paid" when deposit clears (depends on item 7 billing)
- [ ] **Invoice due in 3 days** → payment reminder email (depends on item 7 billing)
- [ ] **Final payment received** → thank-you email, stage advances to "Active" (depends on item 7 billing)
- [x] **Gallery delivered** → auto-send gallery link and access instructions, stage advances to "Delivered"
- [x] **2 weeks post-delivery** → review request email (feeds into testimonials item 13)
- [x] All automation emails use Resend with branded templates matching the Coastal design system

---

## ~~6. Document Signing & Contracts~~ ✅ Done

**Goal:** Send, sign, and store legally binding contracts entirely within the platform — clients sign from any device without printing, scanning, or third-party accounts.

### Contract template builder
- [x] Build a contract template editor in `admin/services.html` with a rich-text body and a library of merge fields: `{{client_name}}`, `{{property_name}}`, `{{collection}}`, `{{shoot_date}}`, `{{total_fee}}`, `{{location}}`
- [ ] Create one default template per collection type (The Editorial Stay, The Fashioned Weekend, The Branded Journey) pre-populated with appropriate scope of work, deliverable list, and license terms
- [x] Standard contract sections supported: scope of work, deliverables & timeline, fees & payment schedule, cancellation & rescheduling policy, licensing & usage rights, limitation of liability, governing law
- [x] Admin can preview a rendered contract with merged fields before sending (merge fields applied on template select in pipeline Send Contract panel)

### Sending & signing flow
- [x] Admin sends contract from the project detail page — Worker creates a contract record in D1, generates a unique signing URL, emails client via Resend
- [x] Client opens `/contract.html#{token}` — sees a read-only rendered contract with a scroll-to-bottom requirement before the signature block activates
- [x] Signature capture options: (a) **type name** — rendered in Pinyon Script cursive font, (b) **draw** — mouse or touchscreen Canvas API pad, (c) **upload image** — upload a signature image file
- [x] Client submits: records their signature, signature type, timestamp, IP, user-agent, and clicks "I Agree & Sign"
- [x] Admin receives email notification of client signature with a countersign link
- [x] Admin countersigns in `admin/pipeline.html` project detail using type or draw — finalizes the contract
- [x] On full execution, client receives a "Fully executed contract" email with a permanent download link; both parties can view the signed contract at the same URL

### Legal audit trail
- [x] Each signing event (created, view, client_signed, admin_countersigned) records in D1: UTC timestamp, IP address, email address, browser user-agent string, and a SHA-256 hash of the document contents at signing time
- [x] Certificate of completion shown on the contract page: lists all signing events with timestamps, IPs, and document hashes
- [ ] Store signed PDFs in Cloudflare R2 keyed by contract ID — the current implementation serves the contract as a printable HTML page with browser print-to-PDF; R2 storage is a future enhancement

### Integration option
- [ ] Evaluate Dropbox Sign (HelloSign) API as an alternative to the custom build above — provides jurisdiction-tested legal compliance, SMS authentication, and audit trail out of the box; trade-off is per-envelope cost (~$0.10–0.40/contract) vs. the custom build which is free per signing
- [ ] If using Dropbox Sign: store only the signature request ID and signed document URL in D1; Dropbox Sign hosts the audit trail

---

## ~~7. Billing & Invoicing~~ ✅ Done

**Goal:** Send, track, and collect payment on invoices directly — no third-party tool required unless a full CRM (HoneyBook/Dubsado) is preferred.

- [x] Evaluate approach: chose custom Worker + Stripe API — keeps everything in one system, no per-invoice platform fee, Stripe handles card processing and receipts
- [x] Add an invoices section to admin pipeline — create invoices with line items, tax, due date; send, mark paid, void
- [x] Send invoice links to clients via email (Resend) with branded HTML email and a Pay button
- [x] Client-facing invoice page (`/invoice.html`) — shows line items, total, Stripe Checkout payment flow
- [x] Stripe Checkout integration — POST /invoices/:token/checkout creates a hosted payment session; Stripe webhook marks invoice paid and advances project stage to "Retainer Paid"
- [x] Add invoice history to client portal — clients see all non-draft invoices with Pay / View links
- [x] Handle sales tax — tax_cents field on each invoice, shown as separate line in email and on invoice page
- [x] Automation hooks wired: contract_signed → invoice created (manual); invoice_paid → stage auto-advances to Retainer Paid via webhook
- [ ] Set up Stripe account and configure Worker secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- [ ] Register Stripe webhook endpoint: `POST https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev/stripe/webhook` for `checkout.session.completed` event
- [ ] Run D1 migration: `worker/migrations/011_invoices.sql`

---

## ~~8. Video Support in Client Gallery~~ ✅ Done

**Goal:** Deliver video files alongside photos in the same client gallery — clients see a unified view of all their deliverables.

- [x] Research Synology Photos API for video items — `SYNO.Foto.Browse.Item` returns videos alongside photos; videos have `type: "video"` with the same thumbnail/resolution fields as photos
- [x] Update `fetchAll()` in `client-gallery.html` to include video items in the results — no API change needed; `isVideo()` detects videos by `type` field with filename extension fallback
- [x] Render video cards in the masonry grid differently from photos — circular play-icon badge overlay; thumbnail served via existing `SYNO.Foto.Thumbnail` proxy
- [x] On click, open the lightbox with an HTML `<video>` element instead of an `<img>` — `showLbItem()` swaps between photo/video modes; video pauses and clears on navigation or close
- [x] Add video download support — routed through `SYNO.Foto.Download` via the Worker with correct file extension from filename
- [x] Handle mixed galleries gracefully — photos and videos interleaved in chronological order; nav count shows "X photos & Y videos"
- [x] Confirm the Worker can stream binary video data without buffering issues — video responses use `ReadableStream` passthrough instead of `arrayBuffer()`; `Range` headers forwarded for seeking; `Accept-Ranges` / `Content-Range` / `Content-Length` passed back
- [x] File size handled — streaming via `nasResponse.body` avoids the 128 MB Worker memory limit; large files stream rather than buffer

---

## ~~9. Availability Calendar~~ ✅ Done

**Goal:** Let prospective clients see open dates before reaching out, reducing low-intent inquiries.

- [x] Chose dynamic approach: new public `GET /public/availability` Worker endpoint reads `availability_windows` and `blocked_dates` from D1 — calendar always reflects what the admin configures in the scheduling panel, no manual HTML maintenance
- [x] Added calendar section to `contact.html` between the contact form and collections reference — 3-month rolling view rendered in JS
- [x] Days marked available (teal) when the admin has an active window for that day-of-week and the date is not in `blocked_dates`; unavailable days shown in linen; past days muted
- [x] Fallback renders Mon–Fri available if the Worker is unreachable (graceful degradation)
- [x] Note added: "Based in Palm Beach, Florida — available for travel worldwide. 6–8 week lead time recommended."

---

## 10. Preprod Environment

**Goal:** Create a staging environment that mirrors production so every change — especially Worker deploys, D1 migrations, and auth flows — can be validated end-to-end before touching production. This is a forcing function for safe deployments; Worker changes can't be rolled back once live, and D1 schema migrations that fail in prod require manual intervention.

### GitHub Pages staging site
- [x] Create a `preprod` branch in the repo (branch off master; keep it rebased on master going forward)
- [ ] Configure a GitHub Pages deployment environment named `preprod` in repo Settings → Pages → Environments; point it at the `preprod` branch so pushes to `preprod` deploy to a separate Pages URL (e.g. `willcrain1.github.io/coastaltravelcompany` on the `preprod` environment, or a custom subdomain)
- [ ] Add a `preprod.coastaltravelcompany.com` CNAME DNS record in Cloudflare pointing to the Pages deployment URL; enable "Proxied" so it goes through Cloudflare
- [x] Add `preprod.coastaltravelcompany.com` as an allowed origin in the preprod Worker's CORS config — Worker reads `env.ALLOWED_ORIGIN` set via `[env.preprod.vars]` in `wrangler.toml`; `initCors()` in `router.js` applies it at request time

### Cloudflare Worker — preprod instance
- [ ] Create a second Cloudflare Worker named `coastal-gallery-proxy-preprod` in the Cloudflare dashboard (Workers → Create); initial deploy via `./worker/deploy-worker-preprod.sh`
- [x] Add a `[env.preprod]` section to `worker/wrangler.toml` so `wrangler deploy --env preprod` targets the preprod Worker independently from production; `worker/wrangler.toml.example` updated to show the preprod env block
- [x] Create `worker/deploy-worker-preprod.sh` — auto-provisions `CTC_AUTH_PREPROD` KV and `ctc-preprod` D1, runs all migrations, generates `wrangler.toml` with `[env.preprod]` section, deploys with `--env preprod`
- [x] Add `CF_WORKER_NAME_PREPROD` to `worker/.worker-config.example` alongside the existing production fields

### KV namespace — isolated session state
- [x] `deploy-worker-preprod.sh` auto-creates `CTC_AUTH_PREPROD` KV namespace and binds it as `KV` in `[env.preprod]` — isolated from production `CTC_AUTH`
- [x] `wrangler.toml` `[env.preprod.kv_namespaces]` binds `CTC_AUTH_PREPROD`, not `CTC_AUTH`

### D1 database — isolated data store
- [x] `deploy-worker-preprod.sh` auto-creates `ctc-preprod` D1 database and binds it as `DB` in `[env.preprod]`
- [x] All existing migrations (001–011) run against `ctc-preprod` automatically by `deploy-worker-preprod.sh` on each run (idempotent — CREATE TABLE IF NOT EXISTS)
- [x] Migration run order and preprod workflow documented in `CLAUDE.md` under "Preprod environment → Adding new D1 migrations"

### Secrets — separate values per environment
- [ ] Set each Worker secret on the preprod Worker independently via Cloudflare dashboard → preprod Worker → Settings → Variables, or `wrangler secret put <NAME> --env preprod`: `JWT_SECRET` (different value from prod), `RESEND_API_KEY` (can reuse prod key; preprod emails will go to real inboxes), `GOOGLE_CLIENT_ID` (same value — authorized origins must include `preprod.coastaltravelcompany.com` in Google Cloud Console), `STRIPE_SECRET_KEY` (use Stripe **test mode** key for preprod), `STRIPE_WEBHOOK_SECRET` (register a separate Stripe webhook endpoint for preprod)
- [ ] Register the preprod Stripe webhook in the Stripe dashboard pointing to `POST https://coastal-gallery-proxy-preprod.thecoastaltravelcompany.workers.dev/stripe/webhook` for `checkout.session.completed`

### GitHub Actions CI/CD
- [x] Added `.github/workflows/deploy-worker-preprod.yml` — triggers on push to `preprod`, runs `deploy-worker-preprod.sh` then deploys Pages to the `preprod` environment
- [ ] Add a branch protection rule on `preprod` requiring PR review before merge (GitHub Settings → Branches)

### Admin environment switcher
- [x] Updated `admin/galleries.html` — Production/Preprod toggle with env badge; Preprod mode shows a Worker URL input; `proxyUrl` in the generated gallery config uses the active environment's URL; selection persists in `localStorage`

### Testing checklist and promotion workflow
- [x] Preprod test checklist documented in `CLAUDE.md` (auth, gallery proxy, watermark, contract signing, invoice + Stripe test payment, D1 migration smoke test, scheduling, questionnaire)
- [x] Promotion workflow documented in `CLAUDE.md` (PR preprod → master, CI pass, merge, run prod migrations)

---

## 11. 3D Property Walkthroughs (Gaussian Splatting)

**Goal:** Offer immersive, photorealistic 3D walkthroughs of hotel rooms, lobbies, and outdoor spaces as a premium deliverable — captured via Gaussian Splatting and embedded on the client portal and public portfolio.

### Capture
- [ ] Establish a capture workflow: record slow, overlapping video passes of the space (phone or mirrorless — 4K, steady movement, good exposure) or use a dedicated capture app (Luma AI mobile app is the lowest-friction starting point)
- [ ] Document lighting requirements: even ambient light, no harsh shadows or moving subjects during capture passes

### Processing
- [ ] Evaluate processing tools: **Luma AI** (cloud, fast, free tier) vs. **Postshot** (local GPU, high quality, paid) vs. **COLMAP + nerfstudio/3DGS** (open source, technical) — Luma AI is the recommended starting point for speed
- [ ] Output a `.splat` or `.ply` file per scene after processing; upload to Luma AI or SuperSplat to get the iframe-embeddable URL
- [ ] Establish a naming convention and folder structure on the NAS for raw capture footage and processed splat files

### Hosting & Display
- [x] Hosting approach chosen: iframe-embeddable URLs (Luma AI, SuperSplat) — no self-hosting required; admin pastes the embed URL into the gallery or walkthrough record
- [x] `/walkthroughs.html` built — fetches from `GET /public/walkthroughs`; card grid opens full-screen iframe modal; shows "check back soon" empty state
- [x] 3D Walkthrough section added to `client-gallery.html` — collapsible section below the photo grid; iframe lazy-loads on first expand; only visible when `cfg.splat_url` is set
- [x] `splat_url` (nullable) added to `galleries` D1 table via migration `012_walkthroughs.sql`

### Services & Portfolio
- [x] "3D Property Walkthroughs" added as service #05 to `services.html` — positioned as premium add-on with tags, "See Examples" link to walkthroughs.html, and Inquire CTA
- [x] `/walkthroughs.html` showcase page built — hero, intro, card grid, "How it works" process section, CTA
- [ ] Add walkthrough pricing to `faq.html` alongside print pricing (defer until FAQ page is built in item 21)

### Admin & Data
- [x] `walkthroughs` D1 table created (`012_walkthroughs.sql`) — title, property_name, location, description, embed_url, thumbnail_url, collection, sort_order, published
- [x] Worker endpoints: `GET /public/walkthroughs`, `GET/POST /admin/walkthroughs`, `PUT/DELETE /admin/walkthroughs/:id`
- [x] Walkthroughs admin section added to `admin/galleries.html` — create, publish/unpublish, delete; `splat_url` field added to per-gallery edit panel with "3D walkthrough" badge in gallery list

---

## 12. Print Ordering

**Goal:** Clients can order prints directly from their gallery — revenue opportunity and convenience for hotel/property clients who want wall art.

- [ ] Evaluate print lab integrations: WHCC and Printful both have APIs; Pixieset and Pic-Time are all-in-one solutions that include gallery + print store (worth comparing against building custom)
- [ ] If building custom: add "Order Print" button to the lightbox and photo hover state in `client-gallery.html`
- [ ] Build a print product selection flow — size, paper type, quantity — before handing off to the print lab
- [ ] Handle payment via Stripe (can be same Stripe account as billing/invoices in item 7)
- [ ] Print lab fulfills and ships directly to client — no inventory needed
- [ ] Add print pricing to `faq.html` and `services.html`
- [ ] Dependency: works best alongside the auth system (item 4) so order history is tied to a client account

---

## 13. Individual Photo Purchase (Digital Licensing Store)

**Goal:** Let anyone purchase a digital license for specific portfolio photos hand-picked by the admin — generating passive revenue from the back catalog without requiring a full shoot booking.

### Admin curation
- [ ] Add a "List for sale" toggle to each photo in `gallery-admin.html` — admin selects which photos from any gallery are available for purchase
- [ ] Per-photo store settings: title, brief description (location, collection context), and price per license tier
- [ ] License tiers with separate pricing: **Personal use** (social media, personal prints), **Commercial digital** (website, advertising, digital marketing), **Commercial print** (brochures, signage, magazines), **Exclusive commercial** (removes photo from store after purchase, admin is notified)
- [ ] Admin can set a photo as "featured" to appear prominently on the store front page
- [ ] Store listing data saved in a `store_photos` D1 table: `photo_id`, `gallery_id`, `title`, `description`, `personal_price_cents`, `commercial_digital_price_cents`, `commercial_print_price_cents`, `exclusive_price_cents`, `featured`, `status` (active / sold-exclusive / unlisted)

### Storefront
- [ ] Build `/shop.html` — public-facing photo store using the same masonry grid as the client gallery, watermarked preview thumbnails served through the existing Worker proxy
- [ ] Filter bar: collection type (Editorial Stay, Fashioned Weekend, etc.), subject (interior / exterior / detail / aerial / poolside), orientation (landscape / portrait / square)
- [ ] Individual photo page at `/shop/{photo-id}`: larger watermarked preview, title, description, license tier selector with plain-English explanation of each tier, price displayed per selection
- [ ] "Add to cart" and cart summary before checkout — allows purchasing multiple photos in one Stripe transaction
- [ ] Link to `/shop.html` from `collections.html` and the site footer

### Purchase & delivery flow
- [ ] Stripe Checkout session created by the Worker on purchase initiation — line items include photo title, license tier, and price
- [ ] On payment success: Worker generates a time-limited (72-hour) signed download URL via Cloudflare R2 presigned URL for the full-resolution file fetched from NAS
- [ ] Confirmation email via Resend: includes download link, license type purchased, and attached license certificate PDF (generated by Worker using the `licenses` D1 table)
- [ ] Download link re-sendable from the client portal (item 4) for authenticated users; guest purchasers receive a re-send link via email
- [ ] Purchased photos and their license tier stored in `photo_purchases` D1 table: `user_id` (nullable for guest), `email`, `photo_id`, `license_type`, `price_cents`, `stripe_payment_intent_id`, `download_token`, `purchased_at`

### License certificate
- [ ] Auto-generate a PDF license certificate on purchase: buyer name, purchase date, photo title, license scope and permitted uses, geographic scope, duration, Coastal Travel Company signature
- [ ] Certificate stored in R2 and attached to the confirmation email — permanent proof of license for commercial buyers
- [ ] Exclusive purchases trigger an admin notification and automatically set the photo status to `sold-exclusive` in D1, removing it from the storefront

---

## 14. Email Capture / Mailing List

**Goal:** Collect visitor emails for newsletters, availability announcements, or seasonal campaigns.

- [ ] Choose a provider — Mailchimp or ConvertKit (both have free tiers and embed forms)
- [ ] Add an email capture section to `index.html` — minimal, one-field form with a brand-appropriate headline (e.g. "Stay in the loop — new collections, destinations, availability")
- [ ] Optionally add a slide-in or footer capture on `contact.html` for visitors who don't submit the inquiry form
- [ ] Connect form to provider embed code or API
- [ ] Set up a welcome email in the provider dashboard that goes out automatically on signup

---

## 15. Video Reel / Showreel

**Goal:** Feature short-form video work prominently, since it's a core part of the collections offering.

- [ ] Upload reel to Vimeo (preferred over YouTube for clean embeds without ads/recommendations)
- [ ] Add a full-width video hero or reel section to `index.html` — autoplay muted loop for ambient effect, or a play-button overlay for the full reel
- [ ] Add video examples to `services.html` per collection (e.g. sample clip from The Fashioned Weekend)
- [ ] Ensure video does not autoplay with sound — muted autoplay is fine for hero, full reel should be user-initiated

---

## 16. Testimonials Page

**Goal:** Dedicated page (and homepage section) showing client reviews to build credibility with prospective hotel/property clients.

- [ ] Design and build `testimonials.html` — full-page layout with quotes, client name, property name, and optional photo
- [ ] Add a testimonials preview section to `index.html` (2–3 featured quotes with a "Read More" link)
- [ ] Add "Testimonials" to the main nav and footer links
- [ ] Populate with real client quotes
- [ ] Consider a pull-quote format with property name and collection type (e.g. "The Editorial Stay — The Grand Palms, Palm Beach") for specificity

---

## 17. Enhanced SEO & AI Search Visibility

**Goal:** Ensure the site ranks in traditional search and surfaces in AI-powered search engines (Google AI Overviews, Perplexity, ChatGPT Search, Bing Copilot) — both for branded queries ("Coastal Travel Company") and category queries ("hospitality photographer", "hotel photography", "luxury property photographer").

### Technical SEO foundations
- [ ] Add `<meta name="description">` to every page — currently none exist; write unique, specific descriptions per page (e.g. services.html: "Coastal Travel Company offers editorial hotel and property photography across The Editorial Stay, Fashioned Weekend, and Branded Journey collections.")
- [ ] Add Open Graph tags to every page: `og:title`, `og:description`, `og:image`, `og:type`, `og:url` — use a hero portfolio photo as the OG image for social sharing
- [ ] Add Twitter/X card meta tags: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
- [ ] Create `robots.txt` in the repo root — allow all crawlers, reference the sitemap URL
- [ ] Create `sitemap.xml` listing all public pages with `<lastmod>` and `<changefreq>` — submit to Google Search Console and Bing Webmaster Tools
- [ ] Audit and fix image `alt` attributes across all HTML pages — every `<img>` should describe its content specifically ("Beachfront suite with ocean view, The Editorial Stay collection" not "photo1.jpg")
- [ ] Audit heading hierarchy on all pages — each page should have exactly one `<h1>`, logical `<h2>`/`<h3>` structure; use semantic HTML (`<article>`, `<section>`, `<main>`, `<nav>`, `<footer>`)
- [ ] Add canonical `<link rel="canonical">` tags to prevent any duplicate content issues

### Structured data (JSON-LD Schema.org)
- [ ] Add `LocalBusiness` + `Photographer` schema to `index.html` — business name, URL, description, geo coordinates, service area, social profiles
- [ ] Add `Service` schema to `services.html` and `collections.html` — one `Service` block per collection with name, description, and price range
- [ ] Add `FAQPage` schema to `faq.html` (item 18) — each Q&A becomes a machine-readable FAQ entry surfaced directly in Google results and AI Overviews
- [ ] Add `Review` / `AggregateRating` schema to `testimonials.html` (item 13) — structured reviews improve E-E-A-T signals and can appear as star ratings in search results
- [ ] Add `ImageGallery` / `CreativeWork` schema to `collections.html` — helps AI crawlers understand the portfolio context
- [ ] Add `BreadcrumbList` schema to all non-home pages

### AI search optimization
- [ ] Create `llms.txt` in the repo root — an emerging standard (analogous to `robots.txt`) that tells AI crawlers the site's purpose, key facts, preferred citation name, and which pages contain authoritative content; example: "# Coastal Travel Company\nA hospitality and travel photography company specializing in editorial hotel and property photography.\n## Key pages\n- /services.html — collections and pricing overview\n- /collections.html — portfolio by collection type"
- [ ] Structure key page content to directly answer questions AI models are likely to surface: "What is hospitality photography?", "How much does hotel photography cost?", "What is included in a property photography package?" — write concise, factual answers in the page body, not just in FAQs
- [ ] Add an editorial blog or "Journal" section (`/journal/`) with long-form, authoritative content: destination shoot recaps, guides for hotel marketing directors on photography ROI, behind-the-scenes of collections — AI models favor sites with original depth and expertise (E-E-A-T)
- [ ] Establish entity consistency: ensure the business name "Coastal Travel Company", website URL, and contact information appear identically across Google Business Profile, photography directories (Thumbtack, Bark, local directories), and the website — AI models use cross-source consistency to establish trustworthiness
- [ ] Set up Google Search Console and Bing Webmaster Tools — monitor impressions, clicks, and coverage errors; submit sitemap
- [ ] Monitor AI search appearance: periodically query Perplexity and ChatGPT for "hospitality photographer [target markets]" — track whether Coastal Travel Company surfaces and which pages are cited

---

## 18. Admin Content Editor (CMS)

**Goal:** Allow the admin to update text and photos on every public website page directly from the browser — no HTML editing or git knowledge required. Changes commit to the GitHub repo via the API and GitHub Pages deploys automatically within ~2 minutes.

### Architecture
- Extend `gallery-admin.html` or create `admin/content-editor.html` — gated behind admin auth (item 4)
- Mark editable zones in each HTML page using `data-content-id` attributes (e.g. `<h1 data-content-id="home-hero-headline">`) so the Worker can parse and update only the relevant zones without touching surrounding markup
- Worker reads current file content via GitHub API (`GET /repos/{owner}/{repo}/contents/{path}`), extracts zone values, serves them to the editor; on save, injects updated values back and commits via `PUT /repos/{owner}/{repo}/contents/{path}` with the file's current SHA
- Store `GITHUB_TOKEN` (fine-grained personal access token with repo write scope, scoped to this repo only) as a Worker secret
- Show a "Deploying — live in ~2 minutes" status badge after a successful commit; poll GitHub API for deployment status and update badge to "Live" when complete

### Editable content zones per page
- **`index.html`**: hero headline, hero subheadline, hero CTA button label, about-preview paragraph, featured collection names and one-line descriptions (per card), homepage testimonial quotes (2–3 pull quotes with attribution)
- **`about.html`**: bio / brand story paragraphs, brand photo (replaceable), pull-quote overlays
- **`services.html`**: per-collection card — name, description, inclusions list, price range indicator, hero photo
- **`collections.html`**: portfolio photos per collection — add, remove, reorder; per-photo caption
- **`contact.html`**: intro paragraph, contact details text
- **`testimonials.html`** (item 13): add / edit / remove testimonials — quote text, client name, property name, optional photo
- **`faq.html`** (item 19): add / edit / remove FAQ entries — question and answer; drag-to-reorder

### Photo management
- **Upload**: admin drags an image into the editor → Worker uploads to a public Cloudflare R2 bucket → returns the CDN URL → URL written into the content zone on save
- **Pick from NAS**: admin opens a picker that loads gallery thumbnails via the existing Worker proxy → selects a photo → Worker fetches full-res from NAS and copies to R2 → URL used in content zone
- **Reorder**: drag-and-drop handles on photo grids in `collections.html` and services cards; order persisted as a data attribute the Worker commits back to the file

### Editor UI
- Per-page editor shows each content zone as a labeled field — short text zones use a single-line input, body copy uses a minimal rich-text editor (bold, italic, line breaks only — no full HTML)
- Inline photo picker appears on hover over any image zone — "Replace" opens upload or NAS picker, "Remove" clears the zone
- Live preview panel renders the full page in an `<iframe>` using the current (unsaved) edits so the admin can see exactly how the page will look before publishing
- **Save & Publish** commits all changed zones in a single GitHub API call with a descriptive auto-generated message (e.g. "Update home hero headline and about photo")
- **Change history**: list of recent commits affecting website pages — shows timestamp, changed zones summary, and a "Revert" action that creates a new reverting commit (non-destructive)

### Implementation notes
- Use the GitHub Contents API — no git CLI or deploy script needed; the Worker handles all API calls server-side so `GITHUB_TOKEN` is never exposed to the browser
- Each `PUT` to the GitHub Contents API requires the current file's `sha` to prevent conflicts — fetch it fresh immediately before each save
- Add `GITHUB_TOKEN` to the Worker secrets checklist alongside `JWT_SECRET`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`
- Mark all editable HTML zones before building the editor so zone IDs are stable; add a `data-content-id` naming convention to `CLAUDE.md` once established


---

## 19. Licensing Information

**Goal:** Make usage rights clear for commercial hotel/property clients — what they can and can't do with delivered photos.

- [ ] Build a licensing page (`/licensing.html`) covering: personal use vs. commercial use, print vs. digital, exclusivity options, duration, geographic scope, third-party sub-licensing
- [ ] Define license tiers per collection (e.g. The Editorial Stay includes X years of digital commercial use; extended licenses available for an additional fee)
- [ ] Add license summary to each collection on `collections.html` — short plain-English version with a link to the full licensing page
- [ ] Include licensing terms in the FAQ (item 19)
- [ ] Add licensing details to client delivery emails and the client portal (item 4) so clients have a permanent record
- [ ] Consider a simple license certificate PDF generated per delivery — client name, property, collection, usage rights, expiry

---

## 20. Before/After Editing Sliders

**Goal:** Demonstrate editing and retouching quality to commercial clients directly on the website.

- [ ] Choose 3–5 strong before/after pairs from real shoots
- [ ] Build or use a lightweight CSS-only or JS drag slider (no heavy library needed — a simple range input over two stacked images works well)
- [ ] Add a "The Edit" section to `services.html` or create a standalone `/editing.html` page
- [ ] Optionally embed one slider on the homepage as a visual hook

---

## 21. FAQ Page

**Goal:** Answer the most common pre-booking questions so clients arrive at the inquiry form already informed.

- [ ] Build `faq.html` with an accordion layout
- [ ] Cover: pricing / how collections are priced, what's included, licensing and usage rights, travel fees, turnaround time, how to book, what to expect on shoot day
- [ ] Add "FAQ" to footer nav
- [ ] Link to FAQ from the contact page ("Have questions? See our FAQ") and from the collections page

---

## 22. Photo Favorites / Proofing in Client Gallery

**Goal:** Clients and admins each have independent star/heart capabilities — clients mark their selects, admins mark their own picks (e.g. recommended edits, hero shots) — tracked and displayed separately.

**Client favorites**
- [ ] Add a heart button to each photo card in `client-gallery.html` — visible to the client only
- [ ] Store client favorites in `localStorage` keyed by gallery ID so selections persist across sessions on the same device
- [ ] Add a "My Selections" view — filtered grid showing only the client's starred photos, with a count in the nav
- [ ] Add a "Submit Selections" action — compiles filenames/indices and either opens a pre-filled mailto or POSTs to a Worker endpoint that emails the list to the admin
- [ ] Dependency: full cross-device persistence requires the auth system (item 4); localStorage works as a standalone first version

**Admin favorites (separate track)**
- [ ] Add an admin preview mode to `client-gallery.html` — activated by a secret URL param (e.g. `&admin=1`) or via the admin portal, not visible to clients
- [ ] In admin mode, show a separate star icon (different color/shape from the client heart) on each photo
- [ ] Store admin stars in Cloudflare KV keyed by gallery ID and photo ID — persists across devices and sessions without requiring client auth
- [ ] Display admin stars as a read-only overlay when the client views the gallery — e.g. a small badge indicating "Admin pick" — so clients can see which shots the photographer recommends
- [ ] In `gallery-admin.html`, show admin-starred photos per gallery with a "View Admin Picks" filtered view
- [ ] Allow admin to submit their star list to the client as a curated recommendation alongside (not replacing) the client's own selects


---

## 23. Admin Photo Editing

**Goal:** Give admins a browser-based, non-destructive photo editor inside the gallery admin tool — adjust individual photos or apply edits globally across a gallery before client delivery. Edit parameters are stored in D1 and applied at serve time; original NAS files are never modified.

### Editing interface
- [ ] Add an "Edit" button to each photo in `gallery-admin.html` that opens a full-screen editing panel
- [ ] Add a "Global Adjustments" mode that applies a set of edits to every photo in the gallery (useful for consistent look across a shoot)
- [ ] Show a real-time preview using WebGL (via `glfx.js` or custom GLSL shaders on a `<canvas>`) — fast enough for interactive sliders without hitting the server
- [ ] Add a before/after toggle (split-screen or A/B) so the admin can compare against the original
- [ ] Add an "Apply to all" action that copies current photo edits as the gallery-wide baseline

### Tone & exposure controls
- [ ] Exposure (overall brightness in stops)
- [ ] Contrast
- [ ] Highlights (pull down bright areas without clipping)
- [ ] Shadows (lift or crush shadow detail)
- [ ] Whites (set the white point)
- [ ] Blacks (set the black point)
- [ ] Clarity (local contrast / midtone punch)
- [ ] Dehaze (remove atmospheric haze — useful for outdoor/landscape property shots)

### Color controls
- [ ] White balance: Temperature (cool/warm) and Tint (green/magenta)
- [ ] Vibrance (boost muted colors without oversaturating skin/neutrals)
- [ ] Saturation (global color intensity)
- [ ] HSL mixer: per-channel Hue, Saturation, Luminance for the 8 color ranges (Reds, Oranges, Yellows, Greens, Aquas, Blues, Purples, Magentas) — critical for interior shots where you want to shift wall colors or correct mixed lighting
- [ ] Split toning: assign a color cast independently to shadows and highlights (e.g. warm highlights, cool shadows for a cinematic look)

### Tone curve
- [ ] RGB tone curve with draggable control points
- [ ] Per-channel curves (R, G, B) for precise color grading
- [ ] Preset curve shapes: Linear, Contrast S, Film (lifted blacks), Matte (flat)

### Black & white
- [ ] One-click B&W conversion toggle
- [ ] B&W luminosity mixer: per-channel brightness contribution (same 8 ranges as HSL) — lets the admin control how much each color contributes to gray value, e.g. darken blue sky, brighten foliage
- [ ] Film grain overlay with adjustable amount and size
- [ ] Selenium / sepia tone option (split tone applied post-desaturation)

### Effects
- [ ] Vignette: amount, midpoint, feather, and roundness
- [ ] Sharpening: amount and radius (applied via unsharp mask)
- [ ] Noise reduction: luminance smoothing (useful for low-light interior shots)
- [ ] Texture (fine detail enhancement, less aggressive than clarity)

### Crop & transform
- [ ] Crop with aspect ratio lock (free, 1:1, 4:3, 16:9, 3:2)
- [ ] Straighten (rotation with auto-crop)
- [ ] Horizontal and vertical perspective correction (fix converging verticals on architecture shots)
- [ ] Flip horizontal / vertical

### Presets
- [ ] Save current edit settings as a named preset, stored per admin in D1
- [ ] Ship a set of branded starting presets: "Coastal Clean" (neutral, airy), "Editorial Dark" (rich contrast, lifted blacks), "Golden Hour" (warm split tone), "B&W Architecture" (high-contrast monochrome)
- [ ] Apply any preset to the current photo or to all photos in the gallery
- [ ] Export and import presets as JSON for sharing between admin accounts

### Storage & rendering pipeline
- [ ] Add a `photo_edits` table to D1: `(gallery_id, photo_id, edit_params JSON, created_at, updated_at)` — one row per photo, `edit_params` is the full edit state as a JSON object
- [ ] Add a `gallery_edits` table for gallery-wide baseline adjustments that are merged with per-photo overrides at serve time
- [ ] Update the Worker's thumbnail and download endpoints to read edit params from D1, fetch the raw image from the NAS, apply adjustments server-side via **Sharp** (running in a Docker container on the NAS, called by the Worker), and return the processed image — keeps originals untouched
- [ ] For download at full resolution: same pipeline, Sharp processes the original full-res file with the stored params
- [ ] Cache processed thumbnails in Cloudflare R2 keyed by `{photo_id}:{hash_of_edit_params}` to avoid reprocessing on every view — invalidate cache entry when edits are updated

---

## 24. AI-Powered Auto Edit

**Goal:** Analyze each photo individually using vision AI and automatically generate a tailored set of edit parameters that make that specific photo look its best — accounting for scene type, lighting conditions, color cast, exposure, and subject matter. Results feed directly into the item 21 edit system so admins can review, tweak, or approve with one click.

### Analysis approach
- [ ] Use the **Claude API (claude-opus-4-7 with vision)** as the primary analysis engine — send a downscaled JPEG of the photo (800px long edge is sufficient for analysis) and prompt it to return a structured JSON edit recommendation; Claude can reason about scene context ("beachfront suite at golden hour, pool is the hero element, slight haze on the horizon") in ways a pure algorithmic approach cannot
- [ ] Prompt engineering: instruct Claude to identify scene type, lighting condition, dominant color cast, exposure quality, subject prominence, and any specific problem areas (blown highlights, crushed shadows, mixed color temperature), then map its findings to numeric values for every parameter in the item 22 `edit_params` schema
- [ ] Implement a deterministic algorithmic fallback (no API call) for fast batch processing: histogram-based auto exposure (stretch to fill tonal range), gray world white balance correction, and shadow/highlight analysis — use this when Claude API is unavailable or for quick previews
- [ ] Run the two approaches in parallel when both are available; prefer the Claude recommendation but fall back to algorithmic if the API call fails or times out

### Scene & subject detection
- [ ] Detect scene type from Claude's response and use it to bias the edit profile:
  - **Interior — bedroom/suite**: lift shadows, reduce highlights, warm slightly, boost clarity on textures
  - **Interior — lobby/common areas**: balance mixed lighting (tungsten + daylight), increase local contrast
  - **Exterior — poolside/oceanfront**: protect sky highlights, lift foreground shadows, increase vibrance on water/foliage, slight dehaze
  - **Exterior — golden hour**: preserve warm tones, add graduated warmth to highlights, increase saturation selectively in oranges/yellows
  - **Detail/macro shots** (amenities, food, décor): increase clarity and texture, boost local contrast, precise white balance
  - **Aerial/drone**: protect sky, reduce haze, increase global contrast, cool slightly
- [ ] Detect and correct common hospitality photography problems automatically: mixed tungsten/daylight (common in lobbies), heavy vignetting from wide-angle lenses, converging verticals on architecture shots, overexposed windows vs. dark interiors (flag for HDR note if severe)

### Edit parameter output
- [ ] Claude returns a structured JSON object matching the item 22 `edit_params` schema exactly — every slider value, curve points, crop/straighten if needed, B&W conversion flag, and a `confidence` field (0–1) per parameter group
- [ ] Include a `reasoning` field in the response (a 1–2 sentence plain-English explanation of the main corrections applied) — display this in the admin UI so the admin understands why the edits were suggested
- [ ] Low-confidence parameters (below a threshold) are flagged in the UI so the admin knows which adjustments are speculative vs. well-founded

### Admin review workflow
- [ ] Add an "Auto Edit" button per photo and an "Auto Edit All" button at the gallery level in `gallery-admin.html`
- [ ] "Auto Edit All" runs analysis in batches of 5 photos in parallel (respecting Claude API rate limits) with a progress indicator
- [ ] After auto edit runs, show a side-by-side diff view: original vs. proposed edits, with the `reasoning` text beneath — admin clicks "Apply", "Tweak" (opens item 22 editor pre-populated with the suggestions), or "Discard"
- [ ] Add an "Auto Edit confidence" badge to each photo card in the admin view — green (high confidence, minimal touch needed), amber (moderate, worth reviewing), red (low confidence, manual edit recommended)
- [ ] Store `auto_edit_params`, `auto_edit_reasoning`, `auto_edit_confidence`, and `auto_edit_reviewed` columns in the `photo_edits` D1 table alongside the final `edit_params` — preserve the original suggestion even after the admin modifies it

### Learning from admin feedback
- [ ] Track which auto-edit suggestions the admin accepts as-is vs. modifies vs. discards — store deltas (diff between suggested params and final params) in a `photo_edit_feedback` table in D1
- [ ] Periodically summarize accepted edits by scene type and feed them back into the Claude prompt as few-shot examples ("for this photographer, interior shots typically get +0.4 exposure and +12 shadows — here are 5 examples") to align the auto-edit output with the photographer's house style over time
- [ ] Expose a "Style profile" summary in `gallery-admin.html` showing the average adjustments the admin makes per scene type — useful for understanding and communicating the house look

### Cost & performance
- [ ] Downscale photos to 800px long edge before sending to Claude API — reduces token cost significantly vs. full resolution; color and tonal analysis does not require full resolution
- [ ] Cache auto-edit results in D1: if the same `photo_id` has already been analyzed and the source file hasn't changed, return the cached recommendation without another API call
- [ ] Estimate cost at roughly $0.003–0.006 per photo at claude-opus-4-7 vision pricing for an 800px image — for a 300-photo gallery, ~$1–2 per auto-edit run; display an estimated cost to the admin before triggering "Auto Edit All"
- [ ] Add `ANTHROPIC_API_KEY` to the list of Cloudflare Worker secrets (set in Cloudflare dashboard → Worker → Settings → Variables)

---

## 25. Photo License Enforcement & Monitoring

**Goal:** Deter misuse of purchased photos and enable discovery of violations through invisible watermarking, metadata embedding, a public license lookup URL, and automated reverse image search monitoring. Cannot prevent misuse of delivered digital files, but makes violations traceable and creates strong deterrents.

### Invisible watermarking (steganographic)
- [ ] Add invisible watermark injection to the purchase delivery pipeline — run before the download file is generated; embed buyer's `license_id` and `user_email` into the pixel data using the `invisible-watermark` Python library (runs in the same Docker container on the NAS already planned for Sharp photo editing)
- [ ] The embedded watermark survives JPEG re-compression and moderate resizing — if the photo appears somewhere unauthorized, extract the watermark to identify the buyer and license held
- [ ] Add a Worker endpoint `POST /licenses/extract-watermark` (admin-only, behind item 4 auth) that accepts an uploaded image, sends it to the NAS Docker container for watermark extraction, and returns the embedded `license_id` — used to investigate suspected violations
- [ ] Add a note to the purchase confirmation email and license certificate: "This image is digitally fingerprinted with your license ID" — acts as a deterrent without being adversarial

### EXIF/XMP metadata injection
- [ ] Inject license metadata into every delivered file via Sharp before download — write to the following fields:
  - `IPTC:CopyrightNotice` → "© Coastal Travel Company — Licensed to [Buyer Name], [Purchase Date]"
  - `IPTC:RightsUsageTerms` → plain-English permitted uses for the purchased license tier
  - `XMP:WebStatement` → `https://coastaltravelcompany.com/verify/[license-id]`
  - `XMP:UsageTerms` → same as IPTC rights string
- [ ] Metadata travels with the file in most professional workflows (Photoshop, Lightroom, InDesign, stock agency submissions) — puts any downstream user on notice that the file is licensed and traceable

### License lookup page
- [ ] Build a public `/verify/{license-id}` page — no login required, returns: buyer display name (first name + last initial), purchase date, license type, permitted uses, geographic scope, duration, and current status (active / expired / revoked)
- [ ] Worker reads license record from D1 `photo_purchases` table on each request — include the URL in EXIF metadata and on the license certificate so it travels with the file
- [ ] Add a `GET /verify/{license-id}` JSON endpoint alongside the HTML page for programmatic verification (publishers and stock agencies sometimes check programmatically)
- [ ] If a license ID is not found or has been revoked, return a clear "No valid license found" response — useful when investigating suspected unauthorized use

### Automated reverse image search monitoring
- [ ] Set up a Cloudflare Worker cron trigger (runs weekly) that submits each active store photo to the **TinEye API** — compares against TinEye's index of billions of web images and returns any matches
- [ ] For each match found: look up the matched URL's domain against the `photo_purchases` D1 table — if the domain matches a buyer's declared use case, flag as likely compliant; if no matching license exists, flag as potential violation and email admin via Resend
- [ ] Evaluate **Pixsy** or **Copytrack** as managed alternatives to the custom TinEye integration — both continuously crawl the web, identify unauthorized uses, and can initiate takedowns or compensation claims; recommended for ongoing production use once the store has meaningful volume
- [ ] Store monitoring results in a `license_monitoring` D1 table: `photo_id`, `match_url`, `match_domain`, `detected_at`, `matched_license_id` (nullable), `status` (compliant / potential_violation / resolved / ignored)
- [ ] Add a "License monitoring" panel in `gallery-admin.html` showing recent matches, their status, and quick actions (Mark compliant / Send takedown notice / Ignore)

---

## 26. Employee Email Addresses (@coastaltravelcompany.com)

**Goal:** Set up professional email addresses on the company domain for any employees or contractors — replaces personal Gmail/etc. addresses for client-facing communication.

- [ ] Choose an email host: **Google Workspace** (familiar UI, integrates with Google Meet/Drive, ~$6/user/month) or **Cloudflare Email Routing** (free, forwards to an existing inbox — good for a small team that doesn't need a separate mailbox) or **Microsoft 365** (~$6/user/month, includes Office apps)
- [ ] Add the required DNS records for the chosen provider (MX, SPF, DKIM, DMARC) — these go in the Cloudflare DNS dashboard for `coastaltravelcompany.com`
- [ ] Create addresses for each employee/role (e.g. `will@coastaltravelcompany.com`, `hello@coastaltravelcompany.com`)
- [ ] Update the contact form delivery address and any Resend sending addresses to use the new domain emails
- [ ] Add DMARC reporting (`rua=mailto:...`) so you can monitor for spoofing of the domain

---

## 27. Update Gallery Admin Form

**Goal:** Update to remove and add form values in the Gallery Admin page.

- [ ] Remove 'Client Name' in 'Create New Gallery'.  This is not required as the site administrator will link photo albums to client accounts.
- [ ] Add Name to the 'Client Accounts' creation section.  Also add name to required fields in the register account page.

---

## 28. Enhance watermark capabilities

**Goal:** Update watermark capabilities so once a gallery is created noted with watermark capabilities it queues all items to be watermarked.  A worker works through the items to watermark, watermarks them, then uploads them to a new synology album for a watermarked version of the album.

---

## 29. Enhance Gallery Admin 

**Goal:** Fix any issues associated with the gallery admin page.

- [ ] Auth method is shown as Google Only in the UI, however these users can login with password auth + google.  Also, how is Google Only being determined?  thecoastaltravelcompany@gmail.com has not logged in with google auth but it says auth method google only. 


---

## 30. Customer Photo Sharing

**Goal:**  Allow customers to be able to share photo albums to 5 users which send them an email invite.  ensure only the primary associated users with an album set by the administrator is able to share the album with users.  Allow the primary associated user to revoke the share, and see if the user has accepted the share invitation or if it is still pending.  Show all of this activity in the gallery-admin page for admins to see.


---

## 31. Physical/Digital Business Cards

**Goal:**  Create a physical and digital business card for employees of Coastal Travel Company.

- [ ] Physical cards are created
- [ ] Digital cards are created
- [ ] QR codes on cards route through the site where we are able to track through website analytics


---

## 32. Website analytics

**Goal:**  How are people finding the site?  What actions do users take on the site?  Why do users not move forward with inquiry/booking?

1. Goals & Success Metrics
The analytics implementation should answer these core business questions:

How are people finding the site?
What pages are they visiting and in what order?
Are they taking action (contacting, booking, submitting a form)?
Where are they dropping off?
What devices and locations are visitors coming from?

2. Analytics Platform
Primary: Google Analytics 4 (GA4)

Free, industry standard, integrates with Google Search Console
Tracks pageviews, sessions, events, and conversions
Required: Create a GA4 property and embed the tracking snippet in all HTML pages

Secondary (Optional): Cloudflare Web Analytics

Already available in your Cloudflare dashboard at no cost
Privacy-friendly, no cookies, GDPR-compliant out of the box
Good for a high-level traffic overview without setup complexity
Enable under Cloudflare Dashboard → Web Analytics

Recommendation
Use both: Cloudflare for a quick daily pulse, GA4 for deeper analysis.

3. Core Tracking Requirements
3.1 Pageview Tracking

Track every page visit with URL, page title, and referrer
Capture entry pages (where visitors land first)
Capture exit pages (where visitors leave)

3.2 Traffic Source Tracking

Organic search (Google, Bing)
Direct (typed URL, bookmarks)
Social media (Facebook, Instagram)
Referral (other sites linking to you)
UTM parameter support for campaigns (e.g. business card QR code link)

3.3 Conversion / Goal Tracking
Track these as key conversion events:
EventTriggercontact_clickUser clicks phone number or email linkform_submitUser submits a contact/inquiry formbooking_clickUser clicks any booking or inquiry CTA buttonsocial_clickUser clicks a social media linkqr_scan_landingVisitor arrives via /card or UTM source businesscard
3.4 Engagement Tracking

Time on page
Scroll depth (25%, 50%, 75%, 100%)
Bounce rate per page

4. UTM Campaign Tracking
To measure how well your business card QR code is performing:

QR code should link to:
https://coastaltravelcompany.com/?utm_source=businesscard&utm_medium=qr&utm_campaign=networking
This lets GA4 show you exactly how many visitors came from your physical card

5. Search Console Integration

Set up Google Search Console and link it to GA4
Verifies site ownership with Google
Shows which search keywords are bringing visitors to your site
Identifies any crawl errors or indexing issues

6. Implementation Requirements (Static Site / GitHub Pages)
Since the site is static HTML on GitHub Pages, all tracking is client-side:
GA4 Snippet
Add to the <head> of every HTML page:
html<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
Event Tracking Example (Contact Click)
html<a href="tel:+15551234567"
   onclick="gtag('event', 'contact_click', { method: 'phone' });">
   Call Us
</a>
Google Tag Manager (Optional but Recommended)

Deploy GTM instead of raw GA4 snippets
Lets you add/modify tracking without editing code and redeploying to GitHub
One GTM snippet in <head>, manage all tags from the GTM dashboard

7. Privacy & Compliance

Add a Privacy Policy page disclosing use of Google Analytics
Consider a cookie consent banner (required for EU visitors under GDPR)

Simple option: Cookieyes.com free tier


GA4 has IP anonymization enabled by default
Cloudflare Web Analytics is cookieless and GDPR-compliant with no extra configuration


8. Reporting & Alerting
Weekly Check (5 min)

Sessions, top pages, top traffic sources
Any conversion events fired?

Monthly Review

Traffic trends vs. prior month
Top landing pages
QR code / business card traffic (UTM report)
Search Console: top queries, click-through rates

Alerts to Configure in GA4

Spike in traffic (potential viral moment or bot traffic)
Drop in sessions > 30% week-over-week


9. Future Enhancements (Phase 2)

Heatmaps via Microsoft Clarity (free) — see where users click and scroll
A/B testing via Google Optimize or Cloudflare Pages experiments
CRM integration — connect form submissions to a CRM (HubSpot free tier)
Booking funnel tracking — if a booking flow is added later


10. Acceptance Criteria

 GA4 property created and snippet deployed on all pages
 Cloudflare Web Analytics enabled
 Google Search Console verified and linked to GA4
 Conversion events firing correctly (verified in GA4 DebugView)
 UTM link generated for business card QR code
 Privacy Policy page published
 Baseline report captured (first 30 days of data)

---


## ~~33. Admin User Role Management~~ ✅ Done

**Goal:** Allow admins to promote a client account to admin or demote an admin account back to client directly from the admin panel — no manual database edits or Worker redeploys required.

- [x] Add a "Role" column to the user list in `admin/galleries.html` — shows each account's current role (`client` or `admin`) as a badge
- [x] Add a role toggle control per user row — a dropdown or toggle button that lets an admin switch a user between `client` and `admin`; the control is disabled for the currently logged-in admin to prevent self-demotion
- [x] Add a Worker endpoint `PATCH /admin/users/:userId/role` — accepts `{ role: "client" | "admin" }`, validates that the requesting user is an admin, rejects attempts to change one's own role, updates the user record in KV, returns the updated user object
- [x] Confirm the role change with a brief in-UI prompt ("Promote [name] to admin? They will gain full admin access.") before submitting — prevents accidental promotions
- [x] Reflect the new role immediately in the UI after a successful response — no page reload required
- [x] Emit an activity log entry in the pipeline for the role change: timestamp, acting admin, affected user, old role, new role — stored in D1 for audit purposes (`worker/migrations/012_user_role_audit.sql`)
- [x] Send an email notification to the affected user via Resend when their role changes ("Your account has been updated to [role] by an administrator")

---

## ~~34. Migrate Production Hosting from GitHub Pages to Cloudflare Pages~~ ✅ Done

**Goal:** Move the production static site from GitHub Pages to Cloudflare Pages to match the preprod setup — single hosting platform, faster global CDN, unified deployment pipeline, and no single-custom-domain limitation.

- [x] Create a Cloudflare Pages project for production (connected to the `master` branch, output dir: `site`) via the `create-pages-preprod.yml` workflow pattern or Cloudflare dashboard
- [x] Add `coastaltravelcompany.com` and `www.coastaltravelcompany.com` as custom domains on the Cloudflare Pages project
- [x] Verify DNS: update or confirm the `coastaltravelcompany.com` CNAME/A record in Cloudflare points to the Pages project URL instead of GitHub Pages
- [x] Remove the `CNAME` file from `site/` — Cloudflare Pages uses its own domain config; the file is only needed for GitHub Pages
- [x] Remove the `deploy-pages` job from `.github/workflows/deploy.yml` and replace with `deploy-site` using `wrangler pages deploy`; `acceptance-tests` depends on `deploy-site`
- [x] Confirm acceptance tests still run after the deploy job is restructured — `acceptance-tests` runs after `deploy-site` in `deploy.yml`; also runs on PRs via `acceptance-tests.yml`
- [x] Verify the production site loads correctly at `coastaltravelcompany.com` after cutover
- [x] Monitor for any caching or redirect issues (www → apex, HTTP → HTTPS) — Cloudflare Pages handles these automatically when the domain is proxied

---

## ~~35. Fix Mobile Menu Focus on Scroll~~ ✅ Done

**Goal:** Fix the mobile navigation menu so that menu items remain visible and focused on screen when the user opens the menu and then scrolls before clicking anything.

- [x] Investigate `main.js` mobile nav toggle behavior — overlay was already `position: fixed` but body scroll was not locked
- [x] Add `document.body.style.overflow = 'hidden'` on menu open and restore it on close — prevents the page from scrolling behind the overlay, which would shift the mobile browser toolbar and push menu items off-screen
- [x] Refactored toggle into `openMobileMenu()` / `closeMobileMenu()` helpers so both the toggle button and link-click handler share the same teardown logic
- [x] Add hamburger → X CSS animation on `.nav-toggle.open` so users have a clear affordance to close the menu

---

## 36. Resolve npm Dependency Vulnerabilities in Worker

**Goal:** Eliminate the 5 known vulnerabilities in `worker/package.json` (4 moderate, 1 high).

- [ ] **undici — CRLF Injection (high):** [GHSA-4992-7rv2-5pvq](https://github.com/advisories/GHSA-4992-7rv2-5pvq) — present via `miniflare` → `undici`
- [ ] **ws — Uninitialized memory disclosure (moderate):** [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) — present via `miniflare` → `ws`
- [ ] Fix requires upgrading `wrangler` to ≥ 4.93.0 (`npm audit fix --force` in `worker/`) — test for breaking changes before merging
- [ ] Verify worker deploys and acceptance tests pass after the upgrade

---

## 36. Fix Mobile Nav Menu Scroll Bug

**Goal:** The mobile nav menu should always display all header links when opened, regardless of scroll position. Currently, if the user scrolls down the page first and then opens the menu, only half the headers are visible — the menu is offset by the scroll position and clipped by the viewport.

- [x] Investigate `main.js` mobile nav toggle logic — check whether the menu's height or max-height calculation accounts for the current scroll position
- [x] Check whether the mobile nav overlay is positioned `fixed` vs `absolute` — root cause was `backdrop-filter: blur(8px)` on `nav.scrolled` making `nav` the containing block for `position:fixed` children, clipping the overlay to the nav bar height; fixed by setting `nav.style.backdropFilter = 'none'` on open and clearing it on close
- [x] Verify the body scroll-lock behavior when the nav is open — scroll-lock (`document.body.style.overflow = 'hidden'`) was already in place and working correctly

---

## 37. Hybrid data load approach

**Goal:** Use the NAS as the primary backup/archive for all original files. Serve active gallery thumbnails, static site assets, and splat files from Cloudflare R2 to reduce NAS load and improve global delivery performance.

### Phase 1 — R2 infrastructure

- [ ] Create R2 bucket `ctc-assets` in the Cloudflare dashboard; add a second bucket `ctc-assets-preprod` for staging
- [ ] Bind both buckets in `wrangler.toml`: `ASSETS` binding for prod, preprod environments respectively
- [ ] Define the key-space layout:
  - `site/` — static site assets (CSS, JS, public images); compare with Cloudflare Pages CDN to decide if migration is worth it
  - `galleries/{passphrase}/thumbs/{id}.jpg` — active gallery thumbnails cached from NAS
  - `splats/{slug}/scene.splat` — 3D splat files
  - NAS remains the source-of-truth for originals; R2 holds hot/cached copies only

### Phase 2 — NAS → R2 sync

- [ ] Write `worker/scripts/sync-gallery-to-r2.sh`: enumerate active galleries from D1, download thumbnails from NAS via `nas.coastaltravelcompany.com` using the existing `sharing_sid` flow, upload to R2 using `wrangler r2 object put`
- [ ] Add a `r2_synced BOOLEAN DEFAULT 0` column to the `galleries` table in a new D1 migration (`worker/migrations/NNN_r2_synced_flag.sql`)
- [ ] Add a GitHub Actions workflow `sync-gallery-to-r2.yml` (manual `workflow_dispatch` trigger initially; scheduled `cron` trigger once validated) that runs the sync script and marks galleries as synced in D1

### Phase 3 — Worker routing changes

- [ ] In `worker/src/router.js`, for thumbnail and download requests: check D1 `r2_synced` flag for the session's gallery; if true, serve from R2 directly (R2 `get` binding); if false, fall back to the existing NAS proxy path
- [ ] Add a `Cache-Control: public, max-age=86400` header to R2-served responses; keep NAS proxy responses non-cached
- [ ] Add a custom response header `X-Asset-Source: r2 | nas` for observability

### Phase 4 — Acceptance test

- [ ] Add Playwright test: create a gallery in admin (preprod env), trigger sync, load gallery page, confirm thumbnail responses include `X-Asset-Source: r2`

---

## 38. Add Real Estate client type

**Goal:** Expand the platform to support real estate agents as a distinct client type. Agents get per-property virtual tour pages, photo gallery integration, 3D splat walkthrough embeds, Zillow/Redfin data linking, and privacy-compliant aggregate analytics — all managed from their portal.

### Phase 1 — Data model (D1 migrations)

- [ ] `worker/migrations/NNN_client_type.sql` — add `client_type TEXT NOT NULL DEFAULT 'standard' CHECK(client_type IN ('standard','real_estate'))` to the `users` table
- [ ] `worker/migrations/NNN_properties.sql` — create `properties` table:
  ```sql
  id TEXT PRIMARY KEY,
  agent_user_id TEXT NOT NULL REFERENCES users(id),
  address TEXT NOT NULL,
  mls_number TEXT,
  zillow_url TEXT,
  redfin_url TEXT,
  splat_r2_key TEXT,          -- R2 key of the uploaded .splat file
  hotspots_json TEXT,         -- JSON array of {label, x, y, z, note} hotspot objects
  lead_gate_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ```
- [ ] `worker/migrations/NNN_property_galleries.sql` — create `property_galleries` join table: `property_id, passphrase, display_order`; one property can draw photos from multiple galleries
- [ ] `worker/migrations/NNN_property_analytics.sql` — create `property_events` table:
  ```sql
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id TEXT NOT NULL REFERENCES properties(id),
  session_id TEXT NOT NULL,   -- client-generated crypto.randomUUID(); no IP or device stored
  event_type TEXT NOT NULL CHECK(event_type IN ('view','room_enter','hotspot_click','lead_capture')),
  room_label TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ```
- [ ] `worker/migrations/NNN_property_leads.sql` — create `property_leads` table: `id, property_id, email, session_id, created_at`; email is PII — only insert after explicit opt-in

### Phase 2 — Worker API endpoints (`worker/src/router.js`)

- [ ] `POST /re/properties` — create property; requires `client_type = 'real_estate'`; returns `{id}`
- [ ] `GET /re/properties` — list the authenticated agent's properties with pre-aggregated stats: `total_views`, `avg_dwell_ms`, `engagement_rate` (% of sessions with ≥ 3 `room_enter` events or any `hotspot_click`)
- [ ] `PATCH /re/properties/:id` — update `address`, `mls_number`, `zillow_url`, `redfin_url`, `hotspots_json`, `lead_gate_enabled`, `status`; owner-only
- [ ] `GET /re/properties/:id/analytics` — return room engagement breakdown:
  ```json
  { "rooms": [{ "label": "Kitchen", "views": 450, "avg_duration_ms": 75000 }],
    "total_views": 620, "avg_dwell_ms": 180000, "engagement_rate": 0.62 }
  ```
  Computed from `property_events` with a single aggregating SQL query; no raw event rows returned
- [ ] `POST /re/properties/:id/events` — ingest analytics events from the tour page; validates `session_id` is a UUID, `event_type` is in the allowed set; rejects any fields beyond the schema (no freeform data); rate-limited 60 events/session/minute via KV
- [ ] `POST /re/properties/:id/leads` — store lead email; requires consent flag `{ email, consent: true }` in body; sends notification email to agent via Resend; returns 400 if `consent !== true`
- [ ] `GET /re/properties/:id/report` — returns HTML with print CSS (Coastal Travel Co. branding, property photo, stats table, Actionable Insight blurb); agent prints to PDF from browser

### Phase 3 — Property page (`site/property/property-page.html`)

- [ ] Build property page template: hero photo (largest photo from linked gallery), splat viewer (iframe to a self-hosted or third-party splat renderer using `splat_r2_key` URL), photo gallery grid (reuse `client-gallery.html` component or a lightweight subset), Zillow/Redfin embed section (iframe with sandbox), agent branding footer
- [ ] Property page URL scheme: `https://coastaltravelcompany.com/property/{id}` — page reads `id` from the URL path, calls `GET /re/properties/:id` (public endpoint, no auth required for viewing), renders content
- [ ] Analytics tracking: generate `session_id = crypto.randomUUID()` on page load, store in `sessionStorage`; fire `POST /re/properties/:id/events` with `{event_type:'view', session_id}` on load; fire `room_enter` events via `IntersectionObserver` on room-labeled sections; fire `hotspot_click` events on hotspot tap/click
- [ ] Consent gate: show a minimal cookie/tracking consent banner on first visit (before any events are sent); store consent as `sessionStorage.setItem('ctc_consent','granted')`; only call the events endpoint if consent is `'granted'`
- [ ] Lead capture gate: if `lead_gate_enabled` is true, show modal after 30 s of browsing with a form ("Enter your email to view full property specs"); submit to `POST /re/properties/:id/leads`; dismiss permanently in `sessionStorage` once submitted

### Phase 4 — Agent portal dashboard (`site/portal/real-estate.html`)

- [ ] Property list view: card grid, each card shows address, status badge, Pulse metrics (total views, avg dwell, engagement rate), links to detail view and public property page
- [ ] Property detail view: Room Engagement Table (room | views | avg time | trend indicator vs. a stored neighborhood benchmark average); Actionable Insight text block auto-generated from template strings (e.g. "Kitchen engagement is 30% above average — feature it in your next post")
- [ ] Hotspot Manager: display a thumbnail of the property hero photo with existing hotspots overlaid as draggable pins; click empty area to add new hotspot (label + note fields); save via `PATCH /re/properties/:id`
- [ ] Embed Link Generator: text input pre-filled with the `<iframe src="...">` embed code; "Copy" button uses `navigator.clipboard.writeText`
- [ ] QR Code Generator: use the `qrcode.js` library (CDN, no build step) to render a downloadable `<canvas>` QR code pointing at the property page URL; "Download PNG" button

### Phase 5 — Privacy & compliance (prerequisite for public launch)

- [ ] Complete item 39 (privacy policy) before any real estate property pages go live publicly
- [ ] `property_events` table must never store IP addresses, user agents, or device fingerprints — enforce at the Worker ingest endpoint (strip any extra fields, validate schema strictly)
- [ ] Add "Do Not Sell or Share My Personal Information" link in every property page footer, pointing to `privacy.html#do-not-sell`
- [ ] Consent banner on property pages (see Phase 3) must fire before any `POST /re/properties/:id/events` call; if consent is denied, no events are sent for that session

---

## 39. Create privacy policy

**Goal:** Publish an accurate, readable privacy policy page that satisfies CCPA minimum requirements and covers all data collected across the current platform and the planned real estate analytics feature. Required before real estate property pages launch publicly.

### Content — sections to include

- [ ] **What we collect and why** — for each data type below, state what is collected, why, and how long it is retained:
  - Contact form: name, email, message → forwarded to `thecoastaltravelcompany@gmail.com` via Resend; not stored server-side; retained by recipient's email client only
  - User accounts: email address, bcrypt-hashed password (or Google OAuth token), role — stored in D1 indefinitely until account deletion is requested
  - Gallery sessions: short-lived session token (UUID) in Cloudflare KV, 4-hour TTL; no IP address or browser fingerprint stored; photos fetched from NAS through Worker and not cached server-side
  - Booking/invoicing: name, email, invoice and contract data stored in D1; Stripe payment tokens (not card numbers — Stripe holds those)
  - Real estate analytics (when live): anonymized `session_id` (UUID generated in browser, stored in `sessionStorage` only), room engagement events, hotspot interactions — aggregate only, no PII, collected only with consent
  - Real estate lead capture (when live): email address submitted voluntarily by the visitor, shared only with the listing agent; not sold to third parties
- [ ] **Third-party services** — list each, link to their privacy policy, describe what data is shared with them:
  - Cloudflare (Pages, Workers, R2, KV, D1, Tunnel)
  - Resend (email delivery — contact form, notifications)
  - Google (OAuth login)
  - Stripe (payment processing)
  - Synology NAS (photo storage — self-hosted)
- [ ] **Cookies and local storage** — the site currently sets no cookies; `sessionStorage` is used for gallery tokens and analytics session IDs (cleared when the tab closes); `localStorage` is used in the admin panel for saved settings
- [ ] **Your rights (CCPA)** — right to know, right to delete, right to opt-out of sale/sharing; include `id="do-not-sell"` anchor for direct linking
- [ ] **How to contact us** — email address for privacy requests; target response time (e.g. 30 days)
- [ ] **Effective date and version** — include a "Last updated: YYYY-MM-DD" line at the top

### Implementation

- [ ] Create `site/privacy.html` — use the shared nav, `styles.css`, and footer pattern from `about.html`; no new styles required
- [ ] Add the footer privacy link to: `site/index.html`, `site/about.html`, `site/services.html`, `site/collections.html`, `site/contact.html`, `site/login.html`, `site/portal.html` — append `<a href="/privacy.html">Privacy Policy</a>` to each page's footer (or footer partial if one is extracted)
- [ ] Have the policy reviewed by a human before publishing — flag this in the PR description; tag with `needs-legal-review`

---

## 40. Create full real estate portal

**Goal:** Deliver the complete agent-facing portal (item 38 Phase 4) and the public property page (item 38 Phase 3) as a polished, shippable product with analytics, lead capture, PDF-ready reports, QR codes, and embed tooling. Items 38 and 39 are hard prerequisites — complete them first.

This item tracks the integration, polish, and acceptance testing work that goes beyond the individual feature implementation tasks in item 38.

### Integration checklist

- [ ] End-to-end flow works without errors: agent creates property in portal → adds photos from gallery → publishes → shares public URL → visitor views page → analytics appear in agent dashboard within 60 seconds
- [ ] Lead capture gate flow: visitor triggers gate → submits email with consent → agent receives Resend email notification → lead appears in portal (add `GET /re/properties/:id/leads` endpoint and a Leads tab in the detail view)
- [ ] R2 splat file upload: add a file upload field in the property create/edit form in the portal; `PUT` the file directly to R2 via a pre-signed URL (Worker generates with `ASSETS.createMultipartUpload` or `fetch` to R2 API); store the resulting key in `properties.splat_r2_key`

### PDF report

- [ ] `GET /re/properties/:id/report` returns a styled HTML page with `@media print` CSS: Coastal Travel Co. logo (use the existing brand colors and Gilda Display font), property address, hero photo, Pulse metrics summary, Room Engagement Table, Actionable Insight text, footer with "Generated by Coastal Travel Co." and the date
- [ ] Print CSS hides nav, sidebar, and all interactive controls; sets page size to Letter; forces `break-inside: avoid` on each section
- [ ] Test print-to-PDF in Chrome and Safari; confirm layout doesn't break across pages

### QR code generator

- [ ] Load `qrcode.min.js` from CDN (jsDelivr) in the portal; no build step
- [ ] Render QR code into a `<canvas>` in the portal's Embed & Share tab; target URL is the public property page (`https://coastaltravelcompany.com/property/{id}`)
- [ ] "Download PNG" button: `canvas.toBlob()` → object URL → `<a download="property-qr.png">` click; confirm download works on Chrome and Safari mobile

### Acceptance tests (Playwright)

- [ ] Real estate agent login → property creation → publish → confirm public property page renders (address, hero photo visible)
- [ ] Analytics event ingest: load property page, wait 1 s, confirm `POST /re/properties/:id/events` returns 200
- [ ] Lead capture: trigger gate, submit email, confirm `POST /re/properties/:id/leads` returns 200 and agent receives Resend email (mock Resend in preprod using test API key with delivery verification)
- [ ] Agent dashboard: navigate to property analytics tab, confirm Room Engagement Table renders with at least the seeded event data
- [ ] Embed & Share tab: confirm QR code canvas renders and Download PNG button produces a non-empty file

---

## 41. Expand Automated Test Coverage

**Goal:** Complement the existing Vitest unit tests (586 tests, 98.52% branch coverage) and Playwright acceptance tests with deeper integration, migration, and security testing layers that catch issues the mocked unit tests cannot.

### Wrangler integration tests
- [ ] Set up a Vitest test suite that boots the Worker via `wrangler dev --local` (Miniflare) against real local D1 and KV bindings — no mocks
- [ ] Cover the full auth flow end-to-end: register → verify email token → login → access protected route → logout
- [ ] Cover the gallery proxy flow: `POST /token` with a passphrase → receive `sid` → use `sid` on a downstream request → verify KV TTL behaviour
- [ ] Cover D1-backed CRUD paths for projects, invoices, contracts, and questionnaires against a real schema (not a mock `prepare()` chain)
- [ ] Add to CI: run integration tests on every push to `preprod` and on PRs targeting `preprod`

### D1 migration smoke tests
- [ ] Write a CI job that applies all migrations in `worker/migrations/` in order against a fresh in-memory SQLite database (via `wrangler d1 execute --local`) and asserts the resulting schema matches expected table/column definitions
- [ ] Detect migration conflicts early: the job fails if any migration breaks, leaving the schema in an unknown state
- [ ] Verify idempotency: run all migrations twice and assert no errors (all statements use `IF NOT EXISTS` / `IF NOT EXISTS` guards)
- [ ] Add the smoke test job to `.github/workflows/` so it runs on every PR that touches any file under `worker/migrations/`

### Security / auth boundary tests
- [ ] Add a dedicated Vitest suite (`tests/auth-boundaries.test.js`) that exhaustively verifies every Worker route returns the correct auth rejection status
- [ ] For every admin route: assert 401 with no token, 403 with a valid client token, and 200/201/etc. with a valid admin token
- [ ] For every public route: assert the route is accessible without any token
- [ ] For every portal route: assert 401 with no token and 200 with a valid client token
- [ ] Cross-check the route list against `router.js` programmatically so new routes can't be added without a corresponding auth boundary test
- [ ] Add JWT tampering tests: expired token → 401, wrong secret → 401, role field removed from payload → appropriate rejection

---

## 42. End-to-end email testing via mailbox capture service

**Goal:** Verify that every Resend email (verification, password reset, invoice send, contract send, contact form) is actually delivered with the correct content — something unit tests cannot do because they stub `fetch`. Use a mailbox capture service so real SMTP delivery is exercised in the preprod Playwright suite without relying on real inboxes.

### Why this matters

Unit tests assert that the Worker calls `fetch('https://api.resend.com/emails', ...)` with the right shape. They do not verify that Resend accepts the request, that the API key is valid, that the `from` domain is verified, or that the rendered HTML is well-formed. A misconfigured Resend account or a broken email template would pass all unit tests and only be caught by a human during manual preprod testing.

### Recommended approach: Mailosaur

[Mailosaur](https://mailosaur.com) provides dedicated SMTP/API inboxes per test run. Each inbox has a deterministic address (`<anything>@<server-id>.mailosaur.net`) that can be polled via their REST API immediately after sending. It integrates cleanly with Playwright and has a Node.js SDK.

Alternative options in rough priority order:
1. **Mailtrap** — similar inbox-capture model, generous free tier, good Node SDK
2. **Resend test mode** — Resend itself supports a test API key that records sends without delivering; no external service needed but you can only assert the API accepted the request, not inspect the rendered HTML
3. **Ethereal Email** — free, nodemailer-based, good for one-off smoke tests but no persistent inboxes

### Setup steps

- [ ] **Choose and configure the service** — sign up for Mailosaur (or Mailtrap) and create a preprod server/inbox; store the API key as a GitHub Actions secret (`MAILOSAUR_API_KEY`) and as a Cloudflare Worker secret on `coastal-gallery-proxy-preprod`
- [ ] **Route preprod emails to the capture inbox** — in the Worker, check `env.EMAIL_CAPTURE_DOMAIN`; if set, rewrite all `to` addresses to `<original-local-part>@<EMAIL_CAPTURE_DOMAIN>` before calling Resend. This ensures no real email is sent from preprod while still exercising the full Resend code path
- [ ] **Add `EMAIL_CAPTURE_DOMAIN` to preprod Worker secrets** — set to the Mailosaur server inbox domain (e.g. `abc123.mailosaur.net`)
- [ ] **Install Mailosaur Node SDK** — `npm install --save-dev mailosaur` in the `tests/e2e` package; add to the Playwright project

### Playwright test coverage

- [ ] **Verification email** — register a new account using a `@<server>.mailosaur.net` address; poll Mailosaur API until the verification email arrives (timeout 10 s); assert subject line, presence of the verify link, and that clicking the link marks the account verified
- [ ] **Password reset email** — trigger reset for an existing preprod account; poll for reset email; assert the reset link is present and functional
- [ ] **Invoice send** — admin creates and sends an invoice to a capture address; poll for email; assert it contains the invoice total and payment link URL
- [ ] **Contract send** — admin sends a contract to a capture address; poll for email; assert it contains the signing link URL
- [ ] **Contact form** — submit the contact form; poll for the notification email sent to `thecoastaltravelcompany@gmail.com` (rewritten to capture inbox in preprod); assert subject and sender name appear in the body

### CI integration

- [ ] Pass `MAILOSAUR_API_KEY` and `EMAIL_CAPTURE_DOMAIN` to the `acceptance-tests` GitHub Actions job via `env:` (sourced from repository secrets)
- [ ] Gate the email assertions on `!!process.env.MAILOSAUR_API_KEY` so local runs without the secret skip gracefully rather than failing
- [ ] Add a note to the preprod test checklist in `CLAUDE.md` confirming that email capture tests run automatically — remove the manual "verify email link works" steps that are now automated

---

## 43. Close Playwright e2e coverage gaps

**Goal:** Eliminate the remaining test gaps where a silent production failure would only be caught by a human during manual preprod testing. Ranked by risk — highest-impact items first.

### Stripe webhook completion

Currently `invoice.spec.js` tests the Stripe checkout redirect but stops there. The webhook handler (`POST /stripe/webhook`) is what marks the invoice paid and advances the project stage; if it breaks, Stripe payments succeed but the app never updates.

- [ ] Use the [Stripe CLI](https://stripe.com/docs/stripe-cli) (`stripe trigger checkout.session.completed`) in CI to fire a realistic webhook event against the preprod Worker
- [ ] Assert the invoice status changes from `sent` → `paid` in the D1 `invoices` table after the webhook fires
- [ ] Assert the corresponding project stage advances to `Retainer Paid` in the pipeline view
- [ ] Add `STRIPE_CLI_API_KEY` to GitHub Actions secrets and install `stripe` CLI in the acceptance-tests job

### Admin countersigning

`contract.spec.js` ends at `client_signed` with the "waiting for admin" banner. The admin countersign step and the resulting `fully_executed` state are not exercised end-to-end.

- [ ] Extend `contract.spec.js`: after client signs, log in as admin, navigate to the project contracts tab, click countersign
- [ ] Assert the contract status advances to `fully_executed`
- [ ] Assert both signatures and the full audit trail render on the public contract view
- [ ] Assert both parties receive confirmation emails (gate behind `MAILOSAUR_API_KEY` per item 42)

### Password reset full flow

`register.spec.js` confirms the registration success message but never follows the `/auth/verify?token=...` link. The reset flow has zero Playwright coverage.

- [ ] Add a test that registers, intercepts (or reads from KV via Worker test helper) the verify token, navigates to the verify URL, and asserts the account becomes loginable
- [ ] Add a test for the full reset path: trigger reset → receive email → follow reset link → set new password → log in with new password (gate email delivery step behind `MAILOSAUR_API_KEY` per item 42)

### Google OAuth login

No e2e test exercises the Google Sign-In button. A broken `GOOGLE_CLIENT_ID` secret or a changed authorized-origin list would be invisible to CI.

- [ ] Add a Playwright test that stubs `POST /auth/google` at the network layer (Playwright `route()`) to return a fixture JWT — avoids needing real Google credentials in CI
- [ ] Assert the stub response stores a JWT in `localStorage` and redirects to `/portal.html`
- [ ] Add a separate note in the preprod checklist that a human should verify real Google login quarterly (the stub test only covers the frontend wiring, not Cloudflare ↔ Google token verification)

### Walkthrough CRUD

The walkthroughs feature (`GET/POST/PUT/DELETE /admin/walkthroughs`, `GET /public/walkthroughs`) has zero Playwright coverage.

- [ ] Add `tests/e2e/walkthroughs.spec.js` covering: admin creates a walkthrough, it appears in the public list, admin updates it, admin deletes it
- [ ] Assert the public `/public/walkthroughs` endpoint returns the walkthrough without auth

### Admin user management and gallery assignment

No e2e test exercises the Users tab in the admin panel.

- [ ] Add a test that creates a new client user via the admin UI, assigns a gallery to them
- [ ] Log in as the new client and assert the assigned gallery appears in their portal
- [ ] Assert a gallery removed from the user no longer appears in their portal

### Automation settings

The automations page has no Playwright test.

- [ ] Add `tests/e2e/automations.spec.js`: admin toggles an automation on, confirms the enabled state persists after page reload, toggles it off
- [ ] Assert `GET /admin/automation-logs` renders the log table (can be empty — just confirm the page doesn't error)

### Router-based e2e coverage enforcement

Add a CI script that derives the required test surface from `router.js` directly, so new endpoints cannot be shipped without either a spec reference or an explicit exemption — no manually maintained manifest required.

- [ ] Write a Node script (`tests/e2e/scripts/check-route-coverage.js`) that parses all route patterns out of `worker/src/router.js` (regex over the `pathname.match(...)` and `pathname ===` lines) and builds a list of canonical route signatures (e.g. `GET /admin/walkthroughs`, `POST /admin/projects/:id/invoices`)
- [ ] For each route signature, search all `tests/e2e/**/*.spec.js` files for a reference — either a literal path string, a path-building expression that matches the pattern, or an explicit coverage annotation comment (`// covers: GET /admin/walkthroughs`) for routes tested indirectly
- [ ] Any route with zero references fails the script with a non-zero exit code and prints the uncovered routes
- [ ] Maintain a small allowlist in the script for routes that are intentionally excluded from e2e testing (e.g. `POST /stripe/webhook` — covered by Stripe CLI test separately; `POST /auth/google` — stubbed via `page.route()`)
- [ ] Add the script as a step in the `acceptance-tests` GitHub Actions job: run it after the Playwright suite so failures are reported alongside test output
- [ ] Use pattern matching (not string equality) when comparing route signatures to spec references — a spec hitting `/admin/projects/proj-123` should satisfy the `GET /admin/projects/:id` route
