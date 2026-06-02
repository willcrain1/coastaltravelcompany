#!/bin/bash
# Syncs active gallery thumbnails from NAS to Cloudflare R2 via the Worker sync endpoint.
#
# Required environment variables:
#   ADMIN_JWT   — valid admin JWT for the target environment
#   WORKER_URL  — Worker base URL (defaults to production)
#
# Optional:
#   GALLERY_ID  — sync a single gallery; omit to sync all
#
# Usage:
#   ADMIN_JWT=... ./worker/scripts/sync-gallery-to-r2.sh
#   ADMIN_JWT=... WORKER_URL=https://coastal-gallery-proxy-preprod.thecoastaltravelcompany.workers.dev \
#     ./worker/scripts/sync-gallery-to-r2.sh

set -euo pipefail

WORKER_URL="${WORKER_URL:-https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev}"
ADMIN_JWT="${ADMIN_JWT:?Error: ADMIN_JWT is required}"

sync_gallery() {
  local gid="$1"
  local offset=0

  echo "  Syncing gallery $gid..."
  while true; do
    result=$(curl -sf -X POST \
      -H "Authorization: Bearer $ADMIN_JWT" \
      "$WORKER_URL/admin/galleries/$gid/sync-r2?offset=$offset")

    synced=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('synced',0))")
    failed=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('failed',0))")
    total=$(echo  "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total',0))")
    done=$(echo   "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('done',False))")
    next=$(echo   "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('next_offset') or '')")

    echo "    offset=$offset synced=$synced failed=$failed total=$total"

    if [ "$done" = "True" ] || [ -z "$next" ]; then
      break
    fi
    offset="$next"
  done
}

if [ -n "${GALLERY_ID:-}" ]; then
  sync_gallery "$GALLERY_ID"
else
  echo "Fetching gallery list from $WORKER_URL..."
  galleries=$(curl -sf \
    -H "Authorization: Bearer $ADMIN_JWT" \
    "$WORKER_URL/admin/galleries" \
    | python3 -c "import json,sys; [print(g['id']) for g in json.load(sys.stdin)]")

  if [ -z "$galleries" ]; then
    echo "No galleries found."
    exit 0
  fi

  for gid in $galleries; do
    sync_gallery "$gid" || echo "  Warning: $gid failed, continuing."
  done
fi

echo "Sync complete."
