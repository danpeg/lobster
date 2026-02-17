#!/usr/bin/env bash
set -euo pipefail

INPUT_TEXT="${*:-}"

if [[ -z "$INPUT_TEXT" ]]; then
  if [ ! -t 0 ]; then
    INPUT_TEXT="$(cat)"
  fi
fi

if [[ -z "$INPUT_TEXT" ]]; then
  echo '{"ok":false,"error":"missing input text"}'
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
err_file="$(mktemp)"
trap 'rm -f "$err_file"' EXIT

if ! output="$("$SCRIPT_DIR/launch-bot.sh" "$INPUT_TEXT" 2>"$err_file")"; then
  error_text="$(cat "$err_file" 2>/dev/null || true)"
  if [[ -n "$error_text" ]]; then
    output="${error_text}"$'\n'"${output}"
  fi
  escaped="$(printf '%s' "$output" | jq -Rs .)"
  printf '{"ok":false,"error":%s}\n' "$escaped"
  exit 1
fi

bot_id="$(printf '%s' "$output" | jq -r '.id // empty' 2>/dev/null || true)"
launch_status="$(printf '%s' "$output" | jq -r '.status // empty' 2>/dev/null || true)"
replaced_from_bot_id="$(printf '%s' "$output" | jq -r '.replaced_from_bot_id // empty' 2>/dev/null || true)"
meeting_url="$(printf '%s\n' "$INPUT_TEXT" | grep -Eo 'https?://[^[:space:]<>"'"'"']+' | grep -E 'meet\.google\.com|([a-z0-9-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com' | head -n 1 || true)"
launch_response_json="$(printf '%s' "$output" | jq -c . 2>/dev/null || echo '{}')"
action="meeting_bot_launched"
if [[ "$launch_status" == "already_active" ]]; then
  action="meeting_bot_already_active"
elif [[ -n "$replaced_from_bot_id" ]]; then
  action="meeting_bot_replaced"
fi

jq -n \
  --arg action "$action" \
  --arg bot_id "$bot_id" \
  --arg replaced_from_bot_id "$replaced_from_bot_id" \
  --arg meeting_url "$meeting_url" \
  --argjson launch_response "$launch_response_json" \
  '{
    ok: true,
    action: $action,
    bot_id: (if $bot_id == "" then null else $bot_id end),
    replaced_from_bot_id: (if $replaced_from_bot_id == "" then null else $replaced_from_bot_id end),
    meeting_url: (if $meeting_url == "" then null else $meeting_url end),
    launch_response: $launch_response
  }'
