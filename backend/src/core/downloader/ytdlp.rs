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
    /// Whether yt-dlp's `categories` field flagged this as a music video
    /// (the queue feature's music-MV auto-detect, dsd.md §2/§8). Confirmed
    /// sufficient on its own -- no title-keyword fallback.
    pub is_music: bool,
    /// Auto-detected source language ("ja"/"en"), the source-language
    /// auto-detect extension: lets `POST /api/videos/preview` pre-select the
    /// add-to-queue form's 來源語言 picker. See `detect_source_lang` for the
    /// detection priority. Always `Some` -- the detector always resolves to
    /// a concrete code (falling back to "ja" historically) -- kept as an
    /// `Option` only for symmetry with the rest of this struct's optionality.
    pub detected_lang: Option<String>,
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
    #[serde(default)]
    categories: Vec<String>,
    /// yt-dlp's own detected spoken-language guess (e.g. `"en"`, `"ja"`),
    /// when it has one -- one of `detect_source_lang`'s signals.
    #[serde(default)]
    language: Option<String>,
    /// Keys are the available auto-generated-caption language codes (e.g.
    /// `"en"`, `"ja"`, `"en-orig"`); values are yt-dlp's per-language track
    /// list, which we don't need the shape of -- `serde_json::Value` so an
    /// unexpected shape there can never fail metadata parsing.
    #[serde(default)]
    automatic_captions: std::collections::HashMap<String, serde_json::Value>,
    /// Same shape as `automatic_captions` but for manual (uploader-supplied)
    /// subtitle tracks -- also a `detect_source_lang` signal.
    #[serde(default)]
    subtitles: std::collections::HashMap<String, serde_json::Value>,
}

/// Whether `categories` (yt-dlp's own YouTube category classification)
/// marks this as a music video -- currently the sole signal used for
/// music-MV auto-detect, kept as a pure function so it's unit-testable
/// without invoking the real `yt-dlp` subprocess.
fn is_music_category(categories: &[String]) -> bool {
    categories.iter().any(|c| c == "Music")
}

/// Auto-detect a video's source language ("ja"/"en") for the add-to-queue
/// form's 來源語言 picker (`POST /api/videos/preview`'s `source_lang`). Pure
/// function -- no I/O -- so it's unit-testable without invoking the real
/// `yt-dlp` subprocess. Priority, highest first:
///
/// 1. `title` contains a hiragana/katakana character (U+3040..=U+30FF) --
///    kana is definitively Japanese, romaji/kanji-only titles are ambiguous
///    (kanji also appears in Chinese) so this check alone can't rule EN in,
///    only rule JA in.
/// 2. `language` (yt-dlp's own detected-language guess, lowercased):
///    `starts_with("ja")` -> "ja"; `starts_with("en")` -> "en".
/// 3. `caption_langs` (the available auto/manual caption language codes):
///    a "ja"-prefixed code present but no "en"-prefixed one -> "ja"; an
///    "en"-prefixed code present but no "ja"-prefixed one -> "en".
/// 4. Otherwise "ja" -- the historical default (every video before this
///    detector existed was treated as Japanese) -- the picker stays
///    overridable in the UI either way.
pub fn detect_source_lang(title: &str, language: Option<&str>, caption_langs: &[String]) -> String {
    if title.chars().any(|c| ('\u{3040}'..='\u{30FF}').contains(&c)) {
        return "ja".to_string();
    }

    if let Some(lang) = language {
        let lower = lang.to_lowercase();
        if lower.starts_with("ja") {
            return "ja".to_string();
        }
        if lower.starts_with("en") {
            return "en".to_string();
        }
    }

    let has_ja = caption_langs.iter().any(|c| c.to_lowercase().starts_with("ja"));
    let has_en = caption_langs.iter().any(|c| c.to_lowercase().starts_with("en"));
    if has_ja && !has_en {
        return "ja".to_string();
    }
    if has_en && !has_ja {
        return "en".to_string();
    }

    "ja".to_string()
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
        let is_music = is_music_category(&info.categories);

        let title = info.title.unwrap_or_else(|| "Untitled".to_string());
        let caption_langs: Vec<String> = info
            .automatic_captions
            .keys()
            .chain(info.subtitles.keys())
            .cloned()
            .collect();
        let detected_lang = detect_source_lang(&title, info.language.as_deref(), &caption_langs);

        Ok(VideoMetadata {
            video_id: info.id,
            title,
            channel: info
                .channel
                .or(info.uploader)
                .unwrap_or_else(|| "Unknown".to_string()),
            duration_ms,
            is_music,
            detected_lang: Some(detected_lang),
        })
    }

    /// The configured default format selector (`config.yt_dlp_format`),
    /// exposed so callers (the job queue) can pass it as
    /// `format_for_max_height`'s `default_format` argument when no per-video
    /// quality cap was chosen for a given video.
    pub fn default_format(&self) -> &str {
        &self.format
    }

    /// Build the effective yt-dlp `-f` format selector for a per-video
    /// quality cap (the per-video quality picker, add-to-queue form).
    /// Associated function (no `self`) so it's callable/unit-testable
    /// without a real `YtDlp` instance -- no I/O.
    ///
    /// - `None` -- no per-video cap chosen (old on-disk videos, or any
    ///   caller that predates this feature) -- returns `default_format`
    ///   unchanged (the configured `config.yt_dlp_format`), so behavior
    ///   stays byte-identical.
    /// - `Some(0)` -- "best available" (uncapped): mirrors the default's
    ///   H.264-preferred fallback chain but WITHOUT any `height<=N` clause.
    /// - `Some(h)` -- the same fallback chain as the config default, capped
    ///   at `h` instead of whatever `default_format` was capped at.
    pub fn format_for_max_height(max_height: Option<u32>, default_format: &str) -> String {
        match max_height {
            None => default_format.to_string(),
            Some(0) => {
                "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"
                    .to_string()
            }
            Some(h) => format!(
                "bv*[vcodec^=avc1][height<={h}]+ba[acodec^=mp4a]/\
                 bv*[ext=mp4][height<={h}]+ba[ext=m4a]/\
                 b[ext=mp4][height<={h}]/b[height<={h}]/b"
            ),
        }
    }

    /// Download the video to `dest_path` (e.g. `<video_dir>/video.mp4`),
    /// using `format` as the yt-dlp `-f` selector (see
    /// `format_for_max_height` -- callers resolve the effective format
    /// before calling this), and invoking `on_event` for each parsed
    /// progress percentage and raw log line as they stream in.
    pub async fn download_video(
        &self,
        url: &str,
        dest_path: &Path,
        format: &str,
        mut on_event: impl FnMut(ProgressEvent) + Send,
    ) -> Result<(), DownloaderError> {
        if let Some(parent) = dest_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let dest_str = dest_path.to_string_lossy().to_string();

        let mut child = Command::new(&self.bin)
            .args([
                "-f",
                format,
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

    /// Fetch **manual** (uploader-supplied, not auto-generated) closed
    /// captions for BOTH the video's source language and Chinese, in a
    /// single `yt-dlp --write-subs` pass (dsd.md §12.4/§12.5/§12.7, B5.5 --
    /// generalized from the source-only `fetch_source_captions` of B5.4).
    /// Converts to SRT and normalizes each track to its own known path:
    /// `source_cc_path` (e.g. `<video_dir>/cc.srt`) and `target_cc_path`
    /// (e.g. `<video_dir>/cc.zh.srt`). `video_dir` is derived from
    /// `source_cc_path`'s parent.
    ///
    /// Source-track priority (dsd.md §12.7's ASR-skip broadening): the
    /// selected `source_lang` wins, then English, then Japanese -- and within
    /// each language the plain `<lang>` track beats its `<lang>-orig`
    /// (creator-uploaded original) variant. So the search order is
    /// `source_lang, source_lang-orig, en, en-orig, ja, ja-orig` (deduped when
    /// `source_lang` is itself `en`/`ja`). The point: a video whose selected
    /// source language has no manual CC but which DOES ship an English or
    /// Japanese one can still skip Whisper -- we just use that CC as the
    /// source transcript and translate from it. The matched language is
    /// returned so the caller can persist it (`meta.source_cc_lang`), because
    /// it drives the worker's romaji/translate stages and may differ from
    /// `source_lang`.
    ///
    /// Target (Chinese) priority: `zh-Hant` > `zh-TW` > `zh-HK` > `zh` --
    /// simplified (`zh-Hans`/`zh-CN`) is deliberately NOT requested; converting
    /// it to Traditional needs OpenCC, deferred (dsd.md §12.8). Deliberately
    /// uses `--write-subs` (NOT `--write-auto-subs`) so YouTube's
    /// auto-generated/auto-translated captions are never mistaken for the
    /// real thing.
    ///
    /// A source-track hit is what lets the pipeline's source-track
    /// precedence (`reference_lyrics > manual CC > Whisper ASR`, enforced in
    /// `ai/worker.py`) skip ASR entirely for this video. A target-track hit
    /// is what lets the worker skip the LLM translate call entirely and use
    /// the official Chinese CC instead (`doc.target_source == "cc"`).
    ///
    /// Returns `Ok((source_cc_lang, target_found))`: `source_cc_lang` is the
    /// matched source-CC language (`Some("ja")`/`Some("en")`/...) or `None`
    /// when no source CC was found; `target_found` is whether a Chinese CC
    /// landed. Either may be empty -- yt-dlp finding nothing for a given track
    /// is the normal outcome for most videos, not an error. Intentionally
    /// separate from `download_video` so callers (like `extract_audio` below)
    /// can treat failures here as non-fatal: the video still downloads and the
    /// pipeline falls back to Whisper ASR / LLM translation as needed.
    pub async fn fetch_captions(
        &self,
        url: &str,
        source_cc_path: &Path,
        target_cc_path: &Path,
        source_lang: &str,
    ) -> Result<(Option<String>, bool), DownloaderError> {
        let video_dir = source_cc_path.parent().unwrap_or_else(|| Path::new("."));
        tokio::fs::create_dir_all(video_dir).await?;

        // Source-track search: the selected `source_lang` ONLY (plain track,
        // then its `-orig` creator-uploaded variant). Deliberately NO
        // cross-language fallback to `en`/`ja`: a CC in a language other than
        // the audio is a *translation*, not a transcript, so using it as the
        // source layer produces the wrong text (e.g. a Japanese video with an
        // English CC would come out with English source text). If there's no
        // manual CC in the source language we let the pipeline fall back to
        // Whisper ASR on the real audio instead. Matches dsd.md §12.7 B5.4
        // ("抓取來源語人工 CC").
        let source_priority: Vec<String> =
            vec![source_lang.to_string(), format!("{source_lang}-orig")];
        let target_priority = ["zh-Hant", "zh-TW", "zh-HK", "zh"];

        // yt-dlp writes one file per matched language as `cc.<lang>.srt`
        // (e.g. `cc.ja.srt`/`cc.en.srt`/`cc.zh-Hant.srt`), never a fixed
        // filename directly -- `normalize_cc_files` below collapses whichever
        // landed into the caller-specified known path, once per track.
        let out_tmpl = video_dir.join("cc.%(ext)s");
        let out_tmpl_str = out_tmpl.to_string_lossy().to_string();
        let sub_langs = source_priority
            .iter()
            .map(String::as_str)
            .chain(target_priority)
            .collect::<Vec<_>>()
            .join(",");

        let output = Command::new(&self.bin)
            .args([
                "--write-subs",
                "--sub-langs",
                sub_langs.as_str(),
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

        let source_priority_refs: Vec<&str> =
            source_priority.iter().map(String::as_str).collect();
        // Map the matched priority entry (e.g. `"en-orig"`) back to its base
        // language (`"en"`) -- that's the CC's real language, what the pipeline
        // needs as the worker's `source_lang`.
        let source_cc_lang = normalize_cc_files(video_dir, source_cc_path, &source_priority_refs)?
            .map(|matched| {
                matched
                    .strip_suffix("-orig")
                    .unwrap_or(&matched)
                    .to_string()
            });
        let target_found =
            normalize_cc_files(video_dir, target_cc_path, &target_priority)?.is_some();

        Ok((source_cc_lang, target_found))
    }

    /// Fetch the video's poster thumbnail, converted to JPEG and normalized
    /// to `thumbnail_path` (e.g. `<video_dir>/thumbnail.jpg`). Mirrors
    /// `fetch_captions`: a separate, non-fatal step so a thumbnail
    /// failure never blocks marking the video downloaded/usable. yt-dlp writes
    /// `thumbnail.<ext>`; `--convert-thumbnails jpg` (which uses ffmpeg) turns
    /// it into `thumbnail.jpg`, and `normalize_thumbnail_files` collapses the
    /// result to the one known path.
    ///
    /// Returns `Ok(true)` if a thumbnail was written, `Ok(false)` if none was
    /// available for the video.
    pub async fn fetch_thumbnail(
        &self,
        url: &str,
        thumbnail_path: &Path,
    ) -> Result<bool, DownloaderError> {
        let video_dir = thumbnail_path.parent().unwrap_or_else(|| Path::new("."));
        tokio::fs::create_dir_all(video_dir).await?;

        let out_tmpl = video_dir.join("thumbnail.%(ext)s");
        let out_tmpl_str = out_tmpl.to_string_lossy().to_string();

        let mut args: Vec<String> = vec![
            "--write-thumbnail".into(),
            "--skip-download".into(),
            "--convert-thumbnails".into(),
            "jpg".into(),
            "--no-warnings".into(),
            "--no-playlist".into(),
            "-o".into(),
            out_tmpl_str,
        ];
        // `--convert-thumbnails jpg` shells out to ffmpeg. When the configured
        // ffmpeg is an explicit path (not a bare `ffmpeg` resolved via PATH),
        // point yt-dlp at it so conversion works in the same setups audio
        // extraction does.
        if self.ffmpeg_bin.contains('/') {
            args.push("--ffmpeg-location".into());
            args.push(self.ffmpeg_bin.clone());
        }
        args.push(url.to_string());

        let output = Command::new(&self.bin)
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .await?;

        if !output.status.success() {
            return Err(DownloaderError::YtDlpFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        normalize_thumbnail_files(video_dir, thumbnail_path)
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

/// After a `--write-subs --sub-langs <lang1>,<lang2>,... --convert-subs srt`
/// run, yt-dlp has written `cc.<lang>.srt` into `video_dir` for whichever of
/// `lang_priority`'s codes matched (zero, one, or several -- e.g. both a
/// `zh-Hant` and a `zh` track can exist on the same video). Collapse the
/// result down to the one known `out_path`, picking the FIRST code in
/// `lang_priority` order that has a file on disk and removing every other
/// candidate among `lang_priority` so a stale per-language file never
/// lingers. Generalized (B5.5) from the original hardcoded `[lang,
/// lang-orig]` pair -- used for both the source-language priority list and
/// the target (Chinese) priority list.
///
/// Plain sync `std::fs` (not `tokio::fs`): these are a handful of local
/// metadata/rename calls on files yt-dlp just finished writing, small
/// enough not to need async, and keeping it sync lets it be unit-tested
/// with a plain `#[test]` below instead of a `#[tokio::test]`.
/// Returns the `lang_priority` entry that matched (e.g. `"ja"`, `"ja-orig"`,
/// `"en"`), or `None` when the video had no manual CC in any of the requested
/// languages. Callers that only care whether a track landed use `.is_some()`;
/// the source-track caller needs the actual matched language to persist it
/// (the CC's real language can differ from the video's selected `source_lang`
/// -- see `fetch_captions`).
fn normalize_cc_files(
    video_dir: &Path,
    out_path: &Path,
    lang_priority: &[&str],
) -> Result<Option<String>, DownloaderError> {
    let candidates: Vec<std::path::PathBuf> = lang_priority
        .iter()
        .map(|lang| video_dir.join(format!("cc.{lang}.srt")))
        .collect();

    let chosen_idx = candidates.iter().position(|p| p.exists());

    for (i, stray) in candidates.iter().enumerate() {
        if chosen_idx != Some(i) && stray.exists() {
            std::fs::remove_file(stray)?;
        }
    }

    let Some(idx) = chosen_idx else {
        return Ok(None);
    };

    std::fs::rename(&candidates[idx], out_path)?;
    Ok(Some(lang_priority[idx].to_string()))
}

/// After a `--write-thumbnail --convert-thumbnails jpg` run, yt-dlp has
/// written `thumbnail.jpg` (or, if conversion was skipped, a
/// `thumbnail.webp`/`.png`/`.jpeg` original) into `video_dir`. Collapse the
/// result to the one known `thumbnail_path`, preferring an already-`.jpg`
/// file and cleaning up any other `thumbnail.*` image strays so a stale
/// original never lingers. Same sync-`std::fs` rationale as
/// `normalize_cc_files`.
fn normalize_thumbnail_files(
    video_dir: &Path,
    thumbnail_path: &Path,
) -> Result<bool, DownloaderError> {
    let jpg = video_dir.join("thumbnail.jpg");
    let jpeg = video_dir.join("thumbnail.jpeg");

    let chosen = if jpg.exists() {
        Some(jpg)
    } else if jpeg.exists() {
        Some(jpeg)
    } else {
        None
    };

    for ext in ["webp", "png", "jpeg", "jpg"] {
        let stray = video_dir.join(format!("thumbnail.{ext}"));
        if chosen.as_deref() != Some(stray.as_path()) && stray.exists() {
            let _ = std::fs::remove_file(&stray);
        }
    }

    let Some(chosen) = chosen else {
        return Ok(false);
    };

    if chosen != *thumbnail_path {
        std::fs::rename(&chosen, thumbnail_path)?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_music_category_true_when_categories_include_music() {
        assert!(is_music_category(&["Music".to_string()]));
        assert!(is_music_category(&[
            "Music".to_string(),
            "People & Blogs".to_string()
        ]));
    }

    #[test]
    fn is_music_category_false_when_no_music_category() {
        assert!(!is_music_category(&["Entertainment".to_string()]));
        assert!(!is_music_category(&[]));
    }

    #[test]
    fn format_for_max_height_none_passes_through_default() {
        assert_eq!(
            YtDlp::format_for_max_height(None, "bv*[height<=1080]/b"),
            "bv*[height<=1080]/b"
        );
    }

    #[test]
    fn format_for_max_height_zero_is_uncapped() {
        let format = YtDlp::format_for_max_height(Some(0), "bv*[height<=1080]/b");
        assert!(!format.contains("height<="), "uncapped format must not contain a height<= clause: {format}");
        assert_eq!(
            format,
            "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"
        );
    }

    #[test]
    fn format_for_max_height_some_caps_at_the_given_height() {
        let format = YtDlp::format_for_max_height(Some(720), "bv*[height<=1080]/b");
        assert!(format.contains("height<=720"), "expected a height<=720 clause: {format}");
        assert!(!format.contains("1080"), "must not retain the default's 1080 cap: {format}");
    }

    #[test]
    fn detect_source_lang_kana_title_is_ja() {
        assert_eq!(detect_source_lang("こんにちは世界", None, &[]), "ja");
        assert_eq!(detect_source_lang("カタカナ Title", Some("en"), &[]), "ja");
    }

    #[test]
    fn detect_source_lang_ascii_title_with_language_en_is_en() {
        assert_eq!(detect_source_lang("Some English Title", Some("en"), &[]), "en");
    }

    #[test]
    fn detect_source_lang_ascii_title_with_ja_captions_is_ja() {
        assert_eq!(
            detect_source_lang("Some Title", None, &["ja".to_string(), "ja-orig".to_string()]),
            "ja"
        );
    }

    #[test]
    fn detect_source_lang_ascii_title_with_nothing_defaults_to_ja() {
        assert_eq!(detect_source_lang("Some Title", None, &[]), "ja");
    }

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

        let found = normalize_cc_files(&dir.0, &cc_path, &["ja", "ja-orig"]).expect("should not error");

        assert!(found.is_some());
        assert_eq!(std::fs::read_to_string(&cc_path).unwrap(), "ja content");
        assert!(!dir.0.join("cc.ja.srt").exists());
        assert!(!dir.0.join("cc.ja-orig.srt").exists(), "stray ja-orig file should be cleaned up");
    }

    #[test]
    fn normalize_cc_files_falls_back_to_ja_orig() {
        let dir = TempDir::new();
        std::fs::write(dir.0.join("cc.ja-orig.srt"), "orig content").unwrap();
        let cc_path = dir.0.join("cc.srt");

        let found = normalize_cc_files(&dir.0, &cc_path, &["ja", "ja-orig"]).expect("should not error");

        assert_eq!(
            found.as_deref(),
            Some("ja-orig"),
            "must report the actual matched language entry, not just that one landed"
        );
        assert_eq!(std::fs::read_to_string(&cc_path).unwrap(), "orig content");
    }

    #[test]
    fn normalize_cc_files_no_manual_subs_is_not_an_error() {
        let dir = TempDir::new();
        let cc_path = dir.0.join("cc.srt");

        let found = normalize_cc_files(&dir.0, &cc_path, &["ja", "ja-orig"]).expect("no manual CC is not an error");

        assert!(found.is_none());
        assert!(!cc_path.exists());
    }

    /// dsd.md §12.4/§12.7 (B5.4): `normalize_cc_files` must generalize past
    /// the originally-hardcoded `ja` filenames -- proves an English manual CC
    /// (`cc.en.srt`) collapses to `cc_path` just like a Japanese one does.
    #[test]
    fn normalize_cc_files_handles_english() {
        let dir = TempDir::new();
        std::fs::write(dir.0.join("cc.en.srt"), "english content").unwrap();
        let cc_path = dir.0.join("cc.srt");

        let found = normalize_cc_files(&dir.0, &cc_path, &["en", "en-orig"]).expect("should not error");

        assert!(found.is_some());
        assert_eq!(std::fs::read_to_string(&cc_path).unwrap(), "english content");
        assert!(!dir.0.join("cc.en.srt").exists());
    }

    /// Same generalization proof as `normalize_cc_files_prefers_ja_over_ja_orig`,
    /// but for a non-Japanese `source_lang`: the plain `<lang>` file must
    /// still win over `<lang>-orig` when both exist, and the stray must be
    /// cleaned up.
    #[test]
    fn normalize_cc_files_prefers_en_over_en_orig() {
        let dir = TempDir::new();
        std::fs::write(dir.0.join("cc.en.srt"), "en content").unwrap();
        std::fs::write(dir.0.join("cc.en-orig.srt"), "en-orig content").unwrap();
        let cc_path = dir.0.join("cc.srt");

        let found = normalize_cc_files(&dir.0, &cc_path, &["en", "en-orig"]).expect("should not error");

        assert!(found.is_some());
        assert_eq!(std::fs::read_to_string(&cc_path).unwrap(), "en content");
        assert!(!dir.0.join("cc.en.srt").exists());
        assert!(!dir.0.join("cc.en-orig.srt").exists(), "stray en-orig file should be cleaned up");
    }

    /// dsd.md §12.4/§12.5/§12.7 (B5.5): the target (Chinese) priority list
    /// must pick `zh-Hant` over a lower-priority `zh` when both exist, and
    /// clean up the stray -- same shape as the source-language priority
    /// proof above, but for the generalized multi-candidate list used by
    /// `fetch_captions`'s target track.
    #[test]
    fn normalize_cc_files_target_priority_prefers_zh_hant_over_zh() {
        let dir = TempDir::new();
        std::fs::write(dir.0.join("cc.zh.srt"), "zh content").unwrap();
        std::fs::write(dir.0.join("cc.zh-Hant.srt"), "zh-Hant content").unwrap();
        let target_cc_path = dir.0.join("cc.zh.target.srt");

        let found = normalize_cc_files(&dir.0, &target_cc_path, &["zh-Hant", "zh-TW", "zh-HK", "zh"])
            .expect("should not error");

        assert!(found.is_some());
        assert_eq!(std::fs::read_to_string(&target_cc_path).unwrap(), "zh-Hant content");
        assert!(!dir.0.join("cc.zh-Hant.srt").exists());
        assert!(!dir.0.join("cc.zh.srt").exists(), "stray zh file should be cleaned up");
    }

    /// Network test against a real video confirmed (via `yt-dlp --list-subs`)
    /// to have only YouTube's auto-generated captions and NO manual Japanese
    /// track -- proves `fetch_captions` treats that as a graceful
    /// `Ok((false, _))`, not an error, end to end through the real `yt-dlp`
    /// binary (not just the pure `normalize_cc_files` logic above).
    /// `#[ignore]`d so `cargo test` stays hermetic/offline by default; run
    /// explicitly with `cargo test -- --ignored fetch_source_captions_is_ok_false_for_a_video_with_no_manual_cc`.
    #[tokio::test]
    #[ignore]
    async fn fetch_source_captions_is_ok_false_for_a_video_with_no_manual_cc() {
        let dir = TempDir::new();
        let cc_path = dir.0.join("cc.srt");
        let target_cc_path = dir.0.join("cc.zh.srt");
        let ytdlp = YtDlp::new("yt-dlp", "ffmpeg", "best");

        let (source_cc_lang, _target_found) = ytdlp
            .fetch_captions(
                "https://www.youtube.com/watch?v=3cXUHPT2isw",
                &cc_path,
                &target_cc_path,
                "ja",
            )
            .await
            .expect("yt-dlp run itself should succeed even with no matching subs");

        assert!(source_cc_lang.is_none(), "this video has no manual subs -- expected None");
        assert!(!cc_path.exists());
    }
}
