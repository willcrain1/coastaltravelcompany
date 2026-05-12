# NAS Infrastructure

Docker services running on the Synology NAS at `nas.coastaltravelcompany.com`.

## How the tunnel works

This setup uses Cloudflare Tunnel **token-based auth** — no local `config.yml` or `credentials.json` needed. The tunnel token embeds the credentials, and ingress rules (which hostnames route to which local services) are managed entirely in the Cloudflare Zero Trust dashboard:

> Zero Trust → Networks → Tunnels → select tunnel → Public Hostname tab

## Rebuild from scratch

### 1. Get the tunnel token

Cloudflare Zero Trust dashboard → Networks → Tunnels → select your tunnel → **Configure → Token** → copy the token.

If the tunnel was deleted or you're starting fresh:
- Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared → follow the setup wizard → copy the token at the end

### 2. Set up the env file

```bash
# On the NAS (or wherever you're running this)
cp .env.example .env
# Edit .env and paste the tunnel token as TUNNEL_TOKEN=...
```

### 3. Deploy

```bash
docker compose up -d
docker compose ps   # verify cloudflared is running
```

### 4. Verify the tunnel is connected

Cloudflare Zero Trust dashboard → Networks → Tunnels → your tunnel should show **Healthy**.

### 5. Capturing a standalone container

Container Manager does not export standalone containers (only Compose projects). To record a standalone container's config, click it in the UI and transcribe each tab into `docker-compose.yml`:

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
| `docker-compose.yml` | All Docker services — source of truth |
| `.env.example` | Template for secrets — copy to `.env` on the NAS |
| `.env` | Live secrets — **gitignored**, lives on NAS only |
| `cloudflare-tunnel/` | Not used for token-based auth — kept for reference if switching to file-based auth |
