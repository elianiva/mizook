#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_VARS="$PROJECT_DIR/.dev.vars"
WEBHOOK_PATH="/messengers/telegram/webhook"

# --- load env from .dev.vars ---
if [[ ! -f "$DEV_VARS" ]]; then
  echo "error: .dev.vars not found at $DEV_VARS" >&2
  exit 1
fi
set -a
source "$DEV_VARS"
set +a

# --- required vars ---
: "${BOT_TOKEN:?missing BOT_TOKEN in .dev.vars}"
: "${MIZOOK_WEBHOOK_SECRET:?missing MIZOOK_WEBHOOK_SECRET in .dev.vars}"

# --- resolve webhook URL ---
BASE_URL="${1:-${BASE_URL:-}}"
if [[ -z "$BASE_URL" ]]; then
  echo "error: pass the webhook base URL as the first argument or set BASE_URL in .dev.vars" >&2
  echo "usage: $0 [base-url]" >&2
  echo "  example: $0 https://mzk.elianiva.com" >&2
  echo "" >&2
  echo "hint: your worker URL is probably https://mizook.<subdomain>.workers.dev" >&2
  echo "      or visit Cloudflare Dashboard > Workers & Pages > mizook > Triggers" >&2
  exit 1
fi
WEBHOOK_URL="${BASE_URL}${WEBHOOK_PATH}"

API="https://api.telegram.org/bot${BOT_TOKEN}"

echo "── webhook info (current) ──"
curl -sS "${API}/getWebhookInfo" | python3 -m json.tool 2>/dev/null || curl -sS "${API}/getWebhookInfo"
echo

echo ""
echo "── setting webhook ──"
echo "  url:          $WEBHOOK_URL"
echo "  secret_token: $MIZOOK_WEBHOOK_SECRET"
echo "  allowed_updates: [message, callback_query]"
echo

read -rp "Proceed? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "aborted."
  exit 0
fi

RESPONSE=$(curl -sS -X POST "${API}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "url": "$WEBHOOK_URL",
  "secret_token": "$MIZOOK_WEBHOOK_SECRET",
  "allowed_updates": ["message", "callback_query"],
  "drop_pending_updates": true
}
EOF
)")

echo ""
echo "── response ──"
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
echo

# verify
echo "── verifying ──"
sleep 1
VERIFY=$(curl -sS "${API}/getWebhookInfo")
echo "$VERIFY" | python3 -m json.tool 2>/dev/null || echo "$VERIFY"
