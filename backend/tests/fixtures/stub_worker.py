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
  mode=crash_before_reply   exit (no output) right after reading a request,
                             simulating a worker crash mid-job.
  mode=malformed            write one line of invalid JSON, then exit.
"""
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


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
                    "cues": [
                        {
                            "id": 0,
                            "start_ms": 0,
                            "end_ms": 2500,
                            "ja_text": "こんにちは",
                            "ja_tokens": [{"t": "こんにちは"}],
                            "romaji": "konnichiwa",
                            "zh_text": "你好",
                        }
                    ],
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
