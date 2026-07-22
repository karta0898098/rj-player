//! Doctor: a structured self-check of the managed runtime + external tools the
//! app needs (dsd.md §13.3). `GET /api/doctor` renders this report; the
//! first-run wizard and the settings page (B6.5/B6.6) consume the same shape.
//!
//! Key *values* are never exposed — only whether a provider key is present.
//! Checks that have a user-actionable repair carry a `fix` action id; the
//! corresponding fix endpoints (uv install runtime/deps, model download) land
//! in B6.4c.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::broadcast;

use crate::config::Config;

/// A check's state. `missing` = required-but-not-installed (red); `absent` =
/// optional-and-not-provided, e.g. an LLM key (grey); `broken` = present but
/// failing.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Ok,
    Missing,
    Absent,
    Broken,
}

#[derive(Debug, Serialize)]
pub struct DoctorCheck {
    pub id: &'static str,
    pub label: String,
    pub status: CheckStatus,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DoctorReport {
    /// True when every *required* check is `Ok`.
    pub ready: bool,
    pub checks: Vec<DoctorCheck>,
}

/// Run every check and assemble the report. Read-only: it inspects the
/// filesystem and runs `--version` on the bundled tools, but changes nothing.
pub async fn run(config: &Config) -> DoctorReport {
    let runtime_dir = std::env::var_os("RJ_RUNTIME_DIR").map(PathBuf::from);
    let hf_home = std::env::var_os("HF_HOME").map(PathBuf::from);

    let managed_venv = runtime_dir.as_ref().map(|r| r.join("venv"));

    let mut checks = Vec::new();

    // 1. Managed CPython installed by uv (into UV_PYTHON_INSTALL_DIR)? This is
    //    the interpreter `install_runtime` fetches; the venv built on top of it
    //    is the separate `ai_deps` check below.
    let py_install_dir = std::env::var_os("UV_PYTHON_INSTALL_DIR").map(PathBuf::from);
    let py_present = py_install_dir
        .as_ref()
        .is_some_and(|d| dir_has_entry_prefixed(d, "cpython-3.12"));
    checks.push(DoctorCheck {
        id: "python_runtime",
        label: "Python runtime".into(),
        status: if py_present { CheckStatus::Ok } else { CheckStatus::Missing },
        required: true,
        fix: (!py_present).then_some("install_runtime"),
        detail: py_install_dir.as_ref().map(|p| p.display().to_string()),
    });

    // 2. AI dependencies installed into that venv? Marked done by a sentinel the
    //    install step writes, so this stays a cheap filesystem check. A venv dir
    //    that exists without the sentinel is a half-finished install (`broken`),
    //    distinct from nothing there at all (`missing`).
    let deps_status = match managed_venv.as_ref() {
        Some(v) if v.join(".rj-deps-ok").is_file() => CheckStatus::Ok,
        Some(v) if v.is_dir() => CheckStatus::Broken,
        _ => CheckStatus::Missing,
    };
    let deps_ok = matches!(deps_status, CheckStatus::Ok);
    checks.push(DoctorCheck {
        id: "ai_deps",
        label: "AI 依賴 (faster-whisper…)".into(),
        status: deps_status,
        required: true,
        fix: (!deps_ok).then_some("install_deps"),
        detail: None,
    });

    // 3/4. Bundled tools actually run? (No user `fix` — a missing sidecar is a
    //      packaging bug, not something the user installs.) Run concurrently:
    //      each already retries internally, so sequencing them would double
    //      the worst-case wait for no benefit.
    static YTDLP_OK: OnceLock<()> = OnceLock::new();
    static FFMPEG_OK: OnceLock<()> = OnceLock::new();
    let (ytdlp_check, ffmpeg_check) = tokio::join!(
        tool_check("ytdlp", "yt-dlp", &config.yt_dlp_path, &["--version"], &YTDLP_OK),
        tool_check("ffmpeg", "ffmpeg", &config.ffmpeg_path, &["-version"], &FFMPEG_OK)
    );
    checks.push(ytdlp_check);
    checks.push(ffmpeg_check);

    // 5. Selected Whisper model present in the HF cache?
    let whisper_model = current_whisper_model(config);
    let model_ok = hf_home
        .as_ref()
        .is_some_and(|h| model_cached(h, &whisper_model));
    checks.push(DoctorCheck {
        id: "whisper_model",
        label: format!("Whisper 模型 ({whisper_model})"),
        status: if model_ok { CheckStatus::Ok } else { CheckStatus::Missing },
        required: true,
        fix: (!model_ok).then_some("download_model"),
        detail: None,
    });

    // 6. A translation LLM key present? Optional — without one the pipeline still
    //    produces the source + phonetic layers (§7 degradation), so `absent`.
    let key_present = nonempty(&config.gemini_api_key)
        || nonempty(&config.openai_api_key)
        || nonempty(&config.anthropic_api_key);
    checks.push(DoctorCheck {
        id: "llm_key",
        label: "翻譯 API Key".into(),
        status: if key_present { CheckStatus::Ok } else { CheckStatus::Absent },
        required: false,
        fix: (!key_present).then_some("open_settings"),
        detail: (!key_present).then(|| "未設定；可略過，只產原文＋讀音層".into()),
    });

    let ready = checks
        .iter()
        .all(|c| !c.required || matches!(c.status, CheckStatus::Ok));

    DoctorReport { ready, checks }
}

fn nonempty(opt: &Option<String>) -> bool {
    opt.as_deref().is_some_and(|s| !s.is_empty())
}

/// The Whisper model in effect: the live `WHISPER_MODEL` env (which the desktop
/// shell updates when the user picks one in the wizard, dsd.md §13.7) wins over
/// the config snapshot taken at startup.
fn current_whisper_model(config: &Config) -> String {
    config.live_whisper_model()
}

/// Whether `dir` contains any entry whose file name starts with `prefix`.
fn dir_has_entry_prefixed(dir: &std::path::Path, prefix: &str) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with(prefix))
        })
        .unwrap_or(false)
}

/// Whether the HF hub cache under `hf_home` holds a snapshot for the given
/// faster-whisper model (repos are named `models--Systran--faster-whisper-<m>`).
fn model_cached(hf_home: &std::path::Path, model: &str) -> bool {
    let needle = format!("faster-whisper-{model}");
    let hub = hf_home.join("hub");
    let Ok(entries) = std::fs::read_dir(&hub) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .contains(&needle)
            // require an actual snapshot, not just an empty dir
            && e.path().join("snapshots").is_dir()
    })
}

/// HF hub repo dir prefix for faster-whisper models (dsd.md §13.7's model
/// cache management). Real dir names look like
/// `models--Systran--faster-whisper-large-v3`.
const HF_MODEL_DIR_PREFIX: &str = "models--Systran--faster-whisper-";

/// One cached faster-whisper model under `HF_HOME/hub`.
#[derive(Debug, Serialize)]
pub struct CachedModel {
    /// The Whisper model size/name (e.g. `large-v3`), not the full HF repo
    /// dir name.
    pub name: String,
    /// Total on-disk size of this model's snapshot, in bytes.
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct ModelCacheReport {
    /// `HF_HOME`, or `None` if unset — nothing has ever been downloaded.
    pub hf_home: Option<String>,
    pub models: Vec<CachedModel>,
}

/// List every faster-whisper model currently cached under `HF_HOME/hub`
/// (dsd.md §13.7's settings-page cache management: "顯示位置...").
pub fn list_cached_models() -> ModelCacheReport {
    let hf_home = std::env::var_os("HF_HOME").map(PathBuf::from);
    let models = hf_home
        .as_deref()
        .map(scan_cached_models)
        .unwrap_or_default();
    ModelCacheReport {
        hf_home: hf_home.map(|p| p.display().to_string()),
        models,
    }
}

#[derive(Debug, Serialize)]
pub struct StorageReport {
    /// `config.videos_dir()` — where each downloaded video's subfolder
    /// (video/audio/subtitles/thumbnail) lives.
    pub videos_dir: String,
    /// Total on-disk size of `videos_dir`, in bytes.
    pub videos_size_bytes: u64,
}

/// Where downloaded videos/subtitles/thumbnails live + how much space they
/// use (Global Settings' "儲存位置" section, design_handoff_titlebar_settings/).
pub fn storage_report(config: &Config) -> StorageReport {
    let videos_dir = config.videos_dir();
    StorageReport {
        videos_size_bytes: dir_size(&videos_dir),
        videos_dir: videos_dir.display().to_string(),
    }
}

fn scan_cached_models(hf_home: &std::path::Path) -> Vec<CachedModel> {
    let hub = hf_home.join("hub");
    let Ok(entries) = std::fs::read_dir(&hub) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let file_name = e.file_name().to_string_lossy().into_owned();
            let name = file_name.strip_prefix(HF_MODEL_DIR_PREFIX)?.to_string();
            if !e.path().join("snapshots").is_dir() {
                return None;
            }
            Some(CachedModel {
                size_bytes: dir_size(&e.path()),
                name,
            })
        })
        .collect()
}

/// Recursively sum file sizes under `path`. Best-effort: unreadable entries
/// are just skipped rather than failing the whole size (this only feeds a
/// UI display, not a correctness-sensitive path).
fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.metadata() {
            Ok(meta) if meta.is_dir() => dir_size(&e.path()),
            Ok(meta) => meta.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Delete one cached model's directory. Returns whether it existed. `model`
/// is a plain Whisper model size/name (e.g. `large-v3`), matched the same
/// way [`model_cached`] does.
pub fn delete_cached_model(model: &str) -> std::io::Result<bool> {
    let Some(hf_home) = std::env::var_os("HF_HOME").map(PathBuf::from) else {
        return Ok(false);
    };
    let dir = hf_home.join("hub").join(format!("{HF_MODEL_DIR_PREFIX}{model}"));
    if !dir.is_dir() {
        return Ok(false);
    }
    std::fs::remove_dir_all(&dir)?;
    Ok(true)
}

/// Delete every cached faster-whisper model. Returns how many were removed.
pub fn clear_model_cache() -> std::io::Result<usize> {
    let Some(hf_home) = std::env::var_os("HF_HOME").map(PathBuf::from) else {
        return Ok(0);
    };
    let hub = hf_home.join("hub");
    let Ok(entries) = std::fs::read_dir(&hub) else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(HF_MODEL_DIR_PREFIX)
        {
            std::fs::remove_dir_all(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Bounded per-attempt timeouts for `tool_check`, in seconds. Some bundled
/// tools (e.g. yt-dlp's PyInstaller onefile binary) self-extract on every
/// launch — measured 10-16s just to answer `--version` on a loaded disk — so a
/// single short timeout falsely reports them as missing. Escalate across a
/// couple of attempts rather than giving up after one. A killed attempt also
/// leaves its self-extracted temp dir behind (the binary never gets to clean
/// up), so attempt 1 is sized to rarely need killing at all.
const TOOL_CHECK_TIMEOUTS_SECS: &[u64] = &[20, 35];

/// Run `bin args…` and report whether it exits successfully (the tool exists and
/// is runnable). Output is discarded. Once a check succeeds, `cache` remembers
/// it for the life of the process — the tool won't become uninstalled while
/// we're running, so there's no reason to keep paying its startup cost (and
/// timeout-kill risk) on every wizard poll or manual recheck.
async fn tool_check(
    id: &'static str,
    label: &str,
    bin: &str,
    args: &[&str],
    cache: &'static OnceLock<()>,
) -> DoctorCheck {
    let ok = if cache.get().is_some() {
        true
    } else {
        let mut ok = false;
        for &secs in TOOL_CHECK_TIMEOUTS_SECS {
            let mut cmd = Command::new(bin);
            cmd.args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            // Bounded: a wedged binary must not hang the whole `/api/doctor` request
            // (which would leave the wizard's checklist empty). Timeout => retry
            // (or, on the last attempt, not runnable).
            ok = tokio::time::timeout(std::time::Duration::from_secs(secs), cmd.status())
                .await
                .ok()
                .and_then(|r| r.ok())
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                break;
            }
        }
        if ok {
            let _ = cache.set(());
        }
        ok
    };
    DoctorCheck {
        id,
        label: label.into(),
        status: if ok { CheckStatus::Ok } else { CheckStatus::Missing },
        required: true,
        fix: None,
        detail: Some(bin.to_string()),
    }
}

// ============================ Fix actions (B6.4c) ============================
//
// Each Doctor `fix` runs one or more subprocesses (uv install runtime/deps, or a
// model-download probe) as a background task, streaming their merged output over
// a broadcast channel that `GET /api/doctor/events` forwards. Only one fix runs
// at a time.

const DOCTOR_CHANNEL_CAPACITY: usize = 256;
const PY_VERSION: &str = "3.12";

/// Progress events for a running fix, forwarded to WebSocket subscribers.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DoctorEvent {
    /// A line of subprocess output.
    Log { fix: String, line: String },
    /// The fix finished successfully.
    Done { fix: String },
    /// The fix failed; `error` is a short reason.
    Failed { fix: String, error: String },
}

/// Broadcast hub + single-fix-at-a-time guard for Doctor repair actions.
#[derive(Debug)]
pub struct DoctorHub {
    tx: broadcast::Sender<DoctorEvent>,
    running: AtomicBool,
}

impl Default for DoctorHub {
    fn default() -> Self {
        Self::new()
    }
}

impl DoctorHub {
    pub fn new() -> Self {
        Self {
            tx: broadcast::channel(DOCTOR_CHANNEL_CAPACITY).0,
            running: AtomicBool::new(false),
        }
    }

    /// Subscribe to fix-progress events (for the WS handler).
    pub fn subscribe(&self) -> broadcast::Receiver<DoctorEvent> {
        self.tx.subscribe()
    }

    fn publish(&self, event: DoctorEvent) {
        let _ = self.tx.send(event);
    }

    /// Claim the single run slot; returns false if a fix is already running.
    fn try_start(&self) -> bool {
        !self.running.swap(true, Ordering::SeqCst)
    }

    fn finish(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// Whether this build knows how to run the given fix id.
pub fn is_known_fix(id: &str) -> bool {
    matches!(id, "install_runtime" | "install_deps" | "download_model")
}

/// Spawn a fix as a background task. Returns `false` if the id is unknown or a
/// fix is already running (the caller surfaces 400/409). Progress is published
/// to `hub`; the run slot is released when the task finishes.
pub fn start_fix(hub: Arc<DoctorHub>, config: Arc<Config>, fix: String) -> bool {
    if !is_known_fix(&fix) || !hub.try_start() {
        return false;
    }
    tokio::spawn(async move {
        let result = match fix.as_str() {
            "install_runtime" => fix_install_runtime(&hub, &config).await,
            "install_deps" => fix_install_deps(&hub, &config).await,
            "download_model" => fix_download_model(&hub, &config).await,
            _ => Err("unknown fix".to_string()),
        };
        match result {
            Ok(()) => hub.publish(DoctorEvent::Done { fix }),
            Err(error) => hub.publish(DoctorEvent::Failed { fix, error }),
        }
        hub.finish();
    });
    true
}

/// `uv python install 3.12` — download a managed CPython into
/// `UV_PYTHON_INSTALL_DIR` (set by the desktop shell).
async fn fix_install_runtime(hub: &DoctorHub, config: &Config) -> Result<(), String> {
    let uv = uv_path(config)?;
    let mut cmd = Command::new(uv);
    cmd.args(["python", "install", PY_VERSION]);
    run_streaming(hub, "install_runtime", cmd).await
}

/// Create the managed venv and install `requirements.txt` into it, then write
/// the `.rj-deps-ok` sentinel the Doctor checks.
async fn fix_install_deps(hub: &DoctorHub, config: &Config) -> Result<(), String> {
    let uv = uv_path(config)?;
    let venv = managed_venv()?;
    let requirements = requirements_path(config);

    let mut mk = Command::new(&uv);
    // --clear replaces an existing venv (e.g. a leftover from a previous failed
    // attempt) instead of erroring "a virtual environment already exists".
    mk.args(["venv"])
        .arg(&venv)
        .args(["--python", PY_VERSION, "--clear"]);
    run_streaming(hub, "install_deps", mk).await?;

    let mut pip = Command::new(&uv);
    pip.args(["pip", "install", "--python"])
        .arg(&venv)
        .arg("-r")
        .arg(&requirements);
    run_streaming(hub, "install_deps", pip).await?;

    std::fs::write(venv.join(".rj-deps-ok"), b"")
        .map_err(|e| format!("installed deps but couldn't write completion marker: {e}"))?;
    Ok(())
}

/// Load the selected faster-whisper model once with the managed python, which
/// downloads it into `HF_HOME`.
async fn fix_download_model(hub: &DoctorHub, config: &Config) -> Result<(), String> {
    let python = managed_venv()?.join("bin/python");
    if !python.is_file() {
        return Err("managed Python not installed yet — run install_deps first".into());
    }
    let code = format!(
        "from faster_whisper import WhisperModel; \
         WhisperModel('{}', device='cpu', compute_type='int8'); \
         print('model ready')",
        current_whisper_model(config)
    );
    let mut cmd = Command::new(python);
    cmd.arg("-c").arg(code);
    run_streaming(hub, "download_model", cmd).await
}

fn uv_path(config: &Config) -> Result<String, String> {
    config
        .uv_path
        .clone()
        .ok_or_else(|| "uv is not available (no bundled sidecar)".to_string())
}

fn managed_venv() -> Result<PathBuf, String> {
    std::env::var_os("RJ_RUNTIME_DIR")
        .map(|r| PathBuf::from(r).join("venv"))
        .ok_or_else(|| "no managed runtime dir configured (RJ_RUNTIME_DIR)".to_string())
}

fn requirements_path(config: &Config) -> PathBuf {
    // AI_DIR (set by the shell) holds requirements.txt; fall back to the worker
    // script's parent directory.
    std::env::var_os("AI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(&config.ai_worker)
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."))
        })
        .join("requirements.txt")
}

/// Run `cmd`, streaming merged stdout+stderr lines as `DoctorEvent::Log`. Errors
/// if the process fails to start or exits non-zero.
async fn run_streaming(hub: &DoctorHub, fix: &str, mut cmd: Command) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("failed to start: {e}"))?;

    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        readers.push(spawn_line_reader(hub.tx.clone(), fix.to_string(), out));
    }
    if let Some(err) = child.stderr.take() {
        readers.push(spawn_line_reader(hub.tx.clone(), fix.to_string(), err));
    }

    let status = child.wait().await.map_err(|e| format!("wait failed: {e}"))?;
    for r in readers {
        let _ = r.await;
    }
    if status.success() {
        Ok(())
    } else {
        Err(format!("exited with status {}", status.code().unwrap_or(-1)))
    }
}

fn spawn_line_reader<R>(
    tx: broadcast::Sender<DoctorEvent>,
    fix: String,
    pipe: R,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx.send(DoctorEvent::Log {
                fix: fix.clone(),
                line,
            });
        }
    })
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    /// `HF_HOME` is process-wide env state; Rust runs `#[test]`s in parallel
    /// threads by default, so every test here must hold this lock for its
    /// full duration (mirrors `config::tests::ENV_TEST_LOCK`).
    static HF_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        HF_HOME_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct TempHfHome(PathBuf);
    impl TempHfHome {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("rj-player-hf-home-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("hub")).unwrap();
            std::env::set_var("HF_HOME", &dir);
            Self(dir)
        }
        fn seed_model(&self, model: &str, file_bytes: &[u8]) {
            let snapshot = self
                .0
                .join("hub")
                .join(format!("{HF_MODEL_DIR_PREFIX}{model}"))
                .join("snapshots")
                .join("main");
            std::fs::create_dir_all(&snapshot).unwrap();
            std::fs::write(snapshot.join("model.bin"), file_bytes).unwrap();
        }
    }
    impl Drop for TempHfHome {
        fn drop(&mut self) {
            std::env::remove_var("HF_HOME");
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn list_cached_models_finds_seeded_models_with_sizes() {
        let _lock = lock_env();
        let home = TempHfHome::new();
        home.seed_model("large-v3", b"0123456789");
        home.seed_model("small", b"01234");

        let mut report = list_cached_models();
        report.models.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(report.hf_home.as_deref(), Some(home.0.to_string_lossy().as_ref()));
        assert_eq!(report.models.len(), 2);
        assert_eq!(report.models[0].name, "large-v3");
        assert_eq!(report.models[0].size_bytes, 10);
        assert_eq!(report.models[1].name, "small");
        assert_eq!(report.models[1].size_bytes, 5);
    }

    #[test]
    fn list_cached_models_ignores_a_dir_with_no_snapshots() {
        let _lock = lock_env();
        let home = TempHfHome::new();
        // A bare, snapshot-less dir (e.g. a half-finished/corrupt download)
        // must not be reported as a usable cached model.
        std::fs::create_dir_all(home.0.join("hub").join(format!("{HF_MODEL_DIR_PREFIX}broken"))).unwrap();

        assert!(list_cached_models().models.is_empty());
    }

    #[test]
    fn list_cached_models_empty_when_hf_home_unset() {
        let _lock = lock_env();
        std::env::remove_var("HF_HOME");
        let report = list_cached_models();
        assert_eq!(report.hf_home, None);
        assert!(report.models.is_empty());
    }

    #[test]
    fn delete_cached_model_removes_only_the_named_model() {
        let _lock = lock_env();
        let home = TempHfHome::new();
        home.seed_model("large-v3", b"x");
        home.seed_model("small", b"y");

        assert!(delete_cached_model("large-v3").unwrap());
        assert!(!model_cached(&home.0, "large-v3"));
        assert!(model_cached(&home.0, "small"), "unrelated model must survive");
    }

    #[test]
    fn delete_cached_model_returns_false_when_not_cached() {
        let _lock = lock_env();
        let _home = TempHfHome::new();
        assert!(!delete_cached_model("does-not-exist").unwrap());
    }

    #[test]
    fn clear_model_cache_removes_every_model_and_reports_count() {
        let _lock = lock_env();
        let home = TempHfHome::new();
        home.seed_model("large-v3", b"x");
        home.seed_model("small", b"y");

        let removed = clear_model_cache().unwrap();
        assert_eq!(removed, 2);
        assert!(list_cached_models().models.is_empty());
    }
}
