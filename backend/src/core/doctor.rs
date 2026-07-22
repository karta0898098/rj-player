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

use serde::Serialize;
use tokio::process::Command;

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
    let managed_python = managed_venv.as_ref().map(|v| v.join("bin/python"));

    let mut checks = Vec::new();

    // 1. Managed Python interpreter present?
    let py_present = managed_python.as_ref().is_some_and(|p| p.is_file());
    checks.push(DoctorCheck {
        id: "python_runtime",
        label: "Python runtime".into(),
        status: if py_present { CheckStatus::Ok } else { CheckStatus::Missing },
        required: true,
        fix: (!py_present).then_some("install_runtime"),
        detail: managed_python
            .as_ref()
            .map(|p| p.display().to_string())
            .or_else(|| Some("no managed runtime dir configured".into())),
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
    //      packaging bug, not something the user installs.)
    checks.push(tool_check("ytdlp", "yt-dlp", &config.yt_dlp_path, &["--version"]).await);
    checks.push(tool_check("ffmpeg", "ffmpeg", &config.ffmpeg_path, &["-version"]).await);

    // 5. Selected Whisper model present in the HF cache?
    let model_ok = hf_home
        .as_ref()
        .is_some_and(|h| model_cached(h, &config.whisper_model));
    checks.push(DoctorCheck {
        id: "whisper_model",
        label: format!("Whisper 模型 ({})", config.whisper_model),
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

/// Run `bin args…` and report whether it exits successfully (the tool exists and
/// is runnable). Output is discarded.
async fn tool_check(id: &'static str, label: &str, bin: &str, args: &[&str]) -> DoctorCheck {
    let ok = Command::new(bin)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    DoctorCheck {
        id,
        label: label.into(),
        status: if ok { CheckStatus::Ok } else { CheckStatus::Missing },
        required: true,
        fix: None,
        detail: Some(bin.to_string()),
    }
}
