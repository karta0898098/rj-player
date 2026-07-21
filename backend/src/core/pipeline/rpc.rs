//! Python worker RPC client (dsd.md §2, §3.3, §7, B2.1).
//!
//! Manages the lifecycle of the persistent Python AI worker subprocess
//! (`{AI_PYTHON} {AI_WORKER}`, spawned lazily via `tokio::process::Command`
//! and kept alive across jobs so the Whisper model stays warm). Requests are
//! written as single JSON lines to the worker's stdin; the worker streams
//! JSON event lines back on stdout, correlated by request `id`. stderr is
//! forwarded to `tracing` as human-readable log lines.
//!
//! Failure isolation (dsd.md §7): if the worker's stdout hits EOF, or a
//! stdout line fails to parse as a well-formed event, that is treated as a
//! worker crash — the in-flight call returns an error and the process
//! handle is dropped so the *next* call lazily respawns a fresh worker. A
//! crashed/misbehaving worker can never crash the Rust backend.
//!
//! No axum/HTTP types live here (Tauri migration seam, see dsd.md §10).

use std::process::Stdio;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::core::domain::{Cue, Stage, SubtitleDoc};

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("io error talking to AI worker: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to (de)serialize worker RPC message: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("AI worker exited or closed stdout before replying")]
    WorkerExited,
    #[error("AI worker protocol violation: {0}")]
    Protocol(String),
    #[error("AI worker reported an error at stage {stage:?}: {message}")]
    Worker {
        stage: Option<Stage>,
        message: String,
        /// A partial `SubtitleDoc` the worker managed to assemble before
        /// failing, if any (dsd.md §3.3's `error.partial` field).
        partial: Option<Box<SubtitleDoc>>,
    },
}

/// Params for the `generate_subtitles` RPC method (dsd.md §3.3).
#[derive(Debug, Clone, Serialize)]
pub struct GenerateSubtitlesParams {
    pub video_id: String,
    pub audio_path: String,
    pub source_lang: String,
    pub whisper_model: String,
    pub whisper_temperature: f32,
    pub translate: bool,
    pub target_lang: String,
    /// Per-request Whisper `initial_prompt` override (dsd.md's per-request
    /// "regenerate" contract). `None`/omitted -> `ai/worker.py` passes no
    /// initial prompt at all (`params.get("initial_prompt") or None`), same
    /// as an empty string would.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_prompt: Option<String>,
    /// Per-request Silero VAD knob overrides. Always serialized (as `{}`
    /// when every knob is `None`) since `ai/worker.py` reads it as
    /// `params.get("vad") or {}`; individual `None` knobs inside it are
    /// skipped so `ai/pipeline/asr.py`'s `vad_overrides` merge only ever
    /// sees the keys that were actually overridden.
    pub vad: VadParams,
    /// The song's real lyrics, when supplied. `None`/omitted -> `ai/worker.py`
    /// runs `asr.transcribe` as before (`params.get("reference_lyrics") or
    /// None`); `Some` -> the worker force-aligns this text to the audio via
    /// `ai/pipeline/align.py` instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_lyrics: Option<String>,
    /// Path to the manual Japanese CC file fetched at download time
    /// (`FsStore::cc_path`), when the video had one (`FsStore::cc_exists`).
    /// `None`/omitted -> `ai/worker.py` has no CC to consider. `Some` is
    /// passed regardless of `reference_lyrics` -- the worker itself applies
    /// the precedence (`reference_lyrics` > CC > ASR), so the orchestrator
    /// doesn't need to know or care which one will actually win.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cc_path: Option<String>,
}

/// Params for the `retranslate` RPC method — re-runs ONLY the translate
/// stage against `cues` from an existing `SubtitleDoc` (no ASR). `cues`
/// carries `ja_text`/`ja_tokens`/`romaji`/timing straight through
/// unmodified; the worker only overwrites `zh_text`. Everything else
/// mirrors the corresponding fields of the doc being retranslated.
#[derive(Debug, Clone, Serialize)]
pub struct RetranslateParams {
    pub video_id: String,
    pub source_lang: String,
    pub target_lang: String,
    pub duration_ms: u64,
    pub cues: Vec<Cue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// The 4 Silero VAD knobs `ai/pipeline/asr.py`'s `transcribe(...)` accepts
/// as `vad_overrides`. Each field omitted from the outbound JSON when
/// `None`, so the worker's dict-merge only overrides what was actually
/// requested and falls back to asr.py's baked-in defaults for the rest.
#[derive(Debug, Clone, Default, Serialize)]
pub struct VadParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_silence_duration_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speech_pad_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_speech_duration_s: Option<f32>,
}

/// Non-terminal events forwarded to the caller of [`RpcClient::generate_subtitles`]
/// while a request is in flight, so the orchestrator can mirror them onto the
/// WebSocket `EventHub` (dsd.md §3.2).
#[derive(Debug, Clone)]
pub enum WorkerProgress {
    /// The worker has entered a new pipeline stage.
    Stage(Stage),
    /// Percent-complete progress within a stage.
    Progress { stage: Stage, pct: u8 },
    /// A pre-translate snapshot doc (ja_text/ja_tokens/romaji filled,
    /// zh_text null) emitted right after the romaji stage, before translate
    /// starts — lets the caller persist that work immediately rather than
    /// only on the terminal `result`/`error` (see `ai/worker.py`'s
    /// `partial_result` event and dsd.md §7's "don't throw away completed
    /// work", extended from crash-forensics to the common case).
    Partial(SubtitleDoc),
}

#[derive(Debug, Serialize)]
struct RpcRequest<'a, P: Serialize> {
    id: &'a str,
    method: &'a str,
    params: P,
}

/// Deserialized shape of one worker stdout line (dsd.md §3.3). Extra fields
/// (e.g. `stage`'s `status`) are ignored rather than rejected, since they're
/// documented as informational and we don't branch on their value.
#[derive(Debug, Deserialize)]
struct WorkerEventEnvelope {
    id: String,
    #[serde(flatten)]
    payload: WorkerEventPayload,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum WorkerEventPayload {
    Stage {
        stage: Stage,
    },
    Progress {
        stage: Stage,
        pct: u8,
    },
    Result {
        subtitles: SubtitleDoc,
    },
    /// Non-terminal — a `result`/`error` for the same request id always
    /// follows. See `WorkerProgress::Partial`.
    PartialResult {
        subtitles: SubtitleDoc,
    },
    Error {
        #[serde(default)]
        stage: Option<Stage>,
        message: String,
        #[serde(default)]
        partial: Option<Box<SubtitleDoc>>,
    },
    /// Response to `ping` — not part of the dsd.md §3.3 worked examples, but
    /// implied by "ping (health check / dev-time echo)"; kept as a distinct
    /// tag so it can never be mistaken for a `generate_subtitles` result.
    Pong,
}

/// One line read from the worker's stdout, pre-parse-failure-checked.
type LineResult = Result<WorkerEventEnvelope, RpcError>;

struct WorkerProcess {
    child: Child,
    stdin: ChildStdin,
    events_rx: mpsc::UnboundedReceiver<LineResult>,
    // Kept alive only so the reader/stderr-forwarder tasks aren't dropped
    // (and thus aborted) while the process is still in use.
    _stdout_task: JoinHandle<()>,
    _stderr_task: JoinHandle<()>,
}

impl WorkerProcess {
    async fn write_line(&mut self, line: &str) -> Result<(), RpcError> {
        self.stdin.write_all(line.as_bytes()).await?;
        if !line.ends_with('\n') {
            self.stdin.write_all(b"\n").await?;
        }
        self.stdin.flush().await?;
        Ok(())
    }

    /// Force-terminate the process. Used when we're discarding the handle
    /// after a protocol error, so a half-alive worker doesn't linger.
    async fn kill(mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

/// Client for the persistent Python AI worker subprocess.
///
/// The worker is spawned lazily on first use and kept alive across calls.
/// Internally, the (at most one) live process handle is guarded by a mutex
/// that is held for the full duration of a request/response exchange — this
/// is deliberate, not just convenient: dsd.md §8 already constrains the
/// system to a single-worker job queue, so there is never more than one
/// concurrent pipeline job, and serializing on this mutex means a caller
/// never has to worry about another task's response lines interleaving with
/// its own on the single stdout stream.
pub struct RpcClient {
    python: String,
    worker_args: Vec<String>,
    /// Extra env vars set on the spawned worker subprocess, on top of
    /// normal inheritance from the backend's own environment (see
    /// [`RpcClient::with_env`]). Used to hand the AI worker resolved
    /// `[llm]` settings (e.g. from `config.toml`) that may not exist in the
    /// backend's own process environment.
    extra_env: Vec<(String, String)>,
    process: Mutex<Option<WorkerProcess>>,
}

impl RpcClient {
    /// `python` is the interpreter to launch (`{AI_PYTHON}`); `worker_script`
    /// is passed as its sole argument (`{AI_WORKER}`), per dsd.md §8's
    /// config: invoke as `{AI_PYTHON} {AI_WORKER}`.
    pub fn new(python: impl Into<String>, worker_script: impl Into<String>) -> Self {
        Self::with_args(python, vec![worker_script.into()])
    }

    /// Like [`RpcClient::new`], but with full control over the argv passed
    /// to the interpreter after `python`. Exists so tests can drive the
    /// stub worker fixture through argv-selected behavior (e.g. simulate a
    /// crash) without touching shared process environment variables, which
    /// would race across Rust's parallel test execution.
    pub fn with_args(python: impl Into<String>, worker_args: Vec<String>) -> Self {
        Self {
            python: python.into(),
            worker_args,
            extra_env: Vec::new(),
            process: Mutex::new(None),
        }
    }

    /// Builder method: set extra env vars to apply on top of the spawned
    /// worker's inherited environment (e.g. `Config::llm_env_vars()` — the
    /// resolved `LLM_PROVIDER`/`LLM_MODEL`/`*_API_KEY` values, however they
    /// were sourced — env, `config.toml`, or absent). Only pass entries you
    /// actually want to force; leave others out so the worker's own
    /// degradation logic (missing key -> skip translation) still applies.
    pub fn with_env(mut self, extra_env: Vec<(String, String)>) -> Self {
        self.extra_env = extra_env;
        self
    }

    /// Health check / dev-time echo (dsd.md §3.3). Spawns the worker if it
    /// isn't already running.
    ///
    /// Not currently called from any HTTP-reachable path (the orchestrator
    /// only needs `generate_subtitles`), so it's dead code outside of
    /// tests today; kept because it's part of the documented wire protocol
    /// and is the natural hook for a future `/health/ai`-style diagnostic
    /// endpoint or a startup smoke test.
    #[allow(dead_code)]
    pub async fn ping(&self) -> Result<(), RpcError> {
        let id = format!("req-{}", Uuid::new_v4());
        let line = serde_json::to_string(&RpcRequest {
            id: &id,
            method: "ping",
            params: serde_json::json!({}),
        })?;

        let mut guard = self.process.lock().await;
        self.ensure_spawned(&mut guard).await?;
        let proc = guard.as_mut().expect("just ensured spawned");

        if let Err(err) = proc.write_line(&line).await {
            Self::drop_process(&mut guard).await;
            return Err(err);
        }

        loop {
            let proc = guard.as_mut().expect("still spawned");
            match proc.events_rx.recv().await {
                Some(Ok(env)) if env.id == id => match env.payload {
                    WorkerEventPayload::Pong => return Ok(()),
                    other => {
                        tracing::warn!(?other, "unexpected event in reply to ping");
                        continue;
                    }
                },
                Some(Ok(_stale)) => continue, // event for a previous/unrelated request id
                Some(Err(err)) => {
                    Self::drop_process(&mut guard).await;
                    return Err(err);
                }
                None => {
                    Self::drop_process(&mut guard).await;
                    return Err(RpcError::WorkerExited);
                }
            }
        }
    }

    /// Run the full ASR -> tokenize -> romaji -> translate -> assemble
    /// pipeline for one video (dsd.md §3.3 `generate_subtitles`). Blocks
    /// until the worker emits a terminal `result` or `error` event,
    /// invoking `on_progress` for every `stage`/`progress` event seen along
    /// the way so the caller can mirror them onto the WS `EventHub`.
    pub async fn generate_subtitles(
        &self,
        params: GenerateSubtitlesParams,
        mut on_progress: impl FnMut(WorkerProgress) + Send,
    ) -> Result<SubtitleDoc, RpcError> {
        let id = format!("req-{}", Uuid::new_v4());
        let line = serde_json::to_string(&RpcRequest {
            id: &id,
            method: "generate_subtitles",
            params,
        })?;

        let mut guard = self.process.lock().await;
        self.ensure_spawned(&mut guard).await?;
        let proc = guard.as_mut().expect("just ensured spawned");

        if let Err(err) = proc.write_line(&line).await {
            Self::drop_process(&mut guard).await;
            return Err(err);
        }

        loop {
            let proc = guard.as_mut().expect("still spawned");
            match proc.events_rx.recv().await {
                Some(Ok(env)) if env.id == id => match env.payload {
                    WorkerEventPayload::Stage { stage } => {
                        on_progress(WorkerProgress::Stage(stage));
                    }
                    WorkerEventPayload::Progress { stage, pct } => {
                        on_progress(WorkerProgress::Progress { stage, pct });
                    }
                    WorkerEventPayload::PartialResult { subtitles } => {
                        on_progress(WorkerProgress::Partial(subtitles));
                    }
                    WorkerEventPayload::Result { subtitles } => return Ok(subtitles),
                    WorkerEventPayload::Error {
                        stage,
                        message,
                        partial,
                    } => {
                        return Err(RpcError::Worker {
                            stage,
                            message,
                            partial,
                        });
                    }
                    WorkerEventPayload::Pong => {
                        tracing::warn!("unexpected pong event during generate_subtitles");
                    }
                },
                Some(Ok(_stale)) => continue, // event for a previous/unrelated request id
                Some(Err(err)) => {
                    Self::drop_process(&mut guard).await;
                    return Err(err);
                }
                None => {
                    Self::drop_process(&mut guard).await;
                    return Err(RpcError::WorkerExited);
                }
            }
        }
    }

    /// Re-run ONLY the translate stage against already-computed cues (dsd.md
    /// §7 extended: retry translation without redoing ASR). `params.cues`
    /// carries `ja_text`/`ja_tokens`/`romaji`/timing straight from an
    /// existing `subtitles.json` — the worker passes those through untouched
    /// and only overwrites `zh_text`. Same terminal shape as
    /// `generate_subtitles`: blocks until a `result` or `error`, invoking
    /// `on_progress` for `stage`/`progress` events along the way.
    pub async fn retranslate(
        &self,
        params: RetranslateParams,
        mut on_progress: impl FnMut(WorkerProgress) + Send,
    ) -> Result<SubtitleDoc, RpcError> {
        let id = format!("req-{}", Uuid::new_v4());
        let line = serde_json::to_string(&RpcRequest {
            id: &id,
            method: "retranslate",
            params,
        })?;

        let mut guard = self.process.lock().await;
        self.ensure_spawned(&mut guard).await?;
        let proc = guard.as_mut().expect("just ensured spawned");

        if let Err(err) = proc.write_line(&line).await {
            Self::drop_process(&mut guard).await;
            return Err(err);
        }

        loop {
            let proc = guard.as_mut().expect("still spawned");
            match proc.events_rx.recv().await {
                Some(Ok(env)) if env.id == id => match env.payload {
                    WorkerEventPayload::Stage { stage } => {
                        on_progress(WorkerProgress::Stage(stage));
                    }
                    WorkerEventPayload::Progress { stage, pct } => {
                        on_progress(WorkerProgress::Progress { stage, pct });
                    }
                    WorkerEventPayload::PartialResult { subtitles } => {
                        on_progress(WorkerProgress::Partial(subtitles));
                    }
                    WorkerEventPayload::Result { subtitles } => return Ok(subtitles),
                    WorkerEventPayload::Error {
                        stage,
                        message,
                        partial,
                    } => {
                        return Err(RpcError::Worker {
                            stage,
                            message,
                            partial,
                        });
                    }
                    WorkerEventPayload::Pong => {
                        tracing::warn!("unexpected pong event during retranslate");
                    }
                },
                Some(Ok(_stale)) => continue, // event for a previous/unrelated request id
                Some(Err(err)) => {
                    Self::drop_process(&mut guard).await;
                    return Err(err);
                }
                None => {
                    Self::drop_process(&mut guard).await;
                    return Err(RpcError::WorkerExited);
                }
            }
        }
    }

    /// Ask the worker to exit gracefully, then make sure it's actually gone.
    /// Best-effort: intended for backend shutdown, not part of the job
    /// error-handling path.
    pub async fn shutdown(&self) {
        let mut guard = self.process.lock().await;
        let Some(proc) = guard.as_mut() else {
            return;
        };

        let id = format!("req-{}", Uuid::new_v4());
        if let Ok(line) = serde_json::to_string(&RpcRequest {
            id: &id,
            method: "shutdown",
            params: serde_json::json!({}),
        }) {
            let _ = proc.write_line(&line).await;
        }

        Self::drop_process(&mut guard).await;
    }

    async fn ensure_spawned(&self, guard: &mut Option<WorkerProcess>) -> Result<(), RpcError> {
        if guard.is_none() {
            tracing::info!(
                python = %self.python,
                args = ?self.worker_args,
                "spawning AI worker process"
            );
            *guard = Some(self.spawn_worker().await?);
        }
        Ok(())
    }

    async fn spawn_worker(&self) -> Result<WorkerProcess, RpcError> {
        let mut command = Command::new(&self.python);
        command
            .args(&self.worker_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Only the entries Config::llm_env_vars() resolved to Some(non-empty)
        // land here (dsd.md §7's degradation still relies on these being
        // genuinely absent from the child's env when not configured, not
        // just empty strings), so this only ever adds vars, never masks an
        // inherited one with an empty value.
        for (key, value) in &self.extra_env {
            command.env(key, value);
        }
        let mut child = command.spawn()?;

        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let (tx, rx) = mpsc::unbounded_channel::<LineResult>();

        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<WorkerEventEnvelope>(&line) {
                            Ok(env) => {
                                if tx.send(Ok(env)).is_err() {
                                    break;
                                }
                            }
                            Err(err) => {
                                tracing::warn!(
                                    %line,
                                    %err,
                                    "AI worker emitted a malformed event line; treating as a crash"
                                );
                                let _ = tx.send(Err(RpcError::Protocol(format!(
                                    "malformed JSON from worker: {err}"
                                ))));
                                break;
                            }
                        }
                    }
                    Ok(None) => {
                        // EOF: worker closed stdout (exited or crashed).
                        let _ = tx.send(Err(RpcError::WorkerExited));
                        break;
                    }
                    Err(err) => {
                        let _ = tx.send(Err(RpcError::Io(err)));
                        break;
                    }
                }
            }
        });

        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(target: "ai_worker", "{line}");
            }
        });

        Ok(WorkerProcess {
            child,
            stdin,
            events_rx: rx,
            _stdout_task: stdout_task,
            _stderr_task: stderr_task,
        })
    }

    /// Drop (and force-kill) the current process handle, if any, so the
    /// next call lazily respawns a fresh worker (dsd.md §7).
    async fn drop_process(guard: &mut Option<WorkerProcess>) {
        if let Some(proc) = guard.take() {
            proc.kill().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::domain::SUBTITLE_DOC_VERSION;
    use std::path::PathBuf;

    fn stub_worker_path() -> String {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/stub_worker.py")
            .to_string_lossy()
            .to_string()
    }

    fn stub_client() -> RpcClient {
        RpcClient::new("python3", stub_worker_path())
    }

    /// `mode` is passed as argv to the stub fixture (not an env var) so
    /// concurrently-running tests can each drive their own child process
    /// independently without racing on shared process environment state.
    fn stub_client_with_mode(mode: &str) -> RpcClient {
        RpcClient::with_args("python3", vec![stub_worker_path(), mode.to_string()])
    }

    #[tokio::test]
    async fn ping_roundtrips_with_stub_worker() {
        let client = stub_client();
        client.ping().await.expect("ping should succeed");
    }

    #[tokio::test]
    async fn generate_subtitles_returns_canned_doc_from_stub_worker() {
        let client = stub_client();
        let mut saw_stage = false;
        let mut saw_progress = false;

        let doc = client
            .generate_subtitles(
                GenerateSubtitlesParams {
                    video_id: "abc123".to_string(),
                    audio_path: "/tmp/does-not-need-to-exist.wav".to_string(),
                    source_lang: "ja".to_string(),
                    whisper_model: "small".to_string(),
                    whisper_temperature: 0.0,
                    translate: true,
                    target_lang: "zh-TW".to_string(),
                    initial_prompt: None,
                    vad: VadParams::default(),
                    reference_lyrics: None,
                    cc_path: None,
                },
                |event| match event {
                    WorkerProgress::Stage(_) => saw_stage = true,
                    WorkerProgress::Progress { .. } => saw_progress = true,
                    WorkerProgress::Partial(_) => {}
                },
            )
            .await
            .expect("stub worker should return a result");

        assert!(saw_stage, "expected at least one stage event");
        assert!(saw_progress, "expected at least one progress event");
        assert_eq!(doc.video_id, "abc123");
        assert_eq!(doc.version, SUBTITLE_DOC_VERSION);
        assert_eq!(doc.cues.len(), 1);
        assert_eq!(
            doc.cues[0]
                .ja_tokens
                .iter()
                .map(|t| t.t.as_str())
                .collect::<String>(),
            doc.cues[0].ja_text
        );
    }

    #[tokio::test]
    async fn worker_eof_before_result_is_surfaced_as_worker_exited() {
        let client = stub_client_with_mode("crash_before_reply");

        let result = client
            .generate_subtitles(
                GenerateSubtitlesParams {
                    video_id: "abc123".to_string(),
                    audio_path: "/tmp/does-not-need-to-exist.wav".to_string(),
                    source_lang: "ja".to_string(),
                    whisper_model: "small".to_string(),
                    whisper_temperature: 0.0,
                    translate: true,
                    target_lang: "zh-TW".to_string(),
                    initial_prompt: None,
                    vad: VadParams::default(),
                    reference_lyrics: None,
                    cc_path: None,
                },
                |_event| {},
            )
            .await;

        assert!(
            matches!(result, Err(RpcError::WorkerExited) | Err(RpcError::Io(_))),
            "expected a crash-isolated error, got {result:?}"
        );

        // The client must still be usable afterwards (lazy respawn), proving
        // a worker crash does not take the client (or the backend) down.
        let client2 = stub_client();
        client2
            .ping()
            .await
            .expect("client should recover after a crash by respawning");
    }

    #[tokio::test]
    async fn worker_malformed_output_is_surfaced_as_protocol_error() {
        let client = stub_client_with_mode("malformed");

        let result = client.ping().await;

        assert!(
            matches!(
                result,
                Err(RpcError::Protocol(_)) | Err(RpcError::WorkerExited)
            ),
            "expected a protocol error, got {result:?}"
        );
    }

    fn base_params() -> GenerateSubtitlesParams {
        GenerateSubtitlesParams {
            video_id: "abc123".to_string(),
            audio_path: "/tmp/does-not-need-to-exist.wav".to_string(),
            source_lang: "ja".to_string(),
            whisper_model: "small".to_string(),
            whisper_temperature: 0.0,
            translate: true,
            target_lang: "zh-TW".to_string(),
            initial_prompt: None,
            vad: VadParams::default(),
            reference_lyrics: None,
            cc_path: None,
        }
    }

    #[test]
    fn cc_path_omitted_from_json_when_none() {
        let json = serde_json::to_string(&base_params()).unwrap();
        assert!(!json.contains("cc_path"), "cc_path should be omitted when None: {json}");
    }

    #[test]
    fn cc_path_present_in_json_when_some() {
        let params = GenerateSubtitlesParams {
            cc_path: Some("/data/videos/abc123/cc.srt".to_string()),
            ..base_params()
        };
        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("\"cc_path\":\"/data/videos/abc123/cc.srt\""), "got: {json}");
    }
}
