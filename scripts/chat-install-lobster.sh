#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOTAL_STEPS=6
PLUGIN_ID="clawpilot"
PLUGIN_SOURCE="${LOBSTER_PLUGIN_SOURCE:-@clawpilot/clawpilot}"
OPENCLAW_RESTART_CMD="${OPENCLAW_RESTART_CMD:-openclaw daemon restart}"
CHAT_CHANNEL="${CHAT_CHANNEL:-}"
CHAT_TARGET="${CHAT_TARGET:-${OPENCLAW_INSTALL_TARGET:-}}"
CHAT_ACCOUNT_ID="${CHAT_ACCOUNT_ID:-}"
RETRY_SLEEP_SEC="${RETRY_SLEEP_SEC:-2}"

step_ok() {
  local n="$1"
  local action="$2"
  printf 'Step %s/%s: %s -> OK\n' "$n" "$TOTAL_STEPS" "$action"
}

step_failed() {
  local n="$1"
  local action="$2"
  local remediation="$3"
  printf 'Step %s/%s: %s -> FAILED\n' "$n" "$TOTAL_STEPS" "$action"
  printf 'Remediation: %s\n' "$remediation"
  exit 1
}

recovery_note() {
  local msg="$1"
  printf '[recovery] %s\n' "$msg" >&2
}

run_shell() {
  local cmd="$1"
  bash -lc "$cmd"
}

install_plugin_with_recovery() {
  local source="$1"
  local packed_file=''

  if openclaw plugins install "$source"; then
    return 0
  fi

  recovery_note "plugin install from source failed; retrying from local package directory"
  if openclaw plugins install "$ROOT_DIR/packages/clawpilot-plugin"; then
    return 0
  fi

  recovery_note "local directory install failed; building tarball and retrying"
  packed_file="$(cd "$ROOT_DIR/packages/clawpilot-plugin" && npm pack --silent | tail -n 1)"
  if [[ -n "$packed_file" ]] && openclaw plugins install "$ROOT_DIR/packages/clawpilot-plugin/$packed_file"; then
    return 0
  fi

  return 1
}

restart_gateway_with_recovery() {
  if run_shell "$OPENCLAW_RESTART_CMD"; then
    return 0
  fi

  recovery_note "daemon restart failed; trying stop/start sequence"
  if run_shell "openclaw daemon stop" && sleep "$RETRY_SLEEP_SEC" && run_shell "openclaw daemon start"; then
    return 0
  fi

  return 1
}

verify_plugin_loaded_with_recovery() {
  if openclaw plugins info "$PLUGIN_ID" >/dev/null 2>&1; then
    return 0
  fi

  recovery_note "plugin info failed; restarting gateway and re-checking"
  if restart_gateway_with_recovery && openclaw plugins info "$PLUGIN_ID" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

run_chat_install_with_recovery() {
  if [[ -z "$CHAT_TARGET" ]]; then
    return 2
  fi

  local send_cmd=(openclaw message send --target "$CHAT_TARGET" --message '/clawpilot install')
  if [[ -n "$CHAT_CHANNEL" ]]; then
    send_cmd+=(--channel "$CHAT_CHANNEL")
  fi
  if [[ -n "$CHAT_ACCOUNT_ID" ]]; then
    send_cmd+=(--account-id "$CHAT_ACCOUNT_ID")
  fi

  if "${send_cmd[@]}" >/dev/null 2>&1; then
    return 0
  fi

  recovery_note "chat /clawpilot install send failed; retrying setup alias"
  send_cmd=(openclaw message send --target "$CHAT_TARGET" --message '/clawpilot setup')
  if [[ -n "$CHAT_CHANNEL" ]]; then
    send_cmd+=(--channel "$CHAT_CHANNEL")
  fi
  if [[ -n "$CHAT_ACCOUNT_ID" ]]; then
    send_cmd+=(--account-id "$CHAT_ACCOUNT_ID")
  fi

  if "${send_cmd[@]}" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

if ! command -v openclaw >/dev/null 2>&1; then
  step_failed 1 "source check" "Install OpenClaw CLI first, then rerun this script."
fi

# Step 1/6: source check
if [[ -z "$PLUGIN_SOURCE" ]]; then
  recovery_note "LOBSTER_PLUGIN_SOURCE was empty; using default package name"
  PLUGIN_SOURCE='@clawpilot/clawpilot'
fi
if [[ "$PLUGIN_SOURCE" == .* || "$PLUGIN_SOURCE" == /* ]] && [[ ! -e "$PLUGIN_SOURCE" ]]; then
  recovery_note "configured source path not found; falling back to @clawpilot/clawpilot"
  PLUGIN_SOURCE='@clawpilot/clawpilot'
fi
step_ok 1 "source check"

# Step 2/6: install plugin
if install_plugin_with_recovery "$PLUGIN_SOURCE"; then
  step_ok 2 "install plugin"
else
  step_failed 2 "install plugin" "Run: openclaw plugins install @clawpilot/clawpilot (or a valid local package path), then rerun this script."
fi

# Step 3/6: restart gateway
if restart_gateway_with_recovery; then
  step_ok 3 "restart gateway"
else
  step_failed 3 "restart gateway" "Run: openclaw daemon restart (or stop/start), verify daemon health, then rerun."
fi

# Step 4/6: verify plugin loaded
if verify_plugin_loaded_with_recovery; then
  step_ok 4 "verify plugin loaded"
else
  step_failed 4 "verify plugin loaded" "Run: openclaw plugins info clawpilot; if missing, reinstall plugin and restart daemon."
fi

# Step 5/6: run /clawpilot install
chat_install_code=0
if run_chat_install_with_recovery; then
  step_ok 5 "run /clawpilot install"
else
  chat_install_code=$?
  if [[ "$chat_install_code" -eq 2 ]]; then
    step_failed 5 "run /clawpilot install" "Set CHAT_TARGET (and optional CHAT_CHANNEL/CHAT_ACCOUNT_ID), then rerun this script so it can send /clawpilot install to chat."
  fi
  step_failed 5 "run /clawpilot install" "Verify OpenClaw message send permissions and channel routing, then manually send /clawpilot install in chat."
fi

# Step 6/6: final pass/fail
step_ok 6 "final pass/fail"
