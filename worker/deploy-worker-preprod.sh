#!/bin/bash
# Deploys cloudflare-worker.js to the preprod Cloudflare Worker environment.
# Creates and binds CTC_AUTH_PREPROD (KV) and ctc-preprod (D1) automatically.
# Runs all migrations against ctc-preprod in order before deploying.
#
# One-time setup:
#   1. cp worker/.worker-config.example worker/.worker-config
#   2. Fill in CF_ACCOUNT_ID, CF_API_TOKEN, CF_WORKER_NAME, CF_WORKER_NAME_PREPROD
#   3. chmod +x worker/deploy-worker-preprod.sh
#
# Usage (run from repo root):
#   ./worker/deploy-worker-preprod.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/.worker-config"
WORKER_FILE="$SCRIPT_DIR/cloudflare-worker.js"
KV_NAME="CTC_AUTH_PREPROD"
D1_NAME="ctc-preprod"
MIGRATIONS_DIR="$SCRIPT_DIR/migrations"
TMP=$(mktemp)

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

# ── Load and validate config ──────────────────────────────────────────────────
if [ -f "$CONFIG" ]; then
  source "$CONFIG"
fi

if [ -z "$CF_ACCOUNT_ID" ] || [ -z "$CF_API_TOKEN" ] || [ -z "$CF_WORKER_NAME_PREPROD" ]; then
  echo "Error: CF_ACCOUNT_ID, CF_API_TOKEN, and CF_WORKER_NAME_PREPROD must be set."
  echo "Local: cp worker/.worker-config.example worker/.worker-config and fill in values."
  echo "CI:    add them as repository secrets."
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
for ns in (data.get("result") or []):
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

# ── Ensure D1 database exists ─────────────────────────────────────────────────
echo "Checking D1 database '$D1_NAME'..."

curl -s "$BASE/d1/database?per_page=100" \
  -H "Authorization: Bearer $CF_API_TOKEN" > "$TMP"

D1_ID=$(python3 - <<PYEOF
import json, sys
with open("$TMP") as f:
    data = json.load(f)
for db in (data.get("result") or []):
    if db.get("name") == "$D1_NAME":
        print(db["uuid"])
        break
PYEOF
)

if [ -z "$D1_ID" ]; then
  echo "Creating D1 database '$D1_NAME'..."
  curl -s -X POST "$BASE/d1/database" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$D1_NAME\"}" > "$TMP"

  D1_ID=$(python3 -c "import json,sys; d=json.load(open('$TMP')); r=d.get('result'); print(r['uuid'] if r else '')")

  if [ -z "$D1_ID" ]; then
    echo "Failed to create D1 database. Cloudflare response:"
    cat "$TMP"
    exit 1
  fi
  echo "Created D1 database: $D1_ID"
else
  echo "Found existing D1 database: $D1_ID"
fi

# ── Run all migrations against preprod DB ────────────────────────────────────
echo "Running migrations against '$D1_NAME'..."
for SQL_FILE in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
  echo "  Applying $(basename $SQL_FILE)..."
  SQL=$(python3 -c "import json; print(json.dumps({'sql': open('$SQL_FILE').read()}))")
  curl -s -X POST "$BASE/d1/database/$D1_ID/query" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$SQL" > "$TMP"
  python3 -c "
import json, sys
r = json.load(open('$TMP'))
if not r.get('success'):
    print('  Warning:', r)
else:
    print('  Applied.')
"
done

# ── Read prod KV/D1 IDs from existing wrangler.toml (if available) ────────────
PROD_KV_ID="placeholder"
PROD_D1_ID="placeholder"
PROD_WORKER_NAME="${CF_WORKER_NAME:-coastal-gallery-proxy}"

if [ -f "$SCRIPT_DIR/wrangler.toml" ]; then
  PROD_KV_ID=$(python3 - <<PYEOF
import re
with open("$SCRIPT_DIR/wrangler.toml") as f:
    content = f.read()
# Extract first kv id= before any [env.] section
m = re.search(r'(?s)^(.*?)(\[env\.|$)', content)
section = m.group(1) if m else content
match = re.search(r'\[\[kv_namespaces\]\].*?id\s*=\s*"([^"]+)"', section, re.DOTALL)
print(match.group(1) if match else "placeholder")
PYEOF
)
  PROD_D1_ID=$(python3 - <<PYEOF
import re
with open("$SCRIPT_DIR/wrangler.toml") as f:
    content = f.read()
m = re.search(r'(?s)^(.*?)(\[env\.|$)', content)
section = m.group(1) if m else content
match = re.search(r'\[\[d1_databases\]\].*?database_id\s*=\s*"([^"]+)"', section, re.DOTALL)
print(match.group(1) if match else "placeholder")
PYEOF
)
fi

# ── Generate wrangler.toml with [env.preprod] section ────────────────────────
echo "Generating wrangler.toml with preprod environment..."
cat > "$SCRIPT_DIR/wrangler.toml" <<TOML
name = "$PROD_WORKER_NAME"
main = "cloudflare-worker.js"
compatibility_date = "2024-09-23"

[observability]
enabled = true

[[kv_namespaces]]
binding = "KV"
id = "$PROD_KV_ID"

[[d1_databases]]
binding = "DB"
database_name = "CTC_PROJECTS"
database_id = "$PROD_D1_ID"

[triggers]
crons = ["0 * * * *"]

[env.preprod]
name = "$CF_WORKER_NAME_PREPROD"

[env.preprod.vars]
ALLOWED_ORIGIN = "https://preprod.coastaltravelcompany.com"

[env.preprod.observability]
enabled = true

[[env.preprod.kv_namespaces]]
binding = "KV"
id = "$KV_ID"

[[env.preprod.d1_databases]]
binding = "DB"
database_name = "$D1_NAME"
database_id = "$D1_ID"
TOML

# ── Deploy via wrangler ───────────────────────────────────────────────────────
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install

echo "Deploying $CF_WORKER_NAME_PREPROD via wrangler (--env preprod)..."
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
npx wrangler deploy --env preprod

echo ""
echo "Done. Preprod Worker deployed."
echo "  KV namespace:  $KV_NAME ($KV_ID)"
echo "  D1 database:   $D1_NAME ($D1_ID)"
echo "  ALLOWED_ORIGIN: https://preprod.coastaltravelcompany.com"
echo ""
echo "Required Worker secrets (set via Cloudflare dashboard → $CF_WORKER_NAME_PREPROD → Settings → Variables):"
echo "  JWT_SECRET            — different value from production"
echo "  RESEND_API_KEY        — can reuse prod key"
echo "  GOOGLE_CLIENT_ID      — same as prod; add preprod.coastaltravelcompany.com to Google Cloud Console authorized origins"
echo "  STRIPE_SECRET_KEY     — use Stripe TEST MODE key for preprod"
echo "  STRIPE_WEBHOOK_SECRET — register separate preprod webhook in Stripe dashboard"
