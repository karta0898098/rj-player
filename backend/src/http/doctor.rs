//! Doctor endpoints (dsd.md §13.3/§13.4). Thin adapters over `core::doctor`:
//! - `GET    /api/doctor`         — the self-check report.
//! - `POST   /api/doctor/fix/:id` — start a repair action (async).
//! - `GET    /api/doctor/events`  — WebSocket feed of repair progress.
//! - `GET    /api/doctor/models`  — cached Whisper models (dsd.md §13.7).
//! - `DELETE /api/doctor/models`  — clear the whole model cache.
//! - `DELETE /api/doctor/models/:model` — delete one cached model.
//!
//! The first-run wizard and settings page consume these. Key values are never
//! exposed — only presence. No OS-security dependency (unlike the LLM
//! key/settings.json Tauri commands), so these live here rather than as
//! Tauri-only commands — they work the same in `./dev.sh` web mode and the
//! desktop app.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use tokio::sync::broadcast;

use crate::core::doctor::{self, DoctorReport, ModelCacheReport};
use crate::state::SharedState;

pub async fn get_doctor(State(state): State<SharedState>) -> Json<DoctorReport> {
    Json(doctor::run(&state.config).await)
}

/// Start a repair action. 400 if the id is unknown, 409 if another fix is
/// already running, else 202 and progress streams over `/api/doctor/events`.
pub async fn post_fix(State(state): State<SharedState>, Path(id): Path<String>) -> Response {
    if !doctor::is_known_fix(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("unknown fix action: {id}") })),
        )
            .into_response();
    }
    if doctor::start_fix(state.doctor_hub.clone(), state.config.clone(), id.clone()) {
        (StatusCode::ACCEPTED, Json(json!({ "started": id }))).into_response()
    } else {
        (
            StatusCode::CONFLICT,
            Json(json!({ "error": "a fix is already running" })),
        )
            .into_response()
    }
}

/// List cached Whisper models + `HF_HOME` (dsd.md §13.7 settings page).
pub async fn get_models() -> Json<ModelCacheReport> {
    Json(doctor::list_cached_models())
}

/// Delete one cached model. 404 if it wasn't cached.
pub async fn delete_model(Path(model): Path<String>) -> Response {
    match doctor::delete_cached_model(&model) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("model not cached: {model}") })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

/// Clear every cached model.
pub async fn clear_models() -> Response {
    match doctor::clear_model_cache() {
        Ok(removed) => (StatusCode::OK, Json(json!({ "removed": removed }))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub async fn doctor_events(ws: WebSocketUpgrade, State(state): State<SharedState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: SharedState) {
    let mut rx = state.doctor_hub.subscribe();
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(event) => {
                    let text = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                    if socket.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "doctor ws subscriber lagged, dropped events");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                // One-way progress feed; other client messages are ignored.
                Some(Ok(_)) => {}
            },
        }
    }
}
