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
    target_source: Optional[str] = None,
) -> dict:
    """Build the canonical SubtitleDoc.

    {version:1, video_id, language_source, target_lang, duration_ms,
     cues:[{id,start_ms,end_ms,source_text,tokens,phonetic,target_text}], source}

    `translate_partial` is an additive (non-breaking) field, set only when
    translation was requested but degraded for at least one cue -- see
    dsd.md §7's instruction to mark such docs. It is omitted entirely when
    translation wasn't requested or fully succeeded, so it never changes
    the shape of the "happy path" doc.

    `source` is likewise additive: which stage produced the source text/timing
    -- `"asr"` (Whisper), `"cc"` (manual Japanese CC), or `"align"` (forced
    alignment against user-supplied reference lyrics). `worker.py` passes it
    through from whichever branch of the ASR-stage precedence
    (reference_lyrics > CC > ASR) actually ran; omitted when not given, for
    backward compatibility with any caller that doesn't track it.

    `target_source` (dsd.md §12.4/§12.5/§12.7, B5.5) is likewise additive:
    which stage produced `target_text` -- `"cc"` (a manual Chinese CC track
    was time-overlap-merged onto the source timeline, zero LLM calls) or
    `"llm"` (machine-translated). Omitted (not even `None`/`null`) when not
    given, same convention as `source`.
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
    if target_source:
        doc["target_source"] = target_source
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

    Cues are normalized to the full Rust `Cue` shape: a mid-tokenize crash
    leaves some/all cues without `tokens`/`phonetic`/`target_text` (they're
    filled incrementally by worker.py's stage loops), and the Rust side's
    `Cue` requires `tokens`/`phonetic` with no serde defaults — an
    un-normalized partial would fail to deserialize, turning the real stage
    error into a protocol violation and losing the partial work entirely
    (the exact thing this doc exists to prevent).
    """
    doc: dict = {
        "version": 1,
        "video_id": video_id,
        "language_source": source_lang,
        "target_lang": target_lang,
        "duration_ms": duration_ms or 0,
        "cues": [
            {
                **cue,
                "source_text": cue.get("source_text") or "",
                "tokens": cue.get("tokens", []),
                "phonetic": cue.get("phonetic", ""),
                "target_text": cue.get("target_text"),
            }
            for cue in cues
        ],
    }
    if source:
        doc["source"] = source
    return doc
