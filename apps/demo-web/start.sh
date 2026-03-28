#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "🔨 Building @ts-rtc/webrtc..."
pnpm --filter @ts-rtc/webrtc build

echo "🌐 Starting demo-web on http://localhost:3000 ..."
pnpm start
