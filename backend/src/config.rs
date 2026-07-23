//! Configuration loaded from environment variables and an optional
//! `config.toml` file, all with sensible defaults so the service can be
//! started with zero setup.
//!
//! Precedence (highest wins): **env var > `config.toml` value > built-in
//! default**. Env vars are kept authoritative so existing run scripts /
//! ad-hoc overrides (`WHISPER_MODEL=tiny cargo run`) keep working exactly as
//! before; `config.toml` exists so a user can set things once instead of
//! exporting env vars every run.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Runtime configuration for the backend.
///
/// All fields are populated by [`Config::load`], merging environment
/// variables, an optional `config.toml` file, and built-in defaults (see the
/// module docs for precedence).
#[derive(Debug, Clone)]
pub struct Config {
    /// Port the HTTP server binds to on `127.0.0.1`. Env: `PORT`. TOML:
    /// top-level `port`. (default `8080`).
    pub port: u16,
    /// Root directory for all persisted video data. Env: `DATA_DIR`. TOML:
    /// top-level `data_dir`. (default `./data`).
    pub data_dir: PathBuf,
    /// Directory of the built frontend (`frontend/dist`), served as static
    /// files so the backend can host the SPA in production/packaged mode
    /// (dsd.md §13). Env: `DIST_DIR`. TOML: top-level `dist_dir`. Defaults to
    /// `../frontend/dist` (the backend runs from `backend/`, so this is the
    /// sibling `frontend/dist`). In dev the SPA is served by Vite instead, so
    /// a missing directory here is harmless — the fallback just 404s.
    pub dist_dir: PathBuf,
    /// Path/name of the `yt-dlp` binary. Env: `YT_DLP_PATH`. TOML:
    /// `[tools] yt_dlp_path`. (default `yt-dlp`).
    pub yt_dlp_path: String,
    /// Path/name of the `ffmpeg` binary, used for non-fatal audio extraction.
    /// Env: `FFMPEG_PATH`. TOML: `[tools] ffmpeg_path`. (default `ffmpeg`).
    /// Not part of the DSD's env list but added for symmetry/flexibility;
    /// safe to ignore.
    pub ffmpeg_path: String,
    /// yt-dlp `-f` format selector. Env: `YT_DLP_FORMAT`. TOML:
    /// `[tools] yt_dlp_format`. Defaults to a 1080p-capped selector so a
    /// personal tool doesn't pull multi-hundred-MB 4K files by default;
    /// override to `bv*+ba/b` for best available quality.
    pub yt_dlp_format: String,
    /// Path to the Python interpreter used to launch the AI worker (dsd.md
    /// §3.3, §8). Env: `AI_PYTHON` (default: `{AI_DIR}/.venv/bin/python`).
    /// Not independently settable from `config.toml`; it derives from
    /// `ai_dir` (see [`Self::load`]).
    pub ai_python: String,
    /// Path to the AI worker's entrypoint script. Env: `AI_WORKER` (default:
    /// `{AI_DIR}/worker.py`). Not independently settable from
    /// `config.toml`; it derives from `ai_dir` (see [`Self::load`]).
    pub ai_worker: String,
    /// Path to the bundled `uv` binary the Doctor drives to install the managed
    /// Python runtime + dependencies (dsd.md §13.4). Env: `UV_PATH`. `None` when
    /// uv isn't bundled (e.g. the standalone dev binary) — the Doctor then
    /// reports the managed runtime as unavailable rather than trying to build it.
    pub uv_path: Option<String>,
    /// faster-whisper model size/name, passed through in the
    /// `generate_subtitles` RPC params. Env: `WHISPER_MODEL`. TOML:
    /// `[ai] whisper_model`. (default `medium` — better accuracy than
    /// `small` while still much faster than `large-v3`).
    pub whisper_model: String,
    /// Whisper sampling temperature, passed through in the
    /// `generate_subtitles` RPC params. Env: `WHISPER_TEMPERATURE`. TOML:
    /// `[ai] temperature`. (default `0.0` — deterministic decoding).
    pub whisper_temperature: f32,
    /// faster-whisper `compute_type` (dsd.md §13.7), passed through in the
    /// `generate_subtitles` RPC params. Env: `WHISPER_COMPUTE_TYPE`. TOML:
    /// `[ai] compute_type`. (default `int8` — CPU-recommended).
    pub compute_type: String,
    /// faster-whisper `device` (dsd.md §13.7): `cpu`, or `cuda` on Windows
    /// with an NVIDIA GPU (the settings page only offers `cuda` there; Apple
    /// Silicon has no CUDA so mac stays `cpu`-only). The Doctor's
    /// `cuda_runtime` check + `install_cuda_deps` fix cover the extra NVIDIA
    /// wheels cuda needs. Env: `WHISPER_DEVICE`. TOML: `[ai] device`.
    /// (default `cpu`).
    pub device: String,
    /// Forces a translation LLM provider (`gemini`|`openai`|`anthropic`);
    /// `None` lets the AI worker auto-detect from whichever API key is
    /// present. Env: `LLM_PROVIDER`. TOML: `[llm] provider`.
    pub llm_provider: Option<String>,
    /// Overrides the per-provider default model name. Env: `LLM_MODEL`.
    /// TOML: `[llm] model`.
    pub llm_model: Option<String>,
    /// Gemini API key, injected into the AI worker's environment. Env:
    /// `GEMINI_API_KEY`. TOML: `[llm] gemini_api_key`.
    pub gemini_api_key: Option<String>,
    /// OpenAI API key, injected into the AI worker's environment. Env:
    /// `OPENAI_API_KEY`. TOML: `[llm] openai_api_key`.
    pub openai_api_key: Option<String>,
    /// Anthropic API key, injected into the AI worker's environment. Env:
    /// `ANTHROPIC_API_KEY`. TOML: `[llm] anthropic_api_key`.
    pub anthropic_api_key: Option<String>,
}

/// Shape of an optional `config.toml` file. Every field is optional so a
/// user only needs to set the handful of values they actually care about;
/// anything left out falls through to env/defaults (see [`Config::load`]).
#[derive(Debug, Default, Deserialize)]
struct FileConfig {
    port: Option<u16>,
    data_dir: Option<String>,
    dist_dir: Option<String>,
    #[serde(default)]
    tools: FileTools,
    #[serde(default)]
    ai: FileAi,
    #[serde(default)]
    llm: FileLlm,
}

#[derive(Debug, Default, Deserialize)]
struct FileTools {
    yt_dlp_path: Option<String>,
    ffmpeg_path: Option<String>,
    yt_dlp_format: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct FileAi {
    ai_dir: Option<String>,
    whisper_model: Option<String>,
    temperature: Option<f32>,
    compute_type: Option<String>,
    device: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct FileLlm {
    provider: Option<String>,
    model: Option<String>,
    gemini_api_key: Option<String>,
    openai_api_key: Option<String>,
    anthropic_api_key: Option<String>,
}

impl Config {
    /// Load configuration from `config.toml` (if found) and the
    /// environment, falling back to built-in defaults. See the module docs
    /// for precedence (env > file > default).
    pub fn load() -> Self {
        let file = Self::load_file_config();

        let port = std::env::var("PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .or_else(|| file.as_ref().and_then(|f| f.port))
            .unwrap_or(8080);

        let data_dir = std::env::var("DATA_DIR")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.data_dir.clone()))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("./data"));

        let dist_dir = std::env::var("DIST_DIR")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.dist_dir.clone()))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("../frontend/dist"));

        let yt_dlp_path = std::env::var("YT_DLP_PATH")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.tools.yt_dlp_path.clone()))
            .unwrap_or_else(|| "yt-dlp".to_string());
        let ffmpeg_path = std::env::var("FFMPEG_PATH")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.tools.ffmpeg_path.clone()))
            .unwrap_or_else(|| "ffmpeg".to_string());
        let yt_dlp_format = std::env::var("YT_DLP_FORMAT")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.tools.yt_dlp_format.clone()))
            .unwrap_or_else(|| {
                // Prefer H.264 (avc1) + AAC, capped at 1080p, for universal <video>
                // playback — Safari/WKWebView (the future Tauri target) can't reliably
                // decode AV1 without hardware support. Fall back progressively to any
                // mp4, then any 1080p stream, then whatever exists.
                "bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/\
                 bv*[ext=mp4][height<=1080]+ba[ext=m4a]/\
                 b[ext=mp4][height<=1080]/b[height<=1080]/b"
                    .to_string()
            });

        // The backend process runs from `backend/`, so `../ai` is the sibling
        // Python AI service directory by default (dsd.md §2's component
        // layout). `AI_PYTHON`/`AI_WORKER` independently override the
        // derived paths so either can be pointed elsewhere (e.g. at the
        // integration-test stub worker) without touching `AI_DIR`; they are
        // env-only (no `config.toml` equivalent) precisely because they
        // *derive* from `ai_dir` by default.
        let ai_dir = std::env::var("AI_DIR")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.ai.ai_dir.clone()))
            .unwrap_or_else(|| "../ai".to_string());
        let ai_python =
            std::env::var("AI_PYTHON").unwrap_or_else(|_| format!("{ai_dir}/.venv/bin/python"));
        let ai_worker = std::env::var("AI_WORKER").unwrap_or_else(|_| format!("{ai_dir}/worker.py"));
        let uv_path = std::env::var("UV_PATH").ok();
        let whisper_model = std::env::var("WHISPER_MODEL")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.ai.whisper_model.clone()))
            .unwrap_or_else(|| "large-v3".to_string());
        let whisper_temperature = std::env::var("WHISPER_TEMPERATURE")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .or_else(|| file.as_ref().and_then(|f| f.ai.temperature))
            .unwrap_or(0.0);
        let compute_type = std::env::var("WHISPER_COMPUTE_TYPE")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.ai.compute_type.clone()))
            .unwrap_or_else(|| "int8".to_string());
        let device = std::env::var("WHISPER_DEVICE")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.ai.device.clone()))
            .unwrap_or_else(|| "cpu".to_string());

        let llm_provider = std::env::var("LLM_PROVIDER")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.llm.provider.clone()));
        let llm_model = std::env::var("LLM_MODEL")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.llm.model.clone()));
        let gemini_api_key = std::env::var("GEMINI_API_KEY")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.llm.gemini_api_key.clone()));
        let openai_api_key = std::env::var("OPENAI_API_KEY")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.llm.openai_api_key.clone()));
        let anthropic_api_key = std::env::var("ANTHROPIC_API_KEY")
            .ok()
            .or_else(|| file.as_ref().and_then(|f| f.llm.anthropic_api_key.clone()));

        Self {
            port,
            data_dir,
            dist_dir,
            yt_dlp_path,
            ffmpeg_path,
            yt_dlp_format,
            ai_python,
            ai_worker,
            uv_path,
            whisper_model,
            whisper_temperature,
            compute_type,
            device,
            llm_provider,
            llm_model,
            gemini_api_key,
            openai_api_key,
            anthropic_api_key,
        }
    }

    /// Locate `config.toml`, parse it, and return it — or `None` if no file
    /// was found, it couldn't be read, or it failed to parse (in which case
    /// a warning is logged and the caller silently falls back to
    /// env/defaults; a missing or broken config file must never crash the
    /// backend).
    fn load_file_config() -> Option<FileConfig> {
        let path = Self::find_config_path()?;

        let contents = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(err) => {
                tracing::warn!(
                    path = %path.display(),
                    %err,
                    "could not read config.toml; falling back to env vars/defaults"
                );
                return None;
            }
        };

        match toml::from_str::<FileConfig>(&contents) {
            Ok(cfg) => {
                tracing::info!(path = %path.display(), "loaded config.toml");
                Some(cfg)
            }
            Err(err) => {
                tracing::warn!(
                    path = %path.display(),
                    %err,
                    "config.toml is malformed; ignoring it and falling back to env vars/defaults"
                );
                None
            }
        }
    }

    /// Resolve which `config.toml` (if any) to use.
    ///
    /// - If `RJ_CONFIG` is set, that exact path is used (and only that path
    ///   — if it doesn't exist, this is treated as "no config file" rather
    ///   than falling through to the other candidates, since an explicit
    ///   override pointing at a missing file is more likely a mistake worth
    ///   surfacing implicitly than something that should silently pick up
    ///   an unrelated file).
    /// - Otherwise, `./config.toml` (relative to the process's cwd) is
    ///   tried, then `../config.toml` (the repo root, since the backend
    ///   normally runs from `backend/`). The first one that exists wins.
    /// - If nothing is found, `None` — env vars/defaults are used as-is.
    fn find_config_path() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("RJ_CONFIG") {
            let path = PathBuf::from(p);
            return if path.is_file() { Some(path) } else { None };
        }

        [Path::new("config.toml"), Path::new("../config.toml")]
            .into_iter()
            .find(|p| p.is_file())
            .map(Path::to_path_buf)
    }

    /// The LLM-related env vars to inject into the AI worker subprocess's
    /// environment (`ai/pipeline/translate.py` reads these from its own
    /// process env). Only fields that resolved to a non-empty value
    /// (env > `config.toml` > default, per [`Config::load`]) are included —
    /// unset/empty ones are left out entirely so the worker's own "no
    /// usable provider/key" degradation path (dsd.md §7) still applies
    /// exactly as if the var had never been set.
    pub fn llm_env_vars(&self) -> Vec<(String, String)> {
        [
            ("LLM_PROVIDER", self.llm_provider.as_deref()),
            ("LLM_MODEL", self.llm_model.as_deref()),
            ("GEMINI_API_KEY", self.gemini_api_key.as_deref()),
            ("OPENAI_API_KEY", self.openai_api_key.as_deref()),
            ("ANTHROPIC_API_KEY", self.anthropic_api_key.as_deref()),
        ]
        .into_iter()
        .filter_map(|(key, val)| {
            val.filter(|v| !v.is_empty())
                .map(|v| (key.to_string(), v.to_string()))
        })
        .collect()
    }

    /// The `<data_dir>/videos` directory where each video gets its own subfolder.
    pub fn videos_dir(&self) -> PathBuf {
        self.data_dir.join("videos")
    }

    /// The Whisper model in effect right now: a live `WHISPER_MODEL` env
    /// override (set by the desktop shell's settings commands without a
    /// restart, dsd.md §13.7) wins over the value resolved at startup. Used
    /// wherever a value needs to reflect a just-changed setting immediately
    /// rather than whatever `Config::load` saw at process start — the Doctor
    /// report and the job queue's fallback default both need this.
    pub fn live_whisper_model(&self) -> String {
        std::env::var("WHISPER_MODEL")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| self.whisper_model.clone())
    }

    /// Live-env-wins counterpart to `whisper_temperature` (see
    /// [`Self::live_whisper_model`]).
    pub fn live_whisper_temperature(&self) -> f32 {
        std::env::var("WHISPER_TEMPERATURE")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(self.whisper_temperature)
    }

    /// Live-env-wins counterpart to `compute_type` (see
    /// [`Self::live_whisper_model`]). Unlike `whisper_model`, `compute_type`
    /// has no per-request override at all (dsd.md §13.7 scopes it as a
    /// global settings-page knob only) — this live read is the *only* way a
    /// settings-page change takes effect without a full restart.
    pub fn live_compute_type(&self) -> String {
        std::env::var("WHISPER_COMPUTE_TYPE")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| self.compute_type.clone())
    }

    /// Live-env-wins counterpart to `device` (see [`Self::live_whisper_model`]).
    pub fn live_device(&self) -> String {
        std::env::var("WHISPER_DEVICE")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| self.device.clone())
    }

    /// Create the data directory tree if it doesn't exist yet (boot-time init).
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(self.videos_dir())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Guard that removes a set of env vars on drop, so a test that sets
    /// them can't leak state into whichever test runs next in this thread.
    struct EnvGuard(&'static [&'static str]);
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for key in self.0 {
                std::env::remove_var(key);
            }
        }
    }

    const TEST_ENV_KEYS: &[&str] = &[
        "RJ_CONFIG",
        "WHISPER_MODEL",
        "WHISPER_TEMPERATURE",
        "WHISPER_COMPUTE_TYPE",
        "WHISPER_DEVICE",
        "LLM_PROVIDER",
    ];

    /// Process-wide env vars are shared mutable state, but Rust runs
    /// `#[test]`s in parallel threads by default -- without serializing the
    /// tests below, one test's `EnvGuard` can clear a key (e.g. `RJ_CONFIG`)
    /// out from under another test that's concurrently mid-way through
    /// relying on it. Every test in this module that touches `TEST_ENV_KEYS`
    /// must hold this lock for its full duration. `unwrap_or_else` recovers
    /// from a poisoned lock (an earlier test panicking mid-section) instead
    /// of cascading that failure into every later test.
    static ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn load_picks_up_config_toml_and_env_still_overrides_it() {
        let _lock = lock_env();
        let _guard = EnvGuard(TEST_ENV_KEYS);
        for key in TEST_ENV_KEYS {
            std::env::remove_var(key);
        }

        let mut path = std::env::temp_dir();
        path.push(format!("rj_player_test_config_{}.toml", std::process::id()));
        {
            let mut f = std::fs::File::create(&path).expect("create temp config.toml");
            writeln!(
                f,
                r#"
whisper_model_unused = "ignored"

[ai]
whisper_model = "large-v3"

[llm]
provider = "openai"
"#
            )
            .expect("write temp config.toml");
        }
        // The stray top-level key above isn't a real field on `FileConfig`;
        // toml::from_str ignores unknown fields by default (no `deny_unknown_fields`),
        // so it shouldn't cause a parse failure.

        std::env::set_var("RJ_CONFIG", &path);

        let cfg = Config::load();
        assert_eq!(
            cfg.whisper_model, "large-v3",
            "whisper_model should come from config.toml when no env override is set"
        );
        assert_eq!(
            cfg.llm_provider.as_deref(),
            Some("openai"),
            "llm_provider should come from config.toml"
        );

        // Now prove env still wins over the file value.
        std::env::set_var("WHISPER_MODEL", "tiny");
        let cfg2 = Config::load();
        assert_eq!(
            cfg2.whisper_model, "tiny",
            "WHISPER_MODEL env var must override config.toml's [ai] whisper_model"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_picks_up_whisper_temperature_and_env_still_overrides_it() {
        let _lock = lock_env();
        let _guard = EnvGuard(TEST_ENV_KEYS);
        for key in TEST_ENV_KEYS {
            std::env::remove_var(key);
        }

        let mut path = std::env::temp_dir();
        path.push(format!(
            "rj_player_test_temperature_config_{}.toml",
            std::process::id()
        ));
        {
            let mut f = std::fs::File::create(&path).expect("create temp config.toml");
            writeln!(
                f,
                r#"
[ai]
temperature = 0.4
"#
            )
            .expect("write temp config.toml");
        }

        std::env::set_var("RJ_CONFIG", &path);

        let cfg = Config::load();
        assert_eq!(
            cfg.whisper_temperature, 0.4,
            "whisper_temperature should come from config.toml's [ai] temperature when no env override is set"
        );

        // Now prove env still wins over the file value.
        std::env::set_var("WHISPER_TEMPERATURE", "0.1");
        let cfg2 = Config::load();
        assert_eq!(
            cfg2.whisper_temperature, 0.1,
            "WHISPER_TEMPERATURE env var must override config.toml's [ai] temperature"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_falls_back_cleanly_when_rj_config_points_nowhere() {
        let _lock = lock_env();
        let _guard = EnvGuard(TEST_ENV_KEYS);
        for key in TEST_ENV_KEYS {
            std::env::remove_var(key);
        }
        std::env::set_var("RJ_CONFIG", "/nonexistent/path/does-not-exist.toml");

        // An explicit-but-missing RJ_CONFIG must not fall through to
        // ./config.toml or ../config.toml (see find_config_path's doc
        // comment) and must not panic/crash — just resolve to plain
        // env/defaults, deterministically, regardless of whether this repo
        // happens to have a config.toml checked out.
        let cfg = Config::load();
        assert_eq!(cfg.whisper_model, "large-v3");
        assert_eq!(cfg.whisper_temperature, 0.0);
        assert_eq!(cfg.llm_provider, None);
    }

    /// dsd.md §13.7: a settings-page change writes a live env var without
    /// restarting the process, so `live_*` must reflect it on the very next
    /// read — unlike the plain fields, which are frozen at `Config::load`
    /// time.
    #[test]
    fn live_getters_prefer_a_later_env_change_over_the_loaded_snapshot() {
        let _lock = lock_env();
        let _guard = EnvGuard(TEST_ENV_KEYS);
        for key in TEST_ENV_KEYS {
            std::env::remove_var(key);
        }

        let cfg = Config::load();
        assert_eq!(cfg.live_whisper_model(), cfg.whisper_model);
        assert_eq!(cfg.live_whisper_temperature(), cfg.whisper_temperature);
        assert_eq!(cfg.live_compute_type(), cfg.compute_type);
        assert_eq!(cfg.live_device(), cfg.device);

        // Simulate a settings-page write (Tauri's `set_compute_type`/etc.
        // just do `std::env::set_var`) happening after `cfg` was loaded.
        std::env::set_var("WHISPER_MODEL", "small");
        std::env::set_var("WHISPER_TEMPERATURE", "0.7");
        std::env::set_var("WHISPER_COMPUTE_TYPE", "float32");
        std::env::set_var("WHISPER_DEVICE", "cuda");

        assert_eq!(cfg.live_whisper_model(), "small");
        assert_eq!(cfg.live_whisper_temperature(), 0.7);
        assert_eq!(cfg.live_compute_type(), "float32");
        assert_eq!(cfg.live_device(), "cuda");

        // The frozen fields on the same `cfg` instance must NOT have moved —
        // that's precisely the bug `live_*` exists to work around.
        assert_eq!(cfg.whisper_model, "large-v3");
        assert_eq!(cfg.compute_type, "int8");
    }
}
