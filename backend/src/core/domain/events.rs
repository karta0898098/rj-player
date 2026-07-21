//! `JobEvent`: the tagged-JSON event shape pushed to WebSocket subscribers
//! (dsd.md §3.2). Kept in `core/` (no axum types) so the same type can be
//! reused by a future Tauri event emitter.

use serde::{Deserialize, Serialize};

use super::video::{Stage, VideoStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JobEvent {
    /// The video's overall status changed.
    Status { status: VideoStatus },
    /// Percent-complete progress within a stage.
    Progress { stage: Stage, pct: u8 },
    /// A free-form human-readable log line (e.g. raw yt-dlp output).
    Log { line: String },
    /// The job finished successfully; `status` is the resulting terminal status.
    Done { status: VideoStatus },
    /// The job failed at a given stage.
    Error { stage: Stage, message: String },
}
