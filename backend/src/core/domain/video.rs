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
    Downloading,
    DownloadFailed,
    Downloaded,
    Transcribing,
    Tokenizing,
    Translating,
    Assembling,
    PipelineFailed,
    Ready,
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
}

impl From<&VideoMeta> for VideoSummary {
    fn from(m: &VideoMeta) -> Self {
        Self {
            video_id: m.video_id.clone(),
            title: m.title.clone(),
            channel: m.channel.clone(),
            status: m.status,
            duration_ms: m.duration_ms,
        }
    }
}
