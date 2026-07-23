"""Lyrics-polish stage: LLM correction of free-ASR music transcripts.

The LyricWhiz idea ("Whisper as the ear, an LLM as the brain"): Whisper
mis-hears sung lyrics in predictable ways — wrong homophones, garbled
particles, mis-segmented words — that a strong LLM can often repair from
context, because it knows what plausible lyrics look like. This stage sends
the transcribed lines (plus the video's title/channel, a strong hint at
WHICH song this is) to the same provider infrastructure translate.py uses,
under strict constraints:

  * EXACTLY the same number of lines back, same order — timing is never
    touched, so a corrected line still belongs to its cue;
  * only within-line fixes of likely mis-hearings — no rewriting, merging,
    splitting, or "improving";
  * unsure -> return the line unchanged;
  * do NOT reconstruct official lyrics from memory beyond fixing what's
    written — both because the sung take may differ (covers, live edits)
    and because verbatim-lyrics reproduction trips provider copyright
    filters (Gemini's RECITATION finish reason — same lesson as
    translate.py). The prompt is framed as *proofreading a transcript*,
    not *recalling a song*, for exactly this reason.

Only the free-ASR branch runs this (worker.py): reference_lyrics / CC
sources already have correct text. Degradation contract matches translate:
no provider key, or a line's batch failing after split-and-retry, keeps the
ORIGINAL transcribed line — polish can only ever be a no-op, never a new
way to lose text or fail the pipeline.
"""
from __future__ import annotations

from typing import Optional

from . import protocol
from .translate import DEFAULT_BATCH_SIZE, SOURCE_LANG_NAMES, Translator, _select_translator


def _build_polish_prompt(
    texts: list[str],
    source_lang: str,
    title: Optional[str],
    channel: Optional[str],
    hint: Optional[str],
) -> str:
    numbered = "\n".join(f"{i}: {t}" for i, t in enumerate(texts))
    lang_name = SOURCE_LANG_NAMES.get(source_lang, source_lang)
    n = len(texts)
    context_bits = []
    if title:
        context_bits.append(f"Video title: {title}")
    if channel:
        context_bits.append(f"Channel: {channel}")
    if hint:
        context_bits.append(f"Additional context from the user: {hint}")
    context = ("\n".join(context_bits) + "\n\n") if context_bits else ""
    # Mirrors _build_prompt's "EXACTLY N / never merge" hardening — lyric
    # lines repeat, and without it the model merges duplicates and trips the
    # count check.
    return (
        f"You are proofreading an automatic speech-recognition transcript of "
        f"{lang_name} lyrics sung in a music video. ASR mis-hears sung words in "
        f"predictable ways (wrong homophones, garbled particles, mis-split "
        f"words); fix ONLY such likely mis-hearings.\n\n"
        f"{context}"
        f"Rules:\n"
        f"- Output EXACTLY {n} lines — one per input line, in the same order. "
        f"Even if lines are identical, empty, or repeated, emit a SEPARATE "
        f"line for every input; never merge, skip, deduplicate, or combine.\n"
        f"- Only correct words within a line. Never rewrite, reorder, split, "
        f"embellish, or translate.\n"
        f"- If a line already looks right, or you are not confident about a "
        f"fix, return it UNCHANGED.\n"
        f"- Do not insert lyrics you remember that are not reflected in the "
        f"transcript — the sung take may differ from any published version.\n"
        f"- Return ONLY a JSON array of {n} strings (no numbering inside the "
        f"strings, no commentary, no markdown fences).\n\n"
        f"{numbered}"
    )


def _polish_resilient(
    translator: Translator,
    texts: list[str],
    source_lang: str,
    title: Optional[str],
    channel: Optional[str],
    hint: Optional[str],
) -> tuple[list[str], bool]:
    """Polish `texts`, splitting the batch on failure to salvage coverage.

    Same split-and-retry shape as translate._translate_resilient, with one
    contract difference: a permanently-failed line degrades to its ORIGINAL
    text (not None) — an unpolished transcript line is still a perfectly
    valid transcript line.
    """
    if not texts:
        return [], False
    try:
        prompt = _build_polish_prompt(texts, source_lang, title, channel, hint)
        return list(translator.complete_lines(prompt, len(texts))), False
    except Exception as e:  # noqa: BLE001 - split-and-retry, see docstring
        if len(texts) == 1:
            protocol.log(f"[polish] line failed permanently, keeping original: {e}")
            return list(texts), True
        mid = len(texts) // 2
        left, ld = _polish_resilient(translator, texts[:mid], source_lang, title, channel, hint)
        right, rd = _polish_resilient(translator, texts[mid:], source_lang, title, channel, hint)
        return left + right, (ld or rd)


def polish_lines(
    texts: list[str],
    source_lang: str = "ja",
    title: Optional[str] = None,
    channel: Optional[str] = None,
    hint: Optional[str] = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    on_progress: Optional[callable] = None,
) -> tuple[list[str], bool]:
    """Polish all transcript lines, batching like translate_segments.

    Returns (polished_texts, applied): `polished_texts` always has the same
    length/order as `texts` (falling back to the original line wherever
    polishing was unavailable or failed); `applied` is False only when no
    LLM provider was usable at all — the caller uses it to decide whether
    the doc gets marked `polished`.
    """
    if not texts:
        return [], False
    translator = _select_translator()
    if translator is None:
        protocol.log(
            "[polish] no usable LLM provider/key configured; keeping the raw "
            "ASR transcript unchanged"
        )
        return list(texts), False

    results: list[str] = []
    changed = 0
    total = len(texts) or 1
    for start in range(0, len(texts), batch_size):
        batch = texts[start : start + batch_size]
        polished, _deg = _polish_resilient(translator, batch, source_lang, title, channel, hint)
        results.extend(polished)
        if on_progress is not None:
            done = min(start + batch_size, len(texts))
            on_progress(int(done / total * 100))
    changed = sum(1 for old, new in zip(texts, results) if old != new)
    protocol.log(f"[polish] done: {changed}/{len(texts)} lines corrected")
    return results, True
