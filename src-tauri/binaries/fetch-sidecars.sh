#!/usr/bin/env bash
#
# fetch-sidecars.sh — download the yt-dlp + ffmpeg + uv sidecar binaries that
# the Tauri desktop app bundles (dsd.md §13, B6.3 / B6.7).
#
# These are NOT committed (large + platform-specific); this directory is
# gitignored except for this script. It runs at build time — wired as Tauri's
# before{Dev,Build}Command — so a fresh checkout fetches them on first build.
# Repeat runs are a fast no-op once the files exist (set FORCE=1 to refresh).
#
# File names follow Tauri's externalBin convention: <name>-<target-triple>
# (plus `.exe` on Windows). Tauri picks the copy whose triple matches the build
# target, so we only fetch the host platform's set here.
#
# Supported host platforms:
#   macOS  arm64  → aarch64-apple-darwin      (Apple Silicon only; no Intel)
#   Windows x64   → x86_64-pc-windows-msvc     (run under Git-Bash, e.g. CI)
#
# Sources:
#   yt-dlp : https://github.com/yt-dlp/yt-dlp     (official releases)
#   ffmpeg : macOS  → https://ffmpeg.martin-riedl.de  (static arm64)
#            Windows → https://github.com/BtbN/FFmpeg-Builds  (static win64 gpl)
#   uv     : https://github.com/astral-sh/uv       (official releases)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# --- host platform detection -----------------------------------------------
# `uname -s` under Git-Bash / MSYS on Windows reports MINGW*/MSYS*/CYGWIN*.
case "$(uname -s)" in
  Darwin) HOST_OS="macos" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) HOST_OS="windows" ;;
  *) echo "unsupported host OS: $(uname -s) (only macOS arm64 + Windows x64 are wired)" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch_ffmpeg_zip() { # $1=url  $2=out-basename  — extracts the ffmpeg[.exe] inside
  local url="$1" out="$2"
  echo "→ ffmpeg → $out …"
  curl -fSL --retry 3 -o "$tmp/ffmpeg.zip" "$url"
  unzip -o -q "$tmp/ffmpeg.zip" -d "$tmp/ffmpeg"
  local bin
  bin="$(find "$tmp/ffmpeg" -type f \( -name ffmpeg -o -name ffmpeg.exe \) | head -1)"
  [ -n "$bin" ] || { echo "ffmpeg binary not found in zip" >&2; exit 1; }
  cp "$bin" "$out"
  chmod +x "$out"
}

if [ "$HOST_OS" = "macos" ]; then
  TRIPLE="aarch64-apple-darwin"
  OUTPUTS=("yt-dlp-$TRIPLE" "ffmpeg-$TRIPLE" "uv-$TRIPLE")

  all_present=1
  for f in "${OUTPUTS[@]}"; do [ -x "$f" ] || all_present=0; done
  if [ "$all_present" = 1 ] && [ "${FORCE:-}" != 1 ]; then
    echo "✓ sidecars already present (set FORCE=1 to refresh)"; exit 0
  fi

  echo "→ yt-dlp (universal2 macOS) → yt-dlp-$TRIPLE …"
  curl -fSL --retry 3 -o "yt-dlp-$TRIPLE" \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
  chmod +x "yt-dlp-$TRIPLE"

  fetch_ffmpeg_zip \
    "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip" \
    "ffmpeg-$TRIPLE"

  echo "→ uv → uv-$TRIPLE …"
  curl -fSL --retry 3 -o "$tmp/uv.tar.gz" \
    "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz"
  tar -xzf "$tmp/uv.tar.gz" -C "$tmp"
  uvbin="$(find "$tmp" -type f -name uv | head -1)"
  [ -n "$uvbin" ] || { echo "uv binary not found in archive" >&2; exit 1; }
  cp "$uvbin" "uv-$TRIPLE"; chmod +x "uv-$TRIPLE"

else # windows
  TRIPLE="x86_64-pc-windows-msvc"
  OUTPUTS=("yt-dlp-$TRIPLE.exe" "ffmpeg-$TRIPLE.exe" "uv-$TRIPLE.exe")

  all_present=1
  for f in "${OUTPUTS[@]}"; do [ -f "$f" ] || all_present=0; done
  if [ "$all_present" = 1 ] && [ "${FORCE:-}" != 1 ]; then
    echo "✓ sidecars already present (set FORCE=1 to refresh)"; exit 0
  fi

  echo "→ yt-dlp.exe → yt-dlp-$TRIPLE.exe …"
  curl -fSL --retry 3 -o "yt-dlp-$TRIPLE.exe" \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"

  fetch_ffmpeg_zip \
    "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip" \
    "ffmpeg-$TRIPLE.exe"

  echo "→ uv.exe → uv-$TRIPLE.exe …"
  curl -fSL --retry 3 -o "$tmp/uv.zip" \
    "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
  unzip -o -q "$tmp/uv.zip" -d "$tmp/uv"
  uvbin="$(find "$tmp/uv" -type f -name uv.exe | head -1)"
  [ -n "$uvbin" ] || { echo "uv.exe not found in archive" >&2; exit 1; }
  cp "$uvbin" "uv-$TRIPLE.exe"
fi

echo "✓ sidecars ready:"
ls -lh yt-dlp-* ffmpeg-* uv-* 2>/dev/null | awk '{print "   "$5"\t"$NF}'
