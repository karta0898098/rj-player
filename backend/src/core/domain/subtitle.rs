//! Canonical `SubtitleDoc` (dsd.md §5.1) — the three-layer (ja / romaji / zh)
//! subtitle document that lands as `subtitles.json` and is what the Python
//! worker's `result` event carries and what `GET /api/videos/:id/subtitles`
//! serves verbatim.
//!
//! Kept free of any HTTP/axum types (Tauri migration seam, see dsd.md §10).

use serde::{Deserialize, Serialize};

/// Current schema version. Bump this whenever the `SubtitleDoc` shape or the
/// pipeline that produces it changes in a way that should invalidate
/// existing `subtitles.json` caches (dsd.md §5.1/§7 cache-miss rule: a
/// cached doc whose `version` doesn't match this constant is treated as a
/// miss and regenerated).
pub const SUBTITLE_DOC_VERSION: u32 = 1;

/// One token of a tokenized Japanese sentence (dsd.md §4.2).
///
/// `t` is the surface form; concatenating every token's `t` in order must
/// reconstruct the cue's `source_text` exactly (this is what lets the frontend
/// render `<ruby>` for kanji tokens while falling back to plain text for
/// everything else, without losing the original sentence layout).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Token {
    pub t: String,
    /// Furigana reading, present only for tokens that need one (kanji).
    /// Omitted from JSON entirely when absent, rather than serialized as
    /// `null`, per dsd.md §4.2's example payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reading: Option<String>,
}

/// A single subtitle cue spanning `[start_ms, end_ms)` (dsd.md §5.1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cue {
    pub id: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(alias = "ja_text")]
    pub source_text: String,
    #[serde(alias = "ja_tokens")]
    pub tokens: Vec<Token>,
    #[serde(alias = "romaji")]
    pub phonetic: String,
    /// Translated text. Explicitly nullable (serialized as JSON `null`, not
    /// omitted) so a translation failure can degrade gracefully — the doc
    /// still lands with source text + phonetic intact and the frontend
    /// leaves the target layer blank instead of losing the whole cue
    /// (dsd.md §7).
    #[serde(alias = "zh_text")]
    pub target_text: Option<String>,
}

/// The canonical three-layer subtitle document (dsd.md §5.1), persisted as
/// `<data_dir>/videos/<video_id>/subtitles.json` and returned verbatim by
/// `GET /api/videos/:id/subtitles`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleDoc {
    pub version: u32,
    pub video_id: String,
    pub language_source: String,
    pub target_lang: String,
    pub duration_ms: u64,
    pub cues: Vec<Cue>,
    /// Set by the Python worker when translation was requested but degraded
    /// (missing API key or repeated LLM failure) — the doc still lands with
    /// source text + phonetic and null `target_text`s (dsd.md §7). Preserved verbatim through
    /// the Rust round-trip so the frontend can surface a "translation
    /// incomplete" hint; absent on the fully-translated / no-translation paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translate_partial: Option<bool>,
    /// Which ASR-stage source produced the `source_text`/timing for this doc's
    /// cues: `"asr"` (Whisper free transcription), `"cc"` (manual Japanese
    /// closed captions), or `"align"` (forced alignment against
    /// user-supplied `reference_lyrics`). Set by `ai/pipeline/assemble.py`;
    /// `#[serde(default)]` keeps older `subtitles.json` files (written
    /// before this field existed) deserializing fine as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Which stage produced `target_text`: `"cc"` (a manual Chinese CC
    /// track was time-overlap-merged onto the source timeline, dsd.md
    /// §12.4/§12.5/§12.7 B5.5 -- zero LLM calls) or `"llm"`
    /// (machine-translated). Absent means no translation was attempted.
    /// Additive, just like `source` above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_source: Option<String>,
}
