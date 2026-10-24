#!/usr/bin/env bash
# Registers the P2P MCP server with Claude Code.
# Usage: scripts/install-mcp.sh
# Env:   P2P_API_URL  API the MCP tools call (default http://localhost:3000)
#        MCP_SCOPE    claude mcp scope: user, project or local (default user)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
P2P_API_URL="${P2P_API_URL:-http://localhost:3000}"
MCP_SCOPE="${MCP_SCOPE:-user}"
SERVER_NAME="p2p"

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found on PATH. Install Claude Code first: https://claude.com/claude-code" >&2
  exit 1
fi

# Replace any previous registration so re-running the script is safe.
claude mcp remove "$SERVER_NAME" --scope "$MCP_SCOPE" >/dev/null 2>&1 || true

claude mcp add "$SERVER_NAME" --scope "$MCP_SCOPE" -e P2P_API_URL="$P2P_API_URL" -- \
  npx --prefix "$ROOT" tsx "$ROOT/src/mcp/stdio.ts"

cat <<EOF

Registered MCP server '$SERVER_NAME' (scope: $MCP_SCOPE, API: $P2P_API_URL).

Next steps:
  1. Start the API:        cd "$ROOT" && npm run dev
  2. Confirm registration: claude mcp list
  3. Inspect tools (optional): npx @modelcontextprotocol/inspector npx tsx "$ROOT/src/mcp/stdio.ts"
EOF
