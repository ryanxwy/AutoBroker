#!/usr/bin/env python3
"""PreToolUse(Bash) hook — block Bash commands that violate the repo's hard,
written safety rules (CLAUDE.md). These are rules that live in prose today with
no enforcement; this hook turns three of them into deterministic blocks.

Blocks (exit 2 = PreToolUse deny; stderr is shown to Claude):
  A. Setting AUTOBROKER_TEST_AUTO_APPROVE truthy — invariant #11 keeps the
     approval/decline gate live so the decline path is exercised. Never set it.
  B. Pointing the app/harness at the legacy PRODUCTION data dir via
     AUTOBROKER_DATA_DIR=~/.autobroker (the parity period uses ~/.autobroker-ts).
     Invariant #11: never touch a production DB; use an isolated throwaway dir.
  C. git push --force / -f / --force-with-lease — the git-workflow rule says
     never force-push.
  D. rm -rf on the legacy ~/.autobroker (non -ts) dir — destroying the frozen
     parity oracle's data is never a legitimate action from this repo.

Lenient elsewhere by design: ~/.autobroker-ts is allowed everywhere, and the
legacy-DB READ in scripts/cold-copy-sqlite.sh (LEGACY_DB / sqlite3 / cp) is not
matched — only an AUTOBROKER_DATA_DIR= reassignment or an rm targets it here.
Any parse failure allows the command through (fail-safe, never fail-shut).
"""
import json
import re
import sys

# `.autobroker` NOT followed by `-` or a word char => the legacy production dir,
# excluding the parity dir `.autobroker-ts`.
_LEGACY = r"\.autobroker(?![-\w])"

AUTO_APPROVE = re.compile(
    r"\bAUTOBROKER_TEST_AUTO_APPROVE\s*=\s*[\"']?(1|true|yes|on)\b",
    re.IGNORECASE,
)
PROD_DATA_DIR = re.compile(
    r"\bAUTOBROKER_DATA_DIR\s*=\s*[\"']?\S*?" + _LEGACY,
)
FORCE_PUSH = re.compile(r"\bpush\b")
FORCE_FLAG = re.compile(r"(--force(-with-lease)?\b|(?<![\w-])-[a-zA-Z]*f\b)")
RM_LEGACY = re.compile(r"\brm\b\s+[^|;&]*-[a-zA-Z]*[rf][a-zA-Z]*\b[^|;&]*" + _LEGACY)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("tool_name") != "Bash":
        sys.exit(0)

    cmd = (data.get("tool_input") or {}).get("command", "")
    if not cmd:
        sys.exit(0)

    if AUTO_APPROVE.search(cmd):
        deny(
            "refuses to set AUTOBROKER_TEST_AUTO_APPROVE (truthy).\n"
            "  CLAUDE.md invariant #11: keep the approval gate LIVE so the decline\n"
            "  path is exercised. Run without it and approve/decline interactively."
        )

    if PROD_DATA_DIR.search(cmd):
        deny(
            "AUTOBROKER_DATA_DIR points at the legacy PRODUCTION dir ~/.autobroker.\n"
            "  CLAUDE.md invariant #11: never touch a production DB. The parity\n"
            "  period uses an isolated dir — set AUTOBROKER_DATA_DIR=~/.autobroker-ts\n"
            "  (or a /tmp throwaway), never ~/.autobroker."
        )

    if FORCE_PUSH.search(cmd) and FORCE_FLAG.search(cmd):
        deny(
            "force-push detected (git push --force / -f / --force-with-lease).\n"
            "  CLAUDE.md git workflow: never force-push. Push a normal commit, or\n"
            "  if history truly must change, do it by hand outside this session."
        )

    if RM_LEGACY.search(cmd):
        deny(
            "rm -rf targets the legacy ~/.autobroker (non -ts) dir.\n"
            "  That is the frozen parity oracle's data — destroying it is never a\n"
            "  legitimate action from this repo. Scope rm to ~/.autobroker-ts or /tmp."
        )

    sys.exit(0)


def deny(reason):
    sys.stderr.write("guard-safety-env: " + reason + "\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
