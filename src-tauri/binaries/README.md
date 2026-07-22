# Sidecar binaries (yt-dlp + ffmpeg)

The desktop app bundles `yt-dlp` and a static `ffmpeg` as Tauri **sidecars**
(`bundle.externalBin` in `tauri.conf.json`) so downloading and audio extraction
work with **no system install** — no Homebrew, no PATH dependency (dsd.md §13,
B6.3).

These binaries are **not committed** (large + platform-specific). This directory
is gitignored except for `fetch-sidecars.sh`, `.gitignore`, and this file.

## Fetching

`fetch-sidecars.sh` downloads them, named per Tauri's `<name>-<target-triple>`
convention. It runs automatically at build time (wired as the Tauri
`beforeDevCommand` / `beforeBuildCommand`), and is a fast no-op once the files
exist. To fetch or refresh manually:

```bash
bash src-tauri/binaries/fetch-sidecars.sh        # fetch if missing
FORCE=1 bash src-tauri/binaries/fetch-sidecars.sh # re-download latest
```

Produces (macOS, both arches):

```
yt-dlp-aarch64-apple-darwin   ffmpeg-aarch64-apple-darwin
yt-dlp-x86_64-apple-darwin    ffmpeg-x86_64-apple-darwin
```

## Sources

| Tool   | Source | Notes |
|--------|--------|-------|
| yt-dlp | [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) releases (`yt-dlp_macos`) | Official, universal2 — reused for both mac arches |
| ffmpeg | [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de) | Static per-arch macOS builds (no external dylib deps) |

Windows targets are stubbed in the script for when B6.7 adds cross-platform
packaging.
