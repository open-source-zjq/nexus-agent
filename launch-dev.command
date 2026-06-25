#!/bin/zsh
# DOUBLE-CLICK IN FINDER (or launched via `open -a Terminal`).
#
# Launches the Nexus Agent Tauri DESKTOP app in dev form — ONE window, ONE
# action. NOT a packaged .app, and the user does NOT start front/back by hand.
#
# macOS 26 reality: the adhoc/linker-signed Tauri debug binary is SIGTERM'd by
# AMFI's Validation Category Policy the instant it spawns nvm's `node` (the
# backend sidecar) — the kill walks UP the tree, so the whole app dies in <10s
# with no Tauri exit event (the "flash crash"). Signing the app does not help:
# the spawned `node` is what trips the policy and the SIGTERM propagates upward.
#
# Fix that keeps it a single desktop-app launch: this Terminal session (an
# Apple-signed /bin/zsh — spawning `node` from it is normal and NOT policed)
# starts the backend runtime, then runs the SIGNED desktop binary in
# NEXUS_EXTERNAL_RUNTIME mode. In that mode the desktop binary spawns NOTHING —
# it just points its WebView at the already-healthy runtime-served SPA. No
# node-spawn under the app ⇒ nothing for AMFI to tree-kill; the WebView's first
# load succeeds ⇒ no macOS-26 WebContent-invalidation crash. The app stays up.
set -uo pipefail
# Finder/Terminal run this non-interactively, so nvm in ~/.zshrc may not be
# sourced. Prefer an already-resolvable node; fall back to the known nvm install.
NODE_BIN="$(dirname "$(command -v node 2>/dev/null)" 2>/dev/null)"
[[ -x "$NODE_BIN/node" ]] || NODE_BIN="$HOME/.nvm/versions/node/v25.8.1/bin"
export PATH="$NODE_BIN:$PATH"

# The launcher lives at the repo root; resolve the repo from its own location.
REPO="${0:A:h}"
TAURI="$REPO/desktop/src-tauri"
BIN="$TAURI/target/debug/nexus-agent-desktop"
ENT="$TAURI/dev.entitlements"
TSX="$REPO/node_modules/.bin/tsx"
LOG="/tmp/nexus-tauri-dev.log"
BACKEND_LOG="/tmp/nexus-backend.log"
HOST="127.0.0.1"; PORT="8910"
TOKEN="$(uuidgen | tr -d - )$(uuidgen | tr -d - )"
cd "$REPO" || exit 1

: > "$LOG"
log() { print -r -- "$@" | tee -a "$LOG"; }

log "=== Nexus Agent — tauri desktop (external-runtime, AMFI-safe) ==="

# Pre-clean stale runtime/desktop so port 8910 is free and no ghost window.
pkill -f "backend/src/cli/serve-entry.ts" 2>/dev/null || true
pkill -f "nexus-agent-desktop" 2>/dev/null || true
pkill -f "binaries/nexus-agent-runtime" 2>/dev/null || true
pkill -f "target/debug/nexus-agent-runtime" 2>/dev/null || true
sleep 0.5

# 1) built SPA must exist (the WebView loads it from the runtime on :8910).
if [[ ! -f "$REPO/frontend/dist/index.html" ]]; then
  log "[1/4] building frontend (one-time)…"
  npm run build -w frontend 2>&1 | tee -a "$LOG"
else
  log "[1/4] frontend/dist present — skip build"
fi

# 2) build + sign the desktop binary (debug, no bundle). Signing is belt-and-
#    suspenders here (it spawns nothing in external mode) but keeps it launchable.
log "[2/4] cargo build (desktop binary)…"
( cd "$TAURI" && cargo build --no-default-features ) 2>&1 | tee -a "$LOG"
[[ -x "$BIN" ]] || { log "FATAL: binary missing after build"; read _; exit 1; }
codesign --force --options runtime --timestamp=none --entitlements "$ENT" -s - "$BIN" >/dev/null 2>&1 || true

# 3) start the backend runtime in THIS Terminal session (survives — see header).
log "[3/4] starting backend runtime on $HOST:$PORT …"
: > "$BACKEND_LOG"
NEXUS_HOST="$HOST" NEXUS_PORT="$PORT" NEXUS_RUNTIME_TOKEN="$TOKEN" \
NEXUS_STATIC_DIR="$REPO/frontend/dist" \
  "$TSX" "$REPO/backend/src/cli/serve-entry.ts" serve >>"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
log "      backend pid=$BACKEND_PID (log: $BACKEND_LOG)"

cleanup() {
  log ""
  log "=== shutting down (stopping backend pid=$BACKEND_PID) ==="
  kill "$BACKEND_PID" 2>/dev/null || true
  pkill -f "backend/src/cli/serve-entry.ts" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# wait for /health (tsx transpile of the runtime can take ~10-25s on first boot)
READY=0
for i in $(seq 1 80); do
  if curl -sf -m 1 "http://$HOST:$PORT/health" >/dev/null 2>&1; then READY=1; break; fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    log "ERROR: backend exited before binding. last log:"; tail -30 "$BACKEND_LOG" | tee -a "$LOG"; read _; exit 1
  fi
  sleep 0.5
done
[[ "$READY" -eq 1 ]] || { log "ERROR: backend not healthy in 40s"; tail -30 "$BACKEND_LOG" | tee -a "$LOG"; read _; exit 1; }
log "      backend healthy at http://$HOST:$PORT"

# 4) run the signed desktop binary in external-runtime mode (spawns NOTHING).
log "[4/4] launching desktop app — keep THIS window open. Ctrl-C stops everything."
log ""
NEXUS_EXTERNAL_RUNTIME=1 NEXUS_RUNTIME_TOKEN="$TOKEN" "$BIN" 2>&1 | tee -a "$LOG"
status=${pipestatus[1]}
log ""
log "=== desktop app exited (code $status) ==="
echo "Press Enter to close this window."
read _
