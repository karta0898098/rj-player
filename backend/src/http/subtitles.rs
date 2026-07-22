//! `GET /api/videos/:id/subtitles`, `POST /api/videos/:id/pipeline`
//! (dsd.md §3.1, B2.6).
//!
//! Thin adapter: parses/validates the HTTP request, calls into `core::`,
//! and shapes the JSON response. No business logic lives here.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::core::domain::{JobEvent, Stage, VideoStatus};
use crate::core::pipeline::{Job, PipelineOverrides, VadOverrides};
use crate::http::error::ApiError;
use crate::state::SharedState;

/// `GET /api/videos/:id/subtitles` — the canonical `SubtitleDoc` JSON.
///
/// `409` (not `404`) when the video exists but isn't `ready` yet, per
/// dsd.md §3.1: `GET /api/videos/:id/subtitles` -> `409 { status }` while
/// unfinished.
pub async fn get_subtitles(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let meta = state
        .store
        .load_meta(&id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no video with id {id}")))?;

    if meta.status != VideoStatus::Ready {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "not_ready",
            format!("subtitles are not ready yet (status: {:?})", meta.status),
        ));
    }

    match state.store.load_subtitles(&id).await? {
        Some(doc) => Ok(Json(doc).into_response()),
        None => Err(ApiError::internal(
            "video status is ready but subtitles.json is missing on disk",
        )),
    }
}

/// Body of `POST /api/videos/:id/pipeline` — every field optional (the
/// frontend's "regenerate" button contract). Omitted top-level fields fall
/// back to config (`whisper_model`/`whisper_temperature`) or
/// `ai/pipeline/asr.py` defaults (`vad`, `initial_prompt`); the
/// auto-pipeline-after-download path never goes through this handler at all
/// (it enqueues `Job::Pipeline` directly with `PipelineOverrides::default()`
/// from `core::pipeline::queue::process_download_job`), so it's unaffected.
#[derive(Debug, Default, Deserialize)]
pub struct PipelineRequest {
    #[serde(default)]
    pub force: bool,
    /// One of tiny|base|small|medium|large-v3, passed through unvalidated.
    #[serde(default)]
    pub whisper_model: Option<String>,
    #[serde(default)]
    pub whisper_temperature: Option<f32>,
    /// Empty string or omitted both mean "no initial prompt".
    #[serde(default)]
    pub initial_prompt: Option<String>,
    /// Each of the 4 sub-fields optional; omitted ones fall back to
    /// `ai/pipeline/asr.py`'s baked-in VAD defaults.
    #[serde(default)]
    pub vad: VadOverrides,
    /// The song's real lyrics, when the caller has them. When present (and
    /// non-blank), the ASR stage force-aligns this text to the audio
    /// instead of free-transcribing (dsd.md's forced-alignment extension) --
    /// text comes out exactly as given, only timing is computed. Empty
    /// string or omitted both mean "no reference lyrics, transcribe as
    /// usual".
    #[serde(default)]
    pub reference_lyrics: Option<String>,
}

#[derive(Debug, Serialize)]
struct PipelineAccepted {
    status: &'static str,
}

/// `POST /api/videos/:id/pipeline` — (re-)run the subtitle pipeline.
/// Respects the `subtitles.json` cache unless `force: true` (dsd.md §3.1,
/// §5.1/§7). Enqueues onto the same single-worker job queue as downloads
/// (dsd.md §8), so it returns immediately with `202` and progress is
/// observed via `GET /api/videos/:id/events`.
pub async fn trigger_pipeline(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    body: Option<Json<PipelineRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let mut meta = state
        .store
        .load_meta(&id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no video with id {id}")))?;

    if !state.store.video_file_exists(&id) {
        return Err(ApiError::bad_request(
            "video has not finished downloading yet; cannot run the subtitle pipeline",
        ));
    }

    let PipelineRequest {
        force,
        whisper_model,
        whisper_temperature,
        initial_prompt,
        vad,
        reference_lyrics,
    } = body.map(|Json(req)| req).unwrap_or_default();

    // Flip status to `transcribing` SYNCHRONOUSLY, before returning 202 and
    // before the queue worker picks the job up. Otherwise `meta.status` stays
    // at its previous (e.g. `ready`) value during the gap between this POST and
    // the worker starting — and a client that (re)connects its WS in that gap
    // would get a stale `status: ready` snapshot (ws.rs) and think the *new*
    // run had already finished. Setting it here closes that window so the WS
    // snapshot unambiguously reflects "a run is in progress". (A no-op-ish
    // cache-hit run will bounce it right back to `ready`, which is fine.)
    meta.status = VideoStatus::Transcribing;
    meta.last_stage = Some(Stage::Asr);
    meta.last_error = None;
    state.store.save_meta(&meta).await?;
    state.event_hub.publish(
        &id,
        JobEvent::Status {
            status: VideoStatus::Transcribing,
        },
    );

    let overrides = PipelineOverrides {
        whisper_model,
        whisper_temperature,
        initial_prompt,
        vad,
        reference_lyrics,
    };

    state
        .job_tx
        .send(Job::Pipeline {
            video_id: id,
            force,
            overrides,
        })
        .await
        .map_err(|_| ApiError::internal("job queue is not accepting work (worker stopped)"))?;

    Ok((
        StatusCode::ACCEPTED,
        Json(PipelineAccepted {
            status: "transcribing",
        }),
    ))
}

/// `POST /api/videos/:id/retranslate` — re-run ONLY the translate stage
/// against the video's existing `subtitles.json` (source_text/tokens/phonetic/
/// timing untouched, just re-filling `target_text`) — no ASR. dsd.md §7
/// extended: retry a stuck/degraded translation without redoing the slow,
/// expensive Whisper pass. `400` if there's no `subtitles.json` yet (run the
/// full pipeline first) — same reasoning as `trigger_pipeline` requiring the
/// video file to exist before it can run.
pub async fn trigger_retranslate(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let mut meta = state
        .store
        .load_meta(&id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no video with id {id}")))?;

    if state.store.load_subtitles(&id).await?.is_none() {
        return Err(ApiError::bad_request(
            "no existing subtitles.json to retranslate; run the full pipeline first",
        ));
    }

    // Flip status SYNCHRONOUSLY, before returning 202 — same reasoning as
    // trigger_pipeline: closes the gap where a WS (re)connect between this
    // POST and the queue worker picking the job up would otherwise observe
    // a stale `ready` status and think this run had already finished.
    meta.status = VideoStatus::Translating;
    meta.last_stage = Some(Stage::Translate);
    meta.last_error = None;
    state.store.save_meta(&meta).await?;
    state.event_hub.publish(
        &id,
        JobEvent::Status {
            status: VideoStatus::Translating,
        },
    );

    state
        .job_tx
        .send(Job::Retranslate { video_id: id })
        .await
        .map_err(|_| ApiError::internal("job queue is not accepting work (worker stopped)"))?;

    Ok((
        StatusCode::ACCEPTED,
        Json(PipelineAccepted {
            status: "translating",
        }),
    ))
}

/// Body of `PUT /api/videos/:id/subtitles/cues/:cue_id` — an in-place manual
/// edit of one cue's text. Both fields optional: a field left absent is left
/// untouched, so the frontend only sends what it edited.
#[derive(Debug, Deserialize)]
pub struct CuePatch {
    /// New Japanese text. When it actually changes, the cue's now-stale
    /// `tokens` (furigana) and `phonetic` are cleared -- the overlay falls
    /// back to rendering the plain `source_text`, so the edit shows correctly
    /// without wrong furigana. Re-tokenizing/re-romaji-ing a single edited
    /// line would need a new worker RPC round-trip; out of scope for a manual
    /// text fix.
    #[serde(default)]
    pub source_text: Option<String>,
    /// New translation. An empty/whitespace-only string clears it back to
    /// `null` (the nullable `target_text` field), matching the "translation
    /// missing" degrade the overlay already handles.
    #[serde(default)]
    pub target_text: Option<String>,
}

/// `PUT /api/videos/:id/subtitles/cues/:cue_id` — persist a manual edit to one
/// cue's `source_text`/`target_text` (no pipeline run; status stays `Ready`). Modeled
/// on `trigger_retranslate`'s gating: `404` if the video is unknown, `400` if
/// there's no `subtitles.json` yet, `404` if the cue id isn't in the doc.
/// Returns the updated `Cue` so the frontend can refresh in place.
pub async fn patch_cue(
    State(state): State<SharedState>,
    Path((id, cue_id)): Path<(String, u32)>,
    Json(patch): Json<CuePatch>,
) -> Result<impl IntoResponse, ApiError> {
    // Existence gate (404) -- same as the other subtitle handlers.
    state
        .store
        .load_meta(&id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no video with id {id}")))?;

    let mut doc = state
        .store
        .load_subtitles(&id)
        .await?
        .ok_or_else(|| ApiError::bad_request("no subtitles.json to edit; run the pipeline first"))?;

    let cue = doc
        .cues
        .iter_mut()
        .find(|c| c.id == cue_id)
        .ok_or_else(|| ApiError::not_found(format!("no cue with id {cue_id} in this video")))?;

    if let Some(source_text) = patch.source_text {
        if source_text != cue.source_text {
            cue.source_text = source_text;
            cue.tokens = Vec::new();
            cue.phonetic = String::new();
        }
    }
    if let Some(target_text) = patch.target_text {
        cue.target_text = if target_text.trim().is_empty() {
            None
        } else {
            Some(target_text)
        };
    }

    let updated = cue.clone();
    state.store.save_subtitles(&doc).await?;

    Ok(Json(updated))
}
