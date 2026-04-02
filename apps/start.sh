#!/usr/bin/env bash
# apps/start.sh – One-click launcher for the full ts-rtc P2P demo
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[start]${RESET} $*"; }
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET} $*"; }
die()  { echo -e "${RED}  ✗ $*${RESET}"; exit 1; }

pnpm_cmd() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    die "pnpm not found. Install pnpm or use a Node.js install with corepack enabled."
  fi
}

default_flutter_device() {
  case "$(uname -s)" in
    Darwin*) echo "macos" ;;
    CYGWIN*|MINGW*|MSYS*) echo "windows" ;;
    *) echo "macos" ;;
  esac
}

# ── dependency checks ─────────────────────────────────────────────────────────
log "Checking dependencies..."
command -v go    >/dev/null 2>&1 || die "Go not found. Install from https://go.dev/dl/"
command -v pnpm  >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1 || \
  die "pnpm not found. Install pnpm or enable corepack."
command -v flutter >/dev/null 2>&1 && HAS_FLUTTER=1 || { warn "Flutter not found – skipping Flutter step."; HAS_FLUTTER=0; }
ok "Dependencies OK"

# ── cleanup on exit ───────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  echo ""
  log "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  log "Done."
}
trap cleanup EXIT INT TERM

# ── 1. signaling server ───────────────────────────────────────────────────────
log "Starting signaling server (:8080)..."
cd "$SCRIPT_DIR/signaling-server"
go run ./cmd/server > /tmp/ts-rtc-signaling.log 2>&1 &
PIDS+=($!)
SIG_PID=$!

# Wait until :8080 is accepting connections (max 10 s)
for i in $(seq 1 20); do
  if nc -z 127.0.0.1 8080 2>/dev/null; then break; fi
  sleep 0.5
  if ! kill -0 "$SIG_PID" 2>/dev/null; then
    die "Signaling server crashed. Check /tmp/ts-rtc-signaling.log"
  fi
done
nc -z 127.0.0.1 8080 2>/dev/null || die "Signaling server did not start in time. Check /tmp/ts-rtc-signaling.log"
ok "Signaling server up  →  ws://localhost:8080/ws"

# ── 2. demo-web ───────────────────────────────────────────────────────────────
log "Installing pnpm dependencies..."
cd "$SCRIPT_DIR/.."
pnpm_cmd install --frozen-lockfile 2>/dev/null || pnpm_cmd install

log "Building @agentdance/node-webrtc..."
pnpm_cmd --filter @agentdance/node-webrtc build >/dev/null

log "Starting demo-web (:3000)..."
cd "$SCRIPT_DIR/demo-web"
pnpm_cmd start > /tmp/ts-rtc-demo-web.log 2>&1 &
PIDS+=($!)
WEB_PID=$!

# Wait until :3000 is accepting connections (max 15 s)
for i in $(seq 1 30); do
  if nc -z 127.0.0.1 3000 2>/dev/null; then break; fi
  sleep 0.5
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    die "demo-web crashed. Check /tmp/ts-rtc-demo-web.log"
  fi
done
nc -z 127.0.0.1 3000 2>/dev/null || die "demo-web did not start in time. Check /tmp/ts-rtc-demo-web.log"
ok "demo-web up  →  http://localhost:3000"

# ── 3. open browser ───────────────────────────────────────────────────────────
if command -v open >/dev/null 2>&1; then
  open "http://localhost:3000" 2>/dev/null || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3000" 2>/dev/null || true
fi

# ── 4. flutter (optional) ─────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════════${RESET}"
echo -e "${GREEN}  ✅  All backend services are running!${RESET}"
echo -e "${BOLD}════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${CYAN}Signaling${RESET}  ws://localhost:8080/ws"
echo -e "  ${CYAN}Dashboard${RESET}  http://localhost:3000"
echo ""
echo -e "  ${YELLOW}Logs:${RESET}"
echo -e "    Signaling →  /tmp/ts-rtc-signaling.log"
echo -e "    demo-web  →  /tmp/ts-rtc-demo-web.log"
echo ""

if [ "$HAS_FLUTTER" -eq 1 ]; then
  echo -e "  ${CYAN}Flutter${RESET}    Starting in foreground (Ctrl+C stops everything)..."
  echo ""
  cd "$SCRIPT_DIR/demo-flutter"
  # 中国镜像源
  export PUB_HOSTED_URL="https://pub.flutter-io.cn"
  export FLUTTER_STORAGE_BASE_URL="https://storage.flutter-io.cn"
  flutter pub get >/dev/null
  DEVICE="${1:-$(default_flutter_device)}"
  flutter run -d "$DEVICE"
else
  echo -e "  ${YELLOW}Flutter${RESET}    Run manually:"
  echo -e "    cd apps/demo-flutter && flutter run"
  echo ""
  echo "Press Ctrl+C to stop all services."
  # Keep script alive so trap fires on Ctrl+C
  wait "${PIDS[@]}" 2>/dev/null || true
fi
