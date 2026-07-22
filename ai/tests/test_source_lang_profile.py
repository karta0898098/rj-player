"""Hermetic, stdlib-only unit tests for dsd.md §12.2/§12.3/§12.7 (B5.2):

- `worker.profile_for(source_lang)` -- the profile-lookup table that gates
  the tokenize/romaji ("reading") stages.
- `pipeline.translate._build_prompt(...)` -- the source-language-aware
  translate prompt.

No Whisper/LLM/fugashi/pykakasi involved: `_build_prompt` and `profile_for`
are both pure functions of their arguments, so these run fast and need no
API keys or heavy ML deps.

Run via (cwd must be `ai/`, per ai/README.md and dsd.md §12.7's B5.2
acceptance criteria):

    cd ai && python3 -m unittest discover -s tests -t .

Import note (see worker.py's own comment on this): `worker.py`'s top-level
`from pipeline import ...` no longer eagerly imports `tokenizer`/`romaji`
(those pull in fugashi/pykakasi, which this test's plain `python3` may not
have installed) -- they're imported lazily inside the `profile_for(...)
["reading"]` branch of `run_generate_subtitles`, which this test never
exercises. That's what keeps `import worker` cheap enough to run here.
"""
import unittest

from pipeline import translate
import worker


class ProfileForTests(unittest.TestCase):
    """dsd.md §12.2's profile matrix: ja gets the reading stages, everything
    else (en, and any unlisted/future language) doesn't."""

    def test_ja_has_reading_true(self):
        self.assertIs(worker.profile_for("ja")["reading"], True)

    def test_en_has_reading_false(self):
        self.assertIs(worker.profile_for("en")["reading"], False)

    def test_unknown_source_lang_defaults_to_reading_false(self):
        # "ko" stands in for any future/unlisted source language -- dsd.md
        # §12.2: unlisted languages fall back to DEFAULT_PROFILE (2-layer).
        self.assertIs(worker.profile_for("ko")["reading"], False)


class BuildPromptSourceLangTests(unittest.TestCase):
    """dsd.md §12.3/§12.7's translate prompt must name the actual source
    language instead of hardcoding "Japanese"."""

    def test_en_source_lang_names_english_in_prompt(self):
        prompt = translate._build_prompt(["hello"], "zh-TW", "en")
        self.assertIn("English", prompt)
        self.assertNotIn("Japanese", prompt)

    def test_ja_source_lang_names_japanese_in_prompt(self):
        prompt = translate._build_prompt(["こんにちは"], "zh-TW", "ja")
        self.assertIn("Japanese", prompt)

    def test_unknown_source_lang_falls_back_to_the_raw_code(self):
        prompt = translate._build_prompt(["annyeong"], "zh-TW", "ko")
        self.assertIn("ko", prompt)


if __name__ == "__main__":
    unittest.main()
