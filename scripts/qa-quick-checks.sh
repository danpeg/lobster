#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${1:-quick-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="$ROOT_DIR/qa/runs/$RUN_ID"
OUT_FILE="$OUT_DIR/quick-checks.log"

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

  echo "[qa-quick-checks] finished_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$OUT_FILE"

echo "Quick checks log: $OUT_FILE"
