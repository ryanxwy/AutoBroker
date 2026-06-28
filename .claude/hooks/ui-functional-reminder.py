#!/usr/bin/env python3
"""PostToolUse(Edit|Write|MultiEdit) hook — advisory reminder to run the
deterministic UI functional lane before pushing, when an edit touches the UI, a
`data-testid`, or the harness case corpus.

WHY: `scripts/green.sh` SKIPS `pnpm ui:functional` by default (it is heavy ~1m
and off by default), so a UI / testid / harness change can pass local green yet
go CI-RED. This nudges the in-loop fix to run the FULL gate
`RUN_UI_FUNCTIONAL=1 bash scripts/green.sh` before pushing.

Non-blocking by intent (the edit already applied): exit 2 feeds a one-line
advisory back to Claude; exit 0 is silent. Throttled to at most once per 10
minutes via a temp stamp so a burst of UI edits does not nag every keystroke.
Any failure to run is a silent exit 0 — never nag spuriously.
"""
import json
import os
import sys
import tempfile
import time

THROTTLE_SECONDS = 600
STAMP = os.path.join(tempfile.gettempdir(), "autobroker-ui-functional-reminder.stamp")


def is_relevant(path: str, content: str) -> bool:
    p = path.replace("\\", "/")
    if p.endswith(".func.toml"):
        return True
    if "/harness/cases/" in p:
        return True
    if "/apps/ui/" in p and p.endswith((".ts", ".tsx", ".css", ".html")):
        return True
    if "data-testid" in content:  # a testid change in any file
        return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit"):
        sys.exit(0)

    ti = data.get("tool_input") or {}
    path = ti.get("file_path", "") or ""
    content = ti.get("content") or ti.get("new_string") or ""
    if isinstance(ti.get("edits"), list):  # MultiEdit
        content += " ".join((e or {}).get("new_string", "") for e in ti["edits"])

    if not is_relevant(path, content):
        sys.exit(0)

    # Throttle: stay silent if we already reminded within the window.
    try:
        if os.path.exists(STAMP) and (time.time() - os.path.getmtime(STAMP)) < THROTTLE_SECONDS:
            sys.exit(0)
    except Exception:
        pass
    try:
        open(STAMP, "w").close()
    except Exception:
        pass

    sys.stderr.write(
        "ui-functional-reminder: this edit touched the UI / a data-testid / a "
        "harness case. green.sh SKIPS the UI functional lane by default — before "
        "pushing, run `RUN_UI_FUNCTIONAL=1 bash scripts/green.sh` (advisory).\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
