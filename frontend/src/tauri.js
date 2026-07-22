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

// ---- LLM API key, stored in the OS keychain (dsd.md §13.6) ----------------
// The key value is written to / cleared from the keychain via Tauri commands;
// the frontend only ever learns whether a key is present, never its value.

async function invoke(cmd, args) {
  const { invoke: inv } = await import('@tauri-apps/api/core');
  return inv(cmd, args);
}

/** Store (or replace) a provider's API key in the OS keychain (Tauri only). */
export async function setLlmKey(provider, key) {
  if (!isTauri()) return;
  await invoke('set_llm_key', { provider, key });
}

/** Remove a provider's stored key (Tauri only; idempotent). */
export async function clearLlmKey(provider) {
  if (!isTauri()) return;
  await invoke('clear_llm_key', { provider });
}

/** Whether a provider has a stored key. null in a browser. */
export async function llmKeyPresent(provider) {
  if (!isTauri()) return null;
  return invoke('llm_key_present', { provider });
}

// ---- Managed settings (dsd.md §13.7) --------------------------------------

/**
 * Persist the selected Whisper model (Tauri only). Writes it to the app's
 * settings and updates the running process's env so the Doctor's model check +
 * download target it immediately. No-op in a browser.
 */
export async function setWhisperModel(model) {
  if (!isTauri()) return;
  await invoke('set_whisper_model', { model });
}
