//! `POST/GET /api/videos`, `GET /api/videos/:id` (dsd.md §3.1, B1.4).
//!
//! Thin adapter: parses/validates the HTTP request, calls into `core::`,
//! and shapes the JSON response. No business logic lives here.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::core::domain::{JobEvent, VideoMeta, VideoStatus};
use crate::core::downloader::extract_video_id;
use crate::core::pipeline::{Job, PipelineOverrides};
use crate::http::error::ApiError;
use crate::state::SharedState;

#[derive(Debug, Deserialize)]
pub struct CreateVideoRequest {
    pub url: String,
    #[serde(default = "default_auto_pipeline")]
    pub auto_pipeline: bool,
    /// Queue-feature addition: whether the caller has flagged/confirmed
    /// this as a music video (usually pre-filled from
    /// `POST /api/videos/preview`'s `is_music`). Purely descriptive -- it
    /// doesn't change pipeline behavior itself, only `options` does.
    #[serde(default)]
    pub is_music_video: bool,
    /// Queue-feature addition: per-item ASR/generation options chosen when
    /// adding this video to the queue, persisted as `VideoMeta::queued_options`
    /// and used by the auto-pipeline-after-download step. `#[serde(flatten)]`
    /// reuses the exact same field shape as `POST /api/videos/:id/pipeline`'s
    /// `PipelineRequest`, so a caller sending only `{"url": "..."}` still
    /// works unchanged (every field defaults via `PipelineOverrides::default`).
    #[serde(flatten)]
    pub options: PipelineOverrides,
    /// The video's source language (dsd.md §12.2/§12.5/§12.7 B5.2), chosen
    /// by the (future, B5.3) frontend source-language selector. `None`
    /// (including every caller that predates this field) means "ja" --
    /// `VideoMeta::source_lang` / `orchestrator::run_pipeline` default it
    /// the same way, so omitting it keeps today's Japanese-only behavior
    /// byte-identical.
    #[serde(default)]
    pub source_lang: Option<String>,
    /// Per-video quality cap (the per-video quality picker): the yt-dlp `-f`
    /// selector's `height<=N` cap, resolved to an effective format string by
    /// `YtDlp::format_for_max_height` when the download job runs. `None`
    /// (including every caller that predates this field) means "use
    /// `config.yt_dlp_format`'s default cap" -- unchanged behavior.
    /// `Some(0)` means uncapped ("best available").
    #[serde(default)]
    pub max_height: Option<u32>,
}

fn default_auto_pipeline() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct PreviewVideoRequest {
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct PreviewVideoResponse {
    pub video_id: String,
    pub title: String,
    pub channel: String,
    pub duration_ms: u64,
    pub is_music: bool,
    /// Auto-detected source language (dsd.md §12.2/§12.5 B5.3 extension) --
    /// lets the add-to-queue form pre-select the 來源語言 picker before the
    /// user commits to queuing the video. Always a concrete code ("ja"/"en"),
    /// never null -- see `detect_source_lang`'s historical-default fallback.
    /// Purely a suggestion; the user can still override it.
    pub source_lang: String,
}

#[derive(Debug, Serialize)]
struct CreateVideoAccepted {
    video_id: String,
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct CreateVideoReady {
    video_id: String,
    status: &'static str,
}

/// `POST /api/videos` — kick off a download (idempotent on `video_id`).
pub async fn create_video(
    State(state): State<SharedState>,
    Json(req): Json<CreateVideoRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let video_id = extract_video_id(&req.url)?;

    if let Some(meta) = state.store.load_meta(&video_id).await? {
        if meta.status.is_cached_usable() && state.store.video_file_exists(&video_id) {
            tracing::info!(%video_id, "cache hit, skipping download");
            return Ok((
                StatusCode::OK,
                Json(CreateVideoReady {
                    video_id,
                    status: "ready",
                }),
            )
                .into_response());
        }
    }

    // Persist a `Queued` record synchronously, before enqueueing, so the
    // item shows up immediately in `GET /api/videos` (in FIFO order, since
    // `list_meta()` sorts by `created_at`) even though the single worker
    // may not pick it up for a while. `process_download_job` re-reads
    // `queued_options`/`is_music_video` off this same record once it starts.
    let mut meta = state
        .store
        .load_meta(&video_id)
        .await?
        .unwrap_or_else(|| VideoMeta::new(video_id.clone(), req.url.clone()));
    meta.status = VideoStatus::Queued;
    meta.last_error = None;
    meta.is_music_video = req.is_music_video;
    meta.queued_options = Some(req.options);
    meta.source_lang = req.source_lang;
    meta.max_height = req.max_height;
    state.store.save_meta(&meta).await?;

    state
        .job_tx
        .send(Job::Download {
            video_id: video_id.clone(),
            url: req.url,
            auto_pipeline: req.auto_pipeline,
        })
        .await
        .map_err(|_| ApiError::internal("job queue is not accepting work (worker stopped)"))?;

    Ok((
        StatusCode::ACCEPTED,
        Json(CreateVideoAccepted {
            video_id,
            status: "downloading",
        }),
    )
        .into_response())
}

/// `POST /api/videos/preview` — metadata-only lookup (title/channel/
/// duration/`is_music`) for a URL, with no side effects: no job enqueued,
/// no `meta.json` written. Lets the frontend show the auto-detected
/// music-MV flag as the user pastes a URL, before they commit to adding it
/// to the queue. Safe to call repeatedly on a debounce.
pub async fn preview_video(
    State(state): State<SharedState>,
    Json(req): Json<PreviewVideoRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let video_id = extract_video_id(&req.url)?;
    let metadata = state.ytdlp.fetch_metadata(&req.url).await?;

    Ok(Json(PreviewVideoResponse {
        video_id,
        title: metadata.title,
        channel: metadata.channel,
        duration_ms: metadata.duration_ms,
        is_music: metadata.is_music,
        source_lang: metadata.detected_lang.unwrap_or_else(|| "ja".to_string()),
    }))
}

/// `POST /api/videos/:id/cancel` — cancel a video that's still `Queued`
/// (not yet picked up by the worker). `400` for any other status, since an
/// in-progress or finished item can't be cancelled in this iteration.
pub async fn cancel_video(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let mut meta = state
        .store
        .load_meta(&id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no video with id {id}")))?;

    if meta.status != VideoStatus::Queued {
        return Err(ApiError::bad_request(format!(
            "cannot cancel a video with status {:?} (only queued items can be cancelled)",
            meta.status
        )));
    }

    meta.status = VideoStatus::Cancelled;
    state.store.save_meta(&meta).await?;
    state.event_hub.publish(
        &id,
        JobEvent::Status {
            status: VideoStatus::Cancelled,
        },
    );

    Ok(StatusCode::ACCEPTED)
}

/// `GET /api/videos` — library listing. Enriches each `VideoSummary` with the
/// `has_subtitles`/`has_thumbnail` filesystem flags (not stored in
/// `meta.json`) that the library grid needs for its subtitle badge and poster.
pub async fn list_videos(State(state): State<SharedState>) -> Result<impl IntoResponse, ApiError> {
    let all = state.store.list_meta().await?;
    let summaries: Vec<_> = all
        .iter()
        .map(|m| {
            let mut summary = crate::core::domain::VideoSummary::from(m);
            summary.has_subtitles = state.store.subtitles_exist(&m.video_id);
            summary.has_thumbnail = state.store.thumbnail_exists(&m.video_id);
            summary
        })
        .collect();
    Ok(Json(summaries))
}

/// `DELETE /api/videos/:id` — remove a video from the library, deleting its
/// entire on-disk folder to reclaim space. Refuses (`409`) while the video is
/// actively downloading or running its subtitle pipeline, since deleting the
/// folder out from under the worker would race; the caller should cancel or
/// wait first. A queued (not-yet-started) item is deletable -- it just won't
/// be found by the worker when its turn comes.
pub async fn delete_video(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    if let Some(meta) = state.store.load_meta(&id).await? {
        if is_actively_processing(meta.status) {
            return Err(ApiError::conflict(format!(
                "cannot delete a video that is currently {:?}; cancel or wait for it to finish first",
                meta.status
            )));
        }
    }

    state.store.delete_video(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Whether a video is mid-flight in the single worker (download or an active
/// pipeline stage), and therefore unsafe to delete out from under it.
fn is_actively_processing(status: VideoStatus) -> bool {
    matches!(
        status,
        VideoStatus::Downloading
            | VideoStatus::Transcribing
            | VideoStatus::Tokenizing
            | VideoStatus::Translating
            | VideoStatus::Assembling
    )
}

/// `GET /api/videos/:id` — full metadata for one video.
pub async fn get_video(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    match state.store.load_meta(&id).await? {
        Some(meta) => Ok(Json(meta)),
        None => Err(ApiError::not_found(format!("no video with id {id}"))),
    }
}
