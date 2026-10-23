#!/usr/bin/env python3
"""Do not turn a host reboot into an automatic retry of stopped research."""
import json
import pathlib
import sys


def may_resume(directory):
    for label in ("observer-a", "observer-b", "test"):
        path = directory / (label + ".jsonl")
        if not path.exists():
            continue
        if path.stat().st_size > 32 * 1024 * 1024:
            return False
        try:
            with path.open(encoding="utf-8") as source:
                for line in source:
                    if line.strip() and json.loads(line).get("kind") == "needs_review":
                        return False
        except (OSError, ValueError):
            return False
    return True


if __name__ == "__main__":
    sys.exit(0 if may_resume(pathlib.Path(__file__).resolve().parent) else 1)
