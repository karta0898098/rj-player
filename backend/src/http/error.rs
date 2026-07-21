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

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
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
