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

/// `GET /api/videos` — library listing.
pub async fn list_videos(State(state): State<SharedState>) -> Result<impl IntoResponse, ApiError> {
    let all = state.store.list_meta().await?;
    let summaries: Vec<_> = all.iter().map(crate::core::domain::VideoSummary::from).collect();
    Ok(Json(summaries))
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
