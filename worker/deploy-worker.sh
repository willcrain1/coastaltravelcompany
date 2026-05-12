#!/bin/bash
# Deploys cloudflare-worker.js to Cloudflare Workers via the REST API.
#
# One-time setup:
#   1. Copy this file's companion config: cp .worker-config.example .worker-config
#   2. Fill in your Cloudflare Account ID, API token, and worker name in .worker-config
#   3. chmod +x deploy-worker.sh
#
# Usage:
#   ./deploy-worker.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/.worker-config"
WORKER_FILE="$SCRIPT_DIR/cloudflare-worker.js"

# Load config
if [ ! -f "$CONFIG" ]; then
  echo "Error: $CONFIG not found."
  echo "Run: cp .worker-config.example .worker-config  and fill in your credentials."
  exit 1
fi
source "$CONFIG"

# Validate
if [ -z "$CF_ACCOUNT_ID" ] || [ -z "$CF_API_TOKEN" ] || [ -z "$CF_WORKER_NAME" ]; then
  echo "Error: CF_ACCOUNT_ID, CF_API_TOKEN, and CF_WORKER_NAME must all be set in .worker-config"
  exit 1
fi

if [ ! -f "$WORKER_FILE" ]; then
  echo "Error: cloudflare-worker.js not found at $WORKER_FILE"
  exit 1
fi

echo "Deploying $WORKER_FILE → $CF_WORKER_NAME ..."

RESPONSE=$(curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/$CF_WORKER_NAME" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @"$WORKER_FILE")

SUCCESS=$(echo "$RESPONSE" | grep -o '"success":true')

if [ -n "$SUCCESS" ]; then
  echo "Done. Worker deployed successfully."
else
  echo "Deploy failed. Cloudflare response:"
  echo "$RESPONSE"
  exit 1
fi
