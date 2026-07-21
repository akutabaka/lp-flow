#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer was not found on PATH. Install Node.js before starting LP-Flow." >&2
  exit 1
fi

exec node "$PLUGIN_ROOT/scripts/lp-flow.mjs" mcp
