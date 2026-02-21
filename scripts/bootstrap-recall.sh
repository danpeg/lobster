#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/services/clawpilot-bridge/.env"
EXAMPLE_FILE="$ROOT_DIR/services/clawpilot-bridge/.env.example"
QUICK_CHECK_SCRIPT="$ROOT_DIR/scripts/require-cloudflared-quick-tunnel.sh"
FRESH=false

for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=true ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: ./scripts/bootstrap-recall.sh [--fresh]"
      exit 1
      ;;
  esac
done

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "Missing $EXAMPLE_FILE"
  exit 1
fi

has_legacy_config() {
  local file="$1"
  [[ -f "$file" ]] || return 1

  if grep -Eq '^[[:space:]]*WEBHOOK_BASE_URL=' "$file"; then
    return 0
  fi
  if grep -Eq '^[[:space:]]*ALLOW_NGROK_FALLBACK=' "$file"; then
    return 0
  fi
  if grep -Eiq '\.ts\.net|tailscale|ngrok' "$file"; then
    return 0
  fi
  return 1
}

if [[ -f "$ENV_FILE" ]] && [[ "$FRESH" != "true" ]] && has_legacy_config "$ENV_FILE"; then
  echo 'Old config detected. Run `npx clawpilot setup --fresh` to reconfigure.'
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
if command -v gsed >/dev/null 2>&1; then
  gsed -i '/=__PROMPT__/d' "$ENV_FILE"
else
  sed -i.bak '/=__PROMPT__/d' "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
fi

prompt "RECALL_API_KEY" "Recall API key" true
prompt "WEBHOOK_SECRET" "Webhook secret (random long string)" true
prompt "OPENCLAW_AGENT_NAME" "OpenClaw agent name (used for default bot name)"
prompt "RECALL_BOT_NAME" "Recall bot name override (optional)"
prompt "TELEGRAM_CHAT_ID" "Telegram chat id (optional)"

if ! grep -Eq '^CLOUDFLARED_BIN=' "$ENV_FILE"; then
  printf '%s=%s\n' "CLOUDFLARED_BIN" "cloudflared" >> "$ENV_FILE"
fi

echo
if [[ -x "$QUICK_CHECK_SCRIPT" ]] && curl -fsS "http://127.0.0.1:3001/health" >/dev/null 2>&1; then
  echo "Running cloudflared quick tunnel preflight..."
  BRIDGE_ENV_FILE="$ENV_FILE" "$QUICK_CHECK_SCRIPT"
else
  echo "Skipping preflight (bridge not running yet)."
fi

cat <<MSG

Wrote: $ENV_FILE

Next:
1) cd $ROOT_DIR/services/clawpilot-bridge
2) set -a; source ./.env; set +a
3) npm install
4) npm start

If reinstall/update resets plugin or bridge config, rerun this script or run:
  npx clawpilot setup --fresh

MSG
