"""stdout/stderr protocol helpers.

Per dsd.md §3.3: stdout is the machine channel (one JSON object per line,
UTF-8, no ASCII-escaping so Japanese/Chinese text stays readable in logs
piped elsewhere). stderr is for human-readable logs only. Never mix the two.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Callable

EmitFn = Callable[[dict], None]


def emit(event: dict[str, Any]) -> None:
    """Write one JSON object to stdout, machine channel."""
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    """Write one human-readable line to stderr."""
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()
