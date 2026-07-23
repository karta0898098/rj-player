"""Regression tests for the machine-channel protection in pipeline/protocol.py.

The bug: torch.hub printed its 'Downloading: "https://…"' banner to *stdout*
while Demucs fetched model weights on first use, corrupting the JSON
protocol stream and failing the in-flight job with the Rust-side error
"AI worker protocol violation: malformed JSON from worker". The fix is
structural — `protocol.emit` writes only to the real stdout captured at
import (`_MACHINE_OUT`), and `claim_stdout_for_logs()` (worker.py startup)
re-points `sys.stdout` at stderr so stray third-party prints can never
reach the machine channel again.

Same run contract as the other suites here (cwd must be `ai/`):

    cd ai && python3 -m unittest discover -s tests -t .
"""
import io
import json
import os
import subprocess
import sys
import unittest
from unittest import mock

from pipeline import protocol


class MachineChannelTests(unittest.TestCase):
    def test_stray_prints_go_to_stderr_not_the_machine_channel(self):
        machine = io.StringIO()
        fake_stdout = io.StringIO()
        fake_stderr = io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        try:
            sys.stdout, sys.stderr = fake_stdout, fake_stderr
            with mock.patch.object(protocol, "_MACHINE_OUT", machine):
                protocol.claim_stdout_for_logs()
                # Stands in for torch.hub's download banner (or any other
                # third-party library printing to stdout mid-job).
                print('Downloading: "https://example.com/model.th" to /cache')
                protocol.emit({"id": 1, "event": "result"})
        finally:
            sys.stdout, sys.stderr = old_out, old_err

        # The machine channel carries exactly the emitted JSON, nothing else.
        self.assertEqual(
            json.loads(machine.getvalue()), {"id": 1, "event": "result"}
        )
        # The stray print landed on the stderr log channel...
        self.assertIn("Downloading", fake_stderr.getvalue())
        # ...and nothing ever reached the (now-swapped-out) sys.stdout.
        self.assertEqual(fake_stdout.getvalue(), "")

    def test_worker_subprocess_emits_only_json_on_stdout(self):
        """End-to-end ordering proof: worker.py claims stdout for logs BEFORE
        serving requests, so its stdout is pure JSON lines."""
        ai_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        requests = (
            json.dumps({"id": 1, "method": "ping"})
            + "\n"
            + json.dumps({"id": 2, "method": "shutdown"})
            + "\n"
        )
        proc = subprocess.run(
            [sys.executable, os.path.join(ai_dir, "worker.py")],
            input=requests,
            capture_output=True,
            text=True,
            cwd=ai_dir,
            timeout=60,
        )
        lines = [l for l in proc.stdout.splitlines() if l.strip()]
        self.assertTrue(lines, "worker produced no stdout output")
        for line in lines:
            # json.loads raising here is exactly the original bug.
            json.loads(line)
        self.assertEqual(json.loads(lines[0]), {"id": 1, "event": "result", "pong": True})


if __name__ == "__main__":
    unittest.main()
