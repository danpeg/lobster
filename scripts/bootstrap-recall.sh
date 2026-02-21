#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/services/clawpilot-bridge/.env"
EXAMPLE_FILE="$ROOT_DIR/services/clawpilot-bridge/.env.example"
FUNNEL_CHECK_SCRIPT="$ROOT_DIR/scripts/require-tailscale-funnel.sh"

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "Missing $EXAMPLE_FILE"
  exit 1
fi

is_ts_net_https_url() {
  local value="$1"
  [[ "$value" =~ ^https://[^/]+\.ts\.net(/.*)?$ ]]
}

is_recall_api_base_url() {
  local value="$1"
  [[ "$value" =~ ^https://[^/]+\.recall\.ai(/.*)?$ ]]
}

extract_first_ts_url() {
  local input="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" \
      | jq -r '.. | strings | select(test("^https://[^/]+\\.ts\\.net(/.*)?$"))' 2>/dev/null \
      | head -n 1
    return 0
  fi
  printf '%s' "$input" | grep -Eo 'https://[^[:space:]]+\.ts\.net(/[^[:space:]]*)?' | head -n 1
}

discover_funnel_url() {
  local existing_value="${1:-}"
  local candidate=""
  local raw_status=""

  if is_ts_net_https_url "${WEBHOOK_BASE_URL:-}"; then
    printf '%s' "$WEBHOOK_BASE_URL"
    return 0
  fi

  if command -v tailscale >/dev/null 2>&1; then
    raw_status="$(tailscale funnel status --json 2>/dev/null || true)"
    if [[ -n "$raw_status" ]]; then
      candidate="$(extract_first_ts_url "$raw_status")"
      if is_ts_net_https_url "$candidate"; then
        printf '%s' "$candidate"
        return 0
      fi
    fi

    raw_status="$(tailscale funnel status 2>/dev/null || true)"
    if [[ -n "$raw_status" ]]; then
      candidate="$(extract_first_ts_url "$raw_status")"
      if is_ts_net_https_url "$candidate"; then
        printf '%s' "$candidate"
        return 0
      fi
    fi
  fi

  if is_ts_net_https_url "$existing_value"; then
    printf '%s' "$existing_value"
    return 0
  fi

  echo "Error: could not discover a valid Tailscale Funnel URL (https://<node>.ts.net)." >&2
  echo "Run: tailscale funnel status" >&2
  echo "Then rerun this bootstrap script." >&2
  return 1
}

probe_recall_api_base() {
  local base="$1"
  local url="${base%/}/api/v1/bot?page_size=1"
  local code=""

  if [[ -n "${RECALL_API_KEY:-}" ]]; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Token ${RECALL_API_KEY}" "$url" 2>/dev/null || true)"
  else
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
  fi

  [[ "$code" == "200" || "$code" == "401" || "$code" == "403" ]]
}

discover_recall_api_base() {
  local existing_value="${1:-}"
  local candidate
  local candidates=(
    "$existing_value"
    "${RECALL_API_BASE:-}"
    "https://us-east-1.recall.ai"
    "https://eu-central-1.recall.ai"
    "https://us-west-2.recall.ai"
    "https://ap-southeast-1.recall.ai"
  )
  local valid=()

  for candidate in "${candidates[@]}"; do
    [[ -z "$candidate" ]] && continue
    candidate="${candidate%/}"
    if ! is_recall_api_base_url "$candidate"; then
      continue
    fi
    if probe_recall_api_base "$candidate"; then
      valid+=("$candidate")
    fi
  done

  if [[ "${#valid[@]}" -eq 1 ]]; then
    printf '%s' "${valid[0]}"
    return 0
  fi

  return 1
}

prompt() {
  local var_name="$1"
  local prompt_text="$2"
  local secret="${3:-false}"
  local default_value="${4:-}"
  local value=""
  if [[ "$secret" == "true" ]]; then
    read -r -s -p "$prompt_text: " value
    echo
  else
    if [[ -n "$default_value" ]]; then
      read -r -p "$prompt_text [$default_value]: " value
      value="${value:-$default_value}"
    else
      read -r -p "$prompt_text: " value
    fi
  fi
  printf '%s=%s\n' "$var_name" "$value" >> "$ENV_FILE"
}

existing_webhook_base_url=""
existing_recall_api_base=""
if [[ -f "$ENV_FILE" ]]; then
  existing_webhook_base_url="$(grep -E '^WEBHOOK_BASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  existing_recall_api_base="$(grep -E '^RECALL_API_BASE=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
fi

cp "$EXAMPLE_FILE" "$ENV_FILE"

# Remove placeholder lines from copied example, then append user values.
if sed --version >/dev/null 2>&1; then
  sed -i '/=__PROMPT__/d' "$ENV_FILE"
else
  sed -i '' '/=__PROMPT__/d' "$ENV_FILE"
fi

prompt "RECALL_API_KEY" "Recall API key" true

recall_api_base_guess="$(discover_recall_api_base "$existing_recall_api_base" 2>/dev/null || true)"
prompt "RECALL_API_BASE" "Recall API base (region endpoint)" false "$recall_api_base_guess"

prompt "WEBHOOK_SECRET" "Webhook secret (random long string)" true
prompt "OPENCLAW_AGENT_NAME" "OpenClaw agent name (used for default bot name)"
prompt "RECALL_BOT_NAME" "Recall bot name override (optional)"
prompt "TELEGRAM_CHAT_ID" "Telegram chat id (optional)"

configured_recall_api_base="$(grep -E '^RECALL_API_BASE=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
if ! is_recall_api_base_url "$configured_recall_api_base"; then
  echo "Error: RECALL_API_BASE is missing/invalid."
  echo "Set it to your workspace region endpoint (for example: https://us-east-1.recall.ai) and rerun." >&2
  exit 1
fi

funnel_url="$(discover_funnel_url "$existing_webhook_base_url")"
printf '%s=%s\n' "WEBHOOK_BASE_URL" "$funnel_url" >> "$ENV_FILE"

if [[ ! -x "$FUNNEL_CHECK_SCRIPT" ]]; then
  echo "Missing executable funnel check script: $FUNNEL_CHECK_SCRIPT"
  echo "Fix: chmod +x $FUNNEL_CHECK_SCRIPT"
  exit 1
fi

echo
echo "Running strict Funnel preflight..."
BRIDGE_ENV_FILE="$ENV_FILE" "$FUNNEL_CHECK_SCRIPT"

cat <<MSG

Wrote: $ENV_FILE
Detected RECALL_API_BASE: $configured_recall_api_base
Detected WEBHOOK_BASE_URL: $funnel_url

Next:
1) cd $ROOT_DIR/services/clawpilot-bridge
2) set -a; source ./.env; set +a
3) npm install
4) npm start

If reinstall/update resets plugin or bridge config, rerun this script before testing commands.

MSG
