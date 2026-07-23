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
use crate::core::downloader::YtDlp;
use crate::core::pipeline::hub::EventHub;
use crate::core::pipeline::queue::PipelineOverrides;
use crate::core::pipeline::rpc::{
    GenerateSubtitlesParams, RetranslateParams, RpcClient, RpcError, VadParams, WorkerProgress,
};
use crate::core::store::FsStore;

/// Resolve an `auto`/`off`/`always` music-feature policy (Demucs vocal
/// separation, LLM lyrics polish) into an on/off decision for one run.
///
/// Precedence (dsd.md §13.7-style global knob + the per-request "regenerate"
/// contract):
///   1. a global policy of `"off"` is a hard kill-switch — even an explicit
///      per-request `Some(true)` can't turn the feature on (the escape
///      hatch if the feature misbehaves, and for separation the way to stay
///      entirely demucs-free: the worker never even imports it);
///   2. otherwise a per-request override (`Some(_)`) wins;
///   3. otherwise `"always"` → on, and `"auto"` (or any unrecognized
///      value) → follow `meta.is_music_video`.
///
/// Pure function so the precedence table is directly unit-testable.
fn effective_auto_policy(
    policy: &str,
    request_override: Option<bool>,
    is_music_video: bool,
) -> bool {
    match policy {
        "off" => false,
        "always" => request_override.unwrap_or(true),
        _ => request_override.unwrap_or(is_music_video),
    }
}

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
/// `source_lang` is read from the video's persisted `meta.source_lang`
/// (dsd.md §12.2/§12.5), defaulting to `"ja"` when absent -- old
/// `meta.json` files and any caller that never set it -- so today's
/// Japanese-only behavior stays byte-identical. `target_lang` stays fixed
/// to `zh-TW` per the current scope. `whisper_model`, `whisper_temperature`,
/// `compute_type`, and `device` are the *config* defaults (`WHISPER_MODEL` /
/// `WHISPER_TEMPERATURE` / `WHISPER_COMPUTE_TYPE` / `WHISPER_DEVICE`, dsd.md
/// §13.7) so they can be swapped without a rebuild. `compute_type`/`device`
/// have no per-request override today (unlike the other two) -- §13.7 scopes
/// them as global settings-page knobs only, not something the per-video
/// generation popover exposes.
/// `overrides` carries any per-request generation-knob overrides from
/// `POST /api/videos/:id/pipeline`'s JSON body — each `Some` field in it
/// wins over the corresponding config default; every `None` field (which is
/// all of them for the auto-pipeline-after-download path, per
/// `PipelineOverrides::default()`) falls back to `whisper_model`/
/// `whisper_temperature` above, or to `ai/pipeline/asr.py`'s own baked-in
/// defaults for `initial_prompt`/`vad`.
/// `ytdlp` is only used for its ffmpeg wrapper (`extract_audio_hq`), and only
/// when vocal separation is actually on for this run; `vocal_separation` and
/// `lyrics_polish` are the global policy strings
/// (`Config::live_vocal_separation` / `Config::live_lyrics_polish`) resolved
/// against the corresponding per-request override + `meta.is_music_video` by
/// [`effective_auto_policy`].
#[allow(clippy::too_many_arguments)]
pub async fn run_pipeline(
    store: &FsStore,
    hub: &EventHub,
    rpc: &RpcClient,
    ytdlp: &YtDlp,
    video_id: &str,
    whisper_model: &str,
    whisper_temperature: f32,
    compute_type: &str,
    device: &str,
    vocal_separation: &str,
    lyrics_polish: &str,
    vocal_energy_gate: &str,
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

    // The user-selected source language (persisted at add time); "ja" for old
    // on-disk metas / callers that never sent one.
    let source_lang = meta.source_lang.clone().unwrap_or_else(|| "ja".to_string());

    // Manual source CC, fetched at download time (`YtDlp::fetch_captions`) and
    // used as the source transcript to skip Whisper. Use it ONLY when it's in
    // the selected source language: a CC in a *different* language (e.g. an
    // English CC on a `ja` video -- as an older buggy fetch could persist via a
    // stale `meta.source_cc_lang`) is a translation, not a transcript, and
    // would yield the wrong source text. On mismatch we drop the CC as the
    // source; the worker then either back-translates an official target
    // (Chinese) CC into `source_lang` (A3, when one exists + `source_lang` is a
    // reading language) or free-transcribes with Whisper -- see `ai/worker.py`.
    // A `None` `source_cc_lang` (videos from before that field existed) counts
    // as a match, since back then `cc.srt` was always the source_lang track.
    // This also lets a plain "重新產生字幕" fix an already-downloaded,
    // mis-sourced video without a re-download. Beyond this, `ai/worker.py`
    // enforces the full precedence (reference_lyrics > source CC > target-CC
    // back-translate > Whisper ASR).
    let source_cc_mismatches = meta
        .source_cc_lang
        .as_deref()
        .is_some_and(|cc| cc != source_lang.as_str());
    let cc_path = if !source_cc_mismatches && store.cc_exists(video_id) {
        Some(store.cc_path(video_id).to_string_lossy().to_string())
    } else {
        None
    };

    // Manual target-language (Chinese) CC, fetched at download time
    // (`YtDlp::fetch_captions`) when the uploader supplied one (dsd.md
    // §12.4/§12.5/§12.7 B5.5). When present, `ai/worker.py` time-overlap-
    // merges it onto the source timeline instead of calling the LLM, so a
    // video with both a source CC and a Chinese CC needs zero ASR AND zero
    // LLM calls.
    let target_cc_path = if store.target_cc_exists(video_id) {
        Some(store.target_cc_path(video_id).to_string_lossy().to_string())
    } else {
        None
    };

    // The source CC (`cc_path`) is only ever kept when it matches `source_lang`
    // (guarded above), so the worker's source language is simply `source_lang`
    // -- no more keying off a mismatched CC's language.
    let effective_source_lang = source_lang;

    // ---- Demucs vocal separation (global policy + per-request override) ----
    // When on, the worker transcribes a separated vocals track instead of the
    // raw mix. `vocals.wav` doubles as the cache: if a previous run already
    // separated this video, skip straight to it — no ffmpeg re-extract, no
    // Demucs re-run. Otherwise extract the 44.1kHz stereo Demucs input from
    // `video.mp4` here (the only place the original-quality track survives;
    // `audio.wav` is already downsampled to 16kHz mono). EVERY failure on
    // this path — video.mp4 gone, ffmpeg error — just logs and falls back to
    // the unseparated `audio.wav`: separation is a quality enhancer, never a
    // new way for the pipeline to fail.
    let vocals_path = store.vocals_path(video_id);
    let audio_hq_path = store.audio_hq_path(video_id);
    let mut separate_vocals =
        effective_auto_policy(vocal_separation, overrides.separate_vocals, meta.is_music_video);
    let mut audio_hq_for_worker: Option<String> = None;
    if separate_vocals && !vocals_path.exists() {
        let video_path = store.video_path(video_id);
        if !video_path.exists() {
            tracing::warn!(
                %video_id,
                "vocal separation requested but video.mp4 is missing; using the original audio"
            );
            separate_vocals = false;
        } else {
            match ytdlp.extract_audio_hq(&video_path, &audio_hq_path).await {
                Ok(()) => {
                    audio_hq_for_worker = Some(audio_hq_path.to_string_lossy().to_string());
                }
                Err(err) => {
                    tracing::warn!(
                        %video_id, %err,
                        "failed to extract 44.1kHz audio for vocal separation (non-fatal); using the original audio"
                    );
                    separate_vocals = false;
                }
            }
        }
    }

    let params = GenerateSubtitlesParams {
        video_id: video_id.to_string(),
        audio_path: audio_path.to_string_lossy().to_string(),
        source_lang: effective_source_lang,
        whisper_model: effective_whisper_model,
        whisper_temperature: effective_whisper_temperature,
        compute_type: compute_type.to_string(),
        device: device.to_string(),
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
        target_cc_path,
        separate_vocals,
        vocals_path: if separate_vocals {
            Some(vocals_path.to_string_lossy().to_string())
        } else {
            None
        },
        audio_hq_path: audio_hq_for_worker.clone(),
        lyrics_polish: effective_auto_policy(
            lyrics_polish,
            overrides.lyrics_polish,
            meta.is_music_video,
        ),
        // Context for the polish prompt — which song is being proofread.
        video_title: Some(meta.title.clone()).filter(|t| !t.is_empty()),
        video_channel: Some(meta.channel.clone()).filter(|c| !c.is_empty()),
        energy_gate: vocal_energy_gate.to_string(),
    };

    // The pre-translate snapshot write below is spawned (the progress
    // callback is sync), which left it UNORDERED relative to the terminal
    // save: on the target-CC merge path translate is near-instant, so the
    // snapshot task could be scheduled after the terminal save and clobber
    // the finished doc (target_text back to null) under a Ready status.
    // Keep the handle and await it before any terminal-path write.
    let snapshot_write: std::sync::Arc<std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let snapshot_write_slot = snapshot_write.clone();

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
                let handle = tokio::spawn(async move {
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
                *snapshot_write_slot
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(handle);
            }
        })
        .await;

    // Order the snapshot write (if one was spawned) before every terminal
    // write below — both the Ready save and the fail() partial save.
    let pending_snapshot = snapshot_write
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    if let Some(handle) = pending_snapshot {
        let _ = handle.await;
    }

    // `audio_hq.wav` is transient Demucs input (~80MB for a 4-minute song);
    // drop it as soon as the worker is done with it, success or failure —
    // only `vocals.wav` (the separation cache) is worth keeping. Checked by
    // existence rather than "did this run extract it" so a leftover from a
    // crashed earlier run (or a half-written ffmpeg output) gets swept too.
    if audio_hq_path.exists() {
        if let Err(err) = tokio::fs::remove_file(&audio_hq_path).await {
            tracing::warn!(%video_id, %err, "failed to remove transient audio_hq.wav");
        }
    }

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

    use crate::core::domain::subtitle::Token;
    use crate::core::domain::{Cue, VideoMeta};

    fn stub_worker_path() -> String {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/stub_worker.py")
            .to_string_lossy()
            .to_string()
    }

    /// A `YtDlp` whose binaries don't exist. Fine for every test here: its
    /// only use inside `run_pipeline` is `extract_audio_hq`, which is only
    /// reached when vocal separation is on for the run — and where a test
    /// does turn separation on, the nonexistent ffmpeg is exactly the
    /// failure being exercised (extraction must be non-fatal).
    fn test_ytdlp() -> YtDlp {
        YtDlp::new(
            "rj-player-test-nonexistent-yt-dlp",
            "rj-player-test-nonexistent-ffmpeg",
            "best",
        )
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

        run_pipeline(&store, &hub, &rpc, &test_ytdlp(), "abc12345678", "small", 0.0, "int8", "cpu", "auto", "off", "on", false, &PipelineOverrides::default())
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
    /// the snapshot (target_text still null) before the job completes.
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
                &test_ytdlp(),
                "slowvideo001",
                "small",
                0.0,
                "int8",
                "cpu",
                "auto",
                "off",
                "on",
                false,
                &PipelineOverrides::default(),
            )
            .await;
        });

        let mut saw_snapshot = false;
        for _ in 0..50 {
            if let Ok(Some(doc)) = store.load_subtitles("slowvideo001").await {
                if !doc.cues.is_empty() && doc.cues[0].target_text.is_none() {
                    saw_snapshot = true;
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            saw_snapshot,
            "expected the pre-translate snapshot (target_text: null) to be persisted \
             to subtitles.json before the job finished"
        );

        handle.await.expect("run_pipeline task panicked");

        let final_doc = store
            .load_subtitles("slowvideo001")
            .await
            .unwrap()
            .expect("final subtitles.json should exist");
        assert_eq!(final_doc.cues[0].target_text.as_deref(), Some("你好"));
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
                source_text: "こんにちは".to_string(),
                tokens: vec![Token {
                    t: "こんにちは".to_string(),
                    reading: None,
                }],
                phonetic: "konnichiwa".to_string(),
                target_text: None,
            }],
            translate_partial: Some(true),
            source: Some("asr".to_string()),
            target_source: None,
            polished: None,
        };
        store.save_subtitles(&existing).await.unwrap();

        run_retranslate(&store, &hub, &rpc, "retranslate01").await;

        let meta = store.load_meta("retranslate01").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
        assert_eq!(meta.last_error, None);

        let doc = store.load_subtitles("retranslate01").await.unwrap().unwrap();
        // source_text/tokens/phonetic/timing pass through untouched -- only
        // target_text (the stub's canned "STUB:<source_text>") changes.
        assert_eq!(doc.cues[0].source_text, "こんにちは");
        assert_eq!(doc.cues[0].phonetic, "konnichiwa");
        assert_eq!(doc.cues[0].target_text.as_deref(), Some("STUB:こんにちは"));
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
            &test_ytdlp(),
            "ccvideo0001",
            "small",
            0.0,
            "int8",
            "cpu",
            "auto",
            "off",
            "on",
            false,
            &PipelineOverrides::default(),
        )
        .await;

        let meta = store.load_meta("ccvideo0001").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
        assert_eq!(meta.last_error, None);

        // No target (Chinese) CC was written for this video, so the stub's
        // target_source_kwargs stays empty and the doc's target_source must
        // be absent (dsd.md §12.4/§12.5/§12.7, B5.5 -- the flip side of
        // `target_cc_reuse_marks_target_source_cc` below).
        let doc = store.load_subtitles("ccvideo0001").await.unwrap().unwrap();
        assert_eq!(doc.target_source, None);
    }

    /// A `ja`-selected video carrying a STALE/mismatched `source_cc_lang`
    /// (`"en"`, as an older buggy fetch could persist alongside an English
    /// `cc.srt`) must NOT use that CC as its source. The pipeline drops the
    /// mismatched CC and runs ASR against the user's `source_lang`, so
    /// `doc.language_source` comes out `"ja"` (not `"en"`) -- i.e. a plain
    /// "重新產生字幕" fixes a mis-sourced video without a re-download.
    #[tokio::test]
    async fn mismatched_source_cc_lang_is_dropped_and_asr_uses_source_lang() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "mismatchcc1", VideoStatus::Downloaded).await;
        let mut meta = store.load_meta("mismatchcc1").await.unwrap().unwrap();
        meta.source_lang = Some("ja".to_string());
        meta.source_cc_lang = Some("en".to_string()); // stale/buggy: en CC on a ja video
        store.save_meta(&meta).await.unwrap();

        // An English source CC left on disk by the buggy fetch.
        tokio::fs::write(
            store.cc_path("mismatchcc1"),
            "1\n00:00:00,000 --> 00:00:01,000\nHello\n\n",
        )
        .await
        .unwrap();
        assert!(store.cc_exists("mismatchcc1"));

        run_pipeline(
            &store,
            &hub,
            &rpc,
            &test_ytdlp(),
            "mismatchcc1",
            "small",
            0.0,
            "int8",
            "cpu",
            "auto",
            "off",
            "on",
            false,
            &PipelineOverrides::default(),
        )
        .await;

        let doc = store
            .load_subtitles("mismatchcc1")
            .await
            .unwrap()
            .expect("subtitles.json should have been written");
        // ASR ran against the user's `ja`, NOT the mismatched English CC.
        assert_eq!(doc.language_source, "ja");
    }

    /// dsd.md §12.4/§12.5/§12.7 (B5.5): when a manual target-language
    /// (Chinese) CC file exists for the video, `run_pipeline` must compute
    /// `target_cc_path` (via `store.target_cc_exists`/`store.target_cc_path`)
    /// and thread it into `GenerateSubtitlesParams`. The stub worker tags
    /// the result doc `target_source: "cc"` whenever it sees a non-empty
    /// `target_cc_path` in the request params (see stub_worker.py), so
    /// asserting that field on the saved doc proves the path threaded
    /// through end to end.
    #[tokio::test]
    async fn target_cc_reuse_marks_target_source_cc() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "targetcc001", VideoStatus::Downloaded).await;
        assert!(!store.target_cc_exists("targetcc001"));

        tokio::fs::write(
            store.target_cc_path("targetcc001"),
            "1\n00:00:00,000 --> 00:00:01,000\n你好\n\n",
        )
        .await
        .unwrap();
        assert!(store.target_cc_exists("targetcc001"));

        run_pipeline(
            &store,
            &hub,
            &rpc,
            &test_ytdlp(),
            "targetcc001",
            "small",
            0.0,
            "int8",
            "cpu",
            "auto",
            "off",
            "on",
            false,
            &PipelineOverrides::default(),
        )
        .await;

        let meta = store.load_meta("targetcc001").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
        assert_eq!(meta.last_error, None);

        let doc = store
            .load_subtitles("targetcc001")
            .await
            .unwrap()
            .expect("subtitles.json should have been written");
        assert_eq!(doc.target_source.as_deref(), Some("cc"));
    }

    /// The full [`effective_separate_vocals`] precedence table: `"off"` is a
    /// hard kill-switch beating even an explicit `Some(true)`; otherwise the
    /// per-request override wins; otherwise `"always"` → on and `"auto"`
    /// (or anything unrecognized) → follow `is_music_video`.
    #[test]
    fn effective_separate_vocals_precedence() {
        assert!(!effective_auto_policy("off", Some(true), true));
        assert!(!effective_auto_policy("off", None, true));

        assert!(effective_auto_policy("auto", Some(true), false));
        assert!(!effective_auto_policy("auto", Some(false), true));
        assert!(!effective_auto_policy("always", Some(false), true));

        assert!(effective_auto_policy("auto", None, true));
        assert!(!effective_auto_policy("auto", None, false));
        assert!(effective_auto_policy("always", None, false));

        assert!(effective_auto_policy("banana", None, true));
        assert!(!effective_auto_policy("banana", None, false));
    }

    /// A music video under the `"auto"` policy asks for separation, but the
    /// hq-audio extraction fails (`test_ytdlp`'s ffmpeg doesn't exist).
    /// That must be non-fatal: the run falls back to the original audio
    /// (worker sees `separate_vocals: false` — doc.source stays `"asr"`,
    /// not the stub's `"asr_vocals"` tag) and still completes.
    #[tokio::test]
    async fn failed_hq_extraction_is_nonfatal_and_falls_back_to_original_audio() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "musicvid0001", VideoStatus::Downloaded).await;
        let mut meta = store.load_meta("musicvid0001").await.unwrap().unwrap();
        meta.is_music_video = true;
        store.save_meta(&meta).await.unwrap();
        // video.mp4 exists, so run_pipeline attempts the extraction (and
        // fails on the nonexistent ffmpeg binary).
        tokio::fs::write(store.video_path("musicvid0001"), b"fake mp4 bytes")
            .await
            .unwrap();

        run_pipeline(&store, &hub, &rpc, &test_ytdlp(), "musicvid0001", "small", 0.0, "int8", "cpu", "auto", "off", "on", false, &PipelineOverrides::default())
            .await;

        let meta = store.load_meta("musicvid0001").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
        assert_eq!(meta.last_error, None);
        let doc = store.load_subtitles("musicvid0001").await.unwrap().unwrap();
        assert_ne!(doc.source.as_deref(), Some("asr_vocals"));
        assert!(!store.audio_hq_path("musicvid0001").exists());
    }

    /// With a cached `vocals.wav` already on disk, a music video under
    /// `"auto"` keeps separation ON without needing any extraction (no
    /// ffmpeg call — `test_ytdlp`'s ffmpeg would fail), and
    /// `separate_vocals: true` threads through to the worker (the stub tags
    /// the doc `source: "asr_vocals"` when it sees the flag).
    #[tokio::test]
    async fn cached_vocals_keep_separation_on_without_extraction() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "musicvid0002", VideoStatus::Downloaded).await;
        let mut meta = store.load_meta("musicvid0002").await.unwrap().unwrap();
        meta.is_music_video = true;
        store.save_meta(&meta).await.unwrap();
        tokio::fs::write(store.vocals_path("musicvid0002"), b"fake cached vocals")
            .await
            .unwrap();

        run_pipeline(&store, &hub, &rpc, &test_ytdlp(), "musicvid0002", "small", 0.0, "int8", "cpu", "auto", "off", "on", false, &PipelineOverrides::default())
            .await;

        let meta = store.load_meta("musicvid0002").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
        let doc = store.load_subtitles("musicvid0002").await.unwrap().unwrap();
        assert_eq!(doc.source.as_deref(), Some("asr_vocals"));
    }

    /// A music video under the `"auto"` lyrics-polish policy must thread
    /// `lyrics_polish: true` to the worker (the stub tags the doc
    /// `polished: true` when it sees the flag), and the field must
    /// round-trip into the saved `subtitles.json`.
    #[tokio::test]
    async fn lyrics_polish_flag_threads_through_and_marks_doc_polished() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "polishvid001", VideoStatus::Downloaded).await;
        let mut meta = store.load_meta("polishvid001").await.unwrap().unwrap();
        meta.is_music_video = true;
        store.save_meta(&meta).await.unwrap();

        // vocal_separation "off" so no extraction is attempted; polish "auto"
        // follows is_music_video -> on.
        run_pipeline(&store, &hub, &rpc, &test_ytdlp(), "polishvid001", "small", 0.0, "int8", "cpu", "off", "auto", "on", false, &PipelineOverrides::default())
            .await;

        let doc = store.load_subtitles("polishvid001").await.unwrap().unwrap();
        assert_eq!(doc.polished, Some(true));
    }

    /// The global `"off"` policy is a hard kill-switch: even a cached
    /// vocals.wav + `is_music_video` + an explicit per-request `Some(true)`
    /// must not turn separation on.
    #[tokio::test]
    async fn global_off_policy_defeats_per_request_override() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "musicvid0003", VideoStatus::Downloaded).await;
        let mut meta = store.load_meta("musicvid0003").await.unwrap().unwrap();
        meta.is_music_video = true;
        store.save_meta(&meta).await.unwrap();
        tokio::fs::write(store.vocals_path("musicvid0003"), b"fake cached vocals")
            .await
            .unwrap();

        let overrides = PipelineOverrides {
            separate_vocals: Some(true),
            ..PipelineOverrides::default()
        };
        run_pipeline(&store, &hub, &rpc, &test_ytdlp(), "musicvid0003", "small", 0.0, "int8", "cpu", "off", "off", "on", false, &overrides)
            .await;

        let doc = store.load_subtitles("musicvid0003").await.unwrap().unwrap();
        assert_ne!(doc.source.as_deref(), Some("asr_vocals"));
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
            target_source: None,
            polished: None,
        };
        store.save_subtitles(&doc).await.unwrap();

        run_pipeline(&store, &hub, &rpc, &test_ytdlp(), "cachedvideo1", "small", 0.0, "int8", "cpu", "auto", "off", "on", false, &PipelineOverrides::default())
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
        run_pipeline(&store, &hub, &rpc, &test_ytdlp(), "crashvideo01", "small", 0.0, "int8", "cpu", "auto", "off", "on", false, &PipelineOverrides::default())
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

        run_pipeline(&store, &hub, &rpc, &test_ytdlp(), "noaudiovid1", "small", 0.0, "int8", "cpu", "auto", "off", "on", false, &PipelineOverrides::default())
            .await;

        let meta = store.load_meta("noaudiovid1").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::PipelineFailed);
        assert!(meta.last_error.unwrap().contains("audio.wav"));
    }

    /// dsd.md §12.2/§12.5/§12.7 (B5.2): a video whose `meta.source_lang` is
    /// `Some("en")` must have that value flow all the way through
    /// `GenerateSubtitlesParams.source_lang` -> the (stubbed) worker's
    /// `params.source_lang` -> `doc.language_source`, and the worker's
    /// skip-reading simulation (stub_worker.py) must come back through as
    /// empty `tokens` on the assembled cues. This is the proof that
    /// `run_pipeline` no longer hardcodes `"ja"`.
    #[tokio::test]
    async fn english_source_lang_flows_through_and_skips_reading() {
        let tmp = TempDataDir::new();
        let store = FsStore::new(tmp.0.clone());
        let hub = EventHub::new();
        let rpc = RpcClient::new("python3", stub_worker_path());

        seed_video(&store, "englishvid1", VideoStatus::Downloaded).await;
        let mut meta = store.load_meta("englishvid1").await.unwrap().unwrap();
        meta.source_lang = Some("en".to_string());
        store.save_meta(&meta).await.unwrap();

        run_pipeline(
            &store,
            &hub,
            &rpc,
            &test_ytdlp(),
            "englishvid1",
            "small",
            0.0,
            "int8",
            "cpu",
            "auto",
            "off",
            "on",
            false,
            &PipelineOverrides::default(),
        )
        .await;

        let meta = store.load_meta("englishvid1").await.unwrap().unwrap();
        assert_eq!(meta.status, VideoStatus::Ready);
        assert_eq!(meta.last_error, None);

        let doc = store
            .load_subtitles("englishvid1")
            .await
            .unwrap()
            .expect("subtitles.json should have been written");
        assert_eq!(doc.language_source, "en");
        assert!(doc.cues[0].tokens.is_empty());
    }
}
