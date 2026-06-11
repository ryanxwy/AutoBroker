#!/usr/bin/env bash
# =============================================================================
# Stop hook (AutoBroker code repo) — deterministic end-of-turn green gate.
#
# Layered scope:
#   - skill-loop session (.claude/.skill-loop-active marker present, created by
#     /skill-loop and removed at acceptance): run the FULL scripts/green.sh.
#   - any other session: fast `pnpm typecheck` only (seconds, incremental).
#
# Exit 2 blocks the turn from ending and feeds the failure tail back to Claude
# (Claude Code overrides the hook after 8 consecutive blocks — it is a gate,
# not a jail). Exit 0 allows the stop.
# =============================================================================
set -uo pipefail
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

if [ -f .claude/.skill-loop-active ]; then
  if ! out="$(bash scripts/green.sh 2>&1)"; then
    {
      echo "skill-loop gate: scripts/green.sh FAILED — do not end the turn red."
      echo "Fix it (known load-flakes: rerun the failing file isolated first). Tail:"
      printf '%s\n' "$out" | tail -40
    } >&2
    exit 2
  fi
else
  if ! out="$(pnpm -s typecheck 2>&1)"; then
    {
      echo "typecheck gate FAILED — do not end the turn with a broken build. Tail:"
      printf '%s\n' "$out" | tail -40
    } >&2
    exit 2
  fi
fi
exit 0
