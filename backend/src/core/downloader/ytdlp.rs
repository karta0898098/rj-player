//! Thin wrapper around the `yt-dlp` and `ffmpeg` CLIs (dsd.md §2, B1.2).
//!
//! No axum types live here (Tauri migration seam) — this module only knows
//! how to talk to subprocesses and parse their output.

use std::path::Path;
use std::process::Stdio;

use serde::Deserialize;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

#[derive(Debug, Error)]
pub enum DownloaderError {
    #[error("could not extract an 11-character YouTube video id from url: {0}")]
    InvalidUrl(String),
    #[error("failed to spawn/run subprocess: {0}")]
    Io(#[from] std::io::Error),
    #[error("yt-dlp exited with a non-zero status: {0}")]
    YtDlpFailed(String),
    #[error("ffmpeg exited with a non-zero status: {0}")]
    FfmpegFailed(String),
    #[error("failed to parse yt-dlp metadata JSON: {0}")]
    MetadataParse(String),
}

/// Metadata fetched from yt-dlp before/while downloading.
#[derive(Debug, Clone)]
pub struct VideoMetadata {
    pub video_id: String,
    pub title: String,
    pub channel: String,
    pub duration_ms: u64,
}

/// A single line/tick of progress emitted while downloading.
#[derive(Debug, Clone)]
pub enum ProgressEvent {
    /// Parsed download percentage (0-100).
    Percent(u8),
    /// Raw output line, useful for a human-readable log stream.
    Log(String),
}

/// Raw shape of the fields we care about from `yt-dlp -J` output. Extra
/// fields in the real payload are ignored by serde.
#[derive(Debug, Deserialize)]
struct YtDlpInfo {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    uploader: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
}

/// Extract the 11-character YouTube video id from a URL. Supports the
/// common `watch?v=`, `youtu.be/`, `embed/` and `shorts/` forms.
pub fn extract_video_id(url: &str) -> Result<String, DownloaderError> {
    // Manual parsing to avoid pulling in a regex dependency for one job.
    let candidates: [&str; 4] = ["v=", "youtu.be/", "embed/", "shorts/"];

    for marker in candidates {
        if let Some(idx) = url.find(marker) {
            let start = idx + marker.len();
            let rest = &url[start..];
            let id: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if id.len() == 11 {
                return Ok(id);
            }
        }
    }

    Err(DownloaderError::InvalidUrl(url.to_string()))
}

/// Parse a `[download]  42.0% of ...` style yt-dlp progress line into a percent.
fn parse_percent(line: &str) -> Option<u8> {
    let idx = line.find("[download]")?;
    let rest = &line[idx + "[download]".len()..];
    let rest = rest.trim_start();
    let pct_end = rest.find('%')?;
    let pct_str = rest[..pct_end].trim();
    let pct: f32 = pct_str.parse().ok()?;
    Some(pct.round().clamp(0.0, 100.0) as u8)
}

#[derive(Debug, Clone)]
pub struct YtDlp {
    bin: String,
    ffmpeg_bin: String,
    format: String,
}

impl YtDlp {
    pub fn new(
        bin: impl Into<String>,
        ffmpeg_bin: impl Into<String>,
        format: impl Into<String>,
    ) -> Self {
        Self {
            bin: bin.into(),
            ffmpeg_bin: ffmpeg_bin.into(),
            format: format.into(),
        }
    }

    /// Fetch title/channel/duration for a video without downloading it.
    pub async fn fetch_metadata(&self, url: &str) -> Result<VideoMetadata, DownloaderError> {
        let output = Command::new(&self.bin)
            .args(["-J", "--no-warnings", "--no-playlist", url])
            .stdin(Stdio::null())
            .output()
            .await?;

        if !output.status.success() {
            return Err(DownloaderError::YtDlpFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        let info: YtDlpInfo = serde_json::from_slice(&output.stdout)
            .map_err(|e| DownloaderError::MetadataParse(e.to_string()))?;

        let duration_ms = info.duration.map(|d| (d * 1000.0).round() as u64).unwrap_or(0);

        Ok(VideoMetadata {
            video_id: info.id,
            title: info.title.unwrap_or_else(|| "Untitled".to_string()),
            channel: info
                .channel
                .or(info.uploader)
                .unwrap_or_else(|| "Unknown".to_string()),
            duration_ms,
        })
    }

    /// Download the video to `dest_path` (e.g. `<video_dir>/video.mp4`),
    /// invoking `on_event` for each parsed progress percentage and raw log
    /// line as they stream in.
    pub async fn download_video(
        &self,
        url: &str,
        dest_path: &Path,
        mut on_event: impl FnMut(ProgressEvent) + Send,
    ) -> Result<(), DownloaderError> {
        if let Some(parent) = dest_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let dest_str = dest_path.to_string_lossy().to_string();

        let mut child = Command::new(&self.bin)
            .args([
                "-f",
                self.format.as_str(),
                "--merge-output-format",
                "mp4",
                "--newline",
                "--no-warnings",
                "--no-playlist",
                "-o",
                dest_str.as_str(),
                url,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();

        let tx_out = tx.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx_out.send(line).is_err() {
                    break;
                }
            }
        });

        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });

        // Both tasks hold a sender clone; the channel closes once both finish.
        while let Some(line) = rx.recv().await {
            if let Some(pct) = parse_percent(&line) {
                on_event(ProgressEvent::Percent(pct));
            }
            on_event(ProgressEvent::Log(line));
        }

        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let status = child.wait().await?;
        if !status.success() {
            return Err(DownloaderError::YtDlpFailed(format!(
                "yt-dlp exited with status {status}"
            )));
        }

        Ok(())
    }

    /// Fetch **manual** (uploader-supplied, not auto-generated) Japanese
    /// closed captions for a video, converted to SRT and normalized to
    /// `cc_path` (e.g. `<video_dir>/cc.srt`). Tries `ja` then `ja-orig`
    /// (creator-uploaded original track, sometimes the only manual track
    /// present) and keeps whichever yt-dlp actually wrote, preferring `ja`
    /// if both exist. Deliberately uses `--write-subs` (NOT
    /// `--write-auto-subs`) so YouTube's auto-generated/auto-translated
    /// captions are never mistaken for the real thing.
    ///
    /// Returns `Ok(true)` if a manual ja track was found and written to
    /// `cc_path`, `Ok(false)` if the video simply has no manual ja
    /// captions -- yt-dlp writing nothing is the normal outcome for most
    /// videos, not an error. Intentionally separate from `download_video`
    /// so callers (like `extract_audio` below) can treat failures here as
    /// non-fatal: the video still downloads and the pipeline falls back to
    /// Whisper ASR.
    pub async fn fetch_manual_ja_subs(
        &self,
        url: &str,
        cc_path: &Path,
    ) -> Result<bool, DownloaderError> {
        let video_dir = cc_path.parent().unwrap_or_else(|| Path::new("."));
        tokio::fs::create_dir_all(video_dir).await?;

        // yt-dlp writes one file per matched language as `cc.<lang>.srt`
        // (e.g. `cc.ja.srt`), never `cc.srt` directly -- `normalize_cc_files`
        // below collapses whichever landed into the one known path.
        let out_tmpl = video_dir.join("cc.%(ext)s");
        let out_tmpl_str = out_tmpl.to_string_lossy().to_string();

        let output = Command::new(&self.bin)
            .args([
                "--write-subs",
                "--sub-langs",
                "ja,ja-orig",
                "--skip-download",
                "--convert-subs",
                "srt",
                "--no-warnings",
                "--no-playlist",
                "-o",
                out_tmpl_str.as_str(),
                url,
            ])
            .stdin(Stdio::null())
            .output()
            .await?;

        if !output.status.success() {
            return Err(DownloaderError::YtDlpFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        normalize_cc_files(video_dir, cc_path)
    }

    /// Extract a 16kHz mono WAV audio track from an already-downloaded video,
    /// for future Whisper ASR. Intentionally separate from `download_video`
    /// so callers can treat failures here as non-fatal.
    pub async fn extract_audio(
        &self,
        video_path: &Path,
        audio_path: &Path,
    ) -> Result<(), DownloaderError> {
        if let Some(parent) = audio_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let output = Command::new(&self.ffmpeg_bin)
            .args([
                "-y",
                "-i",
                &video_path.to_string_lossy(),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                &audio_path.to_string_lossy(),
            ])
            .stdin(Stdio::null())
            .output()
            .await?;

        if !output.status.success() {
            return Err(DownloaderError::FfmpegFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        Ok(())
    }
}

/// After a `--write-subs --sub-langs ja,ja-orig --convert-subs srt` run,
/// yt-dlp has written `cc.ja.srt` and/or `cc.ja-orig.srt` into `video_dir`
/// for whichever language(s) matched (or neither, the normal "no manual
/// CC" case). Collapse the result down to the one known `cc_path`,
/// preferring `ja` over `ja-orig` when both exist and removing the other
/// so a stale per-language file never lingers on disk.
///
/// Plain sync `std::fs` (not `tokio::fs`): these are a handful of local
/// metadata/rename calls on files yt-dlp just finished writing, small
/// enough not to need async, and keeping it sync lets it be unit-tested
/// with a plain `#[test]` below instead of a `#[tokio::test]`.
fn normalize_cc_files(video_dir: &Path, cc_path: &Path) -> Result<bool, DownloaderError> {
    let ja_path = video_dir.join("cc.ja.srt");
    let ja_orig_path = video_dir.join("cc.ja-orig.srt");

    let chosen = if ja_path.exists() {
        Some(ja_path)
    } else if ja_orig_path.exists() {
        Some(ja_orig_path)
    } else {
        None
    };

    for stray in [video_dir.join("cc.ja.srt"), video_dir.join("cc.ja-orig.srt")] {
        if chosen.as_deref() != Some(stray.as_path()) && stray.exists() {
            std::fs::remove_file(&stray)?;
        }
    }

    let Some(chosen) = chosen else {
        return Ok(false);
    };

    std::fs::rename(&chosen, cc_path)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_watch_url() {
        assert_eq!(
            extract_video_id("https://www.youtube.com/watch?v=BaW_jenozKc").unwrap(),
            "BaW_jenozKc"
        );
    }

    #[test]
    fn extracts_watch_url_with_extra_params() {
        assert_eq!(
            extract_video_id("https://www.youtube.com/watch?v=BaW_jenozKc&t=10s").unwrap(),
            "BaW_jenozKc"
        );
    }

    #[test]
    fn extracts_short_url() {
        assert_eq!(
            extract_video_id("https://youtu.be/BaW_jenozKc").unwrap(),
            "BaW_jenozKc"
        );
    }

    #[test]
    fn extracts_shorts_url() {
        assert_eq!(
            extract_video_id("https://www.youtube.com/shorts/BaW_jenozKc").unwrap(),
            "BaW_jenozKc"
        );
    }

    #[test]
    fn rejects_invalid_url() {
        assert!(extract_video_id("https://example.com/not-youtube").is_err());
    }

    #[test]
    fn parses_progress_percent() {
        assert_eq!(
            parse_percent("[download]  42.0% of   10.00MiB at  1.02MiB/s ETA 00:09"),
            Some(42)
        );
        assert_eq!(parse_percent("[download] Destination: video.mp4"), None);
    }

    /// A fresh throwaway dir under the OS temp dir, cleaned up on drop.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("rj-player-cc-test-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // Only needed by these tests; avoids adding uuid as a non-dev dependency
    // just for the ytdlp module.
    use uuid::Uuid;

    #[test]
    fn normalize_cc_files_prefers_ja_over_ja_orig() {
        let dir = TempDir::new();
        std::fs::write(dir.0.join("cc.ja.srt"), "ja content").unwrap();
        std::fs::write(dir.0.join("cc.ja-orig.srt"), "ja-orig content").unwrap();
        let cc_path = dir.0.join("cc.srt");

        let found = normalize_cc_files(&dir.0, &cc_path).expect("should not error");

        assert!(found);
        assert_eq!(std::fs::read_to_string(&cc_path).unwrap(), "ja content");
        assert!(!dir.0.join("cc.ja.srt").exists());
        assert!(!dir.0.join("cc.ja-orig.srt").exists(), "stray ja-orig file should be cleaned up");
    }

    #[test]
    fn normalize_cc_files_falls_back_to_ja_orig() {
        let dir = TempDir::new();
        std::fs::write(dir.0.join("cc.ja-orig.srt"), "orig content").unwrap();
        let cc_path = dir.0.join("cc.srt");

        let found = normalize_cc_files(&dir.0, &cc_path).expect("should not error");

        assert!(found);
        assert_eq!(std::fs::read_to_string(&cc_path).unwrap(), "orig content");
    }

    #[test]
    fn normalize_cc_files_no_manual_subs_is_not_an_error() {
        let dir = TempDir::new();
        let cc_path = dir.0.join("cc.srt");

        let found = normalize_cc_files(&dir.0, &cc_path).expect("no manual CC is not an error");

        assert!(!found);
        assert!(!cc_path.exists());
    }

    /// Network test against a real video confirmed (via `yt-dlp --list-subs`)
    /// to have only YouTube's auto-generated captions and NO manual Japanese
    /// track -- proves `fetch_manual_ja_subs` treats that as a graceful
    /// `Ok(false)`, not an error, end to end through the real `yt-dlp`
    /// binary (not just the pure `normalize_cc_files` logic above).
    /// `#[ignore]`d so `cargo test` stays hermetic/offline by default; run
    /// explicitly with `cargo test -- --ignored fetch_manual_ja_subs_is_ok_false_for_a_video_with_no_manual_cc`.
    #[tokio::test]
    #[ignore]
    async fn fetch_manual_ja_subs_is_ok_false_for_a_video_with_no_manual_cc() {
        let dir = TempDir::new();
        let cc_path = dir.0.join("cc.srt");
        let ytdlp = YtDlp::new("yt-dlp", "ffmpeg", "best");

        let found = ytdlp
            .fetch_manual_ja_subs("https://www.youtube.com/watch?v=3cXUHPT2isw", &cc_path)
            .await
            .expect("yt-dlp run itself should succeed even with no matching subs");

        assert!(!found, "this video has no manual ja subs -- expected Ok(false)");
        assert!(!cc_path.exists());
    }
}
