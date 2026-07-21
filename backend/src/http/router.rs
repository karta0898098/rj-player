//! Route table (dsd.md §2, §3.1).

use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::http::{media, subtitles, videos, ws};
use crate::state::SharedState;

pub fn build_router(state: SharedState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route(
            "/api/videos",
            get(videos::list_videos).post(videos::create_video),
        )
        .route("/api/videos/:id", get(videos::get_video))
        .route("/api/videos/:id/events", get(ws::video_events))
        .route("/api/videos/:id/subtitles", get(subtitles::get_subtitles))
        .route(
            "/api/videos/:id/pipeline",
            post(subtitles::trigger_pipeline),
        )
        .route("/media/:id/video", get(media::serve_video))
        // Permissive CORS for local dev so the Vite dev server (a different
        // origin/port) can call the API directly without a proxy.
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}
