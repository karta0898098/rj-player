#!/usr/bin/env bash
#
# dev.sh — run the Tauri desktop app (`cargo tauri dev`) with the first-run
# setup wizard forced back on.
#
# The wizard's "已完成" state is a `rj_setup_done` key the webview writes to
# its own localStorage, not anything under this repo — so a fresh `cargo tauri
# dev` normally skips straight past it. This clears just that key (leaving
# playlist/generation-settings untouched) before every dev run, so you always
# land back on step 1.
#
#   src-tauri/dev.sh          reset the wizard flag, then `cargo tauri dev`
#   src-tauri/dev.sh --release  (or any other cargo-tauri-dev args — passed through)
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBKIT_DATA="$HOME/Library/WebKit/rj-player-desktop/WebsiteData/Default"

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }

if pgrep -f "target/(debug|release)/rj-player-desktop" >/dev/null 2>&1; then
  warn "rj-player-desktop is already running — quit it first so its localStorage isn't mid-write."
  exit 1
fi

if [ -d "$WEBKIT_DATA" ] && command -v sqlite3 >/dev/null 2>&1; then
  cleared=0
  for origin_file in "$WEBKIT_DATA"/*/*/origin; do
    [ -f "$origin_file" ] || continue
    # Origin files hold "http"/"127.0.0.1" for our webview's loopback origin;
    # the other entry in this profile is WebKit's own "inspector-resource".
    if strings "$origin_file" 2>/dev/null | grep -qx "127.0.0.1"; then
      db="$(dirname "$origin_file")/LocalStorage/localstorage.sqlite3"
      if [ -f "$db" ]; then
        sqlite3 "$db" "DELETE FROM ItemTable WHERE key='rj_setup_done';" && cleared=1
      fi
    fi
  done
  if [ "$cleared" = 1 ]; then
    say "→ cleared rj_setup_done — wizard will show on next launch"
  else
    say "→ no rj_setup_done found (already unset, or first-ever run)"
  fi
else
  say "→ no WebKit profile yet — first-ever run, wizard will show anyway"
fi

say "→ cargo tauri dev $*"
cd "$ROOT" && exec cargo tauri dev "$@"
