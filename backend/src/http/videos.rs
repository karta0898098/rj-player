//! `POST/GET /api/videos`, `GET /api/videos/:id` (dsd.md §3.1, B1.4).
//!
//! Thin adapter: parses/validates the HTTP request, calls into `core::`,
//! and shapes the JSON response. No business logic lives here.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::core::downloader::extract_video_id;
use crate::core::pipeline::Job;
use crate::http::error::ApiError;
use crate::state::SharedState;

#[derive(Debug, Deserialize)]
pub struct CreateVideoRequest {
    pub url: String,
    #[serde(default = "default_auto_pipeline")]
    pub auto_pipeline: bool,
}

fn default_auto_pipeline() -> bool {
    true
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
