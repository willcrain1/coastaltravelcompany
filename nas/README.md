# NAS Infrastructure

Docker and Cloudflare Tunnel configuration for the Synology NAS at `nas.coastaltravelcompany.com`.

## Rebuild from scratch

### 1. Cloudflare Tunnel

```bash
# Install cloudflared on your machine (not the NAS)
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/

# Authenticate
cloudflared tunnel login

# Create the tunnel (skip if reusing an existing tunnel UUID)
cloudflared tunnel create coastal-travel

# Copy the generated credentials file to the NAS
scp ~/.cloudflared/<tunnel-uuid>.json admin@<nas-ip>:/volume1/docker/nas/cloudflare-tunnel/credentials.json

# On the NAS: copy config template and fill in your tunnel UUID
cp cloudflare-tunnel/config.example.yml cloudflare-tunnel/config.yml
# Edit config.yml — replace YOUR-TUNNEL-UUID-HERE with your actual UUID
```

### 2. Deploy containers

```bash
# SSH into the NAS
ssh admin@<nas-ip>

# Clone the repo (or copy the nas/ directory)
cd /volume1/docker
git clone https://github.com/willcrain1/coastaltravelcompany.git
cd coastaltravelcompany/nas

# Ensure cloudflare-tunnel/credentials.json is in place (see step 1)
# Ensure cloudflare-tunnel/config.yml is filled in

docker compose up -d
docker compose ps   # verify all containers are running
```

### 3. Updating from Container Manager

If you make changes via the Synology Container Manager UI and want to capture them:

1. Container Manager → Projects → select the project → **Action → Export**
2. Replace the relevant service block in `docker-compose.yml` with the exported config
3. Commit and push

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | All Docker services — source of truth for what runs on the NAS |
| `cloudflare-tunnel/config.example.yml` | Tunnel ingress rules template (commit safe) |
| `cloudflare-tunnel/config.yml` | Live tunnel config — **gitignored**, lives on NAS only |
| `cloudflare-tunnel/credentials.json` | Tunnel private key — **gitignored**, lives on NAS only |
