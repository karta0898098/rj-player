//! `GET /api/videos/:id/events` — WebSocket progress feed (dsd.md §3.2, B1.5).
//!
//! The download worker publishes `JobEvent`s into a per-video
//! `core::pipeline::EventHub` broadcast channel; this handler just
//! subscribes and forwards them as JSON text frames.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use tokio::sync::broadcast;

use crate::core::domain::JobEvent;
use crate::state::SharedState;

pub async fn video_events(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Response {
    if let Err(err) = crate::http::error::ensure_safe_id(&id) {
        return err.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state, id))
}

async fn handle_socket(mut socket: WebSocket, state: SharedState, video_id: String) {
    let mut rx = state.event_hub.subscribe(&video_id);

    // Send a status snapshot immediately: broadcast channels don't replay
    // history, so a client that connects slightly after the worker started
    // would otherwise see nothing until the next event.
    if let Ok(Some(meta)) = state.store.load_meta(&video_id).await {
        let snapshot = JobEvent::Status { status: meta.status };
        if send_event(&mut socket, &snapshot).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            broadcast_msg = rx.recv() => {
                match broadcast_msg {
                    Ok(event) => {
                        if send_event(&mut socket, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(%video_id, skipped, "ws subscriber lagged, dropped events");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => {
                        // One-way progress feed; client messages are ignored.
                    }
                }
            }
        }
    }
}

async fn send_event(socket: &mut WebSocket, event: &JobEvent) -> Result<(), axum::Error> {
    let text = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    socket.send(Message::Text(text)).await
}
