"""Hermetic unit tests for ai/pipeline/separate.py's contract:

- vocals-cache hit returns True without ever touching Demucs;
- a stale zero-byte cache file does NOT count as a hit;
- missing/absent high-quality input returns False (fall back to original
  audio);
- ANY failure inside the actual Demucs run (deps not installed, OOM, bad
  input) is swallowed into a False return -- separation must never become a
  new way for the pipeline to fail.

No torch/demucs required: `separate.separate` only reaches its lazy heavy
imports inside `_run_demucs`, which these tests either avoid (cache/missing-
input paths) or replace (the failure path). Same run contract as the other
suites here (cwd must be `ai/`):

    cd ai && python3 -m unittest discover -s tests -t .
"""
import os
import tempfile
import unittest
from unittest import mock

from pipeline import separate


class SeparateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name

    def _path(self, name):
        return os.path.join(self.dir, name)

    def test_cache_hit_returns_true_without_running_demucs(self):
        vocals = self._path("vocals.wav")
        with open(vocals, "wb") as f:
            f.write(b"previously separated vocals")

        progress = []
        with mock.patch.object(
            separate, "_run_demucs", side_effect=AssertionError("must not run")
        ):
            ok = separate.separate(
                self._path("audio_hq.wav"),  # doesn't even need to exist
                vocals,
                on_progress=progress.append,
            )
        self.assertTrue(ok)
        self.assertIn(100, progress)

    def test_zero_byte_cache_file_is_not_a_hit(self):
        vocals = self._path("vocals.wav")
        open(vocals, "wb").close()  # stale empty artifact

        # No hq input either -> must fall through the cache check AND the
        # input check to False, not "hit" the empty file.
        self.assertFalse(separate.separate(self._path("audio_hq.wav"), vocals))

    def test_missing_hq_input_returns_false(self):
        self.assertFalse(
            separate.separate(self._path("nope.wav"), self._path("vocals.wav"))
        )
        self.assertFalse(separate.separate(None, self._path("vocals.wav")))

    def test_demucs_failure_degrades_to_false_instead_of_raising(self):
        hq = self._path("audio_hq.wav")
        with open(hq, "wb") as f:
            f.write(b"fake wav bytes")

        # Stands in for every real failure mode of the heavy path -- demucs
        # not installed (ImportError), model download failure, OOM, ... --
        # all of which surface here as an exception from _run_demucs.
        with mock.patch.object(
            separate, "_run_demucs", side_effect=RuntimeError("boom")
        ):
            ok = separate.separate(hq, self._path("vocals.wav"))
        self.assertFalse(ok)
        self.assertFalse(os.path.exists(self._path("vocals.wav")))

    def test_default_model_name_env_override(self):
        with mock.patch.dict(os.environ, {"DEMUCS_MODEL": "htdemucs_ft"}):
            self.assertEqual(separate.default_model_name(), "htdemucs_ft")
        with mock.patch.dict(os.environ):
            os.environ.pop("DEMUCS_MODEL", None)
            self.assertEqual(separate.default_model_name(), "htdemucs")


if __name__ == "__main__":
    unittest.main()
