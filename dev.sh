#!/usr/bin/env bash
# Local development: Designotron bridge (:5174) + editor dev server (:5173).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d web/node_modules ]; then
  (cd web && npm install)
fi
if [ ! -f web/src/wasm/pkg/designotron_engine_wasm_bg.wasm ]; then
  (cd web && npm run wasm)
fi

cargo build -p designotron-bridge
./target/debug/designotron "$@" &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null || true' EXIT INT TERM

echo
echo "  Editor:  http://localhost:5173"
echo "  MCP:     claude mcp add --transport http designotron http://127.0.0.1:5174/mcp"
echo
(cd web && npx vite --port 5173)
