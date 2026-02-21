#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-$ROOT_DIR/services/clawpilot-bridge/.env}"
BRIDGE_HEALTH_URL="${BRIDGE_HEALTH_URL:-http://127.0.0.1:3001/health}"
OUT_FILE="${OUT_FILE:-}"
CURL_TIMEOUT_SEC="${CURL_TIMEOUT_SEC:-8}"

log_line() {
  local line="$1"
  printf '%s\n' "$line"
  if [[ -n "$OUT_FILE" ]]; then
    printf '%s\n' "$line" >> "$OUT_FILE"
  fi
}

fail_check() {
  local reason="$1"
  log_line "[quick-tunnel-check] result=FAIL"
  log_line "[quick-tunnel-check] reason=${reason}"
  exit 1
}

summary() {
  local key="$1"
  local value="$2"
  log_line "SUMMARY ${key}=${value}"
}

extract_host() {
  local url="$1"
  local no_proto
  no_proto="${url#https://}"
  no_proto="${no_proto%%/*}"
  printf '%s' "${no_proto%%:*}"
}

if [[ -n "$OUT_FILE" ]]; then
  mkdir -p "$(dirname "$OUT_FILE")"
  : > "$OUT_FILE"
fi

if [[ -f "$BRIDGE_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$BRIDGE_ENV_FILE"
  set +a
fi

if [[ -n "${WEBHOOK_BASE_URL:-}" ]]; then
  fail_check 'Old config detected. Run `npx clawpilot setup --fresh` to reconfigure.'
fi
if [[ -n "${ALLOW_NGROK_FALLBACK:-}" ]]; then
  fail_check 'Old config detected. Run `npx clawpilot setup --fresh` to reconfigure.'
fi

CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
if ! command -v "$CLOUDFLARED_BIN" >/dev/null 2>&1; then
  fail_check "cloudflared not found in PATH (bin=${CLOUDFLARED_BIN})."
fi

HEALTH_BODY_FILE="$(mktemp)"
trap 'rm -f "$HEALTH_BODY_FILE"' EXIT

HTTP_CODE="$(curl -sS --max-time "$CURL_TIMEOUT_SEC" -o "$HEALTH_BODY_FILE" -w '%{http_code}' "$BRIDGE_HEALTH_URL" 2>/dev/null || printf '000')"
if [[ "$HTTP_CODE" != "200" ]]; then
  fail_check "bridge /health failed (${BRIDGE_HEALTH_URL} -> HTTP ${HTTP_CODE})."
fi

STATUS=""
TUNNEL_UP=""
TUNNEL_URL=""
if command -v jq >/dev/null 2>&1; then
  STATUS="$(jq -r '.status // empty' "$HEALTH_BODY_FILE" 2>/dev/null || true)"
  TUNNEL_UP="$(jq -r '.tunnel.up // empty' "$HEALTH_BODY_FILE" 2>/dev/null || true)"
  TUNNEL_URL="$(jq -r '.tunnel.public_url // empty' "$HEALTH_BODY_FILE" 2>/dev/null || true)"
else
  STATUS="$(grep -Eo '"status"[[:space:]]*:[[:space:]]*"[^"]+"' "$HEALTH_BODY_FILE" | head -n1 | sed -E 's/.*"([^"]+)"$/\1/' || true)"
  TUNNEL_UP="$(grep -Eo '"up"[[:space:]]*:[[:space:]]*(true|false)' "$HEALTH_BODY_FILE" | head -n1 | sed -E 's/.*(true|false)$/\1/' || true)"
  TUNNEL_URL="$(grep -Eo 'https://[^"[:space:]]+\.trycloudflare\.com' "$HEALTH_BODY_FILE" | head -n1 || true)"
fi

if [[ "$STATUS" != "ok" ]]; then
  fail_check "unexpected health status (${STATUS:-missing})."
fi
if [[ "$TUNNEL_UP" != "true" ]]; then
  fail_check "quick tunnel is not up yet."
fi
if [[ -z "$TUNNEL_URL" ]]; then
  fail_check 'quick tunnel URL missing from /health response.'
fi

TUNNEL_HOST="$(extract_host "$TUNNEL_URL")"
if [[ ! "$TUNNEL_HOST" =~ \.trycloudflare\.com$ ]]; then
  fail_check "quick tunnel host must end with .trycloudflare.com (got ${TUNNEL_HOST})."
fi

summary "bridge_health_url" "$BRIDGE_HEALTH_URL"
summary "cloudflared_bin" "$CLOUDFLARED_BIN"
summary "quick_tunnel_url" "$TUNNEL_URL"
summary "quick_tunnel_host" "$TUNNEL_HOST"
log_line "[quick-tunnel-check] result=PASS"
