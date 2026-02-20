#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-$ROOT_DIR/services/clawpilot-bridge/.env}"
BRIDGE_HEALTH_URL="${BRIDGE_HEALTH_URL:-http://127.0.0.1:3001/health}"
WEBHOOK_BASE_URL_OVERRIDE="${WEBHOOK_BASE_URL_OVERRIDE:-}"
REQUIRE_TS_NET="${REQUIRE_TS_NET:-true}"
REQUIRE_LOCAL_HEALTH="${REQUIRE_LOCAL_HEALTH:-true}"
OUT_FILE="${OUT_FILE:-}"
CURL_TIMEOUT_SEC="${CURL_TIMEOUT_SEC:-8}"

is_truthy() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ "$value" == "true" || "$value" == "1" || "$value" == "yes" || "$value" == "on" ]]
}

log_line() {
  local line="$1"
  printf '%s\n' "$line"
  if [[ -n "$OUT_FILE" ]]; then
    printf '%s\n' "$line" >> "$OUT_FILE"
  fi
}

fail_check() {
  local reason="$1"
  log_line "[funnel-check] result=FAIL"
  log_line "[funnel-check] reason=${reason}"
  exit 1
}

summary() {
  local key="$1"
  local value="$2"
  log_line "SUMMARY ${key}=${value}"
}

extract_url_host() {
  local url="$1"
  local no_proto
  no_proto="${url#https://}"
  no_proto="${no_proto%%/*}"
  printf '%s' "${no_proto%%:*}"
}

probe_http_code() {
  local url="$1"
  local body_file="$2"
  local code
  if ! code="$(curl -sS --max-time "$CURL_TIMEOUT_SEC" -o "$body_file" -w '%{http_code}' "$url" 2>/dev/null)"; then
    printf '000'
    return 0
  fi
  printf '%s' "$code"
}

validate_health_body() {
  local body_file="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -e '.status == "ok" and has("uptime") and has("hook") and has("prompt")' "$body_file" >/dev/null 2>&1
    return $?
  fi
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$body_file" \
    && grep -Eq '"hook"[[:space:]]*:' "$body_file" \
    && grep -Eq '"prompt"[[:space:]]*:' "$body_file"
}

if [[ -n "$OUT_FILE" ]]; then
  mkdir -p "$(dirname "$OUT_FILE")"
  touch "$OUT_FILE"
fi

if [[ -f "$BRIDGE_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$BRIDGE_ENV_FILE"
  set +a
fi

WEBHOOK_BASE_URL="${WEBHOOK_BASE_URL_OVERRIDE:-${WEBHOOK_BASE_URL:-}}"
if [[ -z "$WEBHOOK_BASE_URL" ]]; then
  fail_check "WEBHOOK_BASE_URL is empty. Set it to your Tailscale Funnel URL (https://<node>.ts.net)."
fi

if [[ ! "$WEBHOOK_BASE_URL" =~ ^https:// ]]; then
  fail_check "WEBHOOK_BASE_URL must use https:// (got non-HTTPS value)."
fi

WEBHOOK_HOST="$(extract_url_host "$WEBHOOK_BASE_URL")"
if is_truthy "$REQUIRE_TS_NET" && [[ ! "$WEBHOOK_HOST" =~ \.ts\.net$ ]]; then
  fail_check "WEBHOOK_BASE_URL host must end with .ts.net (got ${WEBHOOK_HOST})."
fi

LOCAL_BODY_FILE="$(mktemp)"
PUBLIC_BODY_FILE="$(mktemp)"
trap 'rm -f "$LOCAL_BODY_FILE" "$PUBLIC_BODY_FILE"' EXIT

LOCAL_CODE="SKIP"
if is_truthy "$REQUIRE_LOCAL_HEALTH"; then
  LOCAL_CODE="$(probe_http_code "$BRIDGE_HEALTH_URL" "$LOCAL_BODY_FILE")"
  if [[ "$LOCAL_CODE" != "200" ]]; then
    fail_check "Local bridge health check failed (${BRIDGE_HEALTH_URL} -> HTTP ${LOCAL_CODE}). Start/restart bridge and retry."
  fi
  if ! validate_health_body "$LOCAL_BODY_FILE"; then
    fail_check "Local bridge health response did not match expected ClawPilot shape."
  fi
fi

PUBLIC_HEALTH_URL="${WEBHOOK_BASE_URL%/}/health"
PUBLIC_CODE="$(probe_http_code "$PUBLIC_HEALTH_URL" "$PUBLIC_BODY_FILE")"
if [[ "$PUBLIC_CODE" != "200" ]]; then
  fail_check "Public Funnel health check failed (${PUBLIC_HEALTH_URL} -> HTTP ${PUBLIC_CODE}). Verify Funnel routing to bridge."
fi
if ! validate_health_body "$PUBLIC_BODY_FILE"; then
  fail_check "Public Funnel /health response did not match expected ClawPilot bridge shape."
fi

summary "webhook_base_url" "$WEBHOOK_BASE_URL"
summary "bridge_health_url" "$BRIDGE_HEALTH_URL"
summary "public_health_url" "$PUBLIC_HEALTH_URL"
summary "local_health_code" "$LOCAL_CODE"
summary "public_health_code" "$PUBLIC_CODE"
log_line "[funnel-check] result=PASS"
