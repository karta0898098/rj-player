//! Tauri desktop shell for rj-player (dsd.md §13, B6.2).
//!
//! Design 2 (dsd.md §13.0/§13.1): the embedded axum backend serves BOTH the
//! built SPA and the `/api` + `/media` endpoints on a random `127.0.0.1` port,
//! and the WebView points at that origin. So the frontend is byte-identical to
//! the split `./dev.sh` deployment — same-origin relative paths just work, with
//! no Tauri-aware branch in the React code. This shell is a *second consumer*
//! of `rj_player_backend`, never a fork.

use std::path::{Path, PathBuf};

use rj_player_backend::{Config, WorkerHandle};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Kept in Tauri's managed state so the AI worker subprocess can be shut down
/// gracefully when the app exits (dsd.md §7).
struct DesktopState {
    worker: WorkerHandle,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    if cfg!(debug_assertions) {
        builder = builder.plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        );
    }
    builder = builder.invoke_handler(tauri::generate_handler![
        set_llm_key,
        clear_llm_key,
        llm_key_present,
        set_whisper_model
    ]);

    let app = builder
        .setup(|app| {
            let handle = app.handle().clone();
            let config = resolve_config(&handle);

            // Bind a *stable* loopback port up front (synchronously) so the
            // exact URL is known before the WebView is created — and, crucially,
            // so the WebView origin (`http://127.0.0.1:<port>`) is the same every
            // launch. A random port would give the SPA a new origin each run,
            // which silently resets all its localStorage (setup-done flag, resume
            // positions, playlists, settings). Fall back to a random port only if
            // the preferred one is somehow taken.
            const PREFERRED_PORT: u16 = 47613;
            let listener = std::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT))
                .or_else(|_| std::net::TcpListener::bind(("127.0.0.1", 0)))
                .expect("failed to bind a loopback port for the embedded backend");
            let port = listener
                .local_addr()
                .expect("bound listener has no local addr")
                .port();

            // Start the very same backend the standalone binary runs, on that
            // port. `block_on` returns quickly — it only assembles state and
            // spawns the server/worker tasks onto Tauri's async runtime.
            let worker = tauri::async_runtime::block_on(rj_player_backend::serve_embedded(
                listener, &config,
            ))
            .expect("failed to start the embedded backend");
            handle.manage(DesktopState { worker });

            // Point the WebView at the local server. Same-origin => the SPA's
            // relative /api and /media resolve to the embedded backend with no
            // frontend change.
            let url = format!("http://127.0.0.1:{port}/");
            WebviewWindowBuilder::new(
                &handle,
                "main",
                WebviewUrl::External(url.parse().expect("valid loopback url")),
            )
            .title("rj-player")
            .inner_size(1100.0, 760.0)
            .min_inner_size(880.0, 560.0)
            .build()
            .expect("failed to create the main window");

            log::info!("rj-player desktop: embedded backend on {url}");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the rj-player desktop app");

    app.run(|app_handle, event| {
        // Graceful worker shutdown on app exit: the Python AI worker is an
        // independent subprocess; ask it to stop once nothing can talk to it.
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<DesktopState>() {
                tauri::async_runtime::block_on(state.worker.shutdown());
            }
        }
    });
}

/// Resolve the backend [`Config`] for desktop mode by steering the *existing*
/// env-override mechanism (dsd.md §13.2): set a few env vars, then let
/// `Config::load()` merge env > config.toml > defaults exactly as the
/// standalone binary does. B6.2 keeps the AI worker + API keys on the machine's
/// existing setup (repo `ai/.venv`, `config.toml`); the managed runtime and
/// keychain land in B6.4/B6.5.
fn resolve_config(handle: &AppHandle) -> Config {
    // Served SPA: prefer the copy bundled into the app's resources; fall back to
    // the dev tree (absolute, via CARGO_MANIFEST_DIR) so it also works when run
    // straight from `cargo run` / `tauri dev` regardless of cwd.
    if std::env::var_os("DIST_DIR").is_none() {
        let dist = handle
            .path()
            .resource_dir()
            .ok()
            .map(|r| r.join("frontend/dist"))
            .filter(|p| p.join("index.html").is_file())
            .unwrap_or_else(|| dev_path("frontend/dist"));
        std::env::set_var("DIST_DIR", dist);
    }

    // Data dir. Dev (`cargo tauri dev`): share the repo's `backend/data` so the
    // desktop app sees the same library you downloaded via `./dev.sh`. Bundled
    // release: a writable per-user app-data location (dsd.md §13.2), separate
    // from any repo checkout.
    if std::env::var_os("DATA_DIR").is_none() {
        if cfg!(debug_assertions) {
            std::env::set_var("DATA_DIR", dev_path("backend/data"));
        } else if let Ok(dir) = handle.path().app_data_dir() {
            std::env::set_var("DATA_DIR", dir.join("data"));
        }
    }

    // AI worker: point at the repo's Python service so subtitle generation uses
    // the existing venv (the B6.2 "走系統既有環境暫代" bridge; B6.4 bundles a
    // managed runtime). Absolute so it resolves when launched from Finder.
    if std::env::var_os("AI_DIR").is_none() {
        std::env::set_var("AI_DIR", dev_path("ai"));
    }

    // Managed Python runtime + model cache (dsd §13.2/§13.4): everything the
    // Doctor downloads lives under a writable per-user runtime dir, out of the
    // read-only app bundle. Point uv's install/cache dirs and the Hugging Face
    // model cache there. If the managed venv has already been built, use its
    // python; otherwise leave AI_PYTHON at its default so ./dev.sh keeps using
    // the repo venv before the Doctor has run.
    if let Ok(app_data) = handle.path().app_data_dir() {
        let runtime = app_data.join("runtime");
        set_env_if_absent("RJ_RUNTIME_DIR", &runtime);
        set_env_if_absent("UV_PYTHON_INSTALL_DIR", runtime.join("python"));
        set_env_if_absent("UV_CACHE_DIR", runtime.join("uv-cache"));
        set_env_if_absent("HF_HOME", app_data.join("models"));
        let managed_python = runtime.join("venv/bin/python");
        if std::env::var_os("AI_PYTHON").is_none() && managed_python.is_file() {
            std::env::set_var("AI_PYTHON", managed_python);
        }

        // Persisted settings (dsd §13.7): the wizard's chosen Whisper model
        // overrides the config default (an explicit env var still wins).
        if let Some(m) = read_settings(&app_data.join("settings.json"))
            .get("whisper_model")
            .and_then(|v| v.as_str())
        {
            set_env_if_absent("WHISPER_MODEL", m);
        }
    }

    // yt-dlp / ffmpeg: in a bundle the sidecars sit next to the executable
    // (Tauri externalBin, copied without the triple suffix) — prefer those so
    // downloading + audio extraction work with no system install (dsd.md §13,
    // B6.3). In dev there's no sidecar next to the debug binary, so the vars
    // stay unset and resolve from PATH (Homebrew, prepended below).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for (key, name) in [
                ("YT_DLP_PATH", "yt-dlp"),
                ("FFMPEG_PATH", "ffmpeg"),
                ("UV_PATH", "uv"),
            ] {
                if std::env::var_os(key).is_none() {
                    let cand = dir.join(name);
                    if cand.is_file() {
                        std::env::set_var(key, cand);
                    }
                }
            }
        }
    }

    // Dev fallback: no bundled sidecar sits next to the debug binary, and a
    // Finder-launched app doesn't inherit the user's shell PATH — prepend the
    // common Homebrew locations so yt-dlp/ffmpeg still resolve there.
    prepend_path(&["/opt/homebrew/bin", "/usr/local/bin"]);

    inject_keychain_llm_keys();

    Config::load()
}

/// Set an env var only if it isn't already set, so an explicit override (a real
/// env var, or `config.toml`-adjacent settings) always wins.
fn set_env_if_absent(key: &str, val: impl AsRef<std::ffi::OsStr>) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, val);
    }
}

/// A path under the repo root, derived from this crate's manifest dir
/// (`<repo>/src-tauri`), so it's correct regardless of the process's cwd.
fn dev_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|repo| repo.join(rel))
        .unwrap_or_else(|| PathBuf::from(rel))
}

/// Prepend directories to `PATH` (skipping any missing or already-present), so
/// child processes (yt-dlp/ffmpeg) launched by the backend can be found even
/// when the app was started from Finder with a minimal environment.
fn prepend_path(dirs: &[&str]) {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let existing: Vec<PathBuf> = std::env::split_paths(&current).collect();
    let mut prefix: Vec<PathBuf> = dirs
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir() && !existing.contains(p))
        .collect();
    if prefix.is_empty() {
        return;
    }
    prefix.extend(existing);
    if let Ok(joined) = std::env::join_paths(prefix) {
        std::env::set_var("PATH", joined);
    }
}

// ---- OS keychain for the LLM API key (dsd.md §13.6) -----------------------
//
// The translation key lives in the macOS Keychain, never in plaintext. It's
// stored via the Tauri commands below (called by the wizard/settings) and
// injected as the provider's env var at startup, so the backend and worker
// consume it exactly as they would a config.toml key — the value just never
// touches disk in the clear.

const KEYCHAIN_SERVICE: &str = "io.github.karta0898098.rjplayer";

/// (keychain provider slug, the env var the backend + worker read).
const LLM_PROVIDERS: [(&str, &str); 3] = [
    ("gemini", "GEMINI_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("anthropic", "ANTHROPIC_API_KEY"),
];

fn keychain_entry(provider: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("llm_api_key:{provider}"))
}

/// The stored key for a provider, if present and non-empty.
fn keychain_get(provider: &str) -> Option<String> {
    keychain_entry(provider)
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.is_empty())
}

/// Inject any keychain-stored LLM keys as their provider env vars, unless one is
/// already set explicitly (an explicit env var wins). `Config::load` then treats
/// them exactly like a config.toml key.
fn inject_keychain_llm_keys() {
    for (provider, env_key) in LLM_PROVIDERS {
        if std::env::var_os(env_key).is_none() {
            if let Some(key) = keychain_get(provider) {
                std::env::set_var(env_key, key);
            }
        }
    }
}

/// Store (or replace) a provider's API key in the OS keychain, and reflect it in
/// this process's env so a freshly spawned worker picks it up without a restart.
#[tauri::command]
fn set_llm_key(provider: String, key: String) -> Result<(), String> {
    let entry = keychain_entry(&provider).map_err(|e| e.to_string())?;
    entry.set_password(&key).map_err(|e| e.to_string())?;
    if let Some((_, env_key)) = LLM_PROVIDERS.iter().find(|(p, _)| *p == provider) {
        std::env::set_var(env_key, &key);
    }
    Ok(())
}

/// Remove a provider's stored key (idempotent).
#[tauri::command]
fn clear_llm_key(provider: String) -> Result<(), String> {
    if let Some((_, env_key)) = LLM_PROVIDERS.iter().find(|(p, _)| *p == provider) {
        std::env::remove_var(env_key);
    }
    match keychain_entry(&provider).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Whether a provider has a stored key (never returns the value).
#[tauri::command]
fn llm_key_present(provider: String) -> bool {
    keychain_get(&provider).is_some()
}

// ---- Persisted app settings (dsd.md §13.7) --------------------------------

fn read_settings(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist the wizard's chosen Whisper model to `<app-data>/settings.json` and
/// reflect it in the running process's env so the Doctor's model check +
/// `download_model` fix target it immediately (dsd.md §13.7).
#[tauri::command]
fn set_whisper_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let mut settings = read_settings(&path);
    settings.insert(
        "whisper_model".to_string(),
        serde_json::Value::String(model.clone()),
    );
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&settings).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    std::env::set_var("WHISPER_MODEL", &model);
    Ok(())
}
