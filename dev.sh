#!/usr/bin/env bash
#
# dev.sh — start the rj-player backend (:8080) and frontend (:5173) together.
#
#   ./dev.sh          start both; open http://127.0.0.1:5173; Ctrl-C stops both
#
# Config comes from config.toml (whisper model, LLM provider/key, etc.).
# Env vars still override, so e.g.  WHISPER_MODEL=large-v3 ./dev.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${PORT:-8080}"
FRONTEND_PORT=5173

say() { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- prerequisites -------------------------------------------------------
command -v cargo >/dev/null 2>&1 || die "cargo (Rust) not found — install from https://rustup.rs"
command -v node  >/dev/null 2>&1 || die "node not found — install Node 18+"
command -v yt-dlp >/dev/null 2>&1 || warn "warning: yt-dlp not on PATH — downloading videos will fail (brew install yt-dlp)"
command -v ffmpeg >/dev/null 2>&1 || warn "warning: ffmpeg not on PATH — audio extraction will fail (brew install ffmpeg)"
[ -f "$ROOT/config.toml" ] || warn "note: no config.toml found — using built-in defaults + env vars (copy config.example.toml to config.toml to edit settings/keys)"

# first run: install frontend deps
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  say "→ installing frontend deps (first run)…"
  ( cd "$ROOT/frontend" && npm install ) || die "npm install failed"
fi

# --- stop both on exit / Ctrl-C ------------------------------------------
cleanup() {
  trap - INT TERM EXIT
  echo ""
  say "→ stopping backend + frontend…"
  local p
  p=$(lsof -ti tcp:"$BACKEND_PORT" 2>/dev/null || true);  [ -n "$p" ] && kill $p 2>/dev/null || true
  p=$(lsof -ti tcp:"$FRONTEND_PORT" 2>/dev/null || true); [ -n "$p" ] && kill $p 2>/dev/null || true
  # the backend spawns a Python AI worker; make sure it goes too
  pkill -f "ai/worker.py" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM EXIT

# --- free the ports if something's already listening ---------------------
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  existing=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$existing" ]; then
    warn "port $port already in use (pid $existing) — reclaiming it"
    kill $existing 2>/dev/null || true
    sleep 1
  fi
done

# --- start both ----------------------------------------------------------
# Backend runs from backend/ so ./data and ../config.toml resolve correctly.
say "→ starting backend  → http://127.0.0.1:$BACKEND_PORT   (cargo run; first build can take a bit)"
( cd "$ROOT/backend" && exec cargo run ) &

say "→ starting frontend → http://127.0.0.1:$FRONTEND_PORT"
# --host 127.0.0.1 pins Vite to IPv4 (plain `npm run dev` binds ::1/IPv6-only,
# which the 127.0.0.1 URL below wouldn't reach); --strictPort fails loudly
# instead of silently hopping to 5174 if the port is taken.
( cd "$ROOT/frontend" && exec npm run dev -- --host 127.0.0.1 --strictPort ) &

cat <<EOF

  ──────────────────────────────────────────────────────────
    rj-player is starting…
        backend : http://127.0.0.1:$BACKEND_PORT
        app     : http://127.0.0.1:$FRONTEND_PORT   ← open this in your browser
    Press Ctrl-C to stop both.
  ──────────────────────────────────────────────────────────

EOF

# Wait for both background jobs; Ctrl-C triggers cleanup() above.
wait
