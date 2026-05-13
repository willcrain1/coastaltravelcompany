# Coastal Travel Company — To-Do

Items are ordered: necessary website fixes first, then by highest revenue impact.

---

## ~~0. Capture Live NAS Configuration~~ ✅ Done

- `cloudflared` container: standalone token-based container, no Docker Compose
- Tunnel ingress documented in `nas/cloudflare-tunnel/config.example.yml` and `nas/README.md` (single route: `nas.coastaltravelcompany.com` → `https://192.168.68.2:5001`, `noTLSVerify`)

---

## 1. Functional Contact Form

**Goal:** Form submissions on `contact.html` actually send an inquiry email instead of doing nothing.

- [x] Decided on Cloudflare Worker + Resend — `POST /contact` endpoint added to existing Worker
- [ ] **One-time setup:** Create Resend account → verify `coastaltravelcompany.com` domain (add DNS records) → copy API key → add `RESEND_API_KEY` as a Worker secret in Cloudflare dashboard (Worker → Settings → Variables & Secrets)
- [ ] **Fill in Worker URL:** set `WORKER_URL` constant at top of `main.js`
- [ ] Deploy Worker: `./worker/deploy-worker.sh`
- [ ] Confirm submissions arrive at `thecoastaltravelcompany@gmail.com` (reply-to is set to the submitter's email)

---

## 2. Real Watermarking

**Goal:** Photos downloaded by clients have Coastal Travel Company watermark burned in by Synology — not just a CSS overlay.

- [ ] Configure watermark in Synology Photos (gear icon → Watermark tab) — set text, position, opacity
- [ ] When creating a watermarked share in Synology Photos, enable "Add watermark to photos" on that share
- [ ] Update `dlUrl()` in `client-gallery.html`: when `cfg.watermark`, return `thumbUrl(photo, 'xl')` instead of `SYNO.Foto.Download` — this routes downloads through Synology's watermarked thumbnail path
- [ ] Re-enable download buttons for watermarked galleries (downloads are now safe — they carry the Synology watermark)
- [ ] Update watermark checkbox label in `gallery-admin.html` to explain the Synology requirement
- [ ] Test end-to-end: verify XL thumbnails from a watermark-enabled share have the watermark burned in

---

## 3. Synology-Level Album Password Protection

**Goal:** Gallery password set in the admin tool is enforced at the Synology Photos share level, not just client-side in the browser.

- [ ] Research Synology Photos sharing API — check if password protection can be set on a share via API (`SYNO.Foto.Sharing.Passphrase` or share creation endpoint)
- [ ] If API supports it: update Worker or `gallery-admin.html` to set the share password to match the admin-specified client password when generating a gallery link
- [ ] If API does not support it: update admin workflow instructions to remind admin to manually set the same password on the Synology share
- [ ] Verify that the Worker's session establishment (`/mo/sharing/{passphrase}`) works correctly when a share has a password set (may need to pass the password during session init)

---

## 4. OAuth Login & Per-User Gallery Access

**Goal:** Clients log in with email/password or Google, and see only their own galleries — no shared password links.

- [ ] Create Resend account, verify `coastaltravelcompany.com` domain for transactional email
- [ ] Get Google Client ID from Google Cloud Console (authorized JS origin: `https://coastaltravelcompany.com`)
- [ ] Set Worker secrets in Cloudflare dashboard: `JWT_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`
- [ ] Build login page (`/login.html`) — email/password form + Google Sign-In button
- [ ] Build client portal page (`/portal.html`) — shows galleries assigned to the logged-in user
- [ ] Add Worker auth endpoints: `POST /auth/login`, `POST /auth/google`, `POST /auth/reset-request`, `POST /auth/reset-confirm`, `POST /auth/logout`
- [ ] Store users, gallery assignments, and reset tokens in Cloudflare KV (`CTC_AUTH` namespace)
- [ ] Add user management to `gallery-admin.html` — create user, assign galleries, revoke access
- [ ] Protect `gallery-admin.html` behind admin auth
- [ ] Session tokens: 7-day JWT, stored in `localStorage`, validated by Worker on each request

---

## 5. Online Booking / Inquiry Workflow

**Goal:** Mirror HoneyBook's end-to-end client workflow — lead capture, pipeline management, branded proposals, intake questionnaires, scheduling, client portal, and automations — built custom on the existing Worker + D1 infrastructure so everything stays in one system.

### Lead & project pipeline
- [ ] Contact form submissions (item 1) feed into a lead inbox in `gallery-admin.html` with unread count badge
- [ ] Build a Kanban-style pipeline view with stages: **Inquiry → Proposal Sent → Contract Sent → Contract Signed → Retainer Paid → Active → Delivered → Complete**
- [ ] Each project card shows: client name, property, collection, shoot date, last activity, current stage, outstanding action (e.g. "Contract unsigned — 3 days")
- [ ] Per-project detail page: notes, labels/tags, activity log, all associated documents (proposal, contract, invoice, gallery) in one place
- [ ] Admin can add manual notes, set follow-up reminders with due dates, and log phone call outcomes
- [ ] Store projects in D1 `projects` table linked to `inquiries`, `users`, `bookings`, `galleries`

### Service packages & proposals
- [ ] Build a package library in `gallery-admin.html`: create reusable packages (The Editorial Stay, The Fashioned Weekend, The Branded Journey, etc.) each with name, description, inclusions list, hero photo, base price, and available add-ons
- [ ] Add-on options admin can attach to any package: rush delivery, extra edited images, video reel, 3D walkthrough (item 8), extended license, additional half-day
- [ ] Send a branded proposal to a lead: select 1–3 packages for side-by-side comparison, add a personalized cover note, set an expiry date
- [ ] Client opens proposal at `/proposal/{id}` — sees branded layout (Coastal design system), browses packages, selects one, checks desired add-ons, and clicks "Let's do this"
- [ ] Track proposal analytics: opened timestamp, time spent, number of views — stored in D1, shown in admin pipeline view
- [ ] On client selection, automatically advance project stage to "Contract Sent" and trigger contract workflow (item 6)

### Intake questionnaires
- [ ] Build a questionnaire builder in `gallery-admin.html`: create reusable question sets with text, multiple choice, date, and file-upload field types
- [ ] Pre-booking questionnaire (sent with or after proposal): property name, address, property type (hotel / boutique / resort / vacation rental / private villa), number of spaces to shoot, key must-have shots, style references, logistics notes
- [ ] Post-booking / pre-shoot questionnaire (sent after contract signed): refined shot list, venue contact name/number, parking/access instructions, mood board upload, any restrictions
- [ ] Client completes questionnaires at `/questionnaire/{id}` — accessible via magic link, no login required
- [ ] Responses stored per project in D1, displayed on the project detail page; admin receives email notification via Resend when a questionnaire is submitted

### Scheduling
- [ ] Admin sets weekly availability windows in `gallery-admin.html` (e.g. Mon–Fri, 9am–5pm, blocked dates synced from availability calendar item 13)
- [ ] Discovery call scheduling: send client a link to pick a 30-minute slot; on confirmation, both parties receive a calendar invite via email (ICS attachment via Resend)
- [ ] Shoot date confirmation: admin selects confirmed shoot date(s) on the project, client receives confirmation email with date, address, and pre-shoot questionnaire link
- [ ] Shoot dates automatically block the availability calendar (item 16)

### Client portal
- [ ] Every project has a dedicated portal at `/portal/{project-id}` — accessible via auth (item 4) or a single-use magic link emailed to the client
- [ ] Portal shows a visual timeline of the project lifecycle: Proposal → Contract → Invoice → Gallery — each step shows status (pending / action required / complete) and a direct link to the relevant document or action
- [ ] Messaging thread per project: client and admin exchange messages directly in the portal; admin receives email notification of new messages; full thread history stored in D1
- [ ] Client can view and download all signed documents, paid invoices, and the final gallery from one URL — no hunting through emails

### Automations
- [ ] Build a workflow engine in `gallery-admin.html`: admin can enable/disable pre-built automation triggers per project or globally
- [ ] **Inquiry received** → auto-reply email acknowledging receipt, send proposal within X hours (configurable delay) or queue for manual send
- [ ] **Proposal not opened** → follow-up email after 3 days ("Just checking in — I wanted to make sure you received the proposal for...")
- [ ] **Proposal not approved** → reminder after 7 days with a soft deadline ("The dates are filling up — happy to answer any questions before deciding")
- [ ] **Proposal approved** → auto-advance to "Contract Sent", send contract link (item 6)
- [ ] **Contract not signed** → reminder after 2 days
- [ ] **Contract signed** → auto-send deposit invoice (item 7), advance stage to "Retainer Paid" when deposit clears
- [ ] **Invoice due in 3 days** → payment reminder email
- [ ] **Final payment received** → thank-you email, stage advances to "Active"
- [ ] **Gallery delivered** → auto-send gallery link and access instructions, stage advances to "Delivered"
- [ ] **2 weeks post-delivery** → review request email (feeds into testimonials item 13)
- [ ] All automation emails use Resend with branded templates matching the Coastal design system

---

## 6. Document Signing & Contracts

**Goal:** Send, sign, and store legally binding contracts entirely within the platform — clients sign from any device without printing, scanning, or third-party accounts.

### Contract template builder
- [ ] Build a contract template editor in `gallery-admin.html` with a rich-text body and a library of merge fields: `{{client_name}}`, `{{property_name}}`, `{{collection}}`, `{{shoot_date}}`, `{{deliverables}}`, `{{total_fee}}`, `{{deposit_amount}}`, `{{deposit_due_date}}`, `{{balance_due_date}}`, `{{license_scope}}`, `{{license_duration}}`, `{{cancellation_policy}}`
- [ ] Create one default template per collection type (The Editorial Stay, The Fashioned Weekend, The Branded Journey) pre-populated with appropriate scope of work, deliverable list, and license terms
- [ ] Standard contract sections to include: scope of work, deliverables & timeline, fees & payment schedule, cancellation & rescheduling policy, licensing & usage rights, property release, limitation of liability, governing law
- [ ] Admin can preview a rendered contract with merged fields before sending

### Sending & signing flow
- [ ] Admin sends contract from the project detail page — Worker creates a contract record in D1, generates a unique signing URL, emails client via Resend
- [ ] Client opens `/contract/{token}` — sees a read-only rendered contract with a scroll-to-bottom requirement before the signature block activates (ensures the client has scrolled through the document)
- [ ] Signature capture options: (a) **type name** — rendered in a cursive font as a signature, (b) **draw** — mouse or touchscreen signature pad using Canvas API, (c) **upload image** — upload a signature image file
- [ ] Client submits: records their signature, name, date, and clicks "I agree and sign"
- [ ] Admin receives email notification of client signature with a countersign link
- [ ] Admin countersigns in `gallery-admin.html` using the same signature options — finalizes the contract
- [ ] On full execution, both parties receive a "Fully executed contract" email with a PDF attachment and a permanent download link

### Legal audit trail
- [ ] Each signing event (view, sign, countersign) records in D1: UTC timestamp, IP address, email address, browser user-agent string, and a hash of the document contents at signing time
- [ ] Certificate of completion appended to the PDF: lists all signing events with timestamps and IP addresses — meets legal requirements for e-signature validity in the US and EU (equivalent to DocuSign's evidence summary)
- [ ] Store signed PDFs in Cloudflare R2 keyed by contract ID — never deleted, accessible from client portal and admin indefinitely

### Integration option
- [ ] Evaluate Dropbox Sign (HelloSign) API as an alternative to the custom build above — provides jurisdiction-tested legal compliance, SMS authentication, and audit trail out of the box; trade-off is per-envelope cost (~$0.10–0.40/contract) vs. the custom build which is free per signing
- [ ] If using Dropbox Sign: store only the signature request ID and signed document URL in D1; Dropbox Sign hosts the audit trail

---

## 7. Billing & Invoicing

**Goal:** Send, track, and collect payment on invoices directly — no third-party tool required unless a full CRM (HoneyBook/Dubsado) is preferred.

- [ ] Evaluate approach: (a) Stripe Invoicing — send invoices via Stripe, client pays by card, automatic receipts; (b) HoneyBook/Dubsado — all-in-one with contracts, invoices, scheduling; (c) custom Worker + Stripe API
- [ ] If Stripe: set up Stripe account, configure invoice templates with Coastal Travel Company branding
- [ ] Add deposit/retainer collection to the booking flow (item 5) — charge a percentage at booking, remainder on delivery
- [ ] Add an invoices section to `gallery-admin.html` or the admin portal — create invoice, mark as paid, view status
- [ ] Send invoice links to clients via email (Resend, shared with auth infrastructure in item 4)
- [ ] Add invoice history to the client portal (item 4) so clients can view and download past invoices
- [ ] Handle sales tax if applicable (Stripe Tax can automate this)

---

## 8. 3D Property Walkthroughs (Gaussian Splatting)

**Goal:** Offer immersive, photorealistic 3D walkthroughs of hotel rooms, lobbies, and outdoor spaces as a premium deliverable — captured via Gaussian Splatting and embedded on the client portal and public portfolio.

### Capture
- [ ] Establish a capture workflow: record slow, overlapping video passes of the space (phone or mirrorless — 4K, steady movement, good exposure) or use a dedicated capture app (Luma AI mobile app is the lowest-friction starting point)
- [ ] Document lighting requirements: even ambient light, no harsh shadows or moving subjects during capture passes

### Processing
- [ ] Evaluate processing tools: **Luma AI** (cloud, fast, free tier) vs. **Postshot** (local GPU, high quality, paid) vs. **COLMAP + nerfstudio/3DGS** (open source, technical) — Luma AI is the recommended starting point for speed
- [ ] Output a `.splat` or `.ply` file per scene after processing
- [ ] Establish a naming convention and folder structure on the NAS for raw capture footage and processed splat files

### Hosting & Display
- [ ] Evaluate hosting options for `.splat` files: **SuperSplat** (PlayCanvas) for hosted/shareable scenes with iframe embed, vs. self-hosted viewer using `@playcanvas/splat` or `three-gaussian-splat` JS libraries, vs. Cloudflare R2 for file hosting with an open-source viewer on the site
- [ ] For portfolio use: embed SuperSplat-published scenes via `<iframe>` on `collections.html` or a new `/walkthroughs.html` page
- [ ] For client delivery: add a "3D Walkthrough" section to the client gallery (`client-gallery.html`) that loads the scene viewer when a splat URL is present in the gallery config
- [ ] Add `splat_url` (nullable) to the `galleries` table in D1 so walkthrough scenes are linked to their gallery delivery (see database architecture)

### Services & Portfolio
- [ ] Add "3D Walkthrough" as a deliverable option to `services.html` — position as a premium add-on to The Editorial Stay and similar property collections
- [ ] Build `/walkthroughs.html` as a showcase page: grid of property cards, each opening a full-screen splat viewer — use as a sales tool for prospective hotel clients
- [ ] Add walkthrough pricing to `faq.html` alongside print pricing

---

## 9. Print Ordering

**Goal:** Clients can order prints directly from their gallery — revenue opportunity and convenience for hotel/property clients who want wall art.

- [ ] Evaluate print lab integrations: WHCC and Printful both have APIs; Pixieset and Pic-Time are all-in-one solutions that include gallery + print store (worth comparing against building custom)
- [ ] If building custom: add "Order Print" button to the lightbox and photo hover state in `client-gallery.html`
- [ ] Build a print product selection flow — size, paper type, quantity — before handing off to the print lab
- [ ] Handle payment via Stripe (can be same Stripe account as billing/invoices in item 7)
- [ ] Print lab fulfills and ships directly to client — no inventory needed
- [ ] Add print pricing to `faq.html` and `services.html`
- [ ] Dependency: works best alongside the auth system (item 4) so order history is tied to a client account

---

## 10. Individual Photo Purchase (Digital Licensing Store)

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

## 11. Email Capture / Mailing List

**Goal:** Collect visitor emails for newsletters, availability announcements, or seasonal campaigns.

- [ ] Choose a provider — Mailchimp or ConvertKit (both have free tiers and embed forms)
- [ ] Add an email capture section to `index.html` — minimal, one-field form with a brand-appropriate headline (e.g. "Stay in the loop — new collections, destinations, availability")
- [ ] Optionally add a slide-in or footer capture on `contact.html` for visitors who don't submit the inquiry form
- [ ] Connect form to provider embed code or API
- [ ] Set up a welcome email in the provider dashboard that goes out automatically on signup

---

## 12. Video Reel / Showreel

**Goal:** Feature short-form video work prominently, since it's a core part of the collections offering.

- [ ] Upload reel to Vimeo (preferred over YouTube for clean embeds without ads/recommendations)
- [ ] Add a full-width video hero or reel section to `index.html` — autoplay muted loop for ambient effect, or a play-button overlay for the full reel
- [ ] Add video examples to `services.html` per collection (e.g. sample clip from The Fashioned Weekend)
- [ ] Ensure video does not autoplay with sound — muted autoplay is fine for hero, full reel should be user-initiated

---

## 13. Testimonials Page

**Goal:** Dedicated page (and homepage section) showing client reviews to build credibility with prospective hotel/property clients.

- [ ] Design and build `testimonials.html` — full-page layout with quotes, client name, property name, and optional photo
- [ ] Add a testimonials preview section to `index.html` (2–3 featured quotes with a "Read More" link)
- [ ] Add "Testimonials" to the main nav and footer links
- [ ] Populate with real client quotes
- [ ] Consider a pull-quote format with property name and collection type (e.g. "The Editorial Stay — The Grand Palms, Palm Beach") for specificity

---

## 14. Enhanced SEO & AI Search Visibility

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

## 15. Admin Content Editor (CMS)

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

## 16. Availability Calendar

**Goal:** Let prospective clients see open dates before reaching out, reducing low-intent inquiries.

- [ ] Choose an approach: simple manually-updated HTML calendar, or embed from a booking tool (syncs automatically if item 5 is implemented)
- [ ] Add to `contact.html` or a new `/availability.html` page
- [ ] Mark booked periods as unavailable, show open windows clearly
- [ ] Add a note about travel availability (available worldwide, lead time requirements)

---

## 17. Licensing Information

**Goal:** Make usage rights clear for commercial hotel/property clients — what they can and can't do with delivered photos.

- [ ] Build a licensing page (`/licensing.html`) covering: personal use vs. commercial use, print vs. digital, exclusivity options, duration, geographic scope, third-party sub-licensing
- [ ] Define license tiers per collection (e.g. The Editorial Stay includes X years of digital commercial use; extended licenses available for an additional fee)
- [ ] Add license summary to each collection on `collections.html` — short plain-English version with a link to the full licensing page
- [ ] Include licensing terms in the FAQ (item 19)
- [ ] Add licensing details to client delivery emails and the client portal (item 4) so clients have a permanent record
- [ ] Consider a simple license certificate PDF generated per delivery — client name, property, collection, usage rights, expiry

---

## 18. Before/After Editing Sliders

**Goal:** Demonstrate editing and retouching quality to commercial clients directly on the website.

- [ ] Choose 3–5 strong before/after pairs from real shoots
- [ ] Build or use a lightweight CSS-only or JS drag slider (no heavy library needed — a simple range input over two stacked images works well)
- [ ] Add a "The Edit" section to `services.html` or create a standalone `/editing.html` page
- [ ] Optionally embed one slider on the homepage as a visual hook

---

## 19. FAQ Page

**Goal:** Answer the most common pre-booking questions so clients arrive at the inquiry form already informed.

- [ ] Build `faq.html` with an accordion layout
- [ ] Cover: pricing / how collections are priced, what's included, licensing and usage rights, travel fees, turnaround time, how to book, what to expect on shoot day
- [ ] Add "FAQ" to footer nav
- [ ] Link to FAQ from the contact page ("Have questions? See our FAQ") and from the collections page

---

## 20. Photo Favorites / Proofing in Client Gallery

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

## 21. Video Support in Client Gallery

**Goal:** Deliver video files alongside photos in the same client gallery — clients see a unified view of all their deliverables.

- [ ] Research Synology Photos API for video items — check whether `SYNO.Foto.Browse.Item` returns videos in a shared album and what fields differ from photos (likely a `type` or `mime_type` field)
- [ ] Update `fetchAll()` in `client-gallery.html` to include video items in the results
- [ ] Render video cards in the masonry grid differently from photos — show a play icon overlay, use the video thumbnail returned by the Synology API
- [ ] On click, open the lightbox with an HTML `<video>` element instead of an `<img>` — proxy the video stream through the Worker the same way thumbnails are proxied
- [ ] Add video download support — route through `SYNO.Foto.Download` via the Worker (same as photo downloads)
- [ ] Handle mixed galleries gracefully — photos and videos interleaved in chronological order
- [ ] Test with Synology video formats (MP4, MOV) — confirm the Worker can stream binary video data without buffering issues at Cloudflare Worker memory limits
- [ ] Consider file size: large video files may need to be linked for direct download rather than streamed through the Worker (Cloudflare Workers have a 128MB response limit)

---

## 22. Admin Photo Editing

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

## 23. AI-Powered Auto Edit

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

## 24. Photo License Enforcement & Monitoring

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

## 25. Employee Email Addresses (@coastaltravelcompany.com)

**Goal:** Set up professional email addresses on the company domain for any employees or contractors — replaces personal Gmail/etc. addresses for client-facing communication.

- [ ] Choose an email host: **Google Workspace** (familiar UI, integrates with Google Meet/Drive, ~$6/user/month) or **Cloudflare Email Routing** (free, forwards to an existing inbox — good for a small team that doesn't need a separate mailbox) or **Microsoft 365** (~$6/user/month, includes Office apps)
- [ ] Add the required DNS records for the chosen provider (MX, SPF, DKIM, DMARC) — these go in the Cloudflare DNS dashboard for `coastaltravelcompany.com`
- [ ] Create addresses for each employee/role (e.g. `will@coastaltravelcompany.com`, `hello@coastaltravelcompany.com`)
- [ ] Update the contact form delivery address and any Resend sending addresses to use the new domain emails
- [ ] Add DMARC reporting (`rua=mailto:...`) so you can monitor for spoofing of the domain
