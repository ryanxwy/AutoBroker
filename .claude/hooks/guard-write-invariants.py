#!/usr/bin/env python3
"""PreToolUse(Edit|Write|MultiEdit) hook — block file mutations that violate the
repo's hard, written rules at WRITE time, instead of only at gate time. Today
these rules live in prose + CI (check:strings) and in CLAUDE.md; this turns two
of them into deterministic, fail-CLOSED write-time blocks so the Stop-hook / CI
never goes red for something a write-time check could have caught.

Blocks (exit 2 = PreToolUse deny; stderr is shown to Claude):
  A. Introducing either stale repo name (the `-ts` / `-legacy-py` suffixed forms
     of "AutoBroker") into added text. Mirrors scripts/check-forbidden-strings.sh
     (the gate-time guard) but fails closed at write time. Exempt the files where
     the rule statement itself must spell the names: CLAUDE.md,
     scripts/check-forbidden-strings.sh, and this hook.
  B. Any write into the FROZEN parity oracle (../AutoBroker-Python/). CLAUDE.md:
     that repo is read-only — cold-copy its SQLite for parity, never share-write.

Only ADDED text is scanned for rule A (Write.content, Edit/MultiEdit new_string),
so removing a stale name is never blocked. Any parse failure allows the call
through (fail-safe), matching guard-safety-env.py.

Deliberately NOT enforced here: the five-layer import wall. dependency-cruiser
(lint:deps) polices it on the real import graph at gate time; a write-time regex
would false-positive on type-only imports and prose mentions, so it stays there.
"""
import json
import re
import sys

# The two stale repo names, grouped so the literal contiguous strings never
# appear in THIS file (else check:strings would flag the hook itself).
STALE = re.compile(r"AutoBroker-(?:ts|legacy-py)")
FROZEN_ORACLE = re.compile(r"/AutoBroker-Python/")

# Files allowed to contain the stale names (the rule statements themselves).
EXEMPT_SUFFIXES = (
    "/CLAUDE.md",
    "/scripts/check-forbidden-strings.sh",
    "/.claude/hooks/guard-write-invariants.py",
)


def added_text(tool_name, ti):
    if tool_name == "Write":
        return ti.get("content", "") or ""
    if tool_name == "Edit":
        return ti.get("new_string", "") or ""
    if tool_name == "MultiEdit":
        return "\n".join((e.get("new_string", "") or "") for e in ti.get("edits", []))
    return ""


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = data.get("tool_name")
    if tool_name not in ("Write", "Edit", "MultiEdit"):
        sys.exit(0)

    ti = data.get("tool_input") or {}
    path = ti.get("file_path", "") or ""
    if not path:
        sys.exit(0)

    # B — write into the frozen Python oracle
    if FROZEN_ORACLE.search(path):
        deny(
            "write targets the FROZEN parity oracle (../AutoBroker-Python/).\n"
            "  CLAUDE.md: that repo is read-only — cold-copy its SQLite for parity,\n"
            "  never share-write it. No new features land there. Edit the TS repo\n"
            "  instead, or work by hand outside this session."
        )

    # A — introducing a stale repo name (added text only), unless exempt
    if not any(path.endswith(s) for s in EXEMPT_SUFFIXES):
        if STALE.search(added_text(tool_name, ti)):
            deny(
                "introduces a stale repo name (the -ts / -legacy-py suffixed form).\n"
                "  CLAUDE.md naming (2026-06-03): use 'AutoBroker' (this TS repo) /\n"
                "  'AutoBroker-Python' (frozen oracle). check:strings would fail on this\n"
                "  at the gate; this blocks it at write time."
            )

    sys.exit(0)


def deny(reason):
    sys.stderr.write("guard-write-invariants: " + reason + "\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
