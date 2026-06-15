#!/usr/bin/env python3
"""PreToolUse(Bash) hook — block Bash commands that violate the repo's hard,
written safety rules (CLAUDE.md). These are rules that live in prose today with
no enforcement; this hook turns four of them into deterministic blocks.

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

Matching is over SHELL TOKENS (shlex), not the raw string, so a quoted argument
— e.g. a `git commit -m "... git push --force ..."` message — collapses to one
token and never trips rules C/D. Lenient by design: ~/.autobroker-ts is allowed
everywhere, and the legacy-DB READ in scripts/cold-copy-sqlite.sh (LEGACY_DB /
sqlite3 / cp) is not matched — only an AUTOBROKER_DATA_DIR= reassignment or an rm
targets it here. Any parse failure allows the command through (fail-safe).
"""
import json
import re
import shlex
import sys

# `.autobroker` NOT followed by `-` or a word char => the legacy production dir,
# excluding the parity dir `.autobroker-ts`.
LEGACY = re.compile(r"\.autobroker(?![-\w])")

AUTO_APPROVE = re.compile(r"^AUTOBROKER_TEST_AUTO_APPROVE=(1|true|yes|on)$", re.IGNORECASE)
DATA_DIR_ASSIGN = re.compile(r"^AUTOBROKER_DATA_DIR=(.*)$")
# A recursive/force flag, e.g. -r -f -rf -fr -Rf (also matches the long forms below).
RECURSIVE_FORCE = re.compile(r"^-[a-zA-Z]*[rRfF][a-zA-Z]*$")
SHORT_FORCE = re.compile(r"^-[a-zA-Z]*[fF][a-zA-Z]*$")


def is_force_flag(tok):
    return tok in ("--force", "--force-with-lease") or bool(SHORT_FORCE.match(tok))


def is_recursive_force_flag(tok):
    return tok in ("--recursive", "--force") or bool(RECURSIVE_FORCE.match(tok))


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

    try:
        toks = shlex.split(cmd)
    except Exception:
        sys.exit(0)  # unparseable (heredoc, unbalanced quotes) — allow, fail-safe

    # A — AUTOBROKER_TEST_AUTO_APPROVE set truthy
    if any(AUTO_APPROVE.match(t) for t in toks):
        deny(
            "refuses to set AUTOBROKER_TEST_AUTO_APPROVE (truthy).\n"
            "  CLAUDE.md invariant #11: keep the approval gate LIVE so the decline\n"
            "  path is exercised. Run without it and approve/decline interactively."
        )

    # B — AUTOBROKER_DATA_DIR pointed at the legacy production dir
    for t in toks:
        m = DATA_DIR_ASSIGN.match(t)
        if m and LEGACY.search(m.group(1)):
            deny(
                "AUTOBROKER_DATA_DIR points at the legacy PRODUCTION dir ~/.autobroker.\n"
                "  CLAUDE.md invariant #11: never touch a production DB. The parity\n"
                "  period uses an isolated dir — set AUTOBROKER_DATA_DIR=~/.autobroker-ts\n"
                "  (or a /tmp throwaway), never ~/.autobroker."
            )

    # C — git force-push (push subcommand + a force flag, both as real tokens)
    if "git" in toks and "push" in toks and any(is_force_flag(t) for t in toks):
        deny(
            "force-push detected (git push --force / -f / --force-with-lease).\n"
            "  CLAUDE.md git workflow: never force-push. Push a normal commit, or\n"
            "  if history truly must change, do it by hand outside this session."
        )

    # D — rm -rf targeting the legacy production dir
    if "rm" in toks and any(is_recursive_force_flag(t) for t in toks) \
            and any(LEGACY.search(t) for t in toks):
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
