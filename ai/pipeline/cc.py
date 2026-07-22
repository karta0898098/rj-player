"""Manual CC stage: parse an official closed-caption file into the
same (segments, duration_ms) shape `asr.transcribe`/`align.align` return.

Used INSTEAD OF `asr.transcribe` (and instead of `align.align`, unless the
caller also supplied `reference_lyrics`, which wins -- see `worker.py`'s
precedence) when the downloaded video has a **manual** (uploader-supplied,
not auto-generated) source-language CC track -- `backend/src/core/
downloader/ytdlp.rs`'s `fetch_captions` fetches it at download time,
converted to SRT, and normalized to `<video_dir>/cc.srt`. A manual CC track
already has correct text AND correct timing, so there's nothing for
ASR/alignment to do here -- just parse the file and clean each cue's text.

Hand-written SRT parser (no new dependency -- SRT is simple: index /
`HH:MM:SS,mmm --> HH:MM:SS,mmm` / text lines / blank-line separator). Also
tolerates `.`-separated milliseconds (VTT's convention) and a leading
`WEBVTT` header, so a VTT-ish file parses too, even though in practice
`ytdlp.rs` always converts to real SRT via `--convert-subs srt`.

Also home to `merge_target_captions` (dsd.md §12.4/§12.5/§12.7, B5.5): the
time-overlap merge that lets a manual target-language (Chinese) CC track
stand in for the LLM translate stage. The source track owns the timeline --
v1 is deliberately the conservative approach (dsd.md §12.4's "v1 保守法"):
each source cue collects whichever target segments overlap it in time and
joins their text, rather than attempting precise dual-track cue alignment
(left for a future §12.8).
"""
from __future__ import annotations

import re
import wave
from pathlib import Path
from typing import Iterator, Optional, TypedDict

from . import protocol


class Segment(TypedDict):
    start_ms: int
    end_ms: int
    text: str


# `HH:MM:SS[,.]mmm --> HH:MM:SS[,.]mmm`, tolerating a `,` (SRT) or `.` (VTT)
# millisecond separator, 1-3 digit milliseconds, and trailing VTT cue-settings
# text after the second timestamp (e.g. `align:start position:10%`), which
# this regex simply ignores by not anchoring the end of the line.
_TIME_RE = re.compile(
    r"(\d{2,}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[.,](\d{1,3})"
)

_TAG_RE = re.compile(r"<[^>]*>")
_MUSIC_MARK_RE = re.compile(r"[♪♫♬♩]")
# A line that consists ENTIRELY of a bracketed sound/music cue, e.g. "[音楽]",
# "[Music]", "(拍手)", "【笑い】" -- dropped wholesale, not just de-bracketed,
# since there's no dialogue content left once the marker is gone.
_BRACKET_ONLY_RE = re.compile(r"^[\[\(（【].*[\]\)）】]$")
# A short, trivially-detectable leading "speaker label" immediately followed
# by a colon (half- or full-width), e.g. "花子：おはよう" -> "おはよう",
# "Tom: hello" -> "hello". Deliberately conservative: the label can't start
# with a digit (avoids mangling things like "3:15" that aren't labels at
# all) and is capped at 20 chars so it doesn't eat an ordinary sentence that
# merely happens to contain a colon further in.
_SPEAKER_LABEL_RE = re.compile(r"^([^\s:：0-9][^\s:：]{0,19})[:：]\s*(.+)$")


def _parse_ms(h: str, m: str, s: str, ms: str) -> int:
    ms3 = ms.ljust(3, "0")[:3]
    return (int(h) * 3600 + int(m) * 60 + int(s)) * 1000 + int(ms3)


def _iter_cue_blocks(content: str) -> Iterator[tuple[int, int, str]]:
    """Yield (start_ms, end_ms, raw_text) for each cue block found in `content`.

    Tolerant of both SRT (index line + `,`-ms timestamps) and VTT-ish input
    (optional `WEBVTT` header, no index line, `.`-ms timestamps) -- blocks
    that don't contain a recognizable timestamp line are silently skipped
    rather than raising, since a malformed one-off cue shouldn't take down
    the whole file.
    """
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")

    if normalized.lstrip().startswith("WEBVTT"):
        parts = normalized.split("\n\n", 1)
        normalized = parts[1] if len(parts) > 1 else ""

    for block in normalized.split("\n\n"):
        lines = block.split("\n")
        while lines and not lines[0].strip():
            lines.pop(0)
        if not lines:
            continue

        # Optional numeric cue-index line (SRT has one, VTT often doesn't).
        if lines[0].strip().isdigit():
            lines.pop(0)
        if not lines:
            continue

        m = _TIME_RE.search(lines[0])
        if not m:
            continue

        start_ms = _parse_ms(m.group(1), m.group(2), m.group(3), m.group(4))
        end_ms = _parse_ms(m.group(5), m.group(6), m.group(7), m.group(8))
        text = "\n".join(lines[1:]).strip()
        yield start_ms, end_ms, text


def _clean_cue_text(raw: str) -> str:
    """Clean one cue's raw text per the CC-cleaning rules (see module docstring
    of `worker.py`'s cc branch): strip HTML/VTT tags, drop music-note
    characters and bracket-only sound cues, strip a trivially-detectable
    leading speaker label, and collapse whitespace. Returns `""` if nothing
    usable remains, which the caller treats as "drop this cue".
    """
    text = _TAG_RE.sub("", raw)

    kept_lines: list[str] = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        if _BRACKET_ONLY_RE.match(line):
            continue  # whole line is a sound cue like "[音楽]" -- drop it
        line = _MUSIC_MARK_RE.sub("", line).strip()
        if not line:
            continue  # was only music-note characters (e.g. a lone "♪")
        kept_lines.append(line)

    text = " ".join(kept_lines)

    label_match = _SPEAKER_LABEL_RE.match(text)
    if label_match:
        text = label_match.group(2)

    return re.sub(r"\s+", " ", text).strip()


def _duration_ms_from_wav(audio_path: str, fallback: int) -> int:
    """Read duration from a 16kHz mono PCM wav via the stdlib `wave` module,
    same approach as `align.py`'s helper of the same name. Falls back to
    `fallback` (the CC file's last cue end_ms) on any error, since
    duration_ms is only used downstream for display/progress.
    """
    try:
        with wave.open(audio_path, "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            if rate > 0:
                return round(frames / rate * 1000)
    except Exception as e:  # noqa: BLE001 - best-effort, fall back below
        protocol.log(f"[cc] failed to read duration from {audio_path!r}: {e}")
    return fallback


def load_cc(cc_path: str, audio_path: Optional[str] = None) -> tuple[list[Segment], int]:
    """Parse a manual-CC subtitle file into (segments, duration_ms).

    Returns the same shape `asr.transcribe`/`align.align` do, so the rest of
    the pipeline (tokenize -> romaji -> translate -> assemble) runs
    unchanged regardless of which stage produced the ja text/timing.

    Each cue is cleaned via `_clean_cue_text`; a cue that becomes empty
    after cleaning (e.g. it was only a "[音楽]" sound-cue marker) is dropped
    entirely rather than kept as a blank line.

    `audio_path`, when given, is used (via `_duration_ms_from_wav`, same
    approach as `align.py`) as the `duration_ms` fallback source -- a CC
    track's last cue often ends before the actual clip does (e.g. trailing
    instrumental/silence with no captions). When omitted, `duration_ms` is
    just the last surviving cue's `end_ms` (or 0 if every cue was dropped).
    """
    raw = Path(cc_path).read_bytes().decode("utf-8-sig", errors="replace")

    segments: list[Segment] = []
    for start_ms, end_ms, raw_text in _iter_cue_blocks(raw):
        text = _clean_cue_text(raw_text)
        if not text:
            continue
        segments.append({"start_ms": start_ms, "end_ms": end_ms, "text": text})

    fallback_duration_ms = segments[-1]["end_ms"] if segments else 0
    if audio_path:
        duration_ms = _duration_ms_from_wav(audio_path, fallback_duration_ms)
    else:
        duration_ms = fallback_duration_ms

    return segments, duration_ms


def _overlap_ms(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    """Milliseconds of overlap between `[a_start, a_end)` and `[b_start,
    b_end)`, clamped to a non-negative value (0 when the intervals don't
    overlap at all)."""
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def merge_target_captions(
    source_cues: list[dict], target_segments: list[Segment]
) -> list[Optional[str]]:
    """B5.5's time-overlap merge (dsd.md §12.4/§12.5/§12.7): stand a manual
    target-language (Chinese) CC track in for the LLM translate stage.

    `source_cues` is a list of dicts with (at least) `start_ms`/`end_ms` --
    the source track's timeline, which this v1 merge treats as authoritative
    (dsd.md §12.4's "v1 保守法": the source track owns the timeline; precise
    dual-track alignment is deferred to §12.8). `target_segments` is the
    parsed target CC (`load_cc`'s return value's first element).

    For each source cue, every target segment whose `[start_ms, end_ms)`
    overlaps it by more than 0ms is collected, sorted by `start_ms`, and
    joined with a single space -- covers the common case of one source cue
    spanning two shorter target segments. A source cue with no overlapping
    target segment gets `None`, signalling "fall back to LLM translation (or
    leave blank)" to the caller.

    Returns a list the same length as `source_cues`, aligned 1:1.
    """
    merged: list[Optional[str]] = []
    for cue in source_cues:
        overlapping = [
            seg
            for seg in target_segments
            if _overlap_ms(cue["start_ms"], cue["end_ms"], seg["start_ms"], seg["end_ms"]) > 0
        ]
        if not overlapping:
            merged.append(None)
            continue
        overlapping.sort(key=lambda seg: seg["start_ms"])
        merged.append(" ".join(seg["text"] for seg in overlapping))
    return merged
