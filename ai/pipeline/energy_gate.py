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


# voiced_regions knobs: pad each region so quiet onsets/tails aren't
# clipped, and merge regions separated by short gaps (breaths, beat rests)
# so a phrase isn't fragmented into confetti.
_REGION_PAD_S = 0.5
_REGION_MERGE_GAP_S = 1.0

# End-trim knobs (see `gate_segments`). Whisper regularly stretches a cue's
# end_ms into the silence after the line, which pins the subtitle on screen
# long after the singing stopped (and can overlap later cues, breaking the
# frontend's binary search). Trimming to the last voiced frame fixes the
# data instead of masking it at display time.
#   - _TAIL_PAD_MS: keep a little air after the last voiced frame so a note
#     decaying below the threshold isn't cut off mid-breath;
#   - _MIN_TRIM_MS: leave alone unless there's a meaningful amount of
#     trailing silence — no point rewriting timings by a few frames;
#   - _MIN_CUE_MS: never trim a cue below a readable duration, however the
#     energy looks.
# Only the TAIL is trimmed: leading silence inside a cue merely shows the
# subtitle a touch early (harmless, often desirable), and trimming starts
# risks clipping a soft onset — exactly what we fought to recover.
_TAIL_PAD_MS = 300
_MIN_TRIM_MS = 500
_MIN_CUE_MS = 800


def voiced_regions(vocals_path: str) -> Optional[list[float]]:
    """Voiced time regions of the separated vocals, as a flat
    `[start, end, start, end, ...]` list in seconds — the exact shape
    faster-whisper's `clip_timestamps` takes.

    This is the *pre*-transcription counterpart of `filter_segments`:
    instead of dropping hallucinated cues afterwards, don't show Whisper
    the silence in the first place. The observed failure it fixes: with
    VAD off, a long instrumental intro plus the first short sung phrase
    land in one silence-dominated 30s window, and Whisper hallucinates the
    whole window's text — the first real line's words are swallowed. With
    clips, the first window starts ~0.5s before the first vocal onset.

    Returns None when no usable signal exists (unreadable wav, no voiced
    frames at all, any error) — the caller then transcribes the full audio
    exactly as before. Same threshold derivation as `filter_segments`, so
    the two layers agree on what counts as vocal energy.
    """
    try:
        profile = _frame_rms(vocals_path)
        if profile is None:
            return None
        rms, frame_ms = profile

        import numpy as np

        active_level = float(np.percentile(rms, _ACTIVE_PERCENTILE))
        threshold = max(_ABS_FLOOR, active_level * _REL_FACTOR)
        voiced = rms >= threshold
        if not bool(voiced.any()):
            return None

        total_s = len(rms) * frame_ms / 1000.0
        regions: list[list[float]] = []
        start: Optional[float] = None
        for i, v in enumerate(voiced):
            t = i * frame_ms / 1000.0
            if v and start is None:
                start = t
            elif not v and start is not None:
                regions.append([start, t])
                start = None
        if start is not None:
            regions.append([start, total_s])

        # Pad, clamp, then merge overlapping/near regions.
        padded = [
            [max(0.0, s - _REGION_PAD_S), min(total_s, e + _REGION_PAD_S)]
            for s, e in regions
        ]
        merged: list[list[float]] = []
        for s, e in padded:
            if merged and s - merged[-1][1] <= _REGION_MERGE_GAP_S:
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e])

        protocol.log(
            f"[energy_gate] {len(merged)} voiced region(s) for clip_timestamps; "
            f"first starts at {merged[0][0]:.1f}s "
            f"(skipping {merged[0][0]:.1f}s of vocal-free lead-in)"
        )
        return [x for region in merged for x in region]
    except Exception as e:  # noqa: BLE001 - region finding must never fail the pipeline
        protocol.log(f"[energy_gate] voiced-region scan failed ({e}); transcribing full audio")
        return None


def _trim_tail(
    seg: dict, rms, lo: int, threshold: float, frame_ms: int
) -> Optional[int]:
    """Shorten `seg["end_ms"]` to its last voiced frame; return ms removed.

    Returns None when nothing was trimmed: no meaningful trailing silence
    (`_MIN_TRIM_MS`), or trimming would take the cue under `_MIN_CUE_MS`.
    Only ever shortens — a cue whose singing runs to its very end (a held
    note) comes back untouched.
    """
    import numpy as np

    hi = int(-(-seg["end_ms"] // frame_ms))
    voiced = np.nonzero(rms[lo:hi] >= threshold)[0]
    if not len(voiced):
        return None
    last_voiced_end_ms = (lo + int(voiced[-1]) + 1) * frame_ms
    new_end = last_voiced_end_ms + _TAIL_PAD_MS
    if new_end > seg["end_ms"] - _MIN_TRIM_MS:
        return None  # nothing worth trimming
    new_end = max(new_end, seg["start_ms"] + _MIN_CUE_MS)
    if new_end >= seg["end_ms"]:
        return None
    removed = seg["end_ms"] - new_end
    seg["end_ms"] = new_end
    return removed


def gate_segments(
    segments: list[dict], vocals_path: str, debug: bool = False
) -> list[dict]:
    """Apply the vocal-energy profile to a cue list: drop, then trim.

    Two fixes from one profile (reading and analysing the wav once):
    1. DROP cues with no vocal energy anywhere in their range — Whisper's
       hallucinations over instrumental stretches;
    2. TRIM each surviving cue's `end_ms` back to its last voiced frame
       (+`_TAIL_PAD_MS`), so a cue whose end_ms was stretched into the
       silence after the line stops being pinned on screen — and stops
       overlapping later cues, which breaks the frontend's binary search.
       A held note ("ああああ") has energy throughout, so its last voiced
       frame IS its end: sustained singing is never shortened, only
       trailing silence is. Cue text and `start_ms` are never touched.

    Segments need `start_ms`/`end_ms` (the shape asr.transcribe yields) and
    are modified in place. On ANY problem — unreadable/odd wav, no frames,
    numpy missing — the original list is returned unchanged and a log line
    says so.

    Logging contract (this is the tuning instrument for the gate):
    - one summary line always: threshold + how it was derived + counts;
    - one line per DROPPED cue always, with its measured peak — a wrongly
      dropped real line must be visible in the logs, not silent;
    - the closest-call KEPT cue always (lowest peak that survived), showing
      how much margin the quietest real line had;
    - a trim summary when any cue's end_ms moved;
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
        trims: list[tuple[dict, int]] = []
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
                if not past_end:
                    trimmed_ms = _trim_tail(seg, rms, lo, threshold, frame_ms)
                    if trimmed_ms:
                        trims.append((seg, trimmed_ms))
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
        if trims:
            worst = max(trims, key=lambda t: t[1])
            protocol.log(
                f"[energy_gate] trimmed trailing silence off {len(trims)} cue(s), "
                f"{sum(t[1] for t in trims) / 1000:.1f}s total; largest "
                f"-{worst[1] / 1000:.1f}s on the cue now ending at "
                f"{worst[0]['end_ms']}ms {worst[0].get('text', '')[:24]!r}"
            )
        return kept
    except Exception as e:  # noqa: BLE001 - gate must never fail the pipeline
        protocol.log(f"[energy_gate] gating failed ({e}); keeping all cues")
        return segments
