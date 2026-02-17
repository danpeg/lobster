#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/services/recall-bridge/.env"
EXAMPLE_FILE="$ROOT_DIR/services/recall-bridge/.env.example"

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "Missing $EXAMPLE_FILE"
  exit 1
fi

cp "$EXAMPLE_FILE" "$ENV_FILE"

prompt() {
  local var_name="$1"
  local prompt_text="$2"
  local secret="${3:-false}"
  local value
  if [[ "$secret" == "true" ]]; then
    read -r -s -p "$prompt_text: " value
    echo
  else
    read -r -p "$prompt_text: " value
  fi
  printf '%s=%s\n' "$var_name" "$value" >> "$ENV_FILE"
}

# Remove placeholder lines from copied example, then append user values.
sed -i '/=__PROMPT__/d' "$ENV_FILE"

prompt "RECALL_API_KEY" "Recall API key" true
prompt "WEBHOOK_SECRET" "Webhook secret (random long string)" true
prompt "WEBHOOK_BASE_URL" "Public HTTPS base URL (example: https://example.com)"
prompt "OPENCLAW_HOOK_URL" "OpenClaw hook URL (default http://127.0.0.1:18789/hooks/wake)"
prompt "OPENCLAW_HOOK_TOKEN" "OpenClaw hook token" true
prompt "TELEGRAM_BOT_TOKEN" "Telegram bot token (optional)" true
prompt "TELEGRAM_CHAT_ID" "Telegram chat id (optional)"
prompt "GOOGLE_DOC_ID" "Google Doc ID (optional for gdocs scripts)"
prompt "GOOGLE_APPLICATION_CREDENTIALS" "Path to Google service account JSON (optional)"
prompt "NOTION_TOKEN" "Notion token (optional, only if ENABLE_NOTION=true)" true
prompt "NOTION_PAGE_ID" "Notion page/block id (optional)"

cat <<MSG

Wrote: $ENV_FILE

Next:
1) cd $ROOT_DIR/services/recall-bridge
2) set -a; source ./.env; set +a
3) npm install
4) npm start

MSG
