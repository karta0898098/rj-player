// Tauri desktop bridge (dsd.md §13).
//
// This is the ONE place the frontend is Tauri-aware. Every export degrades
// gracefully in a plain browser (`isTauri()` is false, the helpers no-op), so
// the exact same `frontend/` build runs both in the split web/dev deployment
// and inside the desktop app — no fork, just progressive enhancement.

/** True when running inside the Tauri desktop WebView. */
export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let _win = null;
async function currentWindow() {
  if (!_win) {
    // Imported lazily so a plain-browser build never touches the Tauri API.
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    _win = getCurrentWindow();
  }
  return _win;
}

/**
 * Toggle the desktop window's OS fullscreen and return the new state
 * (true/false). Returns null in a browser — callers fall back to the HTML5
 * Fullscreen API there. Used because WKWebView (the macOS Tauri WebView) does
 * not honour element-level `requestFullscreen()`, so the video's fullscreen
 * button has to drive the native window instead.
 */
export async function toggleWindowFullscreen() {
  if (!isTauri()) return null;
  const w = await currentWindow();
  const next = !(await w.isFullscreen());
  await w.setFullscreen(next);
  return next;
}

/** The desktop window's current fullscreen state, or null in a browser. */
export async function isWindowFullscreen() {
  if (!isTauri()) return null;
  return (await currentWindow()).isFullscreen();
}
