# Coastal Travel Company — To-Do

---

## 1. Real Watermarking

**Goal:** Photos downloaded by clients have Coastal Travel Company watermark burned in by Synology — not just a CSS overlay.

- [ ] Configure watermark in Synology Photos (gear icon → Watermark tab) — set text, position, opacity
- [ ] When creating a watermarked share in Synology Photos, enable "Add watermark to photos" on that share
- [ ] Update `dlUrl()` in `client-gallery.html`: when `cfg.watermark`, return `thumbUrl(photo, 'xl')` instead of `SYNO.Foto.Download` — this routes downloads through Synology's watermarked thumbnail path
- [ ] Re-enable download buttons for watermarked galleries (downloads are now safe — they carry the Synology watermark)
- [ ] Update watermark checkbox label in `gallery-admin.html` to explain the Synology requirement
- [ ] Test end-to-end: verify XL thumbnails from a watermark-enabled share have the watermark burned in

---

## 2. OAuth Login & Per-User Gallery Access

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

## 3. Functional Contact Form

**Goal:** Form submissions on `contact.html` actually send an inquiry email instead of doing nothing.

- [ ] Decide on delivery method: Formspree/Web3Forms (no backend, 2-minute setup) vs. Cloudflare Worker + Resend (more control, shares infrastructure with auth work)
- [ ] Wire up form `action` to the chosen endpoint
- [ ] Add success/error feedback in the UI after submit (replace the button state, show a confirmation message)
- [ ] Confirm submissions arrive at `thecoastaltravelcompany@gmail.com`

---

## 4. Synology-Level Album Password Protection

**Goal:** Gallery password set in the admin tool is enforced at the Synology Photos share level, not just client-side in the browser.

- [ ] Research Synology Photos sharing API — check if password protection can be set on a share via API (`SYNO.Foto.Sharing.Passphrase` or share creation endpoint)
- [ ] If API supports it: update Worker or `gallery-admin.html` to set the share password to match the admin-specified client password when generating a gallery link
- [ ] If API does not support it: update admin workflow instructions to remind admin to manually set the same password on the Synology share
- [ ] Verify that the Worker's session establishment (`/mo/sharing/{passphrase}`) works correctly when a share has a password set (may need to pass the password during session init)

---

## 5. Testimonials Page

**Goal:** Dedicated page (and homepage section) showing client reviews to build credibility with prospective hotel/property clients.

- [ ] Design and build `testimonials.html` — full-page layout with quotes, client name, property name, and optional photo
- [ ] Add a testimonials preview section to `index.html` (2–3 featured quotes with a "Read More" link)
- [ ] Add "Testimonials" to the main nav and footer links
- [ ] Populate with real client quotes
- [ ] Consider a pull-quote format with property name and collection type (e.g. "The Editorial Stay — The Grand Palms, Palm Beach") for specificity

---

## 6. Photo Favorites / Proofing in Client Gallery

**Goal:** Clients can star/heart photos in their gallery to indicate selections — admin can see which photos were favorited.

- [ ] Add a heart/star button to each photo card in `client-gallery.html` (alongside or replacing the Save button)
- [ ] Store favorites in `localStorage` keyed by gallery ID so selections persist across sessions on the same device
- [ ] Add a "My Selections" view — filtered grid showing only favorited photos, with a count in the nav
- [ ] Add a "Copy Selections List" or "Submit Selections" action — generates a list of filenames or photo indices the client can send back
- [ ] In `gallery-admin.html`, consider a way to view submitted selections per gallery (requires either a Worker endpoint to receive the list, or a simple mailto link with the selection data)
- [ ] Dependency: full per-client persistence requires the auth system (item 2) — localStorage version works standalone in the meantime

---

## 7. Email Capture / Mailing List

**Goal:** Collect visitor emails for newsletters, availability announcements, or seasonal campaigns.

- [ ] Choose a provider — Mailchimp or ConvertKit (both have free tiers and embed forms)
- [ ] Add an email capture section to `index.html` — minimal, one-field form with a brand-appropriate headline (e.g. "Stay in the loop — new collections, destinations, availability")
- [ ] Optionally add a slide-in or footer capture on `contact.html` for visitors who don't submit the inquiry form
- [ ] Connect form to provider embed code or API
- [ ] Set up a welcome email in the provider dashboard that goes out automatically on signup

---

## 8. Online Booking / Inquiry Workflow

**Goal:** Move beyond the contact form to a structured intake — availability check, project details, deposit request — so new clients can self-qualify and book without back-and-forth.

- [ ] Evaluate tools: HoneyBook or Dubsado handle contracts, invoices, and scheduling in one place and are common in photography; simpler alternative is Calendly for scheduling + Stripe for deposits
- [ ] Embed a scheduling/availability widget on `contact.html` or a new `/book.html` page
- [ ] Set up a project intake questionnaire (property type, dates, collection interest, budget range) that fires after a time slot is selected
- [ ] Connect deposit/invoice flow — client pays a retainer to confirm the booking
- [ ] Update the "Send Inquiry" CTA on `contact.html` and homepage to point to the booking flow once live

---

## 9. Before/After Editing Sliders

**Goal:** Demonstrate editing and retouching quality to commercial clients directly on the website.

- [ ] Choose 3–5 strong before/after pairs from real shoots
- [ ] Build or use a lightweight CSS-only or JS drag slider (no heavy library needed — a simple range input over two stacked images works well)
- [ ] Add a "The Edit" section to `services.html` or create a standalone `/editing.html` page
- [ ] Optionally embed one slider on the homepage as a visual hook

---

## 10. Video Reel / Showreel

**Goal:** Feature short-form video work prominently, since it's a core part of the collections offering.

- [ ] Upload reel to Vimeo (preferred over YouTube for clean embeds without ads/recommendations)
- [ ] Add a full-width video hero or reel section to `index.html` — autoplay muted loop for ambient effect, or a play-button overlay for the full reel
- [ ] Add video examples to `services.html` per collection (e.g. sample clip from The Fashioned Weekend)
- [ ] Ensure video does not autoplay with sound — muted autoplay is fine for hero, full reel should be user-initiated

---

## 11. Availability Calendar

**Goal:** Let prospective clients see open dates before reaching out, reducing low-intent inquiries.

- [ ] Choose an approach: simple manually-updated HTML calendar, or embed from a booking tool (syncs automatically if item 8 is implemented)
- [ ] Add to `contact.html` or a new `/availability.html` page
- [ ] Mark booked periods as unavailable, show open windows clearly
- [ ] Add a note about travel availability (available worldwide, lead time requirements)

---

## 12. FAQ Page

**Goal:** Answer the most common pre-booking questions so clients arrive at the inquiry form already informed.

- [ ] Build `faq.html` with an accordion layout
- [ ] Cover: pricing / how collections are priced, what's included, licensing and usage rights, travel fees, turnaround time, how to book, what to expect on shoot day
- [ ] Add "FAQ" to footer nav
- [ ] Link to FAQ from the contact page ("Have questions? See our FAQ") and from the collections page

---

## 13. Proofing & Selection

**Goal:** Structured proofing workflow where clients review their full gallery, mark selects, and submit a final list — replacing informal back-and-forth over email.

- [ ] Add a heart/star toggle to each photo in `client-gallery.html` — persists in `localStorage` keyed by gallery ID
- [ ] Add a "Selections" counter to the gallery nav showing how many photos are favorited
- [ ] Add a "View Selections" mode — filtered grid showing only starred photos
- [ ] Build a "Submit Selections" action that compiles filenames/indices and either: (a) opens a pre-filled mailto, or (b) POSTs to a Worker endpoint that emails the list to the admin
- [ ] Add a selection deadline field to the gallery config in `gallery-admin.html` — display a countdown or reminder in the gallery UI
- [ ] Show submitted selections per gallery in `gallery-admin.html`
- [ ] Dependency: full cross-device persistence requires the auth system (item 2); localStorage works as a standalone first version

---

## 14. Print Ordering

**Goal:** Clients can order prints directly from their gallery — revenue opportunity and convenience for hotel/property clients who want wall art.

- [ ] Evaluate print lab integrations: WHCC and Printful both have APIs; Pixieset and Pic-Time are all-in-one solutions that include gallery + print store (worth comparing against building custom)
- [ ] If building custom: add "Order Print" button to the lightbox and photo hover state in `client-gallery.html`
- [ ] Build a print product selection flow — size, paper type, quantity — before handing off to the print lab
- [ ] Handle payment via Stripe (can be same Stripe account as billing/invoices in item 16)
- [ ] Print lab fulfills and ships directly to client — no inventory needed
- [ ] Add print pricing to `faq.html` and `services.html`
- [ ] Dependency: works best alongside the auth system (item 2) so order history is tied to a client account

---

## 15. Licensing Information

**Goal:** Make usage rights clear for commercial hotel/property clients — what they can and can't do with delivered photos.

- [ ] Build a licensing page (`/licensing.html`) covering: personal use vs. commercial use, print vs. digital, exclusivity options, duration, geographic scope, third-party sub-licensing
- [ ] Define license tiers per collection (e.g. The Editorial Stay includes X years of digital commercial use; extended licenses available for an additional fee)
- [ ] Add license summary to each collection on `collections.html` — short plain-English version with a link to the full licensing page
- [ ] Include licensing terms in the FAQ (item 12)
- [ ] Add licensing details to client delivery emails and the client portal (item 2) so clients have a permanent record
- [ ] Consider a simple license certificate PDF generated per delivery — client name, property, collection, usage rights, expiry

---

## 16. Billing & Invoicing

**Goal:** Send, track, and collect payment on invoices directly — no third-party tool required unless a full CRM (HoneyBook/Dubsado) is preferred.

- [ ] Evaluate approach: (a) Stripe Invoicing — send invoices via Stripe, client pays by card, automatic receipts; (b) HoneyBook/Dubsado — all-in-one with contracts, invoices, scheduling; (c) custom Worker + Stripe API
- [ ] If Stripe: set up Stripe account, configure invoice templates with Coastal Travel Company branding
- [ ] Add deposit/retainer collection to the booking flow (item 8) — charge a percentage at booking, remainder on delivery
- [ ] Add an invoices section to `gallery-admin.html` or the admin portal — create invoice, mark as paid, view status
- [ ] Send invoice links to clients via email (Resend, shared with auth infrastructure in item 2)
- [ ] Add invoice history to the client portal (item 2) so clients can view and download past invoices
- [ ] Handle sales tax if applicable (Stripe Tax can automate this)

---

## 17. Video Support in Client Gallery

**Goal:** Deliver video files alongside photos in the same client gallery — clients see a unified view of all their deliverables.

- [ ] Research Synology Photos API for video items — check whether `SYNO.Foto.Browse.Item` returns videos in a shared album and what fields differ from photos (likely a `type` or `mime_type` field)
- [ ] Update `fetchAll()` in `client-gallery.html` to include video items in the results
- [ ] Render video cards in the masonry grid differently from photos — show a play icon overlay, use the video thumbnail returned by the Synology API
- [ ] On click, open the lightbox with an HTML `<video>` element instead of an `<img>` — proxy the video stream through the Worker the same way thumbnails are proxied
- [ ] Add video download support — route through `SYNO.Foto.Download` via the Worker (same as photo downloads)
- [ ] Handle mixed galleries gracefully — photos and videos interleaved in chronological order
- [ ] Test with Synology video formats (MP4, MOV) — confirm the Worker can stream binary video data without buffering issues at Cloudflare Worker memory limits
- [ ] Consider file size: large video files may need to be linked for direct download rather than streamed through the Worker (Cloudflare Workers have a 128MB response limit)
