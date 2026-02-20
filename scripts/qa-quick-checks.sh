#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${1:-quick-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="$ROOT_DIR/qa/runs/$RUN_ID"
OUT_FILE="$OUT_DIR/quick-checks.log"
RUN_VPS_AUTH_CHECK="${RUN_VPS_AUTH_CHECK:-false}"

is_truthy() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ "$value" == "true" || "$value" == "1" || "$value" == "yes" || "$value" == "on" ]]
}

mkdir -p "$OUT_DIR"

{
  echo "[qa-quick-checks] run_id=$RUN_ID"
  echo "[qa-quick-checks] started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo

  echo "[qa-quick-checks] npm run security:scan"
  (cd "$ROOT_DIR" && npm run security:scan)
  echo

  echo "[qa-quick-checks] npm run check:plugin-pack"
  (cd "$ROOT_DIR" && npm run check:plugin-pack)
  echo

  if is_truthy "$RUN_VPS_AUTH_CHECK"; then
    echo "[qa-quick-checks] RUN_VPS_AUTH_CHECK=true -> running bridge/funnel auth preflight"
    (cd "$ROOT_DIR" && ./scripts/qa-bridge-auth-check.sh "$RUN_ID")
    echo
  else
    echo "[qa-quick-checks] RUN_VPS_AUTH_CHECK=false -> skipping bridge/funnel auth preflight"
    echo
  fi

  echo "[qa-quick-checks] finished_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$OUT_FILE"

echo "Quick checks log: $OUT_FILE"
