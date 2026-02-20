#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${1:-quick-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="$ROOT_DIR/qa/runs/$RUN_ID"
OUT_FILE="$OUT_DIR/bridge-auth-check.log"
ENV_FILE="${CLAWPILOT_VPS_ENV_FILE:-/Users/danpeguine/Projects/.clawpilot-vps.env}"

mkdir -p "$OUT_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  {
    echo "[qa-bridge-auth-check] env_file=$ENV_FILE"
    echo "[qa-bridge-auth-check] result=SKIP (env file missing)"
  } | tee "$OUT_FILE"
  exit 0
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

VPS_HOST="${VPS_HOST:-}"
VPS_SSH_USER="${VPS_SSH_USER:-}"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_OPTS="${VPS_SSH_OPTS:-}"
BRIDGE_HEALTH_URL="${BRIDGE_HEALTH_URL:-http://127.0.0.1:3001/health}"
BRIDGE_TOKEN_ENV_FILE="${BRIDGE_TOKEN_ENV_FILE:-/root/.recall-env}"
BRIDGE_BASE_URL_DEFAULT="${BRIDGE_BASE_URL_DEFAULT:-http://127.0.0.1:3001}"

if [[ -z "$VPS_HOST" ]]; then
  {
    echo "[qa-bridge-auth-check] result=FAIL (VPS_HOST missing)"
  } | tee "$OUT_FILE"
  exit 1
fi

ssh_target="$VPS_HOST"
if [[ -n "$VPS_SSH_USER" ]]; then
  ssh_target="${VPS_SSH_USER}@${VPS_HOST}"
fi

{
  echo "[qa-bridge-auth-check] run_id=$RUN_ID"
  echo "[qa-bridge-auth-check] started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[qa-bridge-auth-check] target=$ssh_target"
  echo "[qa-bridge-auth-check] bridge_health_url=$BRIDGE_HEALTH_URL"
  echo "[qa-bridge-auth-check] bridge_token_env_file=$BRIDGE_TOKEN_ENV_FILE"
  echo

  # shellcheck disable=SC2086
  ssh -p "$VPS_SSH_PORT" $VPS_SSH_OPTS "$ssh_target" /usr/bin/env bash -s -- \
    "$BRIDGE_HEALTH_URL" \
    "$BRIDGE_TOKEN_ENV_FILE" \
    "$BRIDGE_BASE_URL_DEFAULT" <<'REMOTE'
set -euo pipefail

health_url="$1"
token_env_file="$2"
base_default="$3"

if [[ "$health_url" == */health ]]; then
  base_url="${health_url%/health}"
else
  base_url="$base_default"
fi
status_url="${base_url%/}/copilot/status"

unauth_code="$(curl -sS -o /tmp/qa-auth-unauth.json -w '%{http_code}' "$status_url")"

echo "unauth_status_code=$unauth_code"

if [[ "$unauth_code" == "200" ]]; then
  echo "auth_enforced=false"
  echo "auth_status_code=SKIP"
  echo "plugin_bridge_token_configured=SKIP"
  echo "result=PASS"
  exit 0
fi

if [[ "$unauth_code" != "401" ]]; then
  echo "auth_enforced=unknown"
  echo "auth_status_code=SKIP"
  echo "plugin_bridge_token_configured=unknown"
  echo "result=FAIL (unexpected unauth status code)"
  exit 1
fi

echo "auth_enforced=true"

if [[ ! -f "$token_env_file" ]]; then
  echo "auth_status_code=SKIP"
  echo "plugin_bridge_token_configured=unknown"
  echo "result=FAIL (token env file missing)"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$token_env_file"
set +a

if [[ -z "${BRIDGE_API_TOKEN:-}" ]]; then
  echo "auth_status_code=SKIP"
  echo "plugin_bridge_token_configured=unknown"
  echo "result=FAIL (BRIDGE_API_TOKEN missing)"
  exit 1
fi

if openclaw config get plugins.entries.clawpilot.config.bridgeToken >/dev/null 2>&1; then
  echo "plugin_bridge_token_configured=yes"
else
  echo "plugin_bridge_token_configured=no"
fi

auth_code="$(curl -sS -o /tmp/qa-auth-auth.json -w '%{http_code}' -H "Authorization: Bearer ${BRIDGE_API_TOKEN}" "$status_url")"
echo "auth_status_code=$auth_code"

if [[ "$auth_code" != "200" ]]; then
  echo "result=FAIL (authorized status call failed)"
  exit 1
fi

if ! openclaw config get plugins.entries.clawpilot.config.bridgeToken >/dev/null 2>&1; then
  echo "result=FAIL (plugin bridgeToken missing)"
  exit 1
fi

echo "result=PASS"
REMOTE

  echo
  echo "[qa-bridge-auth-check] finished_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$OUT_FILE"

echo "Bridge auth check log: $OUT_FILE"
