"""Vocal-energy gate: drop hallucinated cues using the separated vocals.

Whisper's classic failure mode with VAD off is inventing captions over
non-speech stretches (a song's intro/interlude/outro — the model was
trained on weakly-labeled web audio and "knows" what subtitles usually say
there, e.g. ご視聴ありがとうございました). Silero VAD can't fix this
without introducing the opposite failure (it doesn't understand SINGING,
so it drops real sung lines). But once Demucs separation actually ran, we
hold a far more reliable signal than either model: the separated
`vocals.wav` has essentially zero energy wherever nobody sings.

So: transcribe with VAD off (maximum lyric completeness), then throw away
any cue whose time range shows no vocal energy. Pure post-filter — the
transcription itself is untouched, and a cue with ANY real singing in its
range survives (peak-based test). Only meaningful on the separated path;
the raw mix has music energy everywhere, which is exactly why this signal
didn't exist before separation worked.

Escape hatch: `VOCAL_ENERGY_GATE=off` in the environment disables the gate
entirely (checked by worker.py, not here). Every failure path in here
returns the original segments unchanged — same "never a new way to fail"
contract as separate.py/polish.py.
"""
from __future__ import annotations

import wave
from typing import Optional

from . import protocol

# Frame size for the RMS profile. 100ms is fine-grained enough to catch a
# single short sung word inside an otherwise quiet cue.
_FRAME_MS = 100

# A cue is kept when its loudest frame exceeds BOTH floors:
#   - _ABS_FLOOR: an absolute level (on int16-normalized [-1, 1] samples,
#     0.004 ~= -48dBFS) below which content is separation residue/noise,
#     regardless of how quiet the whole track is;
#   - _REL_FACTOR of the track's active singing level (90th percentile of
#     frame RMS): scales the bar to however this particular master was
#     leveled, so a quiet acoustic take isn't gated by a threshold tuned
#     on loud pop.
_ABS_FLOOR = 0.004
_REL_FACTOR = 0.05
_ACTIVE_PERCENTILE = 90


def _frame_rms(vocals_path: str) -> Optional[tuple["object", int]]:
    """Per-frame RMS profile of a 16kHz mono 16-bit vocals WAV.

    Returns (numpy array of frame RMS values, frame_ms), or None when the
    file can't be read as expected (caller degrades to no filtering).
    """
    import numpy as np

    with wave.open(vocals_path, "rb") as f:
        if f.getnchannels() != 1 or f.getsampwidth() != 2:
            return None
        sr = f.getframerate()
        pcm = f.readframes(f.getnframes())
    samples = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0
    frame_len = max(1, int(sr * _FRAME_MS / 1000))
    n_frames = len(samples) // frame_len
    if n_frames == 0:
        return None
    trimmed = samples[: n_frames * frame_len].reshape(n_frames, frame_len)
    return np.sqrt((trimmed**2).mean(axis=1)), _FRAME_MS


def filter_segments(segments: list[dict], vocals_path: str) -> list[dict]:
    """Return `segments` minus the ones with no vocal energy in their range.

    Each segment needs `start_ms`/`end_ms` (the shape asr.transcribe
    yields). On ANY problem — unreadable/odd wav, no frames, numpy missing
    — the original list is returned unchanged and a log line says so.
    """
    if not segments:
        return segments
    try:
        profile = _frame_rms(vocals_path)
        if profile is None:
            protocol.log("[energy_gate] vocals wav not usable for gating; keeping all cues")
            return segments
        rms, frame_ms = profile

        import numpy as np

        active_level = float(np.percentile(rms, _ACTIVE_PERCENTILE))
        threshold = max(_ABS_FLOOR, active_level * _REL_FACTOR)

        kept: list[dict] = []
        dropped: list[dict] = []
        for seg in segments:
            lo = max(0, int(seg["start_ms"] // frame_ms))
            hi = int(-(-seg["end_ms"] // frame_ms))  # ceil division
            window = rms[lo:hi]
            # A cue extending past the profile's end keeps whatever frames
            # overlap; a cue entirely past the end has no evidence either
            # way — keep it (never drop on missing data).
            peak = float(window.max()) if len(window) else threshold
            (kept if peak >= threshold else dropped).append(seg)

        if dropped:
            protocol.log(
                f"[energy_gate] dropped {len(dropped)}/{len(segments)} cue(s) with no "
                f"vocal energy (threshold={threshold:.4f}): "
                + "; ".join(
                    f"{d['start_ms']}-{d['end_ms']}ms {d.get('text', '')[:20]!r}"
                    for d in dropped[:5]
                )
                + ("…" if len(dropped) > 5 else "")
            )
        return kept
    except Exception as e:  # noqa: BLE001 - gate must never fail the pipeline
        protocol.log(f"[energy_gate] gating failed ({e}); keeping all cues")
        return segments
