#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[scan] scanning repository for likely secrets..."

PATTERN='(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{30,}|BEGIN[[:space:]]+PRIVATE[[:space:]]+KEY|ntn_[A-Za-z0-9]{20,}|[0-9]{9,}:[A-Za-z0-9_-]{30,}|tailc[0-9a-z]{5,}\.ts\.net)'

if rg -n --hidden -g '!.git' -g '!**/node_modules/**' -g '!**/package-lock.json' "$PATTERN"; then
  echo "[scan] potential secret(s) found; please remove or rotate before commit/publish."
  exit 1
fi

echo "[scan] no obvious secrets found."
