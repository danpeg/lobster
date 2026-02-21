#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEW_SCRIPT="$SCRIPT_DIR/require-cloudflared-quick-tunnel.sh"

if [[ ! -x "$NEW_SCRIPT" ]]; then
  echo "Missing $NEW_SCRIPT"
  exit 1
fi

exec "$NEW_SCRIPT" "$@"
