"""Hermetic unit tests for ai/pipeline/polish.py (the LyricWhiz-style LLM
lyrics-correction pass).

No real LLM: the provider is either absent (degrade path) or a stub injected
in place of `_select_translator`. The contract under test:

- no usable provider -> the ORIGINAL lines come back verbatim and
  `applied` is False (the doc stays unmarked);
- with a provider -> corrected lines come back 1:1 and `applied` is True;
- a failing batch degrades per-line to the ORIGINAL text (never None,
  never an exception) — polish must never be able to lose transcript text;
- the prompt carries the video title/channel context and the hard
  line-count / no-merge constraints.

    cd ai && python3 -m unittest discover -s tests -t .
"""
import unittest
from unittest import mock

from pipeline import polish


class FakeTranslator:
    def __init__(self, replies=None, fail=False):
        self.replies = replies
        self.fail = fail
        self.prompts = []

    def complete_lines(self, prompt, expected_count):
        self.prompts.append(prompt)
        if self.fail:
            raise RuntimeError("boom")
        if self.replies is not None:
            assert len(self.replies) == expected_count
            return list(self.replies)
        return ["polished"] * expected_count


class PolishTests(unittest.TestCase):
    def test_no_provider_returns_originals_unapplied(self):
        with mock.patch.object(polish, "_select_translator", return_value=None):
            out, applied = polish.polish_lines(["a", "b"])
        self.assertEqual(out, ["a", "b"])
        self.assertFalse(applied)

    def test_provider_corrections_come_back_in_order(self):
        fake = FakeTranslator(replies=["嘘だよ", "夢の中"])
        with mock.patch.object(polish, "_select_translator", return_value=fake):
            out, applied = polish.polish_lines(
                ["うそだよ", "ゆめのなか"], "ja", title="song", channel="ch"
            )
        self.assertEqual(out, ["嘘だよ", "夢の中"])
        self.assertTrue(applied)

    def test_failure_degrades_to_original_lines_not_none(self):
        fake = FakeTranslator(fail=True)
        with mock.patch.object(polish, "_select_translator", return_value=fake):
            out, applied = polish.polish_lines(["line 1", "line 2"])
        self.assertEqual(out, ["line 1", "line 2"])
        # A provider existed, so the pass "ran" — it just degraded to a
        # no-op. applied stays True (the flag means "polish pass ran with a
        # provider", per polish_lines' docstring).
        self.assertTrue(applied)

    def test_empty_input_is_a_noop(self):
        self.assertEqual(polish.polish_lines([]), ([], False))

    def test_emptied_line_is_passed_through_for_the_caller_to_drop(self):
        # The LLM's one allowed form of deletion: blank a line it judges to
        # be ASR residue. polish_lines must NOT re-fill it with the
        # original — worker.py drops emptied cues.
        fake = FakeTranslator(replies=["嘘だよ", ""])
        with mock.patch.object(polish, "_select_translator", return_value=fake):
            out, applied = polish.polish_lines(["うそだよ", "ご視聴ありがとうございました"])
        self.assertEqual(out, ["嘘だよ", ""])
        self.assertTrue(applied)

    def test_prompt_allows_blanking_asr_residue(self):
        prompt = polish._build_polish_prompt(["a", "b"], "ja", None, None, None)
        self.assertIn("EMPTY STRING", prompt)
        self.assertIn("ONLY when confident", prompt)

    def test_prompt_carries_context_and_constraints(self):
        prompt = polish._build_polish_prompt(
            ["line a", "line b"], "ja", "My Song Title", "My Channel", "user hint"
        )
        self.assertIn("My Song Title", prompt)
        self.assertIn("My Channel", prompt)
        self.assertIn("user hint", prompt)
        self.assertIn("EXACTLY 2", prompt)
        self.assertIn("UNCHANGED", prompt)
        self.assertIn("Japanese", prompt)
        # The no-official-lyrics-from-memory guard (copyright/RECITATION
        # lesson from translate.py) must be present.
        self.assertIn("Do not insert lyrics you remember", prompt)


if __name__ == "__main__":
    unittest.main()
