"""Assemble stage: build the canonical SubtitleDoc per dsd.md §5.1."""
from __future__ import annotations

from typing import Optional


def assemble(
    video_id: str,
    source_lang: str,
    target_lang: str,
    duration_ms: int,
    cues: list[dict],
    translate_requested: bool,
    degraded: bool,
    source: Optional[str] = None,
) -> dict:
    """Build the canonical SubtitleDoc.

    {version:1, video_id, language_source, target_lang, duration_ms,
     cues:[{id,start_ms,end_ms,ja_text,ja_tokens,romaji,zh_text}], source}

    `translate_partial` is an additive (non-breaking) field, set only when
    translation was requested but degraded for at least one cue -- see
    dsd.md §7's instruction to mark such docs. It is omitted entirely when
    translation wasn't requested or fully succeeded, so it never changes
    the shape of the "happy path" doc.

    `source` is likewise additive: which stage produced the ja text/timing
    -- `"asr"` (Whisper), `"cc"` (manual Japanese CC), or `"align"` (forced
    alignment against user-supplied reference lyrics). `worker.py` passes it
    through from whichever branch of the ASR-stage precedence
    (reference_lyrics > CC > ASR) actually ran; omitted when not given, for
    backward compatibility with any caller that doesn't track it.
    """
    doc: dict = {
        "version": 1,
        "video_id": video_id,
        "language_source": source_lang,
        "target_lang": target_lang,
        "duration_ms": duration_ms,
        "cues": cues,
    }
    if translate_requested and degraded:
        doc["translate_partial"] = True
    if source:
        doc["source"] = source
    return doc


def partial_doc(
    video_id: str,
    source_lang: str,
    target_lang: str,
    duration_ms: Optional[int],
    cues: list[dict],
    source: Optional[str] = None,
) -> dict:
    """Best-effort doc for the `partial` field of an `error` event.

    Used when a fatal exception happens mid-pipeline (e.g. tokenize/romaji
    crash) after ASR already produced segments, so the caller doesn't lose
    everything that *did* complete.
    """
    doc: dict = {
        "version": 1,
        "video_id": video_id,
        "language_source": source_lang,
        "target_lang": target_lang,
        "duration_ms": duration_ms,
        "cues": cues,
    }
    if source:
        doc["source"] = source
    return doc
