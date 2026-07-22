//! Tauri desktop shell for rj-player (dsd.md §13, B6.2).
//!
//! Design 2 (dsd.md §13.0/§13.1): the embedded axum backend serves BOTH the
//! built SPA and the `/api` + `/media` endpoints on a random `127.0.0.1` port,
//! and the WebView points at that origin. So the frontend is byte-identical to
//! the split `./dev.sh` deployment — same-origin relative paths just work, with
//! no Tauri-aware branch in the React code. This shell is a *second consumer*
//! of `rj_player_backend`, never a fork.

use std::path::PathBuf;

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

    let app = builder
        .setup(|app| {
            let handle = app.handle().clone();
            let config = resolve_config(&handle);

            // Bind a random loopback port up front (synchronously) so the exact
            // URL is known before the WebView is created.
            let listener = std::net::TcpListener::bind("127.0.0.1:0")
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
