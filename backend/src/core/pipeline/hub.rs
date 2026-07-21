//! Per-video event hub: a `tokio::sync::broadcast` channel per `video_id` so
//! the download worker (single publisher) can fan out `JobEvent`s to any
//! number of WebSocket subscribers (dsd.md §2, B1.5).

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::broadcast;

use crate::core::domain::JobEvent;

/// Ring buffer size per video's broadcast channel. Generous enough that a
/// slow subscriber won't miss much during a single download.
const CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Default)]
pub struct EventHub {
    channels: Mutex<HashMap<String, broadcast::Sender<JobEvent>>>,
}

impl EventHub {
    pub fn new() -> Self {
        Self {
            channels: Mutex::new(HashMap::new()),
        }
    }

    fn sender_for(&self, video_id: &str) -> broadcast::Sender<JobEvent> {
        let mut channels = self.channels.lock().expect("event hub mutex poisoned");
        channels
            .entry(video_id.to_string())
            .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0)
            .clone()
    }

    /// Subscribe to events for a given video, creating its channel lazily.
    pub fn subscribe(&self, video_id: &str) -> broadcast::Receiver<JobEvent> {
        self.sender_for(video_id).subscribe()
    }

    /// Publish an event for a given video. If there are no subscribers yet,
    /// the event is simply dropped (broadcast semantics) — the WS handler
    /// compensates by sending a status snapshot immediately on connect.
    pub fn publish(&self, video_id: &str, event: JobEvent) {
        let sender = self.sender_for(video_id);
        // A send error just means no receivers are currently listening.
        let _ = sender.send(event);
    }
}
