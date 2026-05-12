# Coastal Travel Company — To-Do

Items are ordered: necessary website fixes first, then by highest revenue impact.

---

## 1. Functional Contact Form

**Goal:** Form submissions on `contact.html` actually send an inquiry email instead of doing nothing.

- [ ] Decide on delivery method: Formspree/Web3Forms (no backend, 2-minute setup) vs. Cloudflare Worker + Resend (more control, shares infrastructure with auth work)
- [ ] Wire up form `action` to the chosen endpoint
- [ ] Add success/error feedback in the UI after submit (replace the button state, show a confirmation message)
- [ ] Confirm submissions arrive at `thecoastaltravelcompany@gmail.com`

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

**Goal:** Move beyond the contact form to a structured intake — availability check, project details, deposit request — so new clients can self-qualify and book without back-and-forth.

- [ ] Evaluate tools: HoneyBook or Dubsado handle contracts, invoices, and scheduling in one place and are common in photography; simpler alternative is Calendly for scheduling + Stripe for deposits
- [ ] Embed a scheduling/availability widget on `contact.html` or a new `/book.html` page
- [ ] Set up a project intake questionnaire (property type, dates, collection interest, budget range) that fires after a time slot is selected
- [ ] Connect deposit/invoice flow — client pays a retainer to confirm the booking
- [ ] Update the "Send Inquiry" CTA on `contact.html` and homepage to point to the booking flow once live

---

## 6. Billing & Invoicing

**Goal:** Send, track, and collect payment on invoices directly — no third-party tool required unless a full CRM (HoneyBook/Dubsado) is preferred.

- [ ] Evaluate approach: (a) Stripe Invoicing — send invoices via Stripe, client pays by card, automatic receipts; (b) HoneyBook/Dubsado — all-in-one with contracts, invoices, scheduling; (c) custom Worker + Stripe API
- [ ] If Stripe: set up Stripe account, configure invoice templates with Coastal Travel Company branding
- [ ] Add deposit/retainer collection to the booking flow (item 5) — charge a percentage at booking, remainder on delivery
- [ ] Add an invoices section to `gallery-admin.html` or the admin portal — create invoice, mark as paid, view status
- [ ] Send invoice links to clients via email (Resend, shared with auth infrastructure in item 4)
- [ ] Add invoice history to the client portal (item 4) so clients can view and download past invoices
- [ ] Handle sales tax if applicable (Stripe Tax can automate this)

---

## 7. 3D Property Walkthroughs (Gaussian Splatting)

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

## 8. Print Ordering

**Goal:** Clients can order prints directly from their gallery — revenue opportunity and convenience for hotel/property clients who want wall art.

- [ ] Evaluate print lab integrations: WHCC and Printful both have APIs; Pixieset and Pic-Time are all-in-one solutions that include gallery + print store (worth comparing against building custom)
- [ ] If building custom: add "Order Print" button to the lightbox and photo hover state in `client-gallery.html`
- [ ] Build a print product selection flow — size, paper type, quantity — before handing off to the print lab
- [ ] Handle payment via Stripe (can be same Stripe account as billing/invoices in item 6)
- [ ] Print lab fulfills and ships directly to client — no inventory needed
- [ ] Add print pricing to `faq.html` and `services.html`
- [ ] Dependency: works best alongside the auth system (item 4) so order history is tied to a client account

---

## 9. Email Capture / Mailing List

**Goal:** Collect visitor emails for newsletters, availability announcements, or seasonal campaigns.

- [ ] Choose a provider — Mailchimp or ConvertKit (both have free tiers and embed forms)
- [ ] Add an email capture section to `index.html` — minimal, one-field form with a brand-appropriate headline (e.g. "Stay in the loop — new collections, destinations, availability")
- [ ] Optionally add a slide-in or footer capture on `contact.html` for visitors who don't submit the inquiry form
- [ ] Connect form to provider embed code or API
- [ ] Set up a welcome email in the provider dashboard that goes out automatically on signup

---

## 10. Video Reel / Showreel

**Goal:** Feature short-form video work prominently, since it's a core part of the collections offering.

- [ ] Upload reel to Vimeo (preferred over YouTube for clean embeds without ads/recommendations)
- [ ] Add a full-width video hero or reel section to `index.html` — autoplay muted loop for ambient effect, or a play-button overlay for the full reel
- [ ] Add video examples to `services.html` per collection (e.g. sample clip from The Fashioned Weekend)
- [ ] Ensure video does not autoplay with sound — muted autoplay is fine for hero, full reel should be user-initiated

---

## 11. Testimonials Page

**Goal:** Dedicated page (and homepage section) showing client reviews to build credibility with prospective hotel/property clients.

- [ ] Design and build `testimonials.html` — full-page layout with quotes, client name, property name, and optional photo
- [ ] Add a testimonials preview section to `index.html` (2–3 featured quotes with a "Read More" link)
- [ ] Add "Testimonials" to the main nav and footer links
- [ ] Populate with real client quotes
- [ ] Consider a pull-quote format with property name and collection type (e.g. "The Editorial Stay — The Grand Palms, Palm Beach") for specificity

---

## 12. Availability Calendar

**Goal:** Let prospective clients see open dates before reaching out, reducing low-intent inquiries.

- [ ] Choose an approach: simple manually-updated HTML calendar, or embed from a booking tool (syncs automatically if item 5 is implemented)
- [ ] Add to `contact.html` or a new `/availability.html` page
- [ ] Mark booked periods as unavailable, show open windows clearly
- [ ] Add a note about travel availability (available worldwide, lead time requirements)

---

## 13. Licensing Information

**Goal:** Make usage rights clear for commercial hotel/property clients — what they can and can't do with delivered photos.

- [ ] Build a licensing page (`/licensing.html`) covering: personal use vs. commercial use, print vs. digital, exclusivity options, duration, geographic scope, third-party sub-licensing
- [ ] Define license tiers per collection (e.g. The Editorial Stay includes X years of digital commercial use; extended licenses available for an additional fee)
- [ ] Add license summary to each collection on `collections.html` — short plain-English version with a link to the full licensing page
- [ ] Include licensing terms in the FAQ (item 15)
- [ ] Add licensing details to client delivery emails and the client portal (item 4) so clients have a permanent record
- [ ] Consider a simple license certificate PDF generated per delivery — client name, property, collection, usage rights, expiry

---

## 14. Before/After Editing Sliders

**Goal:** Demonstrate editing and retouching quality to commercial clients directly on the website.

- [ ] Choose 3–5 strong before/after pairs from real shoots
- [ ] Build or use a lightweight CSS-only or JS drag slider (no heavy library needed — a simple range input over two stacked images works well)
- [ ] Add a "The Edit" section to `services.html` or create a standalone `/editing.html` page
- [ ] Optionally embed one slider on the homepage as a visual hook

---

## 15. FAQ Page

**Goal:** Answer the most common pre-booking questions so clients arrive at the inquiry form already informed.

- [ ] Build `faq.html` with an accordion layout
- [ ] Cover: pricing / how collections are priced, what's included, licensing and usage rights, travel fees, turnaround time, how to book, what to expect on shoot day
- [ ] Add "FAQ" to footer nav
- [ ] Link to FAQ from the contact page ("Have questions? See our FAQ") and from the collections page

---

## 16. Photo Favorites / Proofing in Client Gallery

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

---

## 18. Admin Photo Editing

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

## 19. AI-Powered Auto Edit

**Goal:** Analyze each photo individually using vision AI and automatically generate a tailored set of edit parameters that make that specific photo look its best — accounting for scene type, lighting conditions, color cast, exposure, and subject matter. Results feed directly into the item 18 edit system so admins can review, tweak, or approve with one click.

### Analysis approach
- [ ] Use the **Claude API (claude-opus-4-7 with vision)** as the primary analysis engine — send a downscaled JPEG of the photo (800px long edge is sufficient for analysis) and prompt it to return a structured JSON edit recommendation; Claude can reason about scene context ("beachfront suite at golden hour, pool is the hero element, slight haze on the horizon") in ways a pure algorithmic approach cannot
- [ ] Prompt engineering: instruct Claude to identify scene type, lighting condition, dominant color cast, exposure quality, subject prominence, and any specific problem areas (blown highlights, crushed shadows, mixed color temperature), then map its findings to numeric values for every parameter in the item 18 `edit_params` schema
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
- [ ] Claude returns a structured JSON object matching the item 18 `edit_params` schema exactly — every slider value, curve points, crop/straighten if needed, B&W conversion flag, and a `confidence` field (0–1) per parameter group
- [ ] Include a `reasoning` field in the response (a 1–2 sentence plain-English explanation of the main corrections applied) — display this in the admin UI so the admin understands why the edits were suggested
- [ ] Low-confidence parameters (below a threshold) are flagged in the UI so the admin knows which adjustments are speculative vs. well-founded

### Admin review workflow
- [ ] Add an "Auto Edit" button per photo and an "Auto Edit All" button at the gallery level in `gallery-admin.html`
- [ ] "Auto Edit All" runs analysis in batches of 5 photos in parallel (respecting Claude API rate limits) with a progress indicator
- [ ] After auto edit runs, show a side-by-side diff view: original vs. proposed edits, with the `reasoning` text beneath — admin clicks "Apply", "Tweak" (opens item 18 editor pre-populated with the suggestions), or "Discard"
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
