//! Route table (dsd.md §2, §3.1).

use std::path::Path;

use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::http::{doctor, media, subtitles, videos, ws};
use crate::state::SharedState;

/// Build the HTTP router. `dist_dir` is the built frontend directory served
/// as a static-file fallback so the backend can host the SPA in
/// production/packaged mode (dsd.md §13). Explicit `/api`, `/media` and
/// `/health` routes always take precedence over the fallback; unmatched
/// paths fall through to `dist`, with any non-file path resolving to
/// `index.html` for SPA client-side routing. In dev the SPA is served by
/// Vite instead and nothing requests `/` from the backend, so a missing
/// `dist` directory is harmless (the fallback simply 404s).
pub fn build_router(state: SharedState, dist_dir: &Path) -> Router {
    let serve_dist =
        ServeDir::new(dist_dir).not_found_service(ServeFile::new(dist_dir.join("index.html")));

    Router::new()
        .route("/health", get(health))
        .route("/api/doctor", get(doctor::get_doctor))
        .route("/api/doctor/fix/:id", post(doctor::post_fix))
        .route("/api/doctor/events", get(doctor::doctor_events))
        .route(
            "/api/doctor/models",
            get(doctor::get_models).delete(doctor::clear_models),
        )
        .route("/api/doctor/models/:model", delete(doctor::delete_model))
        .route("/api/doctor/storage", get(doctor::get_storage))
        .route(
            "/api/videos",
            get(videos::list_videos).post(videos::create_video),
        )
        .route("/api/videos/preview", post(videos::preview_video))
        .route(
            "/api/videos/:id",
            get(videos::get_video).delete(videos::delete_video),
        )
        .route("/api/videos/:id/events", get(ws::video_events))
        .route("/api/videos/:id/subtitles", get(subtitles::get_subtitles))
        .route(
            "/api/videos/:id/subtitles/cues",
            put(subtitles::replace_cues),
        )
        .route(
            "/api/videos/:id/subtitles/cues/:cue_id",
            put(subtitles::patch_cue),
        )
        .route(
            "/api/videos/:id/pipeline",
            post(subtitles::trigger_pipeline),
        )
        .route(
            "/api/videos/:id/retranslate",
            post(subtitles::trigger_retranslate),
        )
        .route("/api/videos/:id/cancel", post(videos::cancel_video))
        .route("/media/:id/video", get(media::serve_video))
        .route("/media/:id/thumbnail", get(media::serve_thumbnail))
        // Static SPA fallback (dsd.md §13): only handles paths that matched
        // no route above, so it can't shadow the API or media endpoints.
        .fallback_service(serve_dist)
        // Permissive CORS for local dev so the Vite dev server (a different
        // origin/port) can call the API directly without a proxy.
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}
