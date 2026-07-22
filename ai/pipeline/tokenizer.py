"""Tokenize stage: fugashi (MeCab + unidic-lite), self-contained (no external
MeCab install / dictionary download needed).

dsd.md §4.2 (critical invariant): tokens must cover the WHOLE sentence --
concatenating each token's `t` must reproduce `source_text` exactly. Only
tokens whose surface contains at least one kanji get a `reading` (hiragana).

Also exposes a `Tokenizer` protocol per dsd.md §4.3 so a SudachiPy
implementation can be swapped in later without touching the pipeline.
"""
from __future__ import annotations

import re
from typing import Protocol

import fugashi
import pykakasi

_KANJI_RE = re.compile(r"[一-鿿㐀-䶿]")


class Token(dict):
    """A tokens entry: {"t": surface} or {"t": surface, "reading": hiragana}."""


class Tokenizer(Protocol):
    def tokenize(self, text: str) -> list[dict]: ...


def _contains_kanji(s: str) -> bool:
    return bool(_KANJI_RE.search(s))


def _kata_to_hira(s: str) -> str:
    """Katakana -> hiragana by Unicode code-point shift.

    Standard katakana block U+30A1-U+30F6 maps 1:1 onto hiragana
    U+3041-U+3096 at a fixed -0x60 offset. Characters outside that range
    (e.g. the prolonged sound mark 'ー' U+30FC, which has no hiragana
    equivalent) are passed through unchanged.
    """
    out = []
    for ch in s:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


class FugashiTokenizer:
    """Tokenizer implementation backed by fugashi (MeCab) + unidic-lite."""

    def __init__(self) -> None:
        self._tagger = fugashi.Tagger()
        # Fallback reading lookup for kanji tokens unidic couldn't resolve
        # (e.g. rare proper nouns treated as UNK) -- best-effort only.
        self._kks = pykakasi.kakasi()

    def tokenize(self, text: str) -> list[dict]:
        tokens: list[dict] = []
        # MeCab drops inter-token whitespace (common when Whisper inserts
        # spaces in sung/lyric lines), which would break the dsd.md §4.2
        # invariant `"".join(t) == text`. So we align each surface back onto
        # the original text and re-emit any skipped run (spaces, etc.) as its
        # own plain token, keeping the reconstruction exact.
        cursor = 0
        for word in self._tagger(text):
            surface = word.surface
            if not surface:
                continue
            idx = text.find(surface, cursor)
            if idx > cursor:
                # A gap MeCab skipped — preserve it verbatim as a plain token.
                tokens.append({"t": text[cursor:idx]})
                cursor = idx
            elif idx == -1:
                # Defensive: surface not found ahead (shouldn't happen since
                # MeCab preserves surfaces). Fall through without advancing so
                # the invariant check below surfaces the mismatch loudly.
                idx = cursor

            tok: dict = {"t": surface}
            if _contains_kanji(surface):
                kana = getattr(word.feature, "kana", None)
                if not kana or kana == "*":
                    conv = self._kks.convert(surface)
                    kana = "".join(c["kana"] for c in conv)
                if kana and kana != "*":
                    tok["reading"] = _kata_to_hira(kana)
            tokens.append(tok)
            cursor = idx + len(surface)

        # Any trailing run MeCab skipped (e.g. a final space).
        if cursor < len(text):
            tokens.append({"t": text[cursor:]})

        joined = "".join(t["t"] for t in tokens)
        if joined != text:
            raise ValueError(
                f"tokenize invariant violated: joined tokens {joined!r} "
                f"!= original text {text!r}"
            )
        return tokens


_default_tokenizer: FugashiTokenizer | None = None


def _get_default() -> FugashiTokenizer:
    global _default_tokenizer
    if _default_tokenizer is None:
        _default_tokenizer = FugashiTokenizer()
    return _default_tokenizer


def tokenize(text: str) -> list[dict]:
    """Convenience wrapper using the default (fugashi) tokenizer."""
    return _get_default().tokenize(text)
