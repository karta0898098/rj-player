"""Hermetic, stdlib-only unit tests for dsd.md §12.4/§12.5/§12.7 (B5.5):

`pipeline.cc.merge_target_captions` -- the time-overlap merge that lets a
manual target-language (Chinese) CC track stand in for the LLM translate
stage. Pure function of its two list-of-dict arguments, no I/O, so this
needs no fixture files, API keys, or heavy ML deps.

Uses only stdlib (`unittest`) + `from pipeline import cc`, same import
rationale as `test_cc_source_lang.py`: `cc.py` only pulls in stdlib plus
`protocol.py` (also stdlib-only), so importing it never drags in fugashi/
pykakasi/whisper.

Run via (cwd must be `ai/`, per ai/README.md and dsd.md §12.7's acceptance
criteria):

    cd ai && python3 -m unittest discover -s tests -t .
"""
import unittest

from pipeline import cc


class MergeTargetCaptionsTests(unittest.TestCase):
    def test_exact_overlap_uses_that_segment_text(self):
        source_cues = [{"start_ms": 1000, "end_ms": 2000}]
        target_segments = [{"start_ms": 1000, "end_ms": 2000, "text": "你好"}]

        merged = cc.merge_target_captions(source_cues, target_segments)

        self.assertEqual(merged, ["你好"])

    def test_partial_overlap_uses_that_segment_text(self):
        # Source cue [1000, 3000) only partially overlaps the target
        # segment [2500, 4000) -- 500ms of overlap is still > 0, so it
        # counts.
        source_cues = [{"start_ms": 1000, "end_ms": 3000}]
        target_segments = [{"start_ms": 2500, "end_ms": 4000, "text": "部分重疊"}]

        merged = cc.merge_target_captions(source_cues, target_segments)

        self.assertEqual(merged, ["部分重疊"])

    def test_no_overlap_yields_none(self):
        source_cues = [{"start_ms": 0, "end_ms": 1000}]
        target_segments = [{"start_ms": 5000, "end_ms": 6000, "text": "不相關"}]

        merged = cc.merge_target_captions(source_cues, target_segments)

        self.assertEqual(merged, [None])

    def test_source_cue_spanning_two_target_segments_joins_in_order(self):
        # One long source cue [0, 5000) overlaps two shorter target segments;
        # both must be joined with a single space, in time order, regardless
        # of the order they appear in target_segments.
        source_cues = [{"start_ms": 0, "end_ms": 5000}]
        target_segments = [
            {"start_ms": 2500, "end_ms": 4000, "text": "第二段"},
            {"start_ms": 0, "end_ms": 2000, "text": "第一段"},
        ]

        merged = cc.merge_target_captions(source_cues, target_segments)

        self.assertEqual(merged, ["第一段 第二段"])

    def test_aligned_1to1_with_source_cues_including_mixed_results(self):
        source_cues = [
            {"start_ms": 0, "end_ms": 1000},
            {"start_ms": 1000, "end_ms": 2000},
            {"start_ms": 9000, "end_ms": 10000},
        ]
        target_segments = [
            {"start_ms": 0, "end_ms": 1000, "text": "第一句"},
            {"start_ms": 1000, "end_ms": 2000, "text": "第二句"},
        ]

        merged = cc.merge_target_captions(source_cues, target_segments)

        self.assertEqual(merged, ["第一句", "第二句", None])


class OverlapMsTests(unittest.TestCase):
    def test_overlapping_intervals(self):
        self.assertEqual(cc._overlap_ms(0, 1000, 500, 1500), 500)

    def test_non_overlapping_intervals_clamp_to_zero(self):
        self.assertEqual(cc._overlap_ms(0, 1000, 2000, 3000), 0)

    def test_identical_intervals(self):
        self.assertEqual(cc._overlap_ms(0, 1000, 0, 1000), 1000)


if __name__ == "__main__":
    unittest.main()
