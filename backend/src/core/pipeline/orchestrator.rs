//! Drives `audio.wav` through the Python AI worker to a canonical
//! `subtitles.json` (dsd.md §2, §6.1, §7, B2.6).
//!
//! Caching (dsd.md §5.1/§7): if `subtitles.json` already exists for a video
//! and its `version` matches [`SUBTITLE_DOC_VERSION`], the pipeline is
//! skipped unless `force` is set — `video_id` is the cache key.
//!
//! Failure isolation (dsd.md §7): every error path here (worker crash,
//! malformed output, missing audio, disk I/O) is caught and turned into a
//! `pipeline_failed` status + WS error event; nothing here ever panics the
//! job-queue worker task, so one bad video can't take down the backend or
//! block subsequent jobs.

use crate::core::domain::{
    JobEvent, Stage, SubtitleDoc, VideoMeta, VideoStatus, SUBTITLE_DOC_VERSION,
};
use crate::core::pipeline::hub::EventHub;
use crate::core::pipeline::queue::PipelineOverrides;
use crate::core::pipeline::rpc::{
    GenerateSubtitlesParams, RetranslateParams, RpcClient, RpcError, VadParams, WorkerProgress,
};
use crate::core::store::FsStore;

/// Map a pipeline `Stage` (as reported by the worker) onto the coarser
/// `VideoStatus` state machine (dsd.md §5.3). The status machine has no
/// distinct "romaji" state, so `Stage::Romaji` folds into `Tokenizing` —
/// both are part of the same linguistic-analysis leg from the status
/// machine's point of view. `Stage::Download` never reaches here (it's
/// handled entirely by `queue::process_download_job` before the pipeline
/// starts) but is included so the mapping stays total.
fn status_for_stage(stage: Stage) -> VideoStatus {
    match stage {
        Stage::Download => VideoStatus::Downloading,
        Stage::Asr => VideoStatus::Transcribing,
        Stage::Tokenize | Stage::Romaji => VideoStatus::Tokenizing,
        Stage::Translate => VideoStatus::Translating,
        Stage::Assemble => VideoStatus::Assembling,
    }
}

/// Run (or skip, on a cache hit) the subtitle pipeline for one video.
///
/// `source_lang`/`target_lang` are fixed to `ja`/`zh-TW` per the current
/// scope (dsd.md's `generate_subtitles` example params); `whisper_model`
/// and `whisper_temperature` are the *config* defaults (`WHISPER_MODEL` /
/// `WHISPER_TEMPERATURE`) so they can be swapped without a rebuild.
/// `overrides` carries any per-request generation-knob overrides from
/// `POST /api/videos/:id/pipeline`'s JSON body — each `Some` field in it
/// wins over the corresponding config default; every `None` field (which is
/// all of them for the auto-pipeline-after-download path, per
/// `PipelineOverrides::default()`) falls back to `whisper_model`/
/// `whisper_temperature` above, or to `ai/pipeline/asr.py`'s own baked-in
/// defaults for `initial_prompt`/`vad`.
#[allow(clippy::too_many_arguments)]
pub async fn run_pipeline(
    store: &FsStore,
    hub: &EventHub,
    rpc: &RpcClient,
    video_id: &str,
    whisper_model: &str,
    whisper_temperature: f32,
    force: bool,
    overrides: &PipelineOverrides,
) {
    if !force {
        match store.load_subtitles(video_id).await {
            Ok(Some(doc)) if doc.version == SUBTITLE_DOC_VERSION => {
                tracing::info!(%video_id, "subtitles.json cache hit, skipping pipeline");
                mark_ready_from_cache(store, hub, video_id).await;
                return;
            }
            Ok(Some(doc)) => {
                tracing::info!(
                    %video_id,
                    cached_version = doc.version,
                    current_version = SUBTITLE_DOC_VERSION,
                    "cached subtitles.json is a stale schema version, regenerating"
                );
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(%video_id, %err, "failed reading cached subtitles.json, will regenerate");
            }
        }
    }

    let mut meta = match store.load_meta(video_id).await {
        Ok(Some(m)) => m,
        Ok(None) => {
            tracing::error!(%video_id, "run_pipeline called for a video with no meta.json; skipping");
            return;
        }
        Err(err) => {
            tracing::error!(%video_id, %err, "failed to load meta.json before running pipeline; skipping");
            return;
        }
    };

    let audio_path = store.audio_path(video_id);
    if !audio_path.exists() {
        fail(
            store,
            hub,
            &mut meta,
            Stage::Asr,
            "audio.wav not found; cannot run pipeline".to_string(),
            None,
        )
        .await;
        return;
    }

    meta.status = VideoStatus::Transcribing;
    meta.last_stage = Some(Stage::Asr);
    meta.last_error = None;
    persist(store, &meta).await;
    hub.publish(
        video_id,
        JobEvent::Status {
            status: VideoStatus::Transcribing,
        },
    );

    // Effective value = per-request override, falling back to the config
    // default (dsd.md's per-request "regenerate" contract). `initial_prompt`
    // has no config default to fall back to — an omitted or empty-string
    // override means "no initial prompt", matching asr.py's own default —
    // and the 4 `vad` knobs fall straight through to asr.py's baked-in
    // defaults for whichever ones stay `None`.
    let effective_whisper_model = overrides
        .whisper_model
        .clone()
        .unwrap_or_else(|| whisper_model.to_string());
    let effective_whisper_temperature = overrides.whisper_temperature.unwrap_or(whisper_temperature);
    let effective_initial_prompt = overrides
        .initial_prompt
        .clone()
        .filter(|prompt| !prompt.is_empty());
    // Empty/whitespace-only reference lyrics collapse to None, same as
    // `initial_prompt` above -- "no reference lyrics" either way, so the ASR
    // stage falls through to its normal free-transcription path.
    let effective_reference_lyrics = overrides
        .reference_lyrics
        .clone()
        .filter(|lyrics| !lyrics.trim().is_empty());

    // Manual Japanese CC, fetched at download time (`YtDlp::fetch_manual_ja_subs`)
    // when the uploader supplied one. Passed through whenever it exists,
    // regardless of `reference_lyrics` -- `ai/worker.py` enforces the actual
    // precedence (reference_lyrics > CC > Whisper ASR), so this orchestrator
    // doesn't need to duplicate that decision.
    let cc_path = if store.cc_exists(video_id) {
        Some(store.cc_path(video_id).to_string_lossy().to_string())
    } else {
        None
    };

    let params = GenerateSubtitlesParams {
        video_id: video_id.to_string(),
        audio_path: audio_path.to_string_lossy().to_string(),
        source_lang: "ja".to_string(),
        whisper_model: effective_whisper_model,
        whisper_temperature: effective_whisper_temperature,
        translate: true,
        target_lang: "zh-TW".to_string(),
        initial_prompt: effective_initial_prompt,
        vad: VadParams {
            enabled: overrides.vad.enabled,
            threshold: overrides.vad.threshold,
            min_silence_duration_ms: overrides.vad.min_silence_duration_ms,
            speech_pad_ms: overrides.vad.speech_pad_ms,
            max_speech_duration_s: overrides.vad.max_speech_duration_s,
        },
        reference_lyrics: effective_reference_lyrics,
        cc_path,
    };

    let result = rpc
        .generate_subtitles(params, |event| match event {
            WorkerProgress::Stage(stage) => {
                hub.publish(
                    video_id,
                    JobEvent::Status {
                        status: status_for_stage(stage),
                    },
                );
            }
            WorkerProgress::Progress { stage, pct } => {
                hub.publish(video_id, JobEvent::Progress { stage, pct });
            }
            WorkerProgress::Partial(doc) => {
                // ASR/tokenize/romaji are done; translate (a separate LLM
                // round-trip that can retry for a while) hasn't started yet.
                // Persist NOW instead of waiting for the terminal event, so
                // that work is never at risk regardless of how translate
                // goes. `on_progress` is a sync callback (see rpc.rs), so
                // the actual write is spawned rather than awaited here —
                // it's a small JSON file, done in the time translate takes
                // to make even its first network call.
                let store = store.clone();
                let video_id = video_id.to_string();
                tokio::spawn(async move {
                    match store.save_subtitles(&doc).await {
                        Ok(()) => tracing::info!(
                            %video_id,
                            "persisted pre-translate subtitles.json snapshot"
                        ),
                        Err(err) => tracing::warn!(
                            %video_id, %err,
                            "failed to persist pre-translate subtitles.json snapshot"
                        ),
                    }
                });
            }
        })
        .await;

    match result {
        Ok(doc) => {
            if let Err(err) = store.save_subtitles(&doc).await {
                fail(
                    store,
                    hub,
                    &mut meta,
                    Stage::Assemble,
                    format!("failed to write subtitles.json: {err}"),
                    None,
                )
                .await;
                return;
            }
            meta.status = VideoStatus::Ready;
            meta.last_stage = Some(Stage::Assemble);
            meta.last_error = None;
            persist(store, &meta).await;
            hub.publish(
                video_id,
                JobEvent::Done {
                    status: VideoStatus::Ready,
                },
            );
            tracing::info!(%video_id, "pipeline complete, subtitles ready");
        }
        Err(RpcError::Worker {
            stage,
            message,
            partial,
        }) => {
            fail(
                store,
                hub,
                &mut meta,
                stage.unwrap_or(Stage::Assemble),
                message,
                partial.map(|b| *b),
            )
            .await;
        }
        Err(err) => {
            // Worker crash / EOF / malformed output / I/O error talking to
            // the subprocess. `RpcClient` has already dropped its process
            // handle so the *next* job lazily respawns a fresh worker
            // (dsd.md §7) — nothing further to do here besides recording
            // the failure.
            let last_stage = meta.last_stage.unwrap_or(Stage::Asr);
            fail(store, hub, &mut meta, last_stage, err.to_string(), None).await;
        }
    }
}

/// Re-run ONLY the translate stage against the video's existing
/// `subtitles.json` — no ASR (dsd.md §7 extended: retry translation without
/// redoing the slow/expensive Whisper pass). Requires a `subtitles.json` to
/// already exist (from a prior full pipeline run, `run_pipeline`'s
/// pre-translate snapshot, or an earlier retranslate) — there's nothing to
/// re-translate otherwise.
pub async fn run_retranslate(store: &FsStore, hub: &EventHub, rpc: &RpcClient, video_id: &str) {
    let mut meta = match store.load_meta(video_id).await {
        Ok(Some(m)) => m,
        Ok(None) => {
            tracing::error!(%video_id, "run_retranslate called for a video with no meta.json; skipping");
            return;
        }
        Err(err) => {
            tracing::error!(%video_id, %err, "failed to load meta.json before retranslating; skipping");
            return;
        }
    };

    let existing = match store.load_subtitles(video_id).await {
        Ok(Some(doc)) => doc,
        Ok(None) => {
            fail(
                store,
                hub,
                &mut meta,
                Stage::Translate,
                "no existing subtitles.json to retranslate".to_string(),
                None,
            )
            .await;
            return;
        }
        Err(err) => {
            fail(
                store,
                hub,
                &mut meta,
                Stage::Translate,
                format!("failed to read subtitles.json: {err}"),
                None,
            )
            .await;
            return;
        }
    };

    meta.status = VideoStatus::Translating;
    meta.last_stage = Some(Stage::Translate);
    meta.last_error = None;
    persist(store, &meta).await;
    hub.publish(
        video_id,
        JobEvent::Status {
            status: VideoStatus::Translating,
        },
    );

    let params = RetranslateParams {
        video_id: video_id.to_string(),
        source_lang: existing.language_source.clone(),
        target_lang: existing.target_lang.clone(),
        duration_ms: existing.duration_ms,
        cues: existing.cues.clone(),
        source: existing.source.clone(),
    };

    let result = rpc
        .retranslate(params, |event| match event {
            WorkerProgress::Stage(stage) => {
                hub.publish(
                    video_id,
                    JobEvent::Status {
                        status: status_for_stage(stage),
                    },
                );
            }
            WorkerProgress::Progress { stage, pct } => {
                hub.publish(video_id, JobEvent::Progress { stage, pct });
            }
            // `retranslate` has no ASR/romaji stage before it to snapshot —
            // the worker never emits this event for this method.
            WorkerProgress::Partial(_) => {}
        })
        .await;

    match result {
        Ok(doc) => {
            if let Err(err) = store.save_subtitles(&doc).await {
                fail(
                    store,
                    hub,
                    &mut meta,
                    Stage::Assemble,
                    format!("failed to write subtitles.json: {err}"),
                    None,
                )
                .await;
                return;
            }
            meta.status = VideoStatus::Ready;
            meta.last_stage = Some(Stage::Assemble);
            meta.last_error = None;
            persist(store, &meta).await;
            hub.publish(
                video_id,
                JobEvent::Done {
                    status: VideoStatus::Ready,
                },
            );
            tracing::info!(%video_id, "retranslate complete, subtitles ready");
        }
        Err(RpcError::Worker {
            stage,
            message,
            partial,
        }) => {
            fail(
                store,
                hub,
                &mut meta,
                stage.unwrap_or(Stage::Translate),
                message,
                partial.map(|b| *b),
            )
            .await;
        }
        Err(err) => {
            fail(store, hub, &mut meta, Stage::Translate, err.to_string(), None).await;
        }
    }
}

/// A cache hit still needs `meta.json` nudged to `ready` in case it was
/// left in an earlier in-progress/failed state from a prior run.
async fn mark_ready_from_cache(store: &FsStore, hub: &EventHub, video_id: &str) {
    if let Ok(Some(mut meta)) = store.load_meta(video_id).await {
        if meta.status != VideoStatus::Ready {
            meta.status = VideoStatus::Ready;
            meta.last_stage = Some(Stage::Assemble);
            meta.last_error = None;
            persist(store, &meta).await;
        }
    }
    hub.publish(
        video_id,
        JobEvent::Done {
            status: VideoStatus::Ready,
        },
    );
}

async fn fail(
    store: &FsStore,
    hub: &EventHub,
    meta: &mut VideoMeta,
    stage: Stage,
    message: String,
    partial: Option<SubtitleDoc>,
) {
    if let Some(doc) = partial {
        // Persisted for forensics/future-resume (dsd.md §7's spirit of not
        // throwing away completed work), but `GET /subtitles` still gates
        // on `status == ready`, so a partial doc on disk never gets served
        // as if the pipeline had succeeded.
        if let Err(err) = store.save_subtitles(&doc).await {
            tracing::warn!(video_id = %meta.video_id, %err, "failed to persist partial subtitles.json");
        } else {
            tracing::info!(video_id = %meta.video_id, "persisted partial subtitles.json from a failed pipeline run");
        }
    }

    meta.status = VideoStatus::PipelineFailed;
    meta.last_stage = Some(stage);
    meta.last_error = Some(message.clone());
    persist(store, meta).await;
    tracing::error!(video_id = %meta.video_id, ?stage, %message, "pipeline job failed");
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
    use std::path::PathBuf;

    use crate::core::domain::subtitle::JaToken;
    use crate::core::domain::{Cue, VideoMeta};

    fn stub_worker_path() -> String {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/stub_worker.py")
            .to_string_lossy()
            .to_string()
    }

    /// A fresh throwaway data dir under the OS temp dir, cleaned up when the
    /// returned guard drops. Hand-rolled instead of pulling in a `tempfile`
    /// dev-dependency, since this is the only place that needs one.
    struct TempDataDir(std::path::PathBuf);

    impl TempDataDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("rj-player-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create temp data dir");
            Self(dir)
        }
    }

    impl Drop for TempDataDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn seed_video(store: &FsStore, video_id: &str, status: VideoStatus) {
        store.ensure_video_dir(video_id).await.unwrap();
        // audio.wav just needs to exist; the stub worker never reads it.
        tokio::fs::write(store.audio_path(video_id), b"fake wav bytes")
            .await
            .unwrap();
        let mut meta = VideoMeta::new(video_id.to_string(), format!("https://youtu.be/{video_id}"));
        meta.status = status;
        meta.title = "Test Video".to_string();
        meta.channel = "Test Channel".to_string();
        meta.duration_ms = 2500;
        store.save_meta(&meta).await.unwrap();
    }

    #[tokio::test]
    async fn success_path_writes_subtitles_json_and_marks_ready() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "abc12345678", VideoStatus::Downloaded).await;

        run_pipeline(&store, &hub, &rpc, "abc12345678", "small", 0.0, false, &PipelineOverrides::default())
            .await;

        let meta = store.load_meta("abc12345678").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
        assert_eq!(meta.last_error, None);

        let doc = store
            .load_subtitles("abc12345678")
            .await
            .unwrap()
            .expect("subtitles.json should have been written");
        assert_eq!(doc.video_id, "abc12345678");
        assert_eq!(doc.cues.len(), 1);
    }

    /// The pre-translate snapshot (`WorkerProgress::Partial` handling in
    /// `run_pipeline`) must land on disk WHILE translate is still running,
    /// not just as a side effect of the job eventually finishing — that's
    /// the whole point (don't lose ASR work to a stuck/slow translate). The
    /// `slow_translate` stub mode sleeps 200ms between emitting the
    /// snapshot and its final result, giving this test a window to observe
    /// the snapshot (zh_text still null) before the job completes.
    #[tokio::test]
    async fn pretranslate_snapshot_is_persisted_before_the_job_finishes() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::with_args(
            "python3",
            vec![stub_worker_path(), "slow_translate".to_string()],
        );

        seed_video(&store, "slowvideo001", VideoStatus::Downloaded).await;

        let store_for_job = store.clone();
        let handle = tokio::spawn(async move {
            run_pipeline(
                &store_for_job,
                &hub,
                &rpc,
                "slowvideo001",
                "small",
                0.0,
                false,
                &PipelineOverrides::default(),
            )
            .await;
        });

        let mut saw_snapshot = false;
        for _ in 0..50 {
            if let Ok(Some(doc)) = store.load_subtitles("slowvideo001").await {
                if !doc.cues.is_empty() && doc.cues[0].zh_text.is_none() {
                    saw_snapshot = true;
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            saw_snapshot,
            "expected the pre-translate snapshot (zh_text: null) to be persisted \
             to subtitles.json before the job finished"
        );

        handle.await.expect("run_pipeline task panicked");

        let final_doc = store
            .load_subtitles("slowvideo001")
            .await
            .unwrap()
            .expect("final subtitles.json should exist");
        assert_eq!(final_doc.cues[0].zh_text.as_deref(), Some("你好"));
        let meta = store.load_meta("slowvideo001").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
    }

    #[tokio::test]
    async fn retranslate_reuses_existing_cues_and_marks_ready() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "retranslate01", VideoStatus::PipelineFailed).await;
        let existing = SubtitleDoc {
            version: SUBTITLE_DOC_VERSION,
            video_id: "retranslate01".to_string(),
            language_source: "ja".to_string(),
            target_lang: "zh-TW".to_string(),
            duration_ms: 2500,
            cues: vec![Cue {
                id: 0,
                start_ms: 0,
                end_ms: 2500,
                ja_text: "こんにちは".to_string(),
                ja_tokens: vec![JaToken {
                    t: "こんにちは".to_string(),
                    reading: None,
                }],
                romaji: "konnichiwa".to_string(),
                zh_text: None,
            }],
            translate_partial: Some(true),
            source: Some("asr".to_string()),
        };
        store.save_subtitles(&existing).await.unwrap();

        run_retranslate(&store, &hub, &rpc, "retranslate01").await;

        let meta = store.load_meta("retranslate01").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
        assert_eq!(meta.last_error, None);

        let doc = store.load_subtitles("retranslate01").await.unwrap().unwrap();
        // ja_text/ja_tokens/romaji/timing pass through untouched -- only
        // zh_text (the stub's canned "STUB:<ja_text>") changes.
        assert_eq!(doc.cues[0].ja_text, "こんにちは");
        assert_eq!(doc.cues[0].romaji, "konnichiwa");
        assert_eq!(doc.cues[0].zh_text.as_deref(), Some("STUB:こんにちは"));
    }

    #[tokio::test]
    async fn retranslate_fails_cleanly_without_existing_subtitles() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "noexisting001", VideoStatus::Downloaded).await;
        // Deliberately no subtitles.json written.

        run_retranslate(&store, &hub, &rpc, "noexisting001").await;

        let meta = store.load_meta("noexisting001").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::PipelineFailed);
        assert!(meta
            .last_error
            .unwrap()
            .contains("no existing subtitles.json"));
    }

    #[tokio::test]
    async fn cc_srt_presence_is_passed_through_without_breaking_pipeline() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "ccvideo0001", VideoStatus::Downloaded).await;
        assert!(!store.cc_exists("ccvideo0001"));

        tokio::fs::write(
            store.cc_path("ccvideo0001"),
            "1\n00:00:00,000 --> 00:00:01,000\nこんにちは\n\n",
        )
        .await
        .unwrap();
        assert!(store.cc_exists("ccvideo0001"));

        // The stub worker doesn't care about `cc_path` at all -- this just
        // proves `run_pipeline` computing/threading it through
        // `GenerateSubtitlesParams` (via `store.cc_exists`/`store.cc_path`)
        // doesn't break the otherwise-unchanged success path.
        run_pipeline(
            &store,
            &hub,
            &rpc,
            "ccvideo0001",
            "small",
            0.0,
            false,
            &PipelineOverrides::default(),
        )
        .await;

        let meta = store.load_meta("ccvideo0001").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
        assert_eq!(meta.last_error, None);
    }

    #[tokio::test]
    async fn cache_hit_skips_pipeline_without_calling_worker() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        // Point at a nonexistent interpreter: if the pipeline tried to spawn
        // a worker at all, this would fail loudly, proving the cache check
        // short-circuits before ever touching the RPC client.
        let rpc = RpcClient::new("/nonexistent/python-should-not-be-invoked", "worker.py");

        seed_video(&store, "cachedvideo1", VideoStatus::Downloaded).await;
        let doc = SubtitleDoc {
            version: SUBTITLE_DOC_VERSION,
            video_id: "cachedvideo1".to_string(),
            language_source: "ja".to_string(),
            target_lang: "zh-TW".to_string(),
            duration_ms: 1000,
            cues: vec![],
            translate_partial: None,
            source: None,
        };
        store.save_subtitles(&doc).await.unwrap();

        run_pipeline(&store, &hub, &rpc, "cachedvideo1", "small", 0.0, false, &PipelineOverrides::default())
            .await;

        let meta = store.load_meta("cachedvideo1").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
    }

    #[tokio::test]
    async fn worker_crash_marks_pipeline_failed_without_panicking() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::with_args(
            "python3",
            vec![stub_worker_path(), "crash_before_reply".to_string()],
        );

        seed_video(&store, "crashvideo01", VideoStatus::Downloaded).await;

        // If this panicked, the #[tokio::test] itself would fail loudly —
        // the assertions below additionally confirm the *specific*
        // failure-isolation contract (dsd.md §7): status flips to
        // pipeline_failed with a recorded error, nothing left half-written.
        run_pipeline(&store, &hub, &rpc, "crashvideo01", "small", 0.0, false, &PipelineOverrides::default())
            .await;

        let meta = store.load_meta("crashvideo01").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::PipelineFailed);
        assert!(meta.last_error.is_some());

        // The backend (this test process, standing in for it) is still
        // alive and the store/hub are still fully usable afterwards.
        assert!(store
            .load_subtitles("crashvideo01")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn missing_audio_file_fails_cleanly() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        // Seed meta.json but skip writing audio.wav.
        let mut meta = VideoMeta::new(
            "noaudiovid1".to_string(),
            "https://youtu.be/noaudiovid1".to_string(),
        );
        meta.status = VideoStatus::Downloaded;
        store.save_meta(&meta).await.unwrap();

        run_pipeline(&store, &hub, &rpc, "noaudiovid1", "small", 0.0, false, &PipelineOverrides::default())
            .await;

        let meta = store.load_meta("noaudiovid1").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::PipelineFailed);
        assert!(meta.last_error.unwrap().contains("audio.wav"));
    }
}
