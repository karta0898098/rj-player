"""Translate stage: batch source_text -> target_text via a pluggable Translator.

dsd.md §4.3: translation is abstracted behind a `Translator` class so the
LLM provider can be swapped without touching the pipeline. Provider here is
Anthropic Claude via the `anthropic` SDK.

dsd.md §7 (critical, graceful degradation): if ANTHROPIC_API_KEY is missing,
or the API keeps failing after retries, we must NOT fail the whole job --
affected cues get target_text=None, the job still produces a valid `result`, and
a warning goes to stderr. The doc gets marked `translate_partial: true` (per
dsd.md §7: "doc 仍落地並標 translate_partial") so downstream consumers can
tell "translation was requested but degraded" apart from "translation was
never requested".
"""
from __future__ import annotations

import json
import os
import time
from abc import ABC, abstractmethod
from typing import Optional

from . import protocol

DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
# flash-lite has a separate (and higher) free-tier quota bucket than the
# full flash model and is plenty for line translation; override via LLM_MODEL.
DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest"
# Back-compat alias (older code/imports referenced DEFAULT_MODEL).
DEFAULT_MODEL = DEFAULT_ANTHROPIC_MODEL
# Larger batches → far fewer API requests per video, which matters on
# request-per-day-capped free tiers (a whole video fits in a handful of calls).
DEFAULT_BATCH_SIZE = 40
MAX_RETRIES = 3

# dsd.md §12.2/§12.3 (B5.2): human-readable name for each supported source
# language, used in the translate prompt so the LLM is told what it's
# reading. Falls back to the raw code itself for any language not listed
# here (still a reasonable prompt -- e.g. "numbered ko lines").
SOURCE_LANG_NAMES = {"ja": "Japanese", "en": "English"}


class Translator(ABC):
    """Provider-agnostic batch LLM caller. dsd.md §4.3.

    The provider-specific part is `complete_lines` — "send one prompt, get
    back a JSON array of exactly N strings, with retries". `translate_batch`
    is just `complete_lines` over the translate prompt, and other line-wise
    LLM stages (ai/pipeline/polish.py's lyrics correction) reuse
    `complete_lines` with their own prompt instead of duplicating three
    providers' worth of client/retry/parse code.
    """

    @abstractmethod
    def complete_lines(self, prompt: str, expected_count: int) -> list[str]:
        """Send `prompt`, expecting a JSON array of exactly `expected_count`
        strings back. Retries internally; raises on (final) failure — the
        caller handles degradation.
        """
        raise NotImplementedError

    def translate_batch(self, texts: list[str], target_lang: str, source_lang: str) -> list[str]:
        """Translate texts -> target_lang, preserving order/length exactly.

        Raises on failure (caller handles retry/degradation).
        """
        if not texts:
            return []
        return self.complete_lines(_build_prompt(texts, target_lang, source_lang), len(texts))


class AnthropicTranslator(Translator):
    """Translator backed by the Anthropic Claude API."""

    def __init__(self, api_key: str, model: str = DEFAULT_ANTHROPIC_MODEL) -> None:
        import anthropic  # lazy import: avoid paying SDK import cost on ping

        self._client = anthropic.Anthropic(api_key=api_key)
        self._model = model

    def complete_lines(self, prompt: str, expected_count: int) -> list[str]:
        last_err: Optional[Exception] = None

        for attempt in range(MAX_RETRIES):
            try:
                resp = self._client.messages.create(
                    model=self._model,
                    max_tokens=4096,
                    messages=[{"role": "user", "content": prompt}],
                )
                text = "".join(
                    block.text for block in resp.content if getattr(block, "type", None) == "text"
                )
                lines = _parse_json_array(text)
                if len(lines) != expected_count:
                    raise ValueError(
                        f"line count mismatch: got {len(lines)}, "
                        f"expected {expected_count}"
                    )
                return lines
            except Exception as e:  # noqa: BLE001 - deliberately broad, see retry loop
                last_err = e
                if attempt < MAX_RETRIES - 1:
                    wait = 2**attempt  # 1s, 2s, 4s
                    protocol.log(
                        f"[translate] attempt {attempt + 1}/{MAX_RETRIES} failed: "
                        f"{e}; retrying in {wait}s"
                    )
                    time.sleep(wait)

        raise RuntimeError(f"translation failed after {MAX_RETRIES} attempts: {last_err}")


class GeminiTranslator(Translator):
    """Translator backed by the Google Gemini API (google-genai SDK)."""

    def __init__(self, api_key: str, model: str = DEFAULT_GEMINI_MODEL) -> None:
        from google import genai  # lazy import: avoid paying SDK import cost on ping

        self._genai = genai
        self._client = genai.Client(api_key=api_key)
        self._model = model

    def complete_lines(self, prompt: str, expected_count: int) -> list[str]:
        from google.genai import types

        last_err: Optional[Exception] = None

        for attempt in range(MAX_RETRIES):
            try:
                resp = self._client.models.generate_content(
                    model=self._model,
                    contents=prompt,
                    # Force a typed JSON array of strings — with only
                    # response_mime_type the model returned malformed/short JSON
                    # on larger batches; a response_schema makes the shape (and
                    # element count) reliable. max_output_tokens guards against
                    # truncation mid-array on long batches.
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=list[str],
                        max_output_tokens=8192,
                        temperature=0,
                    ),
                )
                raw_text = resp.text or ""
                if not raw_text.strip():
                    # Empty text usually isn't a transient hiccup — it's Gemini
                    # withholding output entirely (finish_reason RECITATION is
                    # common here specifically because these are song lyrics:
                    # the model's copyright/recitation check blocks near-verbatim
                    # reproduction of training-data lyrics). Surface *why* so
                    # retries log something diagnosable instead of the opaque
                    # "Expecting value: line 1 column 1 (char 0)" JSON error.
                    reason = None
                    try:
                        if resp.candidates:
                            reason = resp.candidates[0].finish_reason
                        if reason is None and resp.prompt_feedback:
                            reason = resp.prompt_feedback.block_reason
                    except Exception:  # noqa: BLE001 - best-effort diagnostics only
                        pass
                    raise ValueError(f"Gemini returned no text (finish_reason={reason})")
                lines = _parse_json_array(raw_text)
                if len(lines) != expected_count:
                    raise ValueError(
                        f"line count mismatch: got {len(lines)}, "
                        f"expected {expected_count}"
                    )
                return lines
            except Exception as e:  # noqa: BLE001 - deliberately broad, see retry loop
                last_err = e
                if attempt < MAX_RETRIES - 1:
                    wait = 2**attempt  # 1s, 2s, 4s
                    protocol.log(
                        f"[translate] attempt {attempt + 1}/{MAX_RETRIES} failed: "
                        f"{e}; retrying in {wait}s"
                    )
                    time.sleep(wait)

        raise RuntimeError(f"translation failed after {MAX_RETRIES} attempts: {last_err}")


class OpenAITranslator(Translator):
    """Translator backed by the OpenAI Chat Completions API (openai SDK)."""

    def __init__(self, api_key: str, model: str = DEFAULT_OPENAI_MODEL) -> None:
        from openai import OpenAI  # lazy import: avoid paying SDK import cost on ping

        self._client = OpenAI(api_key=api_key)
        self._model = model

    def complete_lines(self, prompt: str, expected_count: int) -> list[str]:
        # OpenAI structured outputs require an object root, so wrap the array
        # under `lines` and unwrap after parsing.
        schema = {
            "type": "object",
            "properties": {
                "lines": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["lines"],
            "additionalProperties": False,
        }
        last_err: Optional[Exception] = None

        for attempt in range(MAX_RETRIES):
            try:
                resp = self._client.chat.completions.create(
                    model=self._model,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0,
                    response_format={
                        "type": "json_schema",
                        "json_schema": {
                            "name": "lines",
                            "schema": schema,
                            "strict": True,
                        },
                    },
                )
                content = resp.choices[0].message.content or ""
                data = json.loads(content)
                lines = [str(x) for x in data.get("lines", [])]
                if len(lines) != expected_count:
                    raise ValueError(
                        f"line count mismatch: got {len(lines)}, "
                        f"expected {expected_count}"
                    )
                return lines
            except Exception as e:  # noqa: BLE001 - deliberately broad, see retry loop
                last_err = e
                if attempt < MAX_RETRIES - 1:
                    wait = 2**attempt  # 1s, 2s, 4s
                    protocol.log(
                        f"[translate] attempt {attempt + 1}/{MAX_RETRIES} failed: "
                        f"{e}; retrying in {wait}s"
                    )
                    time.sleep(wait)

        raise RuntimeError(f"translation failed after {MAX_RETRIES} attempts: {last_err}")


def _build_prompt(texts: list[str], target_lang: str, source_lang: str) -> str:
    numbered = "\n".join(f"{i}: {t}" for i, t in enumerate(texts))
    lang_hint = "Traditional Chinese (繁體中文，台灣用語)" if target_lang == "zh-TW" else target_lang
    source_name = SOURCE_LANG_NAMES.get(source_lang, source_lang)
    n = len(texts)
    # The "EXACTLY N / never merge duplicates" wording matters: lyric lines
    # repeat (e.g. 「嘘だよ」 many times) and the model otherwise deduplicates
    # or merges adjacent identical lines, returning fewer items than sent and
    # tripping the length-mismatch check (→ that batch degrades to null).
    return (
        f"Translate each of the following {n} numbered {source_name} lines into "
        f"{lang_hint}. Output EXACTLY {n} translations — one per input line, in "
        f"the same order. Even if some lines are identical, empty, or repeated, "
        f"emit a SEPARATE translation for every line; never merge, skip, "
        f"deduplicate, or combine lines. Return ONLY a JSON array of {n} strings "
        f"(no numbering inside the strings, no commentary, no markdown fences).\n\n"
        f"{numbered}"
    )


def _parse_json_array(text: str) -> list[str]:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError("expected a JSON array of translated strings")
    return [str(x) for x in data]


def _select_translator() -> Optional[Translator]:
    """Pick a Translator from env (dsd.md §4.3 — provider is swappable).

    `LLM_PROVIDER` (`gemini`|`anthropic`) forces a provider; otherwise we
    auto-detect from whichever API key is present (Gemini preferred). `LLM_MODEL`
    overrides the per-provider default model. Returns None (→ degrade) when the
    selected provider has no key.
    """
    provider = (os.environ.get("LLM_PROVIDER") or "").strip().lower()
    gemini_key = os.environ.get("GEMINI_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")

    if not provider:
        if gemini_key:
            provider = "gemini"
        elif openai_key:
            provider = "openai"
        elif anthropic_key:
            provider = "anthropic"
        else:
            provider = ""

    model = os.environ.get("LLM_MODEL")
    if provider == "gemini":
        if not gemini_key:
            return None
        return GeminiTranslator(api_key=gemini_key, model=model or DEFAULT_GEMINI_MODEL)
    if provider == "openai":
        if not openai_key:
            return None
        return OpenAITranslator(api_key=openai_key, model=model or DEFAULT_OPENAI_MODEL)
    if provider == "anthropic":
        if not anthropic_key:
            return None
        return AnthropicTranslator(api_key=anthropic_key, model=model or DEFAULT_ANTHROPIC_MODEL)
    return None


def _translate_resilient(
    translator: Translator, texts: list[str], target_lang: str, source_lang: str
) -> tuple[list[Optional[str]], bool]:
    """Translate `texts`, splitting the batch on failure to salvage coverage.

    Returns (results, degraded) with `results` the same length as `texts`
    (None only where even a single-line translation failed). Handles the
    common LLM batch failure where lyric lines with repeats come back with
    fewer items than sent (the model merges adjacent duplicates → length
    mismatch): halving repeatedly isolates the offending run down to single
    lines, which always map 1:1. Extra API calls happen only for the failing
    sub-range, not the whole job.
    """
    if not texts:
        return [], False
    try:
        return list(translator.translate_batch(texts, target_lang, source_lang)), False
    except Exception as e:  # noqa: BLE001 - split-and-retry, see docstring
        if len(texts) == 1:
            protocol.log(f"[translate] line failed permanently, degrading to null: {e}")
            return [None], True
        mid = len(texts) // 2
        left, ld = _translate_resilient(translator, texts[:mid], target_lang, source_lang)
        right, rd = _translate_resilient(translator, texts[mid:], target_lang, source_lang)
        return left + right, (ld or rd)


def translate_segments(
    source_texts: list[str],
    target_lang: str,
    source_lang: str = "ja",
    batch_size: int = DEFAULT_BATCH_SIZE,
    on_progress: Optional[callable] = None,
) -> tuple[list[Optional[str]], bool]:
    """Translate all segments, batching `batch_size` per LLM call.

    `source_lang` (dsd.md §12.2/§12.3, B5.2) feeds the translate prompt so
    the LLM is told the correct source language; it defaults to `"ja"` so
    any caller that predates this parameter (or omits it) keeps translating
    with the same "Japanese lines" prompt as before.

    Returns (target_texts, degraded). target_texts has the same length/order
    as source_texts; entries are None where translation is unavailable/failed.
    degraded is True if ANY cue ended up without a translation.
    """
    translator = _select_translator()
    if translator is None:
        protocol.log(
            "[translate] no usable LLM provider/key configured; skipping "
            "translation (degrading to target_text=null for all cues)"
        )
        return [None] * len(source_texts), True

    results: list[Optional[str]] = [None] * len(source_texts)
    degraded = False
    total = len(source_texts) or 1

    for start in range(0, len(source_texts), batch_size):
        batch = source_texts[start : start + batch_size]
        # Resilient translate: a whole-batch call first, split-and-retry only
        # on failure (e.g. the model merging repeated lyric lines).
        translated, deg = _translate_resilient(translator, batch, target_lang, source_lang)
        for i, t in enumerate(translated):
            results[start + i] = t
        if deg:
            degraded = True
        if on_progress is not None:
            done = min(start + batch_size, len(source_texts))
            on_progress(int(done / total * 100))

    return results, degraded
