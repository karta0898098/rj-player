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


def filter_segments(
    segments: list[dict], vocals_path: str, debug: bool = False
) -> list[dict]:
    """Return `segments` minus the ones with no vocal energy in their range.

    Each segment needs `start_ms`/`end_ms` (the shape asr.transcribe
    yields). On ANY problem — unreadable/odd wav, no frames, numpy missing
    — the original list is returned unchanged and a log line says so.

    Logging contract (this is the tuning instrument for the gate):
    - one summary line always: threshold + how it was derived + counts;
    - one line per DROPPED cue always, with its measured peak — a wrongly
      dropped real line must be visible in the logs, not silent;
    - the closest-call KEPT cue always (lowest peak that survived), showing
      how much margin the quietest real line had;
    - `debug=True` (VOCAL_ENERGY_GATE=debug): one line per cue, every cue.
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
        closest_kept: Optional[tuple[float, dict]] = None
        for seg in segments:
            lo = max(0, int(seg["start_ms"] // frame_ms))
            hi = int(-(-seg["end_ms"] // frame_ms))  # ceil division
            window = rms[lo:hi]
            # A cue extending past the profile's end keeps whatever frames
            # overlap; a cue entirely past the end has no evidence either
            # way — keep it (never drop on missing data).
            past_end = len(window) == 0
            peak = threshold if past_end else float(window.max())
            keep = peak >= threshold
            if debug:
                protocol.log(
                    f"[energy_gate] {'keep' if keep else 'DROP'} "
                    f"{seg['start_ms']}-{seg['end_ms']}ms peak={peak:.4f} "
                    f"({'past end of audio' if past_end else f'thr={threshold:.4f}'}) "
                    f"{seg.get('text', '')[:24]!r}"
                )
            if keep:
                kept.append(seg)
                if not past_end and (closest_kept is None or peak < closest_kept[0]):
                    closest_kept = (peak, seg)
            else:
                dropped.append((peak, seg))

        protocol.log(
            f"[energy_gate] threshold={threshold:.4f} "
            f"(abs_floor={_ABS_FLOOR}, active_p{_ACTIVE_PERCENTILE}={active_level:.4f} "
            f"x {_REL_FACTOR} = {active_level * _REL_FACTOR:.4f}); "
            f"kept {len(kept)}/{len(segments)}, dropped {len(dropped)}"
        )
        for peak, d in dropped:
            protocol.log(
                f"[energy_gate] DROPPED {d['start_ms']}-{d['end_ms']}ms "
                f"peak={peak:.4f} (thr={threshold:.4f}) {d.get('text', '')[:24]!r}"
            )
        if closest_kept is not None:
            peak, c = closest_kept
            protocol.log(
                f"[energy_gate] quietest kept cue: {c['start_ms']}-{c['end_ms']}ms "
                f"peak={peak:.4f} (margin {peak / threshold:.1f}x over threshold) "
                f"{c.get('text', '')[:24]!r}"
            )
        return kept
    except Exception as e:  # noqa: BLE001 - gate must never fail the pipeline
        protocol.log(f"[energy_gate] gating failed ({e}); keeping all cues")
        return segments
