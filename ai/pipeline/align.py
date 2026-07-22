"""Forced-alignment stage: align user-supplied reference lyrics to audio.

Used INSTEAD OF `asr.transcribe` when the caller has real lyrics text for a
song and free transcription would garble it (Japanese music ASR is
unreliable on sung vocals). Here the TEXT is fixed (exactly the user's
lyrics) and only the TIMING is computed by stable-ts's forced-alignment
model.

Verified recipe (see task notes): reuse the existing faster-whisper ct2
model via `stable_whisper.load_faster_whisper(model_size)` -- no separate
torch model, no extra download -- then call `model.align(...)` with
`original_split=True` so each newline-separated line of the reference text
becomes its own segment/cue.
"""
from __future__ import annotations

import wave
from typing import Callable, Optional, TypedDict

from . import protocol

_model_cache: dict[tuple[str, str, str], object] = {}


class Segment(TypedDict):
    start_ms: int
    end_ms: int
    text: str


def _get_model(model_size: str, compute_type: str = "int8", device: str = "cpu"):
    key = (model_size, compute_type, device)
    model = _model_cache.get(key)
    if model is None:
        # Imported lazily, mirroring asr.py: importing stable_whisper (and
        # transitively faster_whisper/ctranslate2) has a non-trivial cost we
        # don't want to pay before the first real align request.
        import stable_whisper

        protocol.log(
            f"[align] loading faster-whisper model '{model_size}' for forced "
            f"alignment (device={device}, compute_type={compute_type}); first "
            f"run may download the model from HuggingFace..."
        )
        model = stable_whisper.load_faster_whisper(
            model_size, device=device, compute_type=compute_type
        )
        _model_cache[key] = model
        protocol.log(f"[align] model '{model_size}' loaded")
    return model


def _duration_ms_from_wav(audio_path: str, fallback: int) -> int:
    """Read duration from a 16kHz mono PCM wav via the stdlib `wave` module.

    Falls back to `fallback` (the last segment's end_ms) on any error, since
    duration_ms is only used downstream for display/progress -- it's not
    worth failing the whole align stage over.
    """
    try:
        with wave.open(audio_path, "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            if rate > 0:
                return round(frames / rate * 1000)
    except Exception as e:  # noqa: BLE001 - best-effort, fall back below
        protocol.log(f"[align] failed to read duration from {audio_path!r}: {e}")
    return fallback


def align(
    audio_path: str,
    reference_text: str,
    source_lang: str,
    model_size: str,
    on_progress: Optional[Callable[[int], None]] = None,
    compute_type: str = "int8",
    device: str = "cpu",
) -> tuple[list[Segment], int]:
    """Force-align `reference_text` to `audio_path`. Returns (segments, duration_ms).

    `reference_text` is the user's real lyrics, one cue per line (newline
    separated). `original_split=True` makes stable-ts treat each line as its
    own segment, so the returned segment text matches the input lines
    exactly (only start/end timing is computed).

    `on_progress` is a coarse signal only -- stable-ts renders its own
    progress bar to the terminal during `model.align`, so there's no
    per-segment callback to hook into like `asr.transcribe` has.
    """
    model = _get_model(model_size, compute_type, device)

    if on_progress is not None:
        on_progress(50)

    result = model.align(
        audio_path, reference_text, language=source_lang, original_split=True
    )

    segments: list[Segment] = []
    for seg in result.segments:
        text = seg.text.strip()
        if not text:
            continue
        segments.append(
            {
                "start_ms": round(seg.start * 1000),
                "end_ms": round(seg.end * 1000),
                "text": text,
            }
        )

    fallback_duration_ms = segments[-1]["end_ms"] if segments else 0
    duration_ms = _duration_ms_from_wav(audio_path, fallback_duration_ms)

    if on_progress is not None:
        on_progress(100)

    return segments, duration_ms
