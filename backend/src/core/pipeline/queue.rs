//! Single-worker job queue (dsd.md §2, §8, B1.4/B1.5, B2.6).
//!
//! Both download jobs and pipeline (subtitle generation) jobs flow through
//! this single queue/worker task, so there is never more than one of either
//! running at a time (dsd.md §8 — avoids Whisper competing with itself or
//! with a concurrent download for CPU/RAM on this single-user local tool).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::core::domain::{JobEvent, Stage, VideoMeta, VideoStatus};
use crate::core::downloader::{ProgressEvent, YtDlp};
use crate::core::pipeline::hub::EventHub;
use crate::core::pipeline::orchestrator;
use crate::core::pipeline::rpc::RpcClient;
use crate::core::store::FsStore;

/// Per-request Silero VAD knob overrides (dsd.md's per-request "regenerate"
/// contract). `None` for any field means "use `ai/pipeline/asr.py`'s
/// baked-in default for that knob" — see `asr.transcribe`'s `vad_overrides`
/// merge. Derives `Deserialize` so the HTTP layer
/// (`http::subtitles::PipelineRequest`) can parse the `vad` object straight
/// out of the `POST /api/videos/:id/pipeline` JSON body without a separate
/// duplicate struct.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VadOverrides {
    /// Whether to run the Silero VAD pre-filter at all. `None`/`Some(true)` →
    /// VAD on (the default; skips instrumental/silence, tightens timings);
    /// `Some(false)` → VAD off (Whisper sees the whole audio — recovers more
    /// quiet/sung content but hallucinates over non-speech). The 4 knobs below
    /// only apply when VAD is on.
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub threshold: Option<f32>,
    #[serde(default)]
    pub min_silence_duration_ms: Option<u32>,
    #[serde(default)]
    pub speech_pad_ms: Option<u32>,
    #[serde(default)]
    pub max_speech_duration_s: Option<f32>,
}

/// Per-request generation-knob overrides threaded from
/// `POST /api/videos/:id/pipeline`'s optional JSON body all the way to
/// `ai/pipeline/asr.py`'s `model.transcribe(...)`. Every field left `None`
/// (or, for `vad`, left with every sub-field `None`) falls back to the
/// config default (`whisper_model`/`whisper_temperature`) or to asr.py's own
/// defaults (`vad`, `initial_prompt`). Also reused as `VideoMeta::queued_options`
/// (the queue feature, `POST /api/videos`) so the auto-pipeline-after-download
/// path in `process_download_job` uses whatever options the video was
/// queued with, falling back to `PipelineOverrides::default()` when none
/// were supplied.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PipelineOverrides {
    #[serde(default)]
    pub whisper_model: Option<String>,
    #[serde(default)]
    pub whisper_temperature: Option<f32>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
    #[serde(default)]
    pub vad: VadOverrides,
    /// The song's real lyrics, when supplied. `Some` (non-blank) switches
    /// the ASR stage from free transcription to forced alignment against
    /// this exact text (dsd.md's forced-alignment extension). `None` is the
    /// default for both this override and the auto-pipeline-after-download
    /// path (`PipelineOverrides::default()`), which keeps behaving exactly
    /// as before this feature existed.
    #[serde(default)]
    pub reference_lyrics: Option<String>,
}

/// A unit of work submitted to the single-worker queue.
#[derive(Debug, Clone)]
pub enum Job {
    /// Download a video, optionally chaining straight into the AI subtitle
    /// pipeline once the download finishes.
    Download {
        video_id: String,
        url: String,
        auto_pipeline: bool,
    },
    /// (Re-)run the AI subtitle pipeline for an already-downloaded video
    /// (`POST /api/videos/:id/pipeline`, dsd.md §3.1). `force` bypasses the
    /// `subtitles.json` cache check (dsd.md §5.1/§7). `overrides` carries
    /// any per-request generation-knob overrides from the request body;
    /// `PipelineOverrides::default()` means "use config/asr.py defaults".
    Pipeline {
        video_id: String,
        force: bool,
        overrides: PipelineOverrides,
    },
    /// Re-run ONLY the translate stage against an existing `subtitles.json`
    /// (`POST /api/videos/:id/retranslate`) — no ASR. Routed through this
    /// same single-worker queue (not called directly) so it can't overlap
    /// with a `Download`/`Pipeline` job for the same (or any other) video,
    /// same as everything else that touches the shared Python worker
    /// process (dsd.md §8).
    Retranslate { video_id: String },
}

/// Sending half handed out via `AppState` so HTTP handlers can enqueue work.
pub type JobSender = mpsc::Sender<Job>;

/// Create a new bounded job channel. A modest bound is enough backpressure
/// for a single-user local tool.
pub fn job_channel() -> (JobSender, mpsc::Receiver<Job>) {
    mpsc::channel(32)
}

/// Drives the queue forever, processing exactly one job at a time. Meant to
/// be spawned once as a background task at startup.
pub async fn run_worker(
    mut rx: mpsc::Receiver<Job>,
    store: Arc<FsStore>,
    hub: Arc<EventHub>,
    ytdlp: Arc<YtDlp>,
    rpc: Arc<RpcClient>,
    config: Arc<Config>,
) {
    tracing::info!("job queue worker started");
    while let Some(job) = rx.recv().await {
        // Re-read live env on every job rather than closing over a value
        // frozen at startup, so a settings-page change (dsd.md §13.7) takes
        // effect on the very next job with no restart needed.
        let whisper_model = config.live_whisper_model();
        let whisper_temperature = config.live_whisper_temperature();
        let compute_type = config.live_compute_type();
        let device = config.live_device();
        match job {
            Job::Download {
                video_id,
                url,
                auto_pipeline,
            } => {
                process_download_job(
                    &store,
                    &hub,
                    &ytdlp,
                    &rpc,
                    &whisper_model,
                    whisper_temperature,
                    &compute_type,
                    &device,
                    video_id,
                    url,
                    auto_pipeline,
                )
                .await;
            }
            Job::Pipeline {
                video_id,
                force,
                overrides,
            } => {
                orchestrator::run_pipeline(
                    &store,
                    &hub,
                    &rpc,
                    &video_id,
                    &whisper_model,
                    whisper_temperature,
                    &compute_type,
                    &device,
                    force,
                    &overrides,
                )
                .await;
            }
            Job::Retranslate { video_id } => {
                orchestrator::run_retranslate(&store, &hub, &rpc, &video_id).await;
            }
        }
    }
    tracing::warn!("job queue worker stopped (channel closed)");
}

#[allow(clippy::too_many_arguments)]
async fn process_download_job(
    store: &FsStore,
    hub: &EventHub,
    ytdlp: &YtDlp,
    rpc: &RpcClient,
    whisper_model: &str,
    whisper_temperature: f32,
    compute_type: &str,
    device: &str,
    video_id: String,
    url: String,
    auto_pipeline: bool,
) {
    tracing::info!(%video_id, auto_pipeline, "download job starting");

    let mut meta = store
        .load_meta(&video_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| VideoMeta::new(video_id.clone(), url.clone()));

    // The user cancelled this item (`POST /api/videos/:id/cancel`) while it
    // was still sitting in the mpsc buffer waiting for the worker. There's
    // no way to pull it back out of the channel, so treat `meta.json`'s
    // `Cancelled` status as the authoritative "skip this" signal instead.
    if meta.status == VideoStatus::Cancelled {
        tracing::info!(%video_id, "download job was cancelled before it started; skipping");
        hub.publish(
            &video_id,
            JobEvent::Status {
                status: VideoStatus::Cancelled,
            },
        );
        return;
    }

    meta.status = VideoStatus::Downloading;
    meta.last_stage = Some(Stage::Download);
    meta.last_error = None;
    persist(store, &meta).await;
    hub.publish(
        &video_id,
        JobEvent::Status {
            status: VideoStatus::Downloading,
        },
    );

    let metadata = match ytdlp.fetch_metadata(&url).await {
        Ok(m) => m,
        Err(err) => {
            fail_job(store, hub, &mut meta, Stage::Download, err.to_string()).await;
            return;
        }
    };

    meta.title = metadata.title;
    meta.channel = metadata.channel;
    meta.duration_ms = metadata.duration_ms;
    if !metadata.video_id.is_empty() && metadata.video_id != meta.video_id {
        tracing::warn!(
            expected = %meta.video_id,
            actual = %metadata.video_id,
            "yt-dlp resolved a different video id than the URL-derived one"
        );
    }

    // The per-video quality picker (add-to-queue form): `meta.max_height`
    // is `None` for old/non-form videos (falls through to `ytdlp`'s own
    // configured default, unchanged behavior), `Some(0)` for "best
    // available" (uncapped), or `Some(h)` for an explicit cap.
    let format = YtDlp::format_for_max_height(meta.max_height, ytdlp.default_format());

    let video_path = store.video_path(&video_id);
    let video_id_for_cb = video_id.clone();
    let download_result = ytdlp
        .download_video(&url, &video_path, &format, move |event| match event {
            ProgressEvent::Percent(pct) => {
                hub.publish(
                    &video_id_for_cb,
                    JobEvent::Progress {
                        stage: Stage::Download,
                        pct,
                    },
                );
            }
            ProgressEvent::Log(line) => {
                hub.publish(&video_id_for_cb, JobEvent::Log { line });
            }
        })
        .await;

    if let Err(err) = download_result {
        fail_job(store, hub, &mut meta, Stage::Download, err.to_string()).await;
        return;
    }

    // Audio extraction is for the future Whisper step (Phase 2) and must
    // never block marking the video as downloaded/usable.
    let audio_path = store.audio_path(&video_id);
    if let Err(err) = ytdlp.extract_audio(&video_path, &audio_path).await {
        tracing::warn!(%video_id, %err, "audio extraction failed (non-fatal)");
        hub.publish(
            &video_id,
            JobEvent::Log {
                line: format!("audio extraction failed (non-fatal): {err}"),
            },
        );
    }

    // Manual source-language + Chinese CC, fetched in one pass (dsd.md
    // §12.4/§12.5/§12.7 B5.5): reference_lyrics > manual source CC > Whisper
    // ASR for the source track, and a manual Chinese CC lets the worker skip
    // the LLM translate call entirely. Mirrors audio extraction above -- a
    // fetch failure, or the video simply having no manual captions in either
    // language (the normal outcome for most videos), must never block
    // marking it downloaded/usable; the pipeline just falls back to Whisper
    // ASR / LLM translation as needed.
    let cc_path = store.cc_path(&video_id);
    let target_cc_path = store.target_cc_path(&video_id);
    let source_lang = meta.source_lang.clone().unwrap_or_else(|| "ja".to_string());
    match ytdlp
        .fetch_captions(&url, &cc_path, &target_cc_path, &source_lang)
        .await
    {
        Ok((source_cc_lang, target_found)) => {
            tracing::info!(
                %video_id, %source_lang, ?source_cc_lang, target_found,
                "manual CC fetch done (which source-CC language landed?, Chinese CC found?)"
            );
            // Persist the ACTUAL source-CC language so the pipeline feeds it
            // (not the selected `source_lang`) to the worker: they differ when
            // the selected language had no manual CC but an en/ja one did
            // (dsd.md §12.7's ASR-skip broadening). `None` when no source CC
            // landed -- the pipeline then runs Whisper against `source_lang`.
            meta.source_cc_lang = source_cc_lang;
        }
        Err(err) => {
            tracing::warn!(%video_id, %source_lang, %err, "manual CC fetch failed (non-fatal)");
            hub.publish(
                &video_id,
                JobEvent::Log {
                    line: format!("manual CC fetch failed (non-fatal): {err}"),
                },
            );
        }
    }

    // Poster thumbnail for the video library grid. Same non-fatal contract as
    // audio extraction / CC above: a failure (or a video with no fetchable
    // thumbnail) must never block marking it downloaded/usable.
    let thumbnail_path = store.thumbnail_path(&video_id);
    match ytdlp.fetch_thumbnail(&url, &thumbnail_path).await {
        Ok(true) => tracing::info!(%video_id, "saved poster thumbnail"),
        Ok(false) => tracing::info!(%video_id, "no thumbnail available for this video"),
        Err(err) => {
            tracing::warn!(%video_id, %err, "thumbnail fetch failed (non-fatal)");
        }
    }

    meta.status = VideoStatus::Downloaded;
    meta.last_error = None;
    persist(store, &meta).await;

    hub.publish(
        &video_id,
        JobEvent::Done {
            status: VideoStatus::Downloaded,
        },
    );

    // Chain straight into the AI subtitle pipeline (ASR -> tokenize ->
    // romaji -> translate -> assemble) on the same single-worker task, so
    // download and pipeline stay serialized end to end for one video
    // without a second enqueue round-trip (dsd.md §6.1, B2.6).
    if auto_pipeline {
        // Use whatever generation options this item was queued with
        // (`POST /api/videos`'s `is_music_video`/whisper/VAD/prompt
        // choices), falling back to defaults for callers that never set
        // `queued_options` (e.g. any future non-HTTP caller).
        let overrides = meta.queued_options.clone().unwrap_or_default();
        orchestrator::run_pipeline(
            store,
            hub,
            rpc,
            &video_id,
            whisper_model,
            whisper_temperature,
            compute_type,
            device,
            false,
            &overrides,
        )
        .await;
    }
}

async fn fail_job(
    store: &FsStore,
    hub: &EventHub,
    meta: &mut VideoMeta,
    stage: Stage,
    message: String,
) {
    meta.status = VideoStatus::DownloadFailed;
    meta.last_stage = Some(stage);
    meta.last_error = Some(message.clone());
    persist(store, meta).await;
    tracing::error!(video_id = %meta.video_id, ?stage, %message, "download job failed");
    hub.publish(&meta.video_id, JobEvent::Error { stage, message });
}

async fn persist(store: &FsStore, meta: &VideoMeta) {
    if let Err(err) = store.save_meta(meta).await {
        tracing::error!(video_id = %meta.video_id, %err, "failed to persist meta.json");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::downloader::YtDlp;
    use crate::core::pipeline::rpc::RpcClient;

    /// A fresh throwaway data dir under the OS temp dir, cleaned up on drop
    /// (mirrors `orchestrator::tests::TempDataDir`).
    struct TempDataDir(std::path::PathBuf);

    impl TempDataDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("rj-player-queue-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create temp data dir");
            Self(dir)
        }
    }

    impl Drop for TempDataDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn process_download_job_skips_a_cancelled_item_before_downloading() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        // Deliberately-bogus binaries/paths: the test only passes if
        // `process_download_job` returns before ever calling `ytdlp` or
        // `rpc`, so invoking either of these would be the failure signal.
        let ytdlp = YtDlp::new("rj-player-test-nonexistent-yt-dlp", "rj-player-test-nonexistent-ffmpeg", "best");
        let rpc = RpcClient::new(
            "rj-player-test-nonexistent-python",
            "rj-player-test-nonexistent-worker.py",
        );

        let video_id = "cancelled01".to_string();
        let mut meta = VideoMeta::new(video_id.clone(), "https://youtu.be/cancelled01".to_string());
        meta.status = VideoStatus::Cancelled;
        store.save_meta(&meta).await.unwrap();

        process_download_job(
            &store, &hub, &ytdlp, &rpc, "small", 0.0, "int8", "cpu", video_id.clone(), meta.source_url.clone(), true,
        )
        .await;

        let reloaded = store.load_meta(&video_id).await.unwrap().unwrap();
        assert_eq!(reloaded.status, VideoStatus::Cancelled, "status must stay Cancelled, not flip to Downloading");
    }

    #[test]
    fn video_meta_with_queued_options_round_trips_through_json() {
        let mut meta = VideoMeta::new("roundtrip01".to_string(), "https://youtu.be/roundtrip01".to_string());
        meta.is_music_video = true;
        meta.queued_options = Some(PipelineOverrides {
            whisper_model: Some("large-v3".to_string()),
            whisper_temperature: Some(0.2),
            initial_prompt: Some("test prompt".to_string()),
            vad: VadOverrides {
                enabled: Some(true),
                threshold: Some(0.5),
                min_silence_duration_ms: Some(500),
                speech_pad_ms: Some(200),
                max_speech_duration_s: Some(20.0),
            },
            reference_lyrics: None,
        });

        let json = serde_json::to_string(&meta).expect("serialize");
        let restored: VideoMeta = serde_json::from_str(&json).expect("deserialize");

        assert!(restored.is_music_video);
        let options = restored.queued_options.expect("queued_options should round-trip");
        assert_eq!(options.whisper_model.as_deref(), Some("large-v3"));
        assert_eq!(options.vad.min_silence_duration_ms, Some(500));
    }

    #[test]
    fn old_shape_meta_json_without_new_fields_still_deserializes() {
        // Simulates a `meta.json` written by a version of this app before
        // `is_music_video`/`queued_options` existed -- must keep loading
        // thanks to `#[serde(default)]` on both fields.
        let old_json = r#"{
            "video_id": "legacy0001",
            "source_url": "https://youtu.be/legacy0001",
            "title": "Legacy Video",
            "channel": "Legacy Channel",
            "duration_ms": 1000,
            "status": "ready",
            "last_stage": null,
            "last_error": null,
            "created_at": "2024-01-01T00:00:00Z"
        }"#;

        let meta: VideoMeta = serde_json::from_str(old_json).expect("old-shape meta.json must still deserialize");
        assert!(!meta.is_music_video);
        assert!(meta.queued_options.is_none());
    }
}
