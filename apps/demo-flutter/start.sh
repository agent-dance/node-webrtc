#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

default_flutter_device() {
  case "$(uname -s)" in
    Darwin*) echo "macos" ;;
    CYGWIN*|MINGW*|MSYS*) echo "windows" ;;
    *) echo "macos" ;;
  esac
}

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

DEVICE="${1:-$(default_flutter_device)}"
flutter run -d "$DEVICE"
