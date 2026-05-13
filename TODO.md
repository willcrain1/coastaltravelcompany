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
- [x] **Fill in Worker URL:** `https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev`
- [ ] Deploy Worker: `./worker/deploy-worker.sh`
- [ ] Confirm submissions arrive at `thecoastaltravelcompany@gmail.com` (reply-to is set to the submitter's email)

---
