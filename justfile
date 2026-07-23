# rj-player — task runner.  Run `just` (or `just --list`) to see everything.
#
# Layout:
#   backend/    axum server crate (rj-player-backend)  → :8080, backend/data, backend/target
#   frontend/   Vite + React SPA (rj-player-frontend)   → :5173, node_modules, dist
#   src-tauri/  Tauri v2 desktop shell (rj-player-desktop; embeds the backend)
#   ai/         Python AI worker (.venv is multi-GB: torch / ct2 / models)

set shell := ["bash", "-euo", "pipefail", "-c"]

# node/npm here are nvm-managed and NOT on a plain (non-login) shell's PATH:
# no profile is sourced for recipe shells, and ~/.zshrc doesn't init nvm. So
# every recipe that touches node/npm — directly, or via a child process it
# spawns (dev.sh, cargo tauri's beforeBuildCommand) — sources nvm first to put
# the default node on PATH. Without this, a plain shell falls back to a stale
# /usr/local/bin/node and `npm run build` dies with "vite: command not found".
nvm := 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh";'

# Show all recipes (runs on bare `just`).
default:
    @just --list

# ── setup ──────────────────────────────────────────────────────────────────

# Install frontend npm deps (first checkout / after package.json changes).
[group('setup')]
install:
    {{nvm}} npm --prefix frontend install

# Reproducible frontend install from package-lock (CI-style).
[group('setup')]
install-ci:
    {{nvm}} npm --prefix frontend ci

# ── run (dev) ───────────────────────────────────────────────────────────────

# Backend (:8080) + frontend (:5173) together — browser workflow (dev.sh).
[group('run')]
dev:
    {{nvm}} ./dev.sh

# Desktop app in dev mode (Tauri shell, hot-reload).
[group('run')]
app:
    {{nvm}} cargo tauri dev

# Backend only (axum on :8080).
[group('run')]
back:
    cd backend && cargo run

# Frontend only (Vite on :5173, IPv4-pinned like dev.sh).
[group('run')]
front:
    {{nvm}} npm --prefix frontend run dev -- --host 127.0.0.1 --strictPort

# ── build ───────────────────────────────────────────────────────────────────

# Compile everything: frontend SPA + both Rust crates (debug).
[group('build')]
build: build-front build-back

# Build the frontend SPA → frontend/dist.
[group('build')]
build-front:
    {{nvm}} npm --prefix frontend run build

# Build the backend crate (debug).
[group('build')]
build-back:
    cd backend && cargo build

# Build the backend crate (release).
[group('build')]
build-back-release:
    cd backend && cargo build --release

# Bundle the desktop app (release .app/.dmg via Tauri). Slow.
[group('build')]
bundle:
    {{nvm}} cargo tauri build

# Bundle the desktop app with the debug profile (faster to compile, bigger binary).
[group('build')]
bundle-debug:
    {{nvm}} cargo tauri build --debug

# ── quality ─────────────────────────────────────────────────────────────────

# Run backend tests.
[group('quality')]
test:
    cd backend && cargo test

# Type/borrow-check both Rust crates without producing binaries.
[group('quality')]
check:
    (cd backend && cargo check)
    (cd src-tauri && cargo check)

# Lint both Rust crates with clippy (warnings → errors).
[group('quality')]
clippy:
    (cd backend && cargo clippy --all-targets -- -D warnings)
    (cd src-tauri && cargo clippy --all-targets -- -D warnings)

# Format all Rust code.
[group('quality')]
fmt:
    (cd backend && cargo fmt)
    (cd src-tauri && cargo fmt)

# ── clean ───────────────────────────────────────────────────────────────────

# Clear build caches: Rust target/ (both crates) + frontend/dist.
# Keeps node_modules, the Python .venv, and downloaded data (backend/data).
[doc('Clear Rust target/ + frontend/dist (safe build caches)')]
[group('clean')]
clean: clean-rust clean-front

# Remove built frontend assets (frontend/dist).
[group('clean')]
clean-front:
    rm -rf frontend/dist

# cargo clean both Rust crates (backend/target + src-tauri/target).
[group('clean')]
clean-rust:
    (cd backend && cargo clean)
    (cd src-tauri && cargo clean)

# Remove frontend/node_modules (reinstall with `just install`).
[group('clean')]
clean-node:
    rm -rf frontend/node_modules

# Remove the Python venv and all __pycache__ (multi-GB; recreated on next app run).
[group('clean')]
clean-py:
    rm -rf ai/.venv
    find ai -type d -name __pycache__ -prune -exec rm -rf {} +

# Nuke every cache: Rust targets, dist, node_modules, Python venv.
# Leaves downloaded data (backend/data) intact. Full reinstall needed after.
[doc('Nuke all caches: targets, dist, node_modules, venv (keeps data)')]
[group('clean')]
clean-all: clean-rust clean-front clean-node clean-py

# DELETE downloaded content (backend/data: videos, audio, subtitles, CC).
# This is your data, not a cache — asks before removing.
[doc('DELETE downloaded content in backend/data — prompts first')]
[group('clean')]
[confirm("Delete backend/data — all downloaded videos, audio, subtitles? [y/N]")]
clean-data:
    rm -rf backend/data

# ── misc ────────────────────────────────────────────────────────────────────

# Show on-disk size of each cache / build dir.
[group('misc')]
size:
    @du -sh backend/target src-tauri/target frontend/node_modules frontend/dist ai/.venv backend/data 2>/dev/null || true
