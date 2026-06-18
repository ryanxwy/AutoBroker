#!/usr/bin/env bash
# =============================================================================
# Stop hook (AutoBroker code repo) — passive end-of-turn progress capture.
#
# Runs when a Claude Code session in this repo finishes a turn. PASSIVE and
# NON-DESTRUCTIVE: never blocks the turn, never clobbers human-written narrative.
#
#   1. Export today's test_run_records -> harness/exports/<date>.json so the
#      daily report's "harness 信号" section has data. (No-op if pnpm/script
#      absent.) Wire package.json: "harness:export": "tsx harness/export_daily.ts --date $(date +%F)".
#   2. Scaffold today's plan-repo daily report IF there is real progress today
#      (>=1 commit) AND the report does not exist yet. new-day.sh refuses to
#      overwrite, so re-runs are no-ops; use /daily-sync to refresh + draft.
#
# The plan repo is the only write target; this (code) repo is read-only here.
# =============================================================================
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PLAN_NEWDAY="$(git rev-parse --show-toplevel 2>/dev/null)/../AutoBroker-dev-plan/ts-rebuild/tools/new-day.sh"
TODAY="$(date +%Y-%m-%d)"

# 1. harness export (best-effort; tolerate missing pnpm / script)
if command -v pnpm >/dev/null 2>&1 && [ -f "$ROOT/package.json" ]; then
  ( cd "$ROOT" && pnpm -s harness:export >/dev/null 2>&1 ) || true
fi

# 2. scaffold today's daily report once there's real progress (>=1 commit today)
if [ -x "$PLAN_NEWDAY" ] \
  && [ -n "$(git -C "$ROOT" log --since="$TODAY 00:00:00" --oneline 2>/dev/null)" ]; then
  "$PLAN_NEWDAY" "$TODAY" --code-repo "$ROOT" >/dev/null 2>&1 || true
fi

exit 0
