use std::sync::Arc;

use crate::core::downloader::YtDlp;
use crate::core::pipeline::{EventHub, JobSender};
use crate::core::store::FsStore;

/// Shared application state, cheaply cloneable via `Arc` (axum `State`
/// extractor requirement). Wires together the `core/` layer for `http/`
/// handlers. Matches dsd.md §2's `AppState { store, job_tx, event_hub }`.
pub struct AppState {
    pub store: Arc<FsStore>,
    pub job_tx: JobSender,
    pub event_hub: Arc<EventHub>,
    /// Used directly (not through the job queue) by the read-only
    /// `POST /api/videos/preview` handler, which needs a metadata-only
    /// yt-dlp call before the user commits to queuing the video.
    pub ytdlp: Arc<YtDlp>,
}

pub type SharedState = Arc<AppState>;
