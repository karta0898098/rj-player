#!/usr/bin/env python3
"""Persistent Python AI worker for the rj-player subtitle pipeline.

Protocol (dsd.md §3.3): reads one JSON request per line on stdin, writes
one JSON object per line on stdout (stage/progress events + exactly one
terminal result/error per request id). stderr is for human logs only --
stdout is the machine channel and must never carry anything else.

Methods:
  ping               -> {"id":..,"event":"result","pong":true} immediately.
                         Does NOT touch the Whisper model (lazy-loaded only
                         on first generate_subtitles), so this stays fast.
  generate_subtitles -> runs ASR -> tokenize -> romaji -> translate ->
                         assemble, emitting stage/progress events, then
                         exactly one `result` (canonical SubtitleDoc) or one
                         `error` (optionally carrying a `partial` doc). Also
                         emits one `partial_result` event right after romaji
                         (before translate starts) carrying a snapshot doc
                         with source_text/tokens/phonetic filled and
                         target_text null, so the Rust side can persist that
                         work immediately instead of only on the terminal
                         event.
  retranslate        -> re-runs ONLY the translate stage against caller-
                         supplied cues (source_text/tokens/phonetic/timing
                         already filled in, from an existing subtitles.json)
                         -- no ASR. Same terminal `result`/`error` shape as
                         generate_subtitles.
  tokenize           -> {"text":.., "source_lang":..} -> one `tokenized` event
                         {"tokens":[..], "phonetic":".."} for a single line.
                         Used when the user manually edits a cue's Japanese
                         text so the ruby/romaji regenerate instead of being
                         dropped. Only reading-profile languages (ja) produce
                         tokens; others return []/"". Never touches Whisper/LLM.
  shutdown           -> emits a result, then exits cleanly.

Standalone self-test (no Rust side needed):
  ai/.venv/bin/python ai/worker.py --selftest /path/to/clip.wav
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from pipeline import align, asr, assemble, cc, energy_gate, polish, protocol, separate, translate

# tokenizer/romaji are imported lazily (inside the `reading` branch of
# run_generate_subtitles below) rather than here at module scope: both pull
# in fugashi/pykakasi eagerly at *their* module scope, and those are only
# ever needed for source languages whose profile has `reading: True` (today,
# just `ja`). Keeping them out of this module's top-level imports means
# `import worker` (and anything that only needs e.g. `profile_for`, like
# ai/tests/) stays cheap and doesn't require those deps installed at all.

# dsd.md §12.2: language profile matrix -- which source languages get the
# tokenize+phonetic ("reading") stages. `reading: True` -> ja-style fugashi
# tokenize -> pykakasi romaji; `reading: False` -> skip both, cues carry
# `tokens: []` / `phonetic: ""`. Unknown source languages fall back to
# DEFAULT_PROFILE (2-layer: source + target only), same as `en` today.
PROFILES = {"ja": {"reading": True}, "en": {"reading": False}}
DEFAULT_PROFILE = {"reading": False}


def profile_for(source_lang: str) -> dict:
    """Pure lookup into PROFILES, defaulting unknown source languages to
    DEFAULT_PROFILE. No I/O, no side effects -- safe to unit test directly.
    """
    return PROFILES.get(source_lang, DEFAULT_PROFILE)


def handle_ping(req_id) -> None:
    protocol.emit({"id": req_id, "event": "result", "pong": True})


def handle_shutdown(req_id) -> None:
    protocol.emit({"id": req_id, "event": "result", "ok": True})


def run_tokenize(req_id, params: dict, emit_fn=protocol.emit) -> None:
    """Tokenize one line: `source_text` -> `{tokens, phonetic}` for the ruby +
    romaji layers.

    A lightweight companion to run_generate_subtitles' tokenize+romaji stages
    (reuses the exact same `tokenizer.tokenize` / `romaji.build_romaji`), called
    by the backend when a user manually edits a cue's Japanese text so the now-
    stale furigana/romaji regenerate in place instead of being dropped. Only
    source languages whose profile has `reading: True` produce tokens; everyone
    else returns `[]`/`""`, matching run_generate_subtitles' skip. Never loads
    Whisper or calls the LLM, so it stays fast.
    """
    text = params.get("text") or ""
    source_lang = params.get("source_lang", "ja")
    try:
        if profile_for(source_lang).get("reading") and text.strip():
            # Lazy import (see the module-level import note): keep fugashi/
            # pykakasi off the hot path for callers that never tokenize.
            from pipeline import romaji, tokenizer  # lazy: see import note up top

            tokens = tokenizer.tokenize(text)
            phonetic = romaji.build_romaji(tokens)
        else:
            tokens, phonetic = [], ""
        emit_fn({"id": req_id, "event": "tokenized", "tokens": tokens, "phonetic": phonetic})
    except Exception as e:  # noqa: BLE001 -- report any failure to the caller, don't crash the worker
        emit_fn({"id": req_id, "event": "error", "message": f"tokenize failed: {e}"})


def run_generate_subtitles(req_id, params: dict, emit_fn=protocol.emit) -> dict | None:
    """Run the full pipeline for one request.

    Emits stage/progress events via emit_fn as it goes, then emits exactly
    one terminal `result` or `error` event via emit_fn. Returns the
    assembled doc on success, None on failure (error already emitted).
    """
    video_id = params.get("video_id")
    audio_path = params.get("audio_path")
    source_lang = params.get("source_lang", "ja")
    whisper_model = params.get("whisper_model") or os.environ.get("WHISPER_MODEL", "small")
    whisper_temperature = params.get("whisper_temperature", 0.0)
    # dsd.md §13.7 settings-page knobs -- global only, no per-request override
    # exists for these (unlike whisper_model/whisper_temperature above).
    compute_type = params.get("compute_type") or os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
    device = params.get("device") or os.environ.get("WHISPER_DEVICE", "cpu")
    do_translate = bool(params.get("translate", False))
    target_lang = params.get("target_lang", "zh-TW")
    # Per-request generation-knob overrides (dsd.md's "regenerate" contract,
    # threaded from POST /api/videos/:id/pipeline via backend/src/core/
    # pipeline/rpc.rs's GenerateSubtitlesParams). Empty string or omitted
    # both collapse to None -- "no initial prompt" either way. An omitted
    # `vad` key (or one present but empty) means every VAD knob falls back
    # to asr.transcribe's own tuned defaults.
    initial_prompt = params.get("initial_prompt") or None
    vad = params.get("vad") or {}
    # `vad.enabled` (default True) toggles the VAD pre-filter entirely; the
    # remaining keys are per-knob overrides that only matter when it's on.
    vad_filter = vad.get("enabled", True)
    vad_overrides = {k: v for k, v in vad.items() if k != "enabled"}
    # When the caller supplies the song's real lyrics, force-align them to
    # the audio instead of free-transcribing (dsd.md's forced-alignment
    # extension) -- free transcription garbles sung Japanese lyrics, but
    # alignment only has to compute timing for text we already know is
    # correct. Empty string or omitted both collapse to None -- "no
    # reference lyrics" -- same shape as `initial_prompt` above.
    reference_lyrics = params.get("reference_lyrics") or None
    # Manual source-language CC, fetched at download time by `backend/src/
    # core/downloader/ytdlp.rs`'s `fetch_captions` and threaded through by
    # `backend/src/core/pipeline/orchestrator.rs` whenever `FsStore::
    # cc_exists` is true. Precedence (highest wins): reference_lyrics > CC >
    # Whisper ASR -- a manual CC track already has correct text AND timing,
    # so it beats free transcription, but a user-pasted reference lyrics
    # override always wins outright.
    cc_path = params.get("cc_path") or None
    # Manual target-language (Chinese) CC, fetched at download time by
    # `backend/src/core/downloader/ytdlp.rs`'s `fetch_captions` and threaded
    # through by `backend/src/core/pipeline/orchestrator.rs` whenever
    # `FsStore::target_cc_exists` is true (dsd.md §12.4/§12.5/§12.7, B5.5).
    # When present, the translate stage below time-overlap-merges it onto
    # the source timeline instead of calling the LLM.
    target_cc_path = params.get("target_cc_path") or None
    # Demucs vocal separation (ai/pipeline/separate.py). The Rust
    # orchestrator has already resolved the global policy + per-request
    # override + is_music_video into this one flag, and supplies both paths:
    # `vocals_path` (the 16kHz mono output, doubling as the cache) and
    # `audio_hq_path` (the transient 44.1kHz stereo Demucs input). Only the
    # two branches that actually feed audio to a model (free ASR and forced
    # alignment) act on it — the CC branches never touch the waveform.
    separate_vocals = bool(params.get("separate_vocals", False))
    vocals_path = params.get("vocals_path") or None
    audio_hq_path = params.get("audio_hq_path") or None
    # LLM lyrics polish (ai/pipeline/polish.py, the LyricWhiz-style
    # correction pass). Like separate_vocals, the orchestrator has already
    # resolved policy + override + is_music_video into one flag. Only the
    # free-ASR branch acts on it — reference_lyrics/CC text is already
    # correct, and cc_reverse text is already LLM-generated. Title/channel
    # give the LLM a strong hint at WHICH song it's proofreading.
    lyrics_polish = bool(params.get("lyrics_polish", False))
    video_title = params.get("video_title") or None
    video_channel = params.get("video_channel") or None

    current_stage = "asr"
    cues: list[dict] = []
    duration_ms: int | None = None
    source: str | None = None
    target_source: str | None = None
    polished: bool | None = None

    try:

        def asr_pct(base: int, end: int):
            """A progress emitter mapping a sub-step's 0-100 onto the asr
            stage's [base, end] window — everything that happens before
            tokenize (separation, transcription, polish) shares the single
            "asr" stage, same reasoning as alignment reusing it (the status
            machine has no distinct states for them)."""
            span = end - base
            return lambda pct: emit_fn(
                {
                    "id": req_id,
                    "event": "progress",
                    "stage": "asr",
                    "pct": base + int(pct * span / 100),
                }
            )

        def resolve_asr_audio(transcribe_end: int = 100):
            """Demucs vocal separation, when the orchestrator asked for it.

            Returns `(audio_for_asr, asr_progress_fn)`. Without separation
            (or when it fails/degrades — separate.separate never raises)
            that's the original `audio_path` with progress spanning
            [0, transcribe_end]. With separation, separation itself maps
            onto 0-30% and transcription onto [30, transcribe_end].
            `transcribe_end` < 100 leaves headroom for a follow-up sub-step
            (the lyrics-polish pass). Only called from the two branches
            that feed audio to a model.
            """
            plain = (audio_path, asr_pct(0, transcribe_end))
            if not (separate_vocals and vocals_path):
                return plain
            ok = separate.separate(
                audio_hq_path,
                vocals_path,
                device=device,
                on_progress=asr_pct(0, 30),
            )
            if not ok:
                return plain
            return (vocals_path, asr_pct(30, transcribe_end))

        # ---- ASR, or one of its two higher-precedence substitutes ----
        current_stage = "asr"
        emit_fn({"id": req_id, "event": "stage", "stage": "asr", "status": "start"})
        if reference_lyrics:
            # Same "asr" stage name/events either way -- the status machine
            # (dsd.md §5.3) doesn't get a distinct state for alignment, it's
            # just a different way of producing the same (segments,
            # duration_ms) shape the rest of the pipeline consumes.
            asr_audio, asr_progress = resolve_asr_audio()
            raw_segments, duration_ms = align.align(
                asr_audio,
                reference_lyrics,
                source_lang,
                whisper_model,
                on_progress=asr_progress,
                compute_type=compute_type,
                device=device,
            )
            source = "align"
        elif cc_path and os.path.exists(cc_path):
            # Same "asr" stage either way, same reasoning as above -- parsing
            # an existing CC file is just a third way of producing
            # (segments, duration_ms); nothing downstream needs to know or
            # care which one ran.
            raw_segments, duration_ms = cc.load_cc(cc_path, audio_path)
            protocol.log(f"[cc] using official {source_lang} CC ({len(raw_segments)} cues)")
            source = "cc"
        elif (
            do_translate
            and target_cc_path
            and os.path.exists(target_cc_path)
            and profile_for(source_lang)["reading"]
        ):
            # A3 (dsd.md §12.7): no source-language CC, but an official target
            # (Chinese) CC exists and the source is a reading language (ja).
            # Rather than free-transcribe the audio (slow, and garbles sung
            # Japanese), BACK-TRANSLATE the target CC into the source language
            # to synthesise the source + romaji layer. The target CC still
            # becomes the translation layer below (its own `target_cc_path`
            # merge branch), so this costs exactly ONE LLM call (target ->
            # source) and NO ASR. The synthesised source is AI-generated (marked
            # `source == "cc_reverse"`), NOT the real lyrics -- the only way to
            # get the true source text is a manual source CC or reference lyrics.
            zh_segments, duration_ms = cc.load_cc(target_cc_path, audio_path)
            zh_texts = [s["text"] for s in zh_segments]
            # translate_segments(texts, target_lang, source_lang): here we go the
            # other way -- Chinese (`target_lang`) INTO Japanese (`source_lang`).
            ja_texts, back_degraded = translate.translate_segments(
                zh_texts,
                source_lang,
                target_lang,
                on_progress=lambda pct: emit_fn(
                    {"id": req_id, "event": "progress", "stage": "asr", "pct": pct}
                ),
            )
            if back_degraded:
                protocol.log(
                    "[cc_reverse] back-translation degraded; source layer may be incomplete"
                )
            # translate_segments degrades per-line to None (missing/exhausted
            # API key, permanent LLM failure). A None here would crash
            # tokenize below AND violates the Rust `Cue` schema
            # (`source_text` is a non-nullable String) — so the whole
            # zero-ASR job would die over lines we can simply leave blank.
            raw_segments = [
                {"start_ms": s["start_ms"], "end_ms": s["end_ms"], "text": ja or ""}
                for s, ja in zip(zh_segments, ja_texts)
            ]
            protocol.log(
                f"[cc_reverse] synthesised {source_lang} source from official "
                f"{target_lang} CC ({len(raw_segments)} cues), no ASR"
            )
            source = "cc_reverse"
        else:
            # Leave the asr stage's 85-100% window for the polish pass when
            # it's going to run — one continuous progress sweep either way.
            transcribe_end = 85 if lyrics_polish else 100
            asr_audio, asr_progress = resolve_asr_audio(transcribe_end)
            raw_segments, duration_ms = asr.transcribe(
                asr_audio,
                source_lang,
                whisper_model,
                on_progress=asr_progress,
                temperature=whisper_temperature,
                initial_prompt=initial_prompt,
                vad_filter=vad_filter,
                vad_overrides=vad_overrides,
                compute_type=compute_type,
                device=device,
                # Transcribing separated vocals -> the separated-audio VAD
                # defaults apply (asr._SEPARATED_VAD_PARAMS); explicit
                # per-request overrides still win inside transcribe.
                separated=asr_audio == vocals_path,
            )
            source = "asr"
            # Vocal-energy gate (energy_gate.py): only meaningful when we
            # actually transcribed the separated vocals — the raw mix has
            # music energy everywhere, so there'd be no signal to gate on.
            # Runs BEFORE polish so the LLM never wastes tokens correcting
            # hallucinated intro/interlude cues. `VOCAL_ENERGY_GATE=off` is
            # the escape hatch.
            if (
                asr_audio == vocals_path
                and raw_segments
                and os.environ.get("VOCAL_ENERGY_GATE", "").strip().lower() != "off"
            ):
                raw_segments = energy_gate.filter_segments(raw_segments, vocals_path)
            if lyrics_polish and raw_segments:
                # LyricWhiz-style LLM correction of the free transcript
                # (polish.py). Timing is untouched — only each line's text
                # can change. `applied` False (no usable provider) keeps
                # the raw transcript and leaves the doc unmarked.
                texts = [seg["text"] for seg in raw_segments]
                new_texts, applied = polish.polish_lines(
                    texts,
                    source_lang,
                    title=video_title,
                    channel=video_channel,
                    hint=initial_prompt,
                    on_progress=asr_pct(85, 100),
                )
                if applied:
                    for seg, new_text in zip(raw_segments, new_texts):
                        seg["text"] = new_text
                    polished = True
        emit_fn({"id": req_id, "event": "stage", "stage": "asr", "status": "done"})

        cues = [
            {
                "id": i,
                "start_ms": seg["start_ms"],
                "end_ms": seg["end_ms"],
                "source_text": seg["text"],
            }
            for i, seg in enumerate(raw_segments)
        ]
        total = len(cues) or 1

        # ---- Tokenize + Romaji ("reading" stages, dsd.md §12.2/§12.3) ----
        # Only source languages whose profile has `reading: True` (today,
        # just `ja`) get fugashi tokenize -> pykakasi romaji; every other
        # source language (en, or any future unlisted one) skips both
        # stages entirely -- no stage/progress events emitted for them --
        # and gets `tokens: []` / `phonetic: ""` so the doc still has valid
        # shape for the Rust `Cue` struct. `source_lang` defaults to "ja"
        # above, so omitting it anywhere upstream reproduces today's
        # behavior exactly.
        if profile_for(source_lang)["reading"]:
            from pipeline import romaji, tokenizer  # lazy: see import note up top

            current_stage = "tokenize"
            emit_fn({"id": req_id, "event": "stage", "stage": "tokenize", "status": "start"})
            for i, cue in enumerate(cues):
                cue["tokens"] = tokenizer.tokenize(cue["source_text"])
                emit_fn(
                    {
                        "id": req_id,
                        "event": "progress",
                        "stage": "tokenize",
                        "pct": int((i + 1) / total * 100),
                    }
                )
            emit_fn({"id": req_id, "event": "stage", "stage": "tokenize", "status": "done"})

            current_stage = "romaji"
            emit_fn({"id": req_id, "event": "stage", "stage": "romaji", "status": "start"})
            for i, cue in enumerate(cues):
                cue["phonetic"] = romaji.build_romaji(cue["tokens"])
                emit_fn(
                    {
                        "id": req_id,
                        "event": "progress",
                        "stage": "romaji",
                        "pct": int((i + 1) / total * 100),
                    }
                )
            emit_fn({"id": req_id, "event": "stage", "stage": "romaji", "status": "done"})
        else:
            for cue in cues:
                cue["tokens"] = []
                cue["phonetic"] = ""

        # ---- Persist a pre-translate snapshot ----
        # ASR (often the slowest, priciest stage -- large-v3 on a full song)
        # plus tokenize/romaji are done at this point; translate is a separate
        # network round-trip to an LLM that can retry for a while (rate
        # limits, RECITATION blocks on song lyrics, etc.) before it even
        # degrades gracefully. Emitting this now lets the Rust side persist
        # source_text/tokens/phonetic to subtitles.json immediately, so that
        # work is never at risk regardless of how translate goes -- and gives
        # run_retranslate (below) something to re-run translate against
        # later without redoing ASR. `target_text` is set to `None` on every
        # cue first purely so this snapshot's shape matches the final doc
        # (the Rust `Cue` struct requires the key present, even if null).
        for cue in cues:
            cue.setdefault("target_text", None)
        pretranslate_doc = assemble.assemble(
            video_id, source_lang, target_lang, duration_ms, cues, False, False, source,
            target_source=None, polished=polished,
        )
        emit_fn({"id": req_id, "event": "partial_result", "subtitles": pretranslate_doc})

        # ---- Translate (graceful degradation lives inside translate_segments) ----
        current_stage = "translate"
        degraded = False
        if do_translate:
            emit_fn({"id": req_id, "event": "stage", "stage": "translate", "status": "start"})
            if target_cc_path and os.path.exists(target_cc_path):
                # B5.5 (dsd.md §12.4/§12.5/§12.7): a manual Chinese CC track
                # exists for this video -- time-overlap-merge it onto the
                # source timeline (cc.merge_target_captions) instead of
                # calling the LLM. NO LLM call in this branch -- a video
                # with both a source CC and a Chinese CC needs zero Whisper
                # AND zero LLM calls.
                target_segments, _ = cc.load_cc(target_cc_path)
                merged = cc.merge_target_captions(cues, target_segments)
                for cue, zh in zip(cues, merged):
                    cue["target_text"] = zh
                target_source = "cc"
                degraded = False
                protocol.log(f"[translate] using official Chinese CC ({len(cues)} cues merged)")
            else:
                source_texts = [c["source_text"] for c in cues]
                target_texts, degraded = translate.translate_segments(
                    source_texts,
                    target_lang,
                    source_lang,
                    on_progress=lambda pct: emit_fn(
                        {"id": req_id, "event": "progress", "stage": "translate", "pct": pct}
                    ),
                )
                for cue, zh in zip(cues, target_texts):
                    cue["target_text"] = zh
                target_source = "llm"
            emit_fn({"id": req_id, "event": "stage", "stage": "translate", "status": "done"})
        else:
            for cue in cues:
                cue["target_text"] = None
            target_source = None

        # ---- Assemble ----
        current_stage = "assemble"
        emit_fn({"id": req_id, "event": "stage", "stage": "assemble", "status": "start"})
        doc = assemble.assemble(
            video_id, source_lang, target_lang, duration_ms, cues, do_translate, degraded, source,
            target_source=target_source, polished=polished,
        )
        emit_fn({"id": req_id, "event": "stage", "stage": "assemble", "status": "done"})

        emit_fn({"id": req_id, "event": "result", "subtitles": doc})
        return doc

    except Exception as e:  # noqa: BLE001 - top-level job guard, must not crash worker
        protocol.log(f"[worker] generate_subtitles failed at stage={current_stage}: {e}")
        error_event: dict = {"id": req_id, "event": "error", "stage": current_stage, "message": str(e)}
        if cues:
            error_event["partial"] = assemble.partial_doc(
                video_id, source_lang, target_lang, duration_ms, cues, source
            )
        emit_fn(error_event)
        return None


def run_retranslate(req_id, params: dict, emit_fn=protocol.emit) -> dict | None:
    """Re-run ONLY the translate stage against already-computed cues.

    Companion to `run_generate_subtitles`'s pre-translate snapshot (see its
    `partial_result` event) -- lets a translate-only failure/degradation be
    retried without redoing ASR (dsd.md §7's "don't throw away completed
    work", extended to the common case, not just crash forensics). `cues`
    comes in with `source_text`/`tokens`/`phonetic`/`start_ms`/`end_ms` already
    set (straight from the existing subtitles.json on the Rust side) --
    those are passed through untouched; only `target_text` is overwritten.
    """
    video_id = params.get("video_id")
    source_lang = params.get("source_lang", "ja")
    target_lang = params.get("target_lang", "zh-TW")
    duration_ms = params.get("duration_ms")
    source = params.get("source")
    cues: list[dict] = params.get("cues") or []

    try:
        emit_fn({"id": req_id, "event": "stage", "stage": "translate", "status": "start"})
        source_texts = [c["source_text"] for c in cues]
        target_texts, degraded = translate.translate_segments(
            source_texts,
            target_lang,
            source_lang,
            on_progress=lambda pct: emit_fn(
                {"id": req_id, "event": "progress", "stage": "translate", "pct": pct}
            ),
        )
        for cue, zh in zip(cues, target_texts):
            cue["target_text"] = zh
        emit_fn({"id": req_id, "event": "stage", "stage": "translate", "status": "done"})

        emit_fn({"id": req_id, "event": "stage", "stage": "assemble", "status": "start"})
        # run_retranslate always calls the LLM (see the translate_segments
        # call above -- there's no CC-merge branch here), so target_source
        # is unconditionally "llm" (dsd.md §12.4/§12.5/§12.7, B5.5).
        doc = assemble.assemble(
            video_id, source_lang, target_lang, duration_ms, cues, True, degraded, source,
            target_source="llm",
        )
        emit_fn({"id": req_id, "event": "stage", "stage": "assemble", "status": "done"})

        emit_fn({"id": req_id, "event": "result", "subtitles": doc})
        return doc

    except Exception as e:  # noqa: BLE001 - top-level job guard, must not crash worker
        protocol.log(f"[worker] retranslate failed: {e}")
        emit_fn({"id": req_id, "event": "error", "stage": "translate", "message": str(e)})
        return None


def selftest(audio_path: str) -> None:
    protocol.log(f"[selftest] running generate_subtitles synchronously on {audio_path}")

    def emit_to_stderr(evt: dict) -> None:
        protocol.log("[event] " + json.dumps(evt, ensure_ascii=False))

    params = {
        "video_id": "selftest",
        "audio_path": audio_path,
        "source_lang": "ja",
        "whisper_model": os.environ.get("WHISPER_MODEL", "small"),
        "translate": True,
        "target_lang": "zh-TW",
    }
    doc = run_generate_subtitles("selftest-1", params, emit_fn=emit_to_stderr)

    if doc is None:
        protocol.log("[selftest] FAILED: no doc produced")
        sys.exit(1)

    protocol.log("[selftest] full doc:")
    protocol.log(json.dumps(doc, ensure_ascii=False, indent=2))

    all_ok = True
    for cue in doc["cues"]:
        joined = "".join(t["t"] for t in cue["tokens"])
        if joined != cue["source_text"]:
            all_ok = False
            protocol.log(f"[selftest] MISMATCH cue {cue['id']}: {joined!r} != {cue['source_text']!r}")

    protocol.log(
        f"[selftest] SUMMARY: segments={len(doc['cues'])} "
        f"tokens==source_text invariant: {'PASS' if all_ok else 'FAIL'} "
        f"translate_partial={doc.get('translate_partial', False)}"
    )
    if doc["cues"]:
        protocol.log("[selftest] sample cue: " + json.dumps(doc["cues"][0], ensure_ascii=False))

    if not all_ok:
        sys.exit(1)


def _force_utf8_stdio() -> None:
    """Pin the protocol streams to UTF-8, whatever the OS locale says.

    The protocol is UTF-8 JSON lines with `ensure_ascii=False` (Japanese/
    Chinese text passes through verbatim). On Windows, Python <= 3.14 opens
    *pipes* with the ANSI code page (e.g. cp950 on zh-TW systems), so the
    first non-ASCII cue would raise UnicodeEncodeError — killing the worker
    mid-job — and UTF-8 request bytes from the Rust side would fail to
    decode on stdin. The backend also sets PYTHONUTF8=1 when spawning
    (rpc.rs); this reconfigure is the in-process belt-and-braces for direct
    invocations (selftest, dev runs).
    """
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def main() -> None:
    _force_utf8_stdio()
    parser = argparse.ArgumentParser(description="rj-player Python AI worker")
    parser.add_argument(
        "--selftest",
        metavar="AUDIO_PATH",
        help="Run one generate_subtitles synchronously against AUDIO_PATH "
        "and print the resulting doc + summary to stderr, instead of "
        "reading requests from stdin.",
    )
    args = parser.parse_args()

    # Reserve the real stdout for protocol.emit and route everything else
    # (including any third-party library that prints — torch.hub's model-
    # download banner being the known offender) to stderr. Must happen
    # before the first request so no stray print can ever corrupt the JSON
    # machine channel. See protocol.py's module docstring.
    protocol.claim_stdout_for_logs()

    if args.selftest:
        selftest(args.selftest)
        return

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            protocol.log(f"[worker] failed to parse request line as JSON: {e}")
            continue

        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}

        if method == "ping":
            handle_ping(req_id)
        elif method == "generate_subtitles":
            run_generate_subtitles(req_id, params)
        elif method == "retranslate":
            run_retranslate(req_id, params)
        elif method == "tokenize":
            run_tokenize(req_id, params)
        elif method == "shutdown":
            handle_shutdown(req_id)
            break
        else:
            protocol.emit(
                {"id": req_id, "event": "error", "message": f"unknown method: {method!r}"}
            )


if __name__ == "__main__":
    main()
