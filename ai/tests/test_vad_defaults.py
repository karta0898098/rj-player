"""Unit tests for asr.vad_defaults — the separated-vs-raw VAD default sets.

Pure-function tests, no Whisper model involved. The contract under test:
Demucs-separated vocals get the relaxed `_SEPARATED_VAD_PARAMS` (standard
0.5 threshold, 30s cap — the audio behaves like clean speech), while the
raw mix keeps the music-tuned compromises (0.45 threshold, 15s hard cap
against music-swallowed mega cues). See the constants' comments in
ai/pipeline/asr.py for the full reasoning.

    cd ai && python3 -m unittest discover -s tests -t .
"""
import unittest

from pipeline import asr


class VadDefaultsTests(unittest.TestCase):
    def test_raw_mix_keeps_music_tuned_defaults(self):
        params = asr.vad_defaults(separated=False)
        self.assertEqual(params["threshold"], 0.45)
        self.assertEqual(params["max_speech_duration_s"], 15)

    def test_separated_vocals_relax_threshold_and_cap(self):
        params = asr.vad_defaults(separated=True)
        self.assertEqual(params["threshold"], 0.5)
        self.assertEqual(params["max_speech_duration_s"], 30)
        # The pause/onset knobs are audio-content properties that separation
        # doesn't change — they must stay identical across both sets.
        raw = asr.vad_defaults(separated=False)
        self.assertEqual(params["min_silence_duration_ms"], raw["min_silence_duration_ms"])
        self.assertEqual(params["speech_pad_ms"], raw["speech_pad_ms"])

    def test_returns_a_fresh_copy_safe_to_mutate(self):
        first = asr.vad_defaults(separated=True)
        first["threshold"] = 0.99
        self.assertEqual(asr.vad_defaults(separated=True)["threshold"], 0.5)


if __name__ == "__main__":
    unittest.main()
