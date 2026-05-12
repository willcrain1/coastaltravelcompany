#!/bin/bash
# Deploys cloudflare-worker.js to Cloudflare Workers via the REST API.
# Creates and binds the CTC_AUTH KV namespace automatically if it doesn't exist.
#
# One-time setup:
#   1. cp worker/.worker-config.example worker/.worker-config
#   2. Fill in CF_ACCOUNT_ID, CF_API_TOKEN, CF_WORKER_NAME
#   3. chmod +x worker/deploy-worker.sh
#
# Usage (run from repo root):
#   ./worker/deploy-worker.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/.worker-config"
WORKER_FILE="$SCRIPT_DIR/cloudflare-worker.js"
KV_NAME="CTC_AUTH"
TMP=$(mktemp)

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

# ── Load and validate config ──────────────────────────────────────────────────
if [ ! -f "$CONFIG" ]; then
  echo "Error: $CONFIG not found."
  echo "Run: cp worker/.worker-config.example worker/.worker-config  and fill in your credentials."
  exit 1
fi
source "$CONFIG"

if [ -z "$CF_ACCOUNT_ID" ] || [ -z "$CF_API_TOKEN" ] || [ -z "$CF_WORKER_NAME" ]; then
  echo "Error: CF_ACCOUNT_ID, CF_API_TOKEN, and CF_WORKER_NAME must all be set in .worker-config"
  exit 1
fi

if [ ! -f "$WORKER_FILE" ]; then
  echo "Error: cloudflare-worker.js not found at $WORKER_FILE"
  exit 1
fi

BASE="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID"

# ── Ensure KV namespace exists ────────────────────────────────────────────────
echo "Checking KV namespace '$KV_NAME'..."

curl -s "$BASE/storage/kv/namespaces?per_page=100" \
  -H "Authorization: Bearer $CF_API_TOKEN" > "$TMP"

KV_ID=$(python3 - <<PYEOF
import json, sys
with open("$TMP") as f:
    data = json.load(f)
for ns in data.get("result", []):
    if ns.get("title") == "$KV_NAME":
        print(ns["id"])
        break
PYEOF
)

if [ -z "$KV_ID" ]; then
  echo "Creating KV namespace '$KV_NAME'..."
  curl -s -X POST "$BASE/storage/kv/namespaces" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"$KV_NAME\"}" > "$TMP"

  KV_ID=$(python3 -c "import json,sys; print(json.load(open('$TMP'))['result']['id'])")

  if [ -z "$KV_ID" ]; then
    echo "Failed to create KV namespace. Cloudflare response:"
    cat "$TMP"
    exit 1
  fi
  echo "Created KV namespace: $KV_ID"
else
  echo "Found existing KV namespace: $KV_ID"
fi

# ── Deploy Worker with KV binding ─────────────────────────────────────────────
echo "Deploying $WORKER_FILE → $CF_WORKER_NAME ..."

METADATA="{\"bindings\":[{\"type\":\"kv_namespace\",\"name\":\"KV\",\"namespace_id\":\"$KV_ID\"}]}"

curl -s -X PUT "$BASE/workers/scripts/$CF_WORKER_NAME" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -F "metadata=$METADATA;type=application/json" \
  -F "script=@$WORKER_FILE;type=application/javascript" > "$TMP"

if python3 -c "import json; d=json.load(open('$TMP')); exit(0 if d.get('success') else 1)"; then
  echo "Done. Worker deployed with KV binding (namespace: $KV_NAME, id: $KV_ID)."
  echo ""
  echo "Required Worker secrets (set once in Cloudflare dashboard → Worker → Settings → Variables):"
  echo "  JWT_SECRET      — random string, used to sign session tokens"
  echo "  RESEND_API_KEY  — from resend.com"
  echo "  GOOGLE_CLIENT_ID — from Google Cloud Console"
else
  echo "Deploy failed. Cloudflare response:"
  cat "$TMP"
  exit 1
fi
