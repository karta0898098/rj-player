"""ASR stage: faster-whisper transcription.

dsd.md §4.1: faster-whisper transcribe(audio, language=source_lang) ->
segments [{start, end, text}] (seconds -> convert to ms).

The WhisperModel is lazy-loaded on first use and cached per model size, so
that `ping` (and worker startup in general) stays instant -- the model is
only pulled into memory (and, on first ever run, downloaded from
HuggingFace, ~500MB for `small`) when a `generate_subtitles` request
actually needs it.

Apple Silicon has no CUDA, so we pin device="cpu", compute_type="int8" per
the task spec.
"""
from __future__ import annotations

from typing import Callable, Optional, TypedDict

from . import protocol

_model_cache: dict[str, object] = {}

# Base Silero VAD knobs (see the long comment inside `transcribe` for why
# these particular values). `transcribe`'s `vad_overrides` param merges on
# top of this per-request -- only the keys actually present there override
# the corresponding default here.
_DEFAULT_VAD_PARAMS: dict[str, float | int] = dict(
    threshold=0.45,
    min_silence_duration_ms=400,
    speech_pad_ms=200,
    max_speech_duration_s=15,
)


class Segment(TypedDict):
    start_ms: int
    end_ms: int
    text: str


def _get_model(model_size: str):
    model = _model_cache.get(model_size)
    if model is None:
        # Imported lazily: importing faster_whisper/ctranslate2 has a
        # non-trivial cost we don't want to pay before the first real job.
        from faster_whisper import WhisperModel

        protocol.log(
            f"[asr] loading whisper model '{model_size}' "
            f"(device=cpu, compute_type=int8); first run may download "
            f"the model from HuggingFace..."
        )
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        _model_cache[model_size] = model
        protocol.log(f"[asr] model '{model_size}' loaded")
    return model


def transcribe(
    audio_path: str,
    source_lang: str,
    model_size: str,
    on_progress: Optional[Callable[[int], None]] = None,
    temperature: float = 0.0,
    initial_prompt: Optional[str] = None,
    vad_filter: bool = True,
    vad_overrides: Optional[dict] = None,
) -> tuple[list[Segment], int]:
    """Run ASR on audio_path. Returns (segments, duration_ms).

    Progress is reported as a percentage of audio duration covered by
    segments emitted so far (faster-whisper yields segments lazily and
    doesn't expose a total segment count up front, so duration-based pct
    is the only way to give a meaningful running progress signal).

    `temperature` is Whisper's sampling temperature (0.0 = deterministic
    greedy decoding); it's plumbed all the way from config.toml's
    `[ai] temperature` / the `WHISPER_TEMPERATURE` env var, mirroring how
    `model_size` (whisper_model) already flows in.

    `initial_prompt` biases decoding toward given context/vocabulary (e.g.
    character names, jargon); `None` or an empty string means "don't pass
    one" -- this is also the default when the per-request override isn't
    set at all (dsd.md's per-request "regenerate" contract).

    `vad_overrides` is an optional dict of any subset of the 4
    `_DEFAULT_VAD_PARAMS` keys (`threshold`, `min_silence_duration_ms`,
    `speech_pad_ms`, `max_speech_duration_s`). Only keys present (and
    non-`None`) override the corresponding default; anything omitted keeps
    the tuned default below.
    """
    model = _get_model(model_size)

    vad_parameters = dict(_DEFAULT_VAD_PARAMS)
    if vad_overrides:
        for key, value in vad_overrides.items():
            if key in vad_parameters and value is not None:
                vad_parameters[key] = value
    # vad_filter=True runs faster-whisper's bundled Silero VAD model first and
    # only feeds speech regions to Whisper, so it stops hallucinating cue text
    # over instrumental/silent stretches (e.g. a song intro) and keeps segment
    # start/end timestamps tight around actual speech instead of spanning
    # whatever silence surrounds it. condition_on_previous_text=False stops
    # each segment's decoding from being biased by the (possibly hallucinated)
    # text of the previous segment, which otherwise compounds drift/hallucination
    # across a run of non-speech segments. Together these are what fix
    # "subtitles don't match the time up".
    #
    # vad_parameters below are tuned for SUNG lyrics over music, balancing two
    # failure modes:
    #   * too aggressive (high threshold) → quiet singing dropped as "not speech";
    #   * too permissive (very low threshold + no length cap) → continuous music
    #     becomes ONE giant "speech" region that Whisper collapses into a single
    #     garbage line spanning a whole chorus (lyrics lost entirely).
    # Settings:
    #   - threshold=0.45 (slightly below Silero's 0.5 default): recovers some
    #     quiet sung content without letting pure music through wholesale.
    #   - speech_pad_ms=200: pad region edges so quiet line starts/ends aren't
    #     clipped.
    #   - min_silence_duration_ms=400: split on short musical pauses between
    #     phrases (finer segmentation, fewer merged lines).
    #   - max_speech_duration_s=15: HARD cap so a continuous sung/music stretch
    #     is force-split into ≤15s regions — prevents the multi-minute mega-cue
    #     that swallowed (and garbled) the whole chorus.
    #
    # All 4 knobs above are individually overridable per-request via
    # `vad_overrides` (merged into `vad_parameters` above); anything not
    # overridden keeps the tuned default.
    #
    # vad_filter=False disables the Silero pre-filter entirely: Whisper sees
    # the whole audio, so nothing quiet/sung is dropped (more complete lyrics)
    # at the cost of hallucinations over instrumental/silent stretches (e.g. a
    # fabricated line over a song intro). When off, vad_parameters don't apply.
    transcribe_kwargs: dict = dict(
        language=source_lang,
        temperature=temperature,
        vad_filter=vad_filter,
        condition_on_previous_text=False,
    )
    if vad_filter:
        transcribe_kwargs["vad_parameters"] = vad_parameters
    # Only bias decoding with an initial_prompt when one was actually given;
    # an empty/None prompt must behave identically to never passing the
    # kwarg at all.
    if initial_prompt:
        transcribe_kwargs["initial_prompt"] = initial_prompt

    segments_gen, info = model.transcribe(audio_path, **transcribe_kwargs)
    duration = float(info.duration or 0.0)
    duration_ms = round(duration * 1000)

    segments: list[Segment] = []
    for seg in segments_gen:
        segments.append(
            {
                "start_ms": round(seg.start * 1000),
                "end_ms": round(seg.end * 1000),
                "text": seg.text.strip(),
            }
        )
        if on_progress is not None and duration > 0:
            pct = max(0, min(99, int(seg.end / duration * 100)))
            on_progress(pct)

    if on_progress is not None:
        on_progress(100)

    return segments, duration_ms
