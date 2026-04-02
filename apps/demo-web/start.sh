#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

pnpm_cmd() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    echo "pnpm not found. Install pnpm or enable corepack." >&2
    exit 1
  fi
}

echo "📦 Installing dependencies..."
pnpm_cmd install --frozen-lockfile 2>/dev/null || pnpm_cmd install

echo "🔨 Building @agentdance/node-webrtc..."
pnpm_cmd --filter @agentdance/node-webrtc build

echo "🌐 Starting demo-web on http://localhost:3000 ..."
pnpm_cmd start
