//! Video domain types: the status machine and the persisted metadata record.
//!
//! Kept free of any HTTP/axum types (Tauri migration seam, see dsd.md §10).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Status machine for a video (dsd.md §5.3).
///
/// Phase 1 only ever reaches `New -> Downloading -> Downloaded` (or
/// `DownloadFailed`). The remaining variants belong to the Phase 2 AI
/// pipeline and are included now so the type doesn't need to change shape
/// when the pipeline lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoStatus {
    New,
    /// Accepted by `POST /api/videos` and persisted, but not yet picked up
    /// by the single-worker queue (the queue-feature extension, dsd.md
    /// §2/§8). Lets a submitted video show up in `GET /api/videos` in FIFO
    /// order immediately, before the worker actually starts on it.
    Queued,
    Downloading,
    DownloadFailed,
    Downloaded,
    Transcribing,
    Tokenizing,
    Translating,
    Assembling,
    PipelineFailed,
    Ready,
    /// The user cancelled a `Queued` item before the worker started on it.
    Cancelled,
}

impl VideoStatus {
    /// Whether the video is currently in a state that Phase 1 considers
    /// "usable" (playable + cached, no need to re-download).
    pub fn is_cached_usable(&self) -> bool {
        matches!(
            self,
            VideoStatus::Downloaded
                | VideoStatus::Transcribing
                | VideoStatus::Tokenizing
                | VideoStatus::Translating
                | VideoStatus::Assembling
                | VideoStatus::PipelineFailed
                | VideoStatus::Ready
        )
    }
}

/// Pipeline stage identifiers, used in progress/error events (dsd.md §3.2).
///
/// Phase 1 only ever emits `Stage::Download`; the rest are reserved for the
/// Phase 2 Python AI pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Download,
    Asr,
    Tokenize,
    Romaji,
    Translate,
    Assemble,
}

/// Persisted per-video metadata (`meta.json`, dsd.md §5.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMeta {
    pub video_id: String,
    pub source_url: String,
    pub title: String,
    pub channel: String,
    pub duration_ms: u64,
    pub status: VideoStatus,
    pub last_stage: Option<Stage>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Whether yt-dlp's `categories` flagged this as a music video (queue
    /// feature, dsd.md §2/§8). `#[serde(default)]` so old on-disk
    /// `meta.json` files written before this field existed keep loading.
    #[serde(default)]
    pub is_music_video: bool,
    /// The per-item ASR/generation options chosen when this video was
    /// queued (`POST /api/videos`), consumed once by the auto-pipeline
    /// step in `queue::process_download_job` and otherwise unused. `None`
    /// means "use config/asr.py defaults", matching the pre-queue-feature
    /// behavior. `#[serde(default)]` for the same on-disk-compat reason.
    #[serde(default)]
    pub queued_options: Option<crate::core::pipeline::PipelineOverrides>,
}

impl VideoMeta {
    /// A freshly-created record for a video that hasn't started downloading yet.
    pub fn new(video_id: String, source_url: String) -> Self {
        Self {
            video_id,
            source_url,
            title: String::new(),
            channel: String::new(),
            duration_ms: 0,
            status: VideoStatus::New,
            last_stage: None,
            last_error: None,
            created_at: Utc::now(),
            is_music_video: false,
            queued_options: None,
        }
    }
}

/// Lightweight summary used in the video library listing (`GET /api/videos`).
#[derive(Debug, Clone, Serialize)]
pub struct VideoSummary {
    pub video_id: String,
    pub title: String,
    pub channel: String,
    pub status: VideoStatus,
    pub duration_ms: u64,
    pub is_music_video: bool,
}

impl From<&VideoMeta> for VideoSummary {
    fn from(m: &VideoMeta) -> Self {
        Self {
            video_id: m.video_id.clone(),
            title: m.title.clone(),
            channel: m.channel.clone(),
            status: m.status,
            duration_ms: m.duration_ms,
            is_music_video: m.is_music_video,
        }
    }
}
