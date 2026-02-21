#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${1:-quick-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="$ROOT_DIR/qa/runs/$RUN_ID"
OUT_FILE="$OUT_DIR/bridge-auth-check.log"
BRIDGE_BASE_URL="${BRIDGE_BASE_URL:-http://127.0.0.1:3001}"
BRIDGE_STATUS_URL="${BRIDGE_STATUS_URL:-${BRIDGE_BASE_URL%/}/copilot/status}"
BRIDGE_HEALTH_URL="${BRIDGE_HEALTH_URL:-${BRIDGE_BASE_URL%/}/health}"
BRIDGE_TOKEN_ENV_FILE="${BRIDGE_TOKEN_ENV_FILE:-$ROOT_DIR/services/clawpilot-bridge/.env}"
BRIDGE_WEBHOOK_ENV_FILE="${BRIDGE_WEBHOOK_ENV_FILE:-$BRIDGE_TOKEN_ENV_FILE}"
QUICK_TUNNEL_CHECK_SCRIPT="$ROOT_DIR/scripts/require-cloudflared-quick-tunnel.sh"

mkdir -p "$OUT_DIR"
: > "$OUT_FILE"

log_line() {
  local line="$1"
  printf '%s\n' "$line" | tee -a "$OUT_FILE"
}

fail_check() {
  local reason="$1"
  log_line "[qa-bridge-auth-check] result=FAIL"
  log_line "[qa-bridge-auth-check] reason=${reason}"
  exit 1
}

load_bridge_token() {
  if [[ -n "${BRIDGE_API_TOKEN:-}" ]]; then
    return 0
  fi
  if [[ ! -f "$BRIDGE_TOKEN_ENV_FILE" ]]; then
    return 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$BRIDGE_TOKEN_ENV_FILE"
  set +a
  [[ -n "${BRIDGE_API_TOKEN:-}" ]]
}

probe_status_code() {
  local url="$1"
  local body_file="$2"
  shift 2
  local code
  if ! code="$(curl -sS -o "$body_file" -w '%{http_code}' "$url" "$@" 2>/dev/null)"; then
    printf '000'
    return 0
  fi
  printf '%s' "$code"
}

log_line "[qa-bridge-auth-check] run_id=$RUN_ID"
log_line "[qa-bridge-auth-check] started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log_line "[qa-bridge-auth-check] status_url=$BRIDGE_STATUS_URL"

UNAUTH_BODY="$(mktemp)"
AUTH_BODY="$(mktemp)"
trap 'rm -f "$UNAUTH_BODY" "$AUTH_BODY"' EXIT

UNAUTH_CODE="$(probe_status_code "$BRIDGE_STATUS_URL" "$UNAUTH_BODY")"
log_line "SUMMARY unauth_status_code=$UNAUTH_CODE"
if [[ "$UNAUTH_CODE" != "401" ]]; then
  fail_check "Expected unauthenticated /copilot/status to return 401, got ${UNAUTH_CODE}."
fi

if ! load_bridge_token; then
  fail_check "BRIDGE_API_TOKEN unavailable (set env or BRIDGE_TOKEN_ENV_FILE=${BRIDGE_TOKEN_ENV_FILE})."
fi

AUTH_CODE="$(probe_status_code "$BRIDGE_STATUS_URL" "$AUTH_BODY" -H "Authorization: Bearer ${BRIDGE_API_TOKEN}")"
log_line "SUMMARY auth_status_code=$AUTH_CODE"
if [[ "$AUTH_CODE" != "200" ]]; then
  fail_check "Expected authenticated /copilot/status to return 200, got ${AUTH_CODE}."
fi

if ! command -v openclaw >/dev/null 2>&1; then
  fail_check "openclaw CLI not found; cannot verify plugin bridgeToken config."
fi

PLUGIN_TOKEN="$(openclaw config get plugins.entries.clawpilot.config.bridgeToken 2>/dev/null || true)"
if [[ -z "$PLUGIN_TOKEN" ]]; then
  fail_check "Plugin bridgeToken is missing (plugins.entries.clawpilot.config.bridgeToken)."
fi
if [[ "$PLUGIN_TOKEN" != "$BRIDGE_API_TOKEN" ]]; then
  fail_check "Plugin bridgeToken does not match BRIDGE_API_TOKEN (token drift)."
fi
log_line "SUMMARY plugin_token_aligned=true"

if [[ ! -x "$QUICK_TUNNEL_CHECK_SCRIPT" ]]; then
  fail_check "Missing executable quick tunnel check script: $QUICK_TUNNEL_CHECK_SCRIPT"
fi

log_line "[qa-bridge-auth-check] running cloudflared quick tunnel alignment check"
OUT_FILE="$OUT_FILE" \
BRIDGE_ENV_FILE="$BRIDGE_WEBHOOK_ENV_FILE" \
BRIDGE_HEALTH_URL="$BRIDGE_HEALTH_URL" \
"$QUICK_TUNNEL_CHECK_SCRIPT"

log_line "[qa-bridge-auth-check] finished_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log_line "[qa-bridge-auth-check] result=PASS"
log_line "bridge-auth-check.log: $OUT_FILE"
