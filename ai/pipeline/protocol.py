"""stdout/stderr protocol helpers.

Per dsd.md §3.3: stdout is the machine channel (one JSON object per line,
UTF-8, no ASCII-escaping so Japanese/Chinese text stays readable in logs
piped elsewhere). stderr is for human-readable logs only. Never mix the two.

`_MACHINE_OUT` is bound to the REAL stdout at import time, and `emit` writes
only through it — combined with `claim_stdout_for_logs()` (called by
worker.py at startup), this makes the machine channel immune to stray
`print`s from third-party libraries. The lesson behind it: torch.hub writes
its 'Downloading: "https://…"' line to *stdout* when Demucs fetches model
weights on first use, which corrupted the protocol stream and killed the
in-flight job with "malformed JSON from worker". Any of the heavyweight deps
(torch, demucs, huggingface, …) could do the same at any version bump, so
the channel is protected structurally instead of patching printers one by
one.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Callable

EmitFn = Callable[[dict], None]

# The real stdout, captured before anyone gets a chance to swap sys.stdout.
# emit() writes ONLY here; after claim_stdout_for_logs() this is the one
# handle left that can reach the machine channel.
_MACHINE_OUT = sys.stdout


def claim_stdout_for_logs() -> None:
    """Point `sys.stdout` at stderr, reserving the real stdout for `emit`.

    Called once by worker.py before processing requests. From then on any
    library (or stray `print`) writing to `sys.stdout` lands on the stderr
    log channel instead of corrupting the JSON protocol stream.
    """
    sys.stdout = sys.stderr


def emit(event: dict[str, Any]) -> None:
    """Write one JSON object to the machine channel (the real stdout)."""
    _MACHINE_OUT.write(json.dumps(event, ensure_ascii=False) + "\n")
    _MACHINE_OUT.flush()


def log(msg: str) -> None:
    """Write one human-readable line to stderr."""
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()
