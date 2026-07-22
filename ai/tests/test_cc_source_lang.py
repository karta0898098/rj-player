"""Hermetic, stdlib-only unit test for dsd.md §12.4/§12.7 (B5.4):

`pipeline.cc.load_cc` was always text-agnostic (it just parses SRT cue
blocks and cleans each cue's text -- nothing in it is Japanese-specific),
but B5.4 is what actually lets a non-Japanese manual CC reach it in
practice (`YtDlp::fetch_source_captions` now fetches whatever `source_lang`
the video was submitted with, not a hardcoded `ja`). This test locks in
that `load_cc` already handles a non-Japanese (English) CC correctly, so a
future regression here would be caught even though B5.4 itself only touched
the Rust fetch side.

Uses only stdlib (`tempfile`, `unittest`) + `from pipeline import cc`.
`cc.py` imports only stdlib (`re`/`wave`/`pathlib`/`typing`) plus
`from . import protocol`, and `protocol.py` in turn only imports stdlib
(`json`/`sys`/`typing`) -- so importing `cc` never pulls in fugashi/
pykakasi/whisper, same as `test_source_lang_profile.py`'s note about
`worker.py`.

Run via (cwd must be `ai/`, per ai/README.md and dsd.md §12.7's B5.4
acceptance criteria):

    cd ai && python3 -m unittest discover -s tests -t .
"""
import tempfile
import unittest
from pathlib import Path

from pipeline import cc


class LoadCcNonJapaneseTests(unittest.TestCase):
    """An English manual CC track must parse just like a Japanese one --
    `load_cc` has no language-specific logic, it just parses SRT text."""

    def test_parses_english_srt_segments(self):
        srt = (
            "1\n"
            "00:00:01,000 --> 00:00:02,500\n"
            "Hello there.\n"
            "\n"
            "2\n"
            "00:00:03,000 --> 00:00:04,000\n"
            "General Kenobi!\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            cc_path = Path(tmp) / "cc.en.srt"
            cc_path.write_text(srt, encoding="utf-8")

            segments, duration_ms = cc.load_cc(str(cc_path))

        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["text"], "Hello there.")
        self.assertEqual(segments[0]["start_ms"], 1000)
        self.assertEqual(segments[0]["end_ms"], 2500)
        self.assertEqual(segments[1]["text"], "General Kenobi!")
        # No audio_path supplied -- duration_ms falls back to the last cue's
        # end_ms, per load_cc's docstring.
        self.assertEqual(duration_ms, 4000)

    def test_music_note_and_bracket_only_cue_cleaning_still_applies(self):
        srt = (
            "1\n"
            "00:00:00,000 --> 00:00:01,000\n"
            "[Music]\n"
            "\n"
            "2\n"
            "00:00:01,000 --> 00:00:02,000\n"
            "♪ some lyrics ♪\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            cc_path = Path(tmp) / "cc.en.srt"
            cc_path.write_text(srt, encoding="utf-8")

            segments, _duration_ms = cc.load_cc(str(cc_path))

        # The bracket-only "[Music]" cue is dropped entirely; the music-note
        # markers on the second cue are stripped but the surrounding text
        # survives.
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "some lyrics")


if __name__ == "__main__":
    unittest.main()
