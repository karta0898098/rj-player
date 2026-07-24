"""Known-hallucination blocklist: drop Whisper's platform-boilerplate cues.

Whisper was trained on weakly-labeled web video, so over a non-speech
stretch it doesn't emit nothing — it emits *the captions those videos end
with*: ご視聴ありがとうございました, チャンネル登録お願いします,
"Thanks for watching!", "Subtitles by the Amara.org community". On a music
video these are never lyrics; they're pure ASR residue.

This is the cheap always-on complement to the two energy-based layers in
`energy_gate`: it needs no LLM key, no separated vocals, and no audio at
all, so it also protects raw-mix runs (where the energy signal doesn't
exist) and installs with no API key configured.

Deliberately conservative. Only phrases that could never plausibly be sung
lyrics are listed — a bare ありがとう, a repeated short line, or anything
context-dependent is NOT here and is left to the LLM polish pass, which can
judge it against the surrounding lyrics. The rule for adding an entry: if
you can imagine it in a song, it doesn't belong in this file.
"""
from __future__ import annotations

from . import protocol

# Stripped before matching so punctuation/spacing variants ("ご視聴
# ありがとうございました。" vs "ご視聴ありがとうございました") collapse to
# the same key.
_PUNCT = set("。、，,．.！!？?〜~・…「」『』()（）[]【】♪♬ 　\t\r\n-—_/\\\"'")


def _normalize(text: str) -> str:
    return "".join(ch for ch in text.strip().lower() if ch not in _PUNCT)


# Whole-cue matches: the cue is artifact if its ENTIRE normalized text is
# one of these.
_EXACT = [
    # Japanese YouTube outro boilerplate — the classic Whisper artifacts.
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございます",
    "ご清聴ありがとうございました",
    "ご清聴ありがとうございます",
    "最後までご視聴いただきありがとうございます",
    "最後までご視聴いただきありがとうございました",
    "本日はご視聴ありがとうございました",
    "次回もお楽しみに",
    "また次回お会いしましょう",
    # English.
    "thanks for watching",
    "thank you for watching",
    "thanks for watching everyone",
    "see you in the next video",
    "see you next time",
    "please subscribe",
    "please subscribe to my channel",
    "dont forget to subscribe",
    "like and subscribe",
    "the end",
    # Chinese boilerplate Whisper emits even on ja/en audio.
    "字幕由amaraorg社区提供",
    "请不吝点赞订阅转发打赏支持明镜与点点栏目",
]

# Substring matches: phrases distinctive enough that containing them
# anywhere makes the cue artifact (they have no lyrical reading at all).
_SUBSTRING = [
    "ご視聴ありがとう",
    "ご清聴ありがとう",
    "チャンネル登録",
    "高評価をお願い",
    "amaraorg",
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "subtitles by",
    "transcription by",
    "subs by",
]

_EXACT_SET = {_normalize(p) for p in _EXACT}
_SUBSTRING_NORM = [_normalize(p) for p in _SUBSTRING]


def is_hallucination(text: str) -> bool:
    """Whether `text` is known ASR boilerplate rather than lyrics."""
    norm = _normalize(text)
    if not norm:
        return False
    if norm in _EXACT_SET:
        return True
    return any(marker in norm for marker in _SUBSTRING_NORM)


def filter_segments(segments: list[dict]) -> list[dict]:
    """Drop segments whose text is known ASR boilerplate.

    Segments need a `text` key (the shape asr.transcribe yields). Pure text
    matching — no audio, no LLM, never raises.
    """
    if not segments:
        return segments
    kept = [seg for seg in segments if not is_hallucination(seg.get("text", ""))]
    dropped = len(segments) - len(kept)
    if dropped:
        for seg in segments:
            if is_hallucination(seg.get("text", "")):
                protocol.log(
                    f"[hallucinations] DROPPED {seg.get('start_ms')}-{seg.get('end_ms')}ms "
                    f"{seg.get('text', '')[:40]!r} (known ASR boilerplate)"
                )
        protocol.log(f"[hallucinations] dropped {dropped}/{len(segments)} known-artifact cue(s)")
    return kept
