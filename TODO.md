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
