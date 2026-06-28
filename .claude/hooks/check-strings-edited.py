#!/usr/bin/env python3
"""PostToolUse(Edit|Write|MultiEdit) hook — scan ONLY the just-edited file for the
repo's forbidden strings, so a stale name surfaces at edit time instead of at the
green.sh / CI `check:strings` gate.

Mirrors scripts/check-forbidden-strings.sh (the authoritative full-tree gate),
case-sensitive, scoped to one file. Banned: the two stale repo names, the two
REMOVED send-control env vars, and the abandoned in-bundle marker draft name —
see BANNED below.

Non-blocking by intent (the edit applied): exit 2 feeds the offending lines back
to Claude; exit 0 is silent. The same files the full gate excludes (they hold
these literals as rule statements / scan targets) are skipped here too, including
this hook itself. Any failure to run is a silent exit 0 — never nag spuriously.

NOTE: the banned tokens are assembled from fragments so this file contains no
contiguous forbidden literal — that keeps it clean for both the full `check:strings`
gate and the PreToolUse write-guard, with no exclude-list change needed anywhere.
"""
import json
import os
import re
import sys

# Built from fragments on purpose (see NOTE above): the contiguous banned string
# never appears in this source.
BANNED = (
    "AutoBroker" + "-ts",
    "AutoBroker" + "-legacy-py",
    "AUTOBROKER_GMAIL" + "_BACKEND",
    "AUTOBROKER_BLOCK" + "_EXTERNAL_MUTATIONS",
    "dev" + "-origin",
)
PATTERN = re.compile("|".join(re.escape(b) for b in BANNED))

EXCLUDED_BASENAMES = {"CLAUDE.md", "pnpm-lock.yaml"}
EXCLUDED_SUFFIXES = (
    "scripts/check-forbidden-strings.sh",
    "scripts/desktop-dist-tripwire.mjs",
    "scripts/desktop-dist-tripwire.test.mjs",
    ".claude/hooks/check-strings-edited.py",
)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit"):
        sys.exit(0)

    path = (data.get("tool_input") or {}).get("file_path", "") or ""
    if not path:
        sys.exit(0)
    norm = path.replace("\\", "/")
    if os.path.basename(norm) in EXCLUDED_BASENAMES:
        sys.exit(0)
    if any(norm.endswith(s) for s in EXCLUDED_SUFFIXES):
        sys.exit(0)

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        sys.exit(0)  # binary / unreadable / gone — fail-safe

    hits = [f"  {i}: {ln.rstrip()}" for i, ln in enumerate(lines, 1) if PATTERN.search(ln)]
    if not hits:
        sys.exit(0)

    body = "\n".join(hits[:20])
    sys.stderr.write(
        "check-strings-edited: forbidden string(s) in this file (advisory — the "
        "edit applied; check:strings will fail the gate). Banned: the stale repo "
        "names / removed send-control env vars / the abandoned marker draft name.\n\n"
        f"{os.path.basename(path)}:\n{body}\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
