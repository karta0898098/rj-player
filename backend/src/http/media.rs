//! `GET /media/:id/video` — Range-enabled local file serving (dsd.md §3.1, B1.3).
//!
//! Delegates entirely to `tower_http::services::ServeFile`, which already
//! implements HTTP Range support (`206 Partial Content`, `Accept-Ranges`),
//! rather than hand-rolling a byte-range parser.

use axum::extract::{Path, Request, State};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::http::error::ApiError;
use crate::state::SharedState;

pub async fn serve_video(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, ApiError> {
    let path = state.store.video_path(&id);
    if !path.exists() {
        return Err(ApiError::not_found(format!(
            "no downloaded video.mp4 for id {id}"
        )));
    }

    // `ServeFile` guesses the Content-Type from the file extension, which
    // correctly resolves `video.mp4` to `video/mp4`.
    let service = ServeFile::new(&path);

    match service.oneshot(request).await {
        Ok(response) => Ok(response.into_response()),
        Err(err) => Err(ApiError::internal(format!(
            "failed to serve video file: {err}"
        ))),
    }
}

/// `GET /media/:id/thumbnail` — the poster JPEG fetched at download time
/// (`YtDlp::fetch_thumbnail`), for the video-library grid. `404` when the
/// video had no fetchable thumbnail (or predates the feature); the frontend
/// falls back to a placeholder tile.
pub async fn serve_thumbnail(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, ApiError> {
    let path = state.store.thumbnail_path(&id);
    if !path.exists() {
        return Err(ApiError::not_found(format!("no thumbnail for id {id}")));
    }

    // `.jpg` extension → `ServeFile` resolves Content-Type to `image/jpeg`.
    let service = ServeFile::new(&path);

    match service.oneshot(request).await {
        Ok(response) => Ok(response.into_response()),
        Err(err) => Err(ApiError::internal(format!(
            "failed to serve thumbnail file: {err}"
        ))),
    }
}
