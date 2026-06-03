#!/usr/bin/env python3
"""PreToolUse(Bash) hook — nudge commits to the phaseN/<skill>: convention.

The plan repo's new-day.sh buckets the daily 'code changes' table by the
`phaseN/<skill>:` commit-subject prefix. This hook keeps that machine-readable.

Lenient by design: it only blocks when it can clearly extract a `git commit -m`
message whose first line carries NO recognized prefix. Anything it cannot parse
(no -m, -F file, --amend, heredoc) is allowed through, so false-positives are rare.
"""
import json
import re
import shlex
import sys

ALLOWED = re.compile(
    r"^(phase[0-6]/[a-z0-9_]+|bootstrap|chore|docs|harness|fix|refactor|test|build|ci|style|perf)"
    r"(\([^)]*\))?:",
    re.IGNORECASE,
)


def extract_message(tokens):
    """Return the -m / --message value if present, else None."""
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in ("-m", "--message") and i + 1 < len(tokens):
            return tokens[i + 1]
        if t.startswith("--message="):
            return t.split("=", 1)[1]
        if t.startswith("-m") and len(t) > 2:
            return t[2:]
        i += 1
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("tool_name") != "Bash":
        sys.exit(0)

    cmd = (data.get("tool_input") or {}).get("command", "")
    if "git" not in cmd or "commit" not in cmd:
        sys.exit(0)

    try:
        tokens = shlex.split(cmd)
    except Exception:
        sys.exit(0)
    if "commit" not in tokens:
        sys.exit(0)

    msg = extract_message(tokens)
    if msg is None:
        sys.exit(0)  # -F / --amend / template — cannot judge, allow

    first = (msg.strip().splitlines() or [""])[0]
    if ALLOWED.match(first):
        sys.exit(0)

    # exit 2 = PreToolUse deny; stderr is shown to Claude.
    sys.stderr.write(
        "commit subject lacks a recognized prefix.\n"
        f"  got:  {first!r}\n"
        "  use:  phaseN/<skill>: <summary>   (e.g. phase1/quote_audit: add +-$1 math L1)\n"
        "  or:   bootstrap|chore|docs|harness|fix|refactor|test|build|ci: <summary>\n"
        "  (the plan repo's daily new-day.sh buckets commits by this prefix)\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
