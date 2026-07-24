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
    /// The video's source language (dsd.md §12.2/§12.5), chosen at
    /// `POST /api/videos` time and persisted so `regenerate` reuses it.
    /// `None` means "ja" (the only source language before this field
    /// existed) -- every reader that cares defaults it explicitly, so this
    /// stays the exact today-behavior for old on-disk `meta.json` files and
    /// any caller that never sends `source_lang`. `#[serde(default)]` for
    /// the same on-disk-compat reason as `is_music_video`/`queued_options`.
    #[serde(default)]
    pub source_lang: Option<String>,
    /// Per-video quality cap chosen at `POST /api/videos` time (the
    /// per-video quality picker, dsd.md queue feature extension): the
    /// yt-dlp `-f` selector's `height<=N` cap. `None` means "use
    /// `config.yt_dlp_format`'s default cap (1080p)" -- the exact
    /// today-behavior for old on-disk `meta.json` files and any caller that
    /// never sends `max_height`. `Some(0)` means uncapped ("best available").
    /// `#[serde(default)]` for the same on-disk-compat reason as
    /// `source_lang`/`queued_options`.
    #[serde(default)]
    pub max_height: Option<u32>,
    /// The language of the manual source CC that `fetch_captions` picked, when
    /// one was found — always equal to `source_lang` now that the source-CC
    /// search is restricted to the selected language only (its plain + `-orig`
    /// tracks). It no longer cross-falls-back to `en`/`ja`: a CC in a language
    /// other than the audio is a translation, not a transcript, so using it as
    /// the source produced the wrong text (a `ja` video with only an English
    /// CC used to land here as `"en"` and come out with English source text).
    /// The pipeline still reads THIS as the worker's source language; kept as a
    /// distinct field (rather than folded into `source_lang`) so the plumbing
    /// stays intact. `None` means no source-language CC was found and Whisper
    /// ASR runs against `source_lang`. `#[serde(default)]` for the same
    /// on-disk-compat reason as `source_lang`/`max_height`.
    #[serde(default)]
    pub source_cc_lang: Option<String>,
    /// Why `audio.wav` extraction failed at download time (ffmpeg missing,
    /// unsigned/quarantined sidecar blocked by Gatekeeper, etc.), if it did.
    /// Audio extraction is non-fatal to the download job (dsd.md §7's
    /// failure-isolation contract) so this never sets `status`/`last_error`
    /// on its own -- it's surfaced later, as extra context, if the pipeline
    /// subsequently fails because `audio.wav` is missing (see
    /// `orchestrator::run_pipeline`). `#[serde(default)]` for the same
    /// on-disk-compat reason as `source_cc_lang`.
    #[serde(default)]
    pub audio_extract_error: Option<String>,
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
            source_lang: None,
            max_height: None,
            source_cc_lang: None,
            audio_extract_error: None,
        }
    }
}

/// Lightweight summary used in the video library listing (`GET /api/videos`).
///
/// `created_at`/`has_subtitles`/`has_thumbnail` back the library grid's sort
/// (by date added), the subtitle-status badge, and the poster thumbnail. The
/// two `has_*` flags are filesystem facts not stored in `meta.json`, so
/// `From<&VideoMeta>` leaves them `false`; the `GET /api/videos` handler fills
/// them in from `store` existence checks (see `videos::list_videos`).
#[derive(Debug, Clone, Serialize)]
pub struct VideoSummary {
    pub video_id: String,
    pub title: String,
    pub channel: String,
    pub status: VideoStatus,
    pub duration_ms: u64,
    pub is_music_video: bool,
    pub created_at: DateTime<Utc>,
    pub has_subtitles: bool,
    pub has_thumbnail: bool,
    /// Forward-looking for B5.3's source-language selector UI: always a
    /// concrete code (never `null`), defaulting `meta.source_lang`'s `None`
    /// to `"ja"` here so the frontend never has to.
    pub source_lang: String,
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
            created_at: m.created_at,
            has_subtitles: false,
            has_thumbnail: false,
            source_lang: m.source_lang.clone().unwrap_or_else(|| "ja".to_string()),
        }
    }
}
