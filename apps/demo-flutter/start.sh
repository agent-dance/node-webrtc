#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 中国镜像源（上海交通大学） ────────────────────────────────────────────────
export PUB_HOSTED_URL="https://pub.flutter-io.cn"
export FLUTTER_STORAGE_BASE_URL="https://storage.flutter-io.cn"

echo "📦 Getting Flutter dependencies (mirror: flutter-io.cn)..."
flutter pub get

echo ""
echo "📱 Available devices:"
flutter devices

echo ""
echo "🐦 Starting Flutter app (choose a device below, or press Enter for default)..."
echo "   Tip: use -d <device-id> to target a specific device"
echo ""

if [ "${1:-}" != "" ]; then
  flutter run -d "$1"
else
  flutter run -d macos
fi
