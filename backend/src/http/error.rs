//! Shared HTTP error type. Translates `core::` errors into the JSON error
//! envelope from dsd.md §3.1: `{ "error": { "code": "...", "message": "..." } }`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::core::downloader::DownloaderError;
use crate::core::store::StoreError;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "conflict", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
    }
}

/// Validate a `:id`-style path segment before it touches the filesystem.
///
/// axum percent-decodes `Path<String>`, so a raw URL segment can smuggle `/`,
/// `\` or `..` into handlers that join it into paths (`<data>/videos/{id}`,
/// the HF model cache) — which turned the DELETE endpoints into arbitrary
/// `remove_dir_all` primitives reachable from a browser. Every handler that
/// receives a path id calls this first. The charset is the union of what
/// real ids need: YouTube ids are 11 chars of `[A-Za-z0-9_-]`, Whisper model
/// names add `.`; 64 is a generous length cap.
pub fn ensure_safe_id(id: &str) -> Result<(), ApiError> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        // 404, not 400: don't advertise that the id was syntactically
        // interesting — it simply doesn't exist.
        Err(ApiError::not_found(format!("no such resource: {id:?}")))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(json!({
            "error": {
                "code": self.code,
                "message": self.message,
            }
        }));
        (self.status, body).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(err: StoreError) -> Self {
        ApiError::internal(err.to_string())
    }
}

impl From<DownloaderError> for ApiError {
    fn from(err: DownloaderError) -> Self {
        match err {
            DownloaderError::InvalidUrl(_) => ApiError::bad_request(err.to_string()),
            other => ApiError::new(StatusCode::BAD_GATEWAY, "download_failed", other.to_string()),
        }
    }
}
