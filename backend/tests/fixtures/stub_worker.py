#!/usr/bin/env python3
"""Throwaway stub AI worker used ONLY to exercise the Rust RPC client and
orchestrator (backend/src/core/pipeline/rpc.rs, orchestrator.rs) without the
real Python pipeline, which is built separately. Speaks the exact wire
protocol from dsd.md §3.3: one JSON request per stdin line in, JSON event
lines out on stdout, human log lines on stderr.

Not the real Phase 2 AI service - do not extend this into one.

Usage: stub_worker.py [mode]
  mode=normal (default)     ping -> pong; generate_subtitles -> stage/progress
                             events then a result with one canned cue.
                             retranslate -> stage/progress then a result
                             reusing the caller's cues, zh_text overwritten.
  mode=crash_before_reply   exit (no output) right after reading a request,
                             simulating a worker crash mid-job.
  mode=malformed            write one line of invalid JSON, then exit.
  mode=slow_translate       generate_subtitles emits a partial_result
                             (zh_text null) then sleeps briefly before the
                             final result, so a test can observe the
                             pre-translate snapshot getting persisted before
                             the run finishes.
"""
import json
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


CANNED_CUE = {
    "id": 0,
    "start_ms": 0,
    "end_ms": 2500,
    "ja_text": "こんにちは",
    "ja_tokens": [{"t": "こんにちは"}],
    "romaji": "konnichiwa",
}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "normal"

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        req = json.loads(raw_line)
        req_id = req.get("id")
        method = req.get("method")

        if mode == "crash_before_reply":
            sys.stderr.write("stub_worker: simulating a crash before replying\n")
            sys.exit(1)

        if mode == "malformed":
            sys.stdout.write("this is not json {{{\n")
            sys.stdout.flush()
            sys.exit(1)

        if method == "ping":
            emit({"id": req_id, "event": "pong"})
            continue

        if method == "shutdown":
            sys.stderr.write("stub_worker: shutting down on request\n")
            return

        if method == "generate_subtitles":
            params = req.get("params", {})
            video_id = params.get("video_id", "unknown")

            emit({"id": req_id, "event": "stage", "stage": "asr", "status": "start"})
            emit({"id": req_id, "event": "progress", "stage": "asr", "pct": 50})

            if mode == "slow_translate":
                emit({
                    "id": req_id,
                    "event": "partial_result",
                    "subtitles": {
                        "version": 1,
                        "video_id": video_id,
                        "language_source": "ja",
                        "target_lang": "zh-TW",
                        "duration_ms": 2500,
                        "cues": [{**CANNED_CUE, "zh_text": None}],
                    },
                })
                time.sleep(0.2)

            emit({"id": req_id, "event": "stage", "stage": "assemble", "status": "start"})
            emit({
                "id": req_id,
                "event": "result",
                "subtitles": {
                    "version": 1,
                    "video_id": video_id,
                    "language_source": "ja",
                    "target_lang": "zh-TW",
                    "duration_ms": 2500,
                    "cues": [{**CANNED_CUE, "zh_text": "你好"}],
                },
            })
            continue

        if method == "retranslate":
            params = req.get("params", {})
            video_id = params.get("video_id", "unknown")
            cues = params.get("cues", [])

            emit({"id": req_id, "event": "stage", "stage": "translate", "status": "start"})
            emit({"id": req_id, "event": "progress", "stage": "translate", "pct": 100})
            emit({"id": req_id, "event": "stage", "stage": "assemble", "status": "start"})
            emit({
                "id": req_id,
                "event": "result",
                "subtitles": {
                    "version": 1,
                    "video_id": video_id,
                    "language_source": params.get("source_lang", "ja"),
                    "target_lang": params.get("target_lang", "zh-TW"),
                    "duration_ms": params.get("duration_ms", 0),
                    "cues": [{**c, "zh_text": f"STUB:{c.get('ja_text', '')}"} for c in cues],
                },
            })
            continue

        emit({
            "id": req_id,
            "event": "error",
            "stage": "asr",
            "message": f"stub_worker: unknown method {method!r}",
        })


if __name__ == "__main__":
    main()
