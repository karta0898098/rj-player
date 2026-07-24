"""Unit tests for ai/pipeline/hallucinations.py (the known-boilerplate
blocklist).

The contract that matters most is the NEGATIVE one: this list must never
eat real lyrics. Whisper's platform boilerplate is removed; anything a
songwriter could plausibly write is left alone for the LLM polish pass to
judge in context.

    cd ai && python3 -m unittest discover -s tests -t .
"""
import unittest

from pipeline import hallucinations


def _seg(text, start_ms=0, end_ms=1000):
    return {"start_ms": start_ms, "end_ms": end_ms, "text": text}


class IsHallucinationTests(unittest.TestCase):
    def test_classic_japanese_outro_boilerplate(self):
        for text in [
            "ご視聴ありがとうございました",
            "ご視聴ありがとうございました。",
            "ご清聴ありがとうございます",
            "最後までご視聴いただきありがとうございます",
            "チャンネル登録お願いします",
            "高評価とチャンネル登録をお願いします",
        ]:
            self.assertTrue(hallucinations.is_hallucination(text), text)

    def test_english_and_amara_artifacts(self):
        for text in [
            "Thanks for watching!",
            "Thank you for watching",
            "Please subscribe",
            "Subtitles by the Amara.org community",
            "Transcription by CastingWords",
        ]:
            self.assertTrue(hallucinations.is_hallucination(text), text)

    def test_punctuation_and_spacing_variants_still_match(self):
        self.assertTrue(hallucinations.is_hallucination("　ご視聴　ありがとうございました！！"))
        self.assertTrue(hallucinations.is_hallucination("thanks   for   watching..."))

    def test_real_lyrics_are_never_dropped(self):
        # The whole point of keeping this list conservative: none of these
        # may match, including plain gratitude and short/repeated lines.
        for text in [
            "渇いた心で駆け抜ける",
            "ごめんね 何もできなくて",
            "ありがとう",
            "ありがとう、さようなら",
            "嘘だよ",
            "La la la",
            "I want to thank you for everything",
            "Watching you from afar",
            "登録された記憶",
        ]:
            self.assertFalse(hallucinations.is_hallucination(text), text)

    def test_empty_text_is_not_a_hallucination(self):
        self.assertFalse(hallucinations.is_hallucination(""))
        self.assertFalse(hallucinations.is_hallucination("   "))


class FilterSegmentsTests(unittest.TestCase):
    def test_drops_only_the_boilerplate_cue(self):
        segs = [
            _seg("渇いた心で駆け抜ける", 27800, 34300),
            _seg("ご視聴ありがとうございました", 648900, 678880),
            _seg("あのね参加してた", 287300, 288520),
        ]
        kept = hallucinations.filter_segments(segs)
        self.assertEqual(
            [s["text"] for s in kept],
            ["渇いた心で駆け抜ける", "あのね参加してた"],
        )

    def test_empty_input_passes_through(self):
        self.assertEqual(hallucinations.filter_segments([]), [])

    def test_all_clean_segments_are_untouched(self):
        segs = [_seg("嘘だよ"), _seg("夢の中")]
        self.assertEqual(hallucinations.filter_segments(segs), segs)


if __name__ == "__main__":
    unittest.main()
