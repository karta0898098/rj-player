#!/usr/bin/env bash
#
# fetch-sidecars.sh — download the yt-dlp + ffmpeg sidecar binaries that the
# Tauri desktop app bundles (dsd.md §13, B6.3).
#
# These are NOT committed (large + platform-specific); this directory is
# gitignored except for this script. It runs at build time — wired as Tauri's
# before{Dev,Build}Command — so a fresh checkout fetches them on first build.
# Repeat runs are a fast no-op once the files exist (set FORCE=1 to refresh).
#
# File names follow Tauri's externalBin convention: <name>-<target-triple>.
# yt-dlp ships a single universal2 macOS build, reused for both mac arches.
#
# macOS only for now. Windows is NOT fetched yet — the same <name>-<triple>
# structure extends to it in B6.7; see the commented WINDOWS block near the
# bottom for the starting point (yt-dlp.exe + a static ffmpeg.exe).
#
# Sources:
#   yt-dlp : https://github.com/yt-dlp/yt-dlp  (official release, universal2)
#   ffmpeg : https://ffmpeg.martin-riedl.de     (static macOS builds, per-arch)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

YTDLP_MACOS_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
FFMPEG_ARM64_URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip"
FFMPEG_AMD64_URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip"
# uv (the managed-Python installer / dep resolver the Doctor drives, dsd §13.4).
UV_ARM64_URL="https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz"
UV_AMD64_URL="https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz"

MAC_TRIPLES=("aarch64-apple-darwin" "x86_64-apple-darwin")

# All outputs we expect to produce; used for the fast-path skip.
OUTPUTS=(
  "yt-dlp-aarch64-apple-darwin" "yt-dlp-x86_64-apple-darwin"
  "ffmpeg-aarch64-apple-darwin" "ffmpeg-x86_64-apple-darwin"
  "uv-aarch64-apple-darwin" "uv-x86_64-apple-darwin"
)

all_present=1
for f in "${OUTPUTS[@]}"; do [ -x "$f" ] || all_present=0; done
if [ "$all_present" = 1 ] && [ "${FORCE:-}" != 1 ]; then
  echo "✓ sidecars already present (set FORCE=1 to refresh)"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "→ yt-dlp (universal2 macOS)…"
curl -fSL --retry 3 -o "$tmp/yt-dlp_macos" "$YTDLP_MACOS_URL"
for t in "${MAC_TRIPLES[@]}"; do
  cp "$tmp/yt-dlp_macos" "yt-dlp-$t"
  chmod +x "yt-dlp-$t"
done

fetch_ffmpeg() { # $1=url  $2=triple
  local url="$1" triple="$2"
  echo "→ ffmpeg ($triple)…"
  curl -fSL --retry 3 -o "$tmp/ffmpeg-$triple.zip" "$url"
  unzip -o -q "$tmp/ffmpeg-$triple.zip" -d "$tmp/ffmpeg-$triple"
  local bin
  bin="$(find "$tmp/ffmpeg-$triple" -type f -name ffmpeg | head -1)"
  [ -n "$bin" ] || { echo "ffmpeg binary not found in zip for $triple" >&2; exit 1; }
  cp "$bin" "ffmpeg-$triple"
  chmod +x "ffmpeg-$triple"
}
fetch_ffmpeg "$FFMPEG_ARM64_URL" "aarch64-apple-darwin"
fetch_ffmpeg "$FFMPEG_AMD64_URL" "x86_64-apple-darwin"

fetch_uv() { # $1=url  $2=triple
  local url="$1" triple="$2"
  echo "→ uv ($triple)…"
  curl -fSL --retry 3 -o "$tmp/uv-$triple.tar.gz" "$url"
  tar -xzf "$tmp/uv-$triple.tar.gz" -C "$tmp"
  local bin
  bin="$(find "$tmp" -type f -name uv -path "*$triple*" | head -1)"
  [ -n "$bin" ] || { echo "uv binary not found in archive for $triple" >&2; exit 1; }
  cp "$bin" "uv-$triple"
  chmod +x "uv-$triple"
}
fetch_uv "$UV_ARM64_URL" "aarch64-apple-darwin"
fetch_uv "$UV_AMD64_URL" "x86_64-apple-darwin"

# --- WINDOWS (B6.7 — not enabled yet) --------------------------------------
# To add Windows, produce yt-dlp-x86_64-pc-windows-msvc.exe and
# ffmpeg-x86_64-pc-windows-msvc.exe, add them to OUTPUTS above, and add
# "x86_64-pc-windows-msvc" to the build's target list. Starting points:
#   yt-dlp: https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
#   ffmpeg: a static win64 build (e.g. gyan.dev / BtbN) — pick + verify in B6.7.
# Left commented so this script stays macOS-only until then.
# ---------------------------------------------------------------------------

echo "✓ sidecars ready:"
ls -lh yt-dlp-* ffmpeg-* uv-* 2>/dev/null | awk '{print "   "$5"\t"$NF}'
