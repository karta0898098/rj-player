"""Romaji stage: pykakasi -> full-sentence romaji string per segment.

dsd.md §4.1 says "pykakasi 對整句 text 轉 romaji" (convert the whole
sentence at once). In practice, feeding pykakasi the raw sentence text
directly hits its built-in idiom dictionary: e.g. "今日は良い天気ですね"
converts the leading "今日は" to the greeting "konnichiha" instead of the
contextually-correct "kyou wa", because pykakasi special-cases that exact
substring regardless of what follows it.

To sidestep that, we build romaji from the already-tokenized `tokens`
(same tokens used for ruby) instead of the raw string: each
kanji token already carries its correct reading (from unidic via
tokenizer.py), and kana/punctuation tokens are converted as-is. This also
guarantees romaji stays consistent with what the ruby overlay shows for
the same sentence, since both derive from one tokenization pass.
"""
from __future__ import annotations

import pykakasi

_kks = pykakasi.kakasi()


def build_romaji(tokens: list[dict]) -> str:
    """Build a full-sentence romaji string from tokens (see tokenizer.py).

    Each token contributes its `reading` (hiragana, if present) or its raw
    surface `t` otherwise, converted to Hepburn romaji, joined with spaces.
    """
    parts: list[str] = []
    for tok in tokens:
        seed = tok.get("reading") or tok["t"]
        seed = seed.strip()
        if not seed:
            continue
        conv = _kks.convert(seed)
        piece = "".join(c["hepburn"] for c in conv)
        if piece:
            parts.append(piece)
    return " ".join(parts)
