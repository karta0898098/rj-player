"""Unit tests for ai/pipeline/energy_gate.py (the vocal-energy hallucination
filter).

Uses a synthesized 16kHz mono WAV: silence 0-2s, a sung "tone" 2-4s,
silence 4-6s — the canonical intro/vocals/outro shape that produces
Whisper's intro-hallucination problem with VAD off. The contract:

- cues lying entirely in silence are dropped (the hallucinations);
- cues overlapping ANY real vocal energy survive (peak-based — the gate
  must never eat a real sung line);
- cues beyond the audio's end, unreadable files, and other failures all
  degrade to keeping everything (never a new way to lose text).

    cd ai && python3 -m unittest discover -s tests -t .
"""
import math
import os
import struct
import tempfile
import unittest
import wave

from pipeline import energy_gate


def _write_wav(path, seconds=6.0, sr=16000, tone_start=2.0, tone_end=4.0):
    """Silence with a 440Hz tone (~ -9dBFS) in [tone_start, tone_end)."""
    frames = bytearray()
    for i in range(int(seconds * sr)):
        t = i / sr
        if tone_start <= t < tone_end:
            v = int(0.35 * 32767 * math.sin(2 * math.pi * 440 * t))
        else:
            v = 0
        frames += struct.pack("<h", v)
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(bytes(frames))


def _seg(start_ms, end_ms, text="x"):
    return {"start_ms": start_ms, "end_ms": end_ms, "text": text}


class EnergyGateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.vocals = os.path.join(self._tmp.name, "vocals.wav")
        _write_wav(self.vocals)

    def test_silent_intro_and_outro_cues_are_dropped(self):
        segs = [
            _seg(0, 1500, "ご視聴ありがとうございました"),  # intro hallucination
            _seg(2100, 3900, "real line"),
            _seg(4500, 5900, "outro hallucination"),
        ]
        kept = energy_gate.filter_segments(segs, self.vocals)
        self.assertEqual([s["text"] for s in kept], ["real line"])

    def test_cue_overlapping_vocal_onset_survives(self):
        # Straddles the silence->tone boundary: it contains real singing,
        # so the (peak-based) gate must keep it.
        kept = energy_gate.filter_segments([_seg(1500, 2500)], self.vocals)
        self.assertEqual(len(kept), 1)

    def test_cue_beyond_audio_end_is_kept_not_dropped(self):
        # No evidence either way -> keep (never drop on missing data).
        kept = energy_gate.filter_segments([_seg(7000, 8000)], self.vocals)
        self.assertEqual(len(kept), 1)

    def test_unreadable_file_keeps_everything(self):
        segs = [_seg(0, 1000), _seg(2000, 3000)]
        kept = energy_gate.filter_segments(segs, os.path.join(self._tmp.name, "nope.wav"))
        self.assertEqual(kept, segs)

    def test_stereo_wav_degrades_to_no_filtering(self):
        stereo = os.path.join(self._tmp.name, "stereo.wav")
        with wave.open(stereo, "wb") as f:
            f.setnchannels(2)
            f.setsampwidth(2)
            f.setframerate(16000)
            f.writeframes(b"\x00\x00" * 3200)
        segs = [_seg(0, 100)]
        self.assertEqual(energy_gate.filter_segments(segs, stereo), segs)

    def test_empty_segments_pass_through(self):
        self.assertEqual(energy_gate.filter_segments([], self.vocals), [])


if __name__ == "__main__":
    unittest.main()
