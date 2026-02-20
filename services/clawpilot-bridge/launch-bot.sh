#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

RAW_INPUT="${*:-}"
DRY_RUN="${DRY_RUN:-false}"
RECALL_API_BASE="${RECALL_API_BASE:-https://eu-central-1.recall.ai}"
RECALL_API_BASE="${RECALL_API_BASE%/}"
RECALL_BOT_API="${RECALL_API_BASE}/api/v1/bot"
RECALL_STT_MODE="${RECALL_STT_MODE:-prioritize_low_latency}"
RECALL_LANGUAGE_CODE="${RECALL_LANGUAGE_CODE:-en}"
REPLACE_ACTIVE_ON_DUPLICATE="${REPLACE_ACTIVE_ON_DUPLICATE:-true}"
BOT_REPLACE_WAIT_TIMEOUT_SEC="${BOT_REPLACE_WAIT_TIMEOUT_SEC:-45}"
BOT_REPLACE_POLL_SEC="${BOT_REPLACE_POLL_SEC:-2}"
BOT_NAME="${BOT_NAME:-}"

extract_meeting_url() {
  printf '%s\n' "$1" | grep -Eo 'https?://[^[:space:]<>"'"'"']+' | grep -E 'meet\.google\.com|([a-z0-9-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com' | head -n 1
}

parse_meeting_target() {
  local url="$1"

  if [[ "$url" =~ meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3}) ]]; then
    printf 'google_meet %s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  if [[ "$url" =~ ([a-z0-9-]+\.)?zoom\.us/j/([0-9]+) ]]; then
    printf 'zoom %s\n' "${BASH_REMATCH[2]}"
    return 0
  fi

  # Teams meeting IDs are not consistently parseable from URL in a stable way.
  printf 'unknown \n'
}

is_truthy() {
  local v="${1,,}"
  [[ "$v" == "1" || "$v" == "true" || "$v" == "yes" || "$v" == "y" ]]
}

sanitize_bot_name() {
  printf '%s' "$1" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//'
}

resolve_bot_name() {
  local explicit="${BOT_NAME:-${RECALL_BOT_NAME:-}}"
  explicit="$(sanitize_bot_name "$explicit")"
  if [[ -n "$explicit" ]]; then
    printf '%.80s' "$explicit"
    return 0
  fi

  local agent_name="${OPENCLAW_AGENT_NAME:-${CLAW_AGENT_NAME:-${AGENT_NAME:-OpenClaw}}}"
  local combined
  combined="$(sanitize_bot_name "${agent_name}")"
  if [[ -z "$combined" ]]; then
    combined="OpenClaw"
  fi
  printf '%.80s' "$combined"
}

is_terminal_status() {
  case "$1" in
    done|fatal|call_ended) return 0 ;;
    *) return 1 ;;
  esac
}

get_bot_status_code() {
  local bot_id="$1"
  curl -fsS "${RECALL_BOT_API}/${bot_id}" \
    -H "Authorization: Token ${RECALL_API_KEY}" \
    | jq -r '.status_changes[-1].code // "unknown"' 2>/dev/null || echo "unknown"
}

remove_bot_from_call() {
  local bot_id="$1"
  local raw http body err_code
  raw="$(curl -sS -w '\n%{http_code}' -X POST "${RECALL_BOT_API}/${bot_id}/leave_call/" \
    -H "Authorization: Token ${RECALL_API_KEY}" \
    -H "Content-Type: application/json" || true)"
  http="${raw##*$'\n'}"
  body="${raw%$'\n'*}"

  if [[ "$http" =~ ^2 ]]; then
    return 0
  fi

  err_code="$(printf '%s' "$body" | jq -r '.code // empty' 2>/dev/null || true)"
  case "$err_code" in
    cannot_command_unstarted_bot|cannot_command_completed_bot)
      return 0
      ;;
  esac

  echo "Error: failed to remove active bot from call (http=${http}, code=${err_code:-unknown})"
  printf '%s\n' "$body"
  return 1
}

wait_for_bot_terminal() {
  local bot_id="$1"
  local deadline status
  deadline=$((SECONDS + BOT_REPLACE_WAIT_TIMEOUT_SEC))
  while (( SECONDS < deadline )); do
    status="$(get_bot_status_code "$bot_id")"
    if is_terminal_status "$status"; then
      return 0
    fi
    sleep "$BOT_REPLACE_POLL_SEC"
  done
  echo "Error: timed out waiting for bot ${bot_id} to leave call (timeout=${BOT_REPLACE_WAIT_TIMEOUT_SEC}s)"
  return 1
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

if [[ -z "${RECALL_API_KEY:-}" ]]; then
  echo "Error: RECALL_API_KEY is not set (export it or define it in ${ENV_FILE})"
  exit 1
fi

if [[ -z "${WEBHOOK_SECRET:-}" ]]; then
  echo "Error: WEBHOOK_SECRET is not set (export it or define it in ${ENV_FILE})"
  exit 1
fi

WEBHOOK_BASE_URL="${WEBHOOK_BASE_URL:-}"
if [[ -z "$WEBHOOK_BASE_URL" ]]; then
  NGROK_URL="$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | jq -r '.tunnels[0].public_url // empty' || true)"
  if [[ -n "$NGROK_URL" ]]; then
    WEBHOOK_BASE_URL="$NGROK_URL"
  fi
fi

if [[ -z "$WEBHOOK_BASE_URL" ]]; then
  echo "Error: WEBHOOK_BASE_URL not set and ngrok URL not found"
  echo "Fix: export WEBHOOK_BASE_URL=https://<public-domain>"
  exit 1
fi

WEBHOOK_URL="${WEBHOOK_BASE_URL%/}/webhook?token=${WEBHOOK_SECRET}"
BOT_NAME_RESOLVED="$(resolve_bot_name)"
read -r MEETING_PLATFORM MEETING_ID <<<"$(parse_meeting_target "$MEETING_URL")"
replaced_bot_id=''

if [[ "$MEETING_PLATFORM" != "unknown" && -n "$MEETING_ID" ]]; then
  active_bot_json=''
  if list_json="$(curl -fsS "${RECALL_BOT_API}/?page_size=100" \
    -H "Authorization: Token ${RECALL_API_KEY}" 2>/dev/null)"; then
    active_bot_json="$(printf '%s' "$list_json" | jq -c \
      --arg platform "$MEETING_PLATFORM" \
      --arg meeting_id "$MEETING_ID" \
      '
      .results
      | map(select((.meeting_url.platform // "") == $platform and (.meeting_url.meeting_id // "") == $meeting_id))
      | map({
          id,
          code: (.status_changes[-1].code // "unknown"),
          meeting_url
        })
      | map(select(.code != "done" and .code != "fatal" and .code != "call_ended"))
      | .[0] // empty
      ' 2>/dev/null || true)"
  fi

  if [[ -n "$active_bot_json" ]]; then
    active_bot_id="$(printf '%s' "$active_bot_json" | jq -r '.id')"
    if is_truthy "$REPLACE_ACTIVE_ON_DUPLICATE"; then
      echo "Replacing active bot ${active_bot_id} for ${MEETING_PLATFORM}:${MEETING_ID}" >&2
      remove_bot_from_call "$active_bot_id"
      wait_for_bot_terminal "$active_bot_id"
      replaced_bot_id="$active_bot_id"
    else
      jq -n \
        --arg meeting_url "$MEETING_URL" \
        --arg platform "$MEETING_PLATFORM" \
        --arg meeting_id "$MEETING_ID" \
        --argjson active_bot "$active_bot_json" \
        '{
          id: $active_bot.id,
          status: "already_active",
          meeting_url: $meeting_url,
          meeting_target: { platform: $platform, meeting_id: $meeting_id },
          active_bot: $active_bot
        }'
      exit 0
    fi
  fi
fi

payload="$(jq -nc \
  --arg meeting_url "$MEETING_URL" \
  --arg webhook_url "$WEBHOOK_URL" \
  --arg bot_name "$BOT_NAME_RESOLVED" \
  --arg recall_stt_mode "$RECALL_STT_MODE" \
  --arg recall_language_code "$RECALL_LANGUAGE_CODE" \
  '{
    meeting_url: $meeting_url,
    bot_name: $bot_name,
    recording_config: {
      transcript: {
        provider: {
          recallai_streaming: {
            mode: $recall_stt_mode,
            language_code: $recall_language_code
          }
        }
      },
      realtime_endpoints: [{
        type: "webhook",
        url: $webhook_url,
        events: ["transcript.data", "transcript.partial_data"]
      }]
    }
  }')"

if [[ "$DRY_RUN" == "true" ]]; then
  jq -n \
    --arg meeting_url "$MEETING_URL" \
    --arg webhook_url "$WEBHOOK_URL" \
    '{ok: true, dry_run: true, meeting_url: $meeting_url, webhook_url: $webhook_url}'
  exit 0
fi

response="$(curl -sS -X POST "${RECALL_BOT_API}" \
  -H "Authorization: Token ${RECALL_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$payload")"

if [[ -n "$replaced_bot_id" ]]; then
  echo "$response" | jq --arg replaced_bot_id "$replaced_bot_id" \
    '{id, bot_name, status: "launching", meeting_url, created_at, replaced_from_bot_id: $replaced_bot_id}'
else
  echo "$response" | jq '{id, bot_name, status: "launching", meeting_url, created_at}'
fi
