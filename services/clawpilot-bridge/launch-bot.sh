#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

RAW_INPUT="${*:-}"
BRIDGE_BASE_URL="${BRIDGE_BASE_URL:-http://127.0.0.1:3001}"
BRIDGE_LAUNCH_URL="${BRIDGE_BASE_URL%/}/launch"
BOT_NAME="${BOT_NAME:-${RECALL_BOT_NAME:-}}"

extract_meeting_url() {
  printf '%s\n' "$1" \
    | grep -Eo 'https?://[^[:space:]<>"'"'"']+' \
    | grep -E 'meet\.google\.com|([a-z0-9-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com' \
    | head -n 1
}

if [[ -z "$RAW_INPUT" ]]; then
  echo "Usage: ./launch-bot.sh <meeting_url_or_text_with_link>"
  exit 1
fi

MEETING_URL="$(extract_meeting_url "$RAW_INPUT" || true)"
if [[ -z "$MEETING_URL" ]]; then
  echo "Error: no supported meeting URL found in input"
  echo "Supported domains: meet.google.com, zoom.us, teams.microsoft.com, teams.live.com"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required"
  exit 1
fi

payload="$(jq -nc --arg meeting_url "$MEETING_URL" --arg bot_name "$BOT_NAME" '
  {
    meeting_url: $meeting_url
  }
  + (if ($bot_name | length) > 0 then { bot_name: $bot_name } else {} end)
')"

headers=(
  -H 'Content-Type: application/json'
)
if [[ -n "${BRIDGE_API_TOKEN:-}" ]]; then
  headers+=( -H "Authorization: Bearer ${BRIDGE_API_TOKEN}" )
fi

raw="$(curl -sS -w '\n%{http_code}' -X POST "$BRIDGE_LAUNCH_URL" "${headers[@]}" --data "$payload" || true)"
http="${raw##*$'\n'}"
body="${raw%$'\n'*}"

if [[ "$http" =~ ^2 ]]; then
  printf '%s\n' "$body" | jq .
  exit 0
fi

echo "Error: bridge launch request failed (http=${http})"
printf '%s\n' "$body"
exit 1
