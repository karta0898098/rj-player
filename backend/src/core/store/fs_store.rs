//! Filesystem-backed storage for per-video data.
//!
//! Layout (dsd.md §5.2):
//! ```text
//! <data_dir>/videos/<video_id>/
//!   meta.json
//!   video.mp4
//!   audio.wav
//!   cc.srt      (optional: manual Japanese CC, when the uploader had one)
//! ```

use std::path::PathBuf;

use thiserror::Error;
use tokio::fs;

use crate::core::domain::{SubtitleDoc, VideoMeta};

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to (de)serialize meta.json: {0}")]
    Serde(#[from] serde_json::Error),
}

/// Single point of filesystem access for video data (dsd.md §2).
#[derive(Debug, Clone)]
pub struct FsStore {
    data_dir: PathBuf,
}

impl FsStore {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    pub fn videos_dir(&self) -> PathBuf {
        self.data_dir.join("videos")
    }

    pub fn video_dir(&self, video_id: &str) -> PathBuf {
        self.videos_dir().join(video_id)
    }

    pub fn video_path(&self, video_id: &str) -> PathBuf {
        self.video_dir(video_id).join("video.mp4")
    }

    pub fn audio_path(&self, video_id: &str) -> PathBuf {
        self.video_dir(video_id).join("audio.wav")
    }

    /// Path to the normalized manual Japanese CC file, if the video had one
    /// (`YtDlp::fetch_manual_ja_subs` writes here at download time). Mirrors
    /// `audio_path`/`video_path` -- always returns the path regardless of
    /// whether the file actually exists; use `cc_exists` to check.
    pub fn cc_path(&self, video_id: &str) -> PathBuf {
        self.video_dir(video_id).join("cc.srt")
    }

    pub fn meta_path(&self, video_id: &str) -> PathBuf {
        self.video_dir(video_id).join("meta.json")
    }

    pub fn subtitles_path(&self, video_id: &str) -> PathBuf {
        self.video_dir(video_id).join("subtitles.json")
    }

    /// Ensure `<data_dir>/videos/<video_id>/` exists.
    pub async fn ensure_video_dir(&self, video_id: &str) -> Result<PathBuf, StoreError> {
        let dir = self.video_dir(video_id);
        fs::create_dir_all(&dir).await?;
        Ok(dir)
    }

    /// Load `meta.json` for a video, if it exists.
    pub async fn load_meta(&self, video_id: &str) -> Result<Option<VideoMeta>, StoreError> {
        let path = self.meta_path(video_id);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path).await?;
        let meta: VideoMeta = serde_json::from_slice(&bytes)?;
        Ok(Some(meta))
    }

    /// Persist `meta.json`, creating the video directory first if needed.
    pub async fn save_meta(&self, meta: &VideoMeta) -> Result<(), StoreError> {
        self.ensure_video_dir(&meta.video_id).await?;
        let path = self.meta_path(&meta.video_id);
        let bytes = serde_json::to_vec_pretty(meta)?;
        fs::write(&path, bytes).await?;
        Ok(())
    }

    /// List every video's metadata by scanning `<data_dir>/videos/*/meta.json`.
    pub async fn list_meta(&self) -> Result<Vec<VideoMeta>, StoreError> {
        let videos_dir = self.videos_dir();
        if !videos_dir.exists() {
            return Ok(Vec::new());
        }

        let mut out = Vec::new();
        let mut entries = fs::read_dir(&videos_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let meta_path = entry.path().join("meta.json");
            if !meta_path.exists() {
                continue;
            }
            match fs::read(&meta_path).await {
                Ok(bytes) => match serde_json::from_slice::<VideoMeta>(&bytes) {
                    Ok(meta) => out.push(meta),
                    Err(err) => {
                        tracing::warn!(path = %meta_path.display(), %err, "skipping unreadable meta.json");
                    }
                },
                Err(err) => {
                    tracing::warn!(path = %meta_path.display(), %err, "failed to read meta.json");
                }
            }
        }
        // Stable, deterministic ordering for the library listing.
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(out)
    }

    pub fn video_file_exists(&self, video_id: &str) -> bool {
        self.video_path(video_id).exists()
    }

    /// Whether a manual Japanese CC file was fetched for this video
    /// (dsd.md's ASR-precedence extension: `reference_lyrics` > manual CC >
    /// Whisper ASR).
    pub fn cc_exists(&self, video_id: &str) -> bool {
        self.cc_path(video_id).exists()
    }

    /// Load `subtitles.json` for a video, if it exists (dsd.md §5.1/§5.2).
    /// Callers use this both to serve `GET /api/videos/:id/subtitles` and to
    /// check the pipeline cache (existing doc + matching `version` == skip).
    pub async fn load_subtitles(&self, video_id: &str) -> Result<Option<SubtitleDoc>, StoreError> {
        let path = self.subtitles_path(video_id);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path).await?;
        let doc: SubtitleDoc = serde_json::from_slice(&bytes)?;
        Ok(Some(doc))
    }

    /// Persist the canonical `SubtitleDoc` as `subtitles.json`, creating the
    /// video directory first if needed.
    pub async fn save_subtitles(&self, doc: &SubtitleDoc) -> Result<(), StoreError> {
        self.ensure_video_dir(&doc.video_id).await?;
        let path = self.subtitles_path(&doc.video_id);
        let bytes = serde_json::to_vec_pretty(doc)?;
        fs::write(&path, bytes).await?;
        Ok(())
    }
}
