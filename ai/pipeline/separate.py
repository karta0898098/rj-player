"""Vocal-separation stage: Demucs two-stems before ASR.

For music videos, Whisper transcribes SUNG lyrics far better when the
instrumental is stripped first — the tuned-for-music VAD in asr.py treats
the symptoms, this treats the cause. The Rust orchestrator decides WHETHER
to separate (global `vocal_separation` policy + per-request override +
`is_music_video`, see backend orchestrator.rs) and provides the paths; this
module only does the work.

Input is the 44.1kHz stereo `audio_hq.wav` the orchestrator extracted from
`video.mp4` (Demucs is trained on 44.1kHz stereo — the 16kHz mono
`audio.wav` would noticeably degrade separation quality). Output is a 16kHz
mono `vocals.wav`, the exact shape Whisper already consumes, written
atomically so a crash mid-write can never leave a corrupt file behind.
`vocals.wav` doubles as the cache: while it exists, `separate` returns
immediately without touching Demucs — a "重新產生字幕" with different
VAD/prompt knobs never pays the separation cost twice.

EVERY failure path returns False instead of raising: demucs not installed
(it's an optional dep group, ai/requirements-demucs.txt), model download
failure, OOM, a bad input file — the caller (worker.py) then transcribes
the original audio unchanged. Separation is a quality enhancer, never a new
way for the pipeline to fail.

Demucs itself (and torch) is imported lazily inside `_run_demucs`, mirroring
asr.py's lazy WhisperModel import: worker startup and every non-separation
job must never pay for (or even require) these deps.
"""
from __future__ import annotations

import os
import wave
from typing import Callable, Optional

from . import protocol

# Demucs model name -> loaded model, cached for the worker's lifetime like
# asr.py's `_model_cache` (the worker is a persistent process; reloading the
# ~80MB model per job would waste seconds).
_model_cache: dict[str, object] = {}

# Whisper's expected input format (matches audio.wav / asr.py).
_OUT_SAMPLE_RATE = 16000


def default_model_name() -> str:
    """`DEMUCS_MODEL` env override, else `htdemucs` (the standard single
    hybrid-transformer model, ~80MB; `htdemucs_ft` is higher quality but a
    4-model bag with ~4x the inference time).
    """
    return os.environ.get("DEMUCS_MODEL", "htdemucs")


def separate(
    audio_hq_path: Optional[str],
    vocals_path: str,
    device: str = "cpu",
    on_progress: Optional[Callable[[int], None]] = None,
) -> bool:
    """Produce a 16kHz mono vocals track at `vocals_path`.

    Returns True when `vocals_path` is ready to be transcribed (fresh
    separation or cache hit), False when the caller should fall back to the
    original audio. Never raises.
    """
    # Cache hit: a previous run already separated this video. Zero-byte
    # files don't count (nothing writes them now that the output is written
    # atomically, but a stale artifact must not poison every future run).
    try:
        if os.path.exists(vocals_path) and os.path.getsize(vocals_path) > 0:
            protocol.log(f"[separate] vocals cache hit: {vocals_path}")
            if on_progress is not None:
                on_progress(100)
            return True
    except OSError:
        pass

    if not audio_hq_path or not os.path.exists(audio_hq_path):
        # The orchestrator failed to extract audio_hq.wav (and said so in
        # its own logs) but still asked for separation — nothing to do.
        protocol.log("[separate] no high-quality audio input; skipping separation")
        return False

    try:
        _run_demucs(audio_hq_path, vocals_path, device, on_progress)
        return True
    except Exception as e:  # noqa: BLE001 -- graceful degradation, see module docstring
        protocol.log(
            f"[separate] demucs separation failed ({type(e).__name__}: {e}); "
            "falling back to the original audio. If demucs isn't installed, "
            "install the optional deps from ai/requirements-demucs.txt."
        )
        return False


def _get_model(model_name: str):
    model = _model_cache.get(model_name)
    if model is None:
        # Lazy imports: see module docstring. get_model downloads the
        # weights on first ever use (~80MB for htdemucs, into the torch hub
        # cache) — same first-run contract as the Whisper model in asr.py.
        from demucs.pretrained import get_model

        protocol.log(
            f"[separate] loading demucs model '{model_name}'; first run may "
            "download the weights..."
        )
        model = get_model(model_name)
        model.eval()
        _model_cache[model_name] = model
        protocol.log(f"[separate] model '{model_name}' loaded")
    return model


def _load_wav(path: str):
    """Read a 16-bit PCM WAV into a float32 torch tensor `[channels, n]`.

    Deliberately stdlib `wave` + numpy instead of `torchaudio.load`: newer
    torchaudio versions dispatch loading to TorchCodec (a separate package
    that also dlopens FFmpeg shared libraries at runtime), which isn't in
    our dep set — on a fresh install `torchaudio.load` raises ImportError
    and separation silently degraded to the raw mix every time. The input
    here is always our own ffmpeg-extracted PCM WAV, so the stdlib reader
    is fully sufficient and has no codec dependencies at all.
    """
    import numpy as np
    import torch

    with wave.open(path, "rb") as f:
        sr = f.getframerate()
        channels = f.getnchannels()
        sampwidth = f.getsampwidth()
        if sampwidth != 2:
            raise ValueError(f"expected 16-bit PCM wav, got sample width {sampwidth}")
        frames = f.readframes(f.getnframes())
    arr = np.frombuffer(frames, dtype="<i2").reshape(-1, channels).T
    return torch.from_numpy(arr.astype("float32") / 32768.0), sr


def _run_demucs(
    audio_hq_path: str,
    vocals_path: str,
    device: str,
    on_progress: Optional[Callable[[int], None]],
) -> None:
    import torch
    import torchaudio
    from demucs.apply import apply_model

    def progress(pct: int) -> None:
        if on_progress is not None:
            on_progress(max(0, min(100, pct)))

    # Requested "cuda" without a usable CUDA torch build degrades to cpu
    # (slower, not wrong) — mirrors the spirit of asr.py's device handling.
    if device == "cuda" and not torch.cuda.is_available():
        protocol.log("[separate] cuda requested but not available to torch; using cpu")
        device = "cpu"

    model = _get_model(default_model_name())
    progress(5)

    wav, sr = _load_wav(audio_hq_path)
    if sr != model.samplerate:
        wav = torchaudio.functional.resample(wav, sr, model.samplerate)
    if wav.shape[0] == 1:
        # Mono source (rare — extract_audio_hq asks ffmpeg for stereo, but a
        # mono-only original stays mono): duplicate to the 2 channels the
        # model expects.
        wav = wav.repeat(2, 1)
    progress(10)

    # Demucs' standard input normalization (undone on the way out).
    ref = wav.mean(0)
    ref_mean, ref_std = ref.mean(), ref.std()
    wav = (wav - ref_mean) / (ref_std + 1e-8)

    # split=True processes the track in overlapping segments so memory stays
    # bounded regardless of song length.
    protocol.log(f"[separate] separating vocals (device={device})...")
    with torch.no_grad():
        sources = apply_model(
            model,
            wav[None],
            device=device,
            split=True,
            overlap=0.25,
            progress=False,
        )[0]
    progress(85)

    vocals = sources[list(model.sources).index("vocals")]
    vocals = vocals * (ref_std + 1e-8) + ref_mean

    # Downmix + resample to Whisper's 16kHz mono, then write atomically
    # (tmp + rename) so `vocals.path exists` always implies a complete file.
    mono = vocals.mean(0)
    mono = torchaudio.functional.resample(mono, model.samplerate, _OUT_SAMPLE_RATE)
    pcm = (mono.clamp(-1.0, 1.0) * 32767.0).to(torch.int16).cpu().numpy()

    tmp_path = vocals_path + ".tmp"
    with wave.open(tmp_path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(_OUT_SAMPLE_RATE)
        f.writeframes(pcm.tobytes())
    os.replace(tmp_path, vocals_path)
    progress(100)
    protocol.log(f"[separate] wrote vocals: {vocals_path}")
