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

### 3. Capturing a standalone container

Container Manager only exports Compose projects, not standalone containers. To record a standalone container's config, click it in the UI and transcribe each tab into `nas/docker-compose.yml`:

| Container Manager tab | `docker-compose.yml` key |
|---|---|
| General — image name and tag | `image:` |
| General — restart policy | `restart:` |
| Port Settings | `ports:` |
| Volume Settings | `volumes:` |
| Environment | `environment:` |
| Network | `network_mode:` |

Commit and push the updated `docker-compose.yml` after transcribing.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | All Docker services — source of truth for what runs on the NAS |
| `cloudflare-tunnel/config.example.yml` | Tunnel ingress rules template (commit safe) |
| `cloudflare-tunnel/config.yml` | Live tunnel config — **gitignored**, lives on NAS only |
| `cloudflare-tunnel/credentials.json` | Tunnel private key — **gitignored**, lives on NAS only |
