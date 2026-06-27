#!/usr/bin/env bash
# =============================================================================
# Stop hook (AutoBroker code repo) — end-of-turn progress capture + publish.
#
# Runs when a Claude Code session in this repo finishes a turn. Read-only and
# PASSIVE on the CODE repo (never blocks the turn, never clobbers human-written
# narrative); step 3 DOES commit + push the plan repo (which stays the only
# write target).
#
#   1. Export today's test_run_records -> harness/exports/<date>.json so the
#      daily report's "harness 信号" section has data. (No-op if pnpm/script
#      absent.) Wire package.json: "harness:export": "tsx harness/export_daily.ts --date $(date +%F)".
#   2. Scaffold today's plan-repo daily report IF there is real progress today
#      (>=1 commit) AND the report does not exist yet. new-day.sh refuses to
#      overwrite, so re-runs are no-ops; use /daily-sync to refresh + draft.
#   3. Auto-commit + push today's generated report (daily/<date>.html + index.html)
#      to the private plan repo's origin/main. Narrow-staged, main-pinned,
#      fail-fast push; failures stay visible but never block the turn. Known
#      misses (out-of-turn hand edits, older-day edits, nested worktrees) are
#      documented in the plan repo's tools/README.md and the daily-sync skill.
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

  # 3. publish today's generated report to the private plan repo (mutates the
  #    plan remote — NOT passive). Narrow-staged ($TODAY.html + index.html only),
  #    main-pinned, fail-fast push. Failures stay VISIBLE (no 2>/dev/null) so a
  #    stale index.lock / non-fast-forward surfaces; || true keeps the turn alive.
  PLAN_REPO="$(cd "$(dirname "$PLAN_NEWDAY")/../.." 2>/dev/null && pwd)"
  if [ -n "$PLAN_REPO" ] && [ -d "$PLAN_REPO/.git" ] \
    && [ "$(git -C "$PLAN_REPO" symbolic-ref --short -q HEAD 2>/dev/null)" = main ]; then
    git -C "$PLAN_REPO" add -- "ts-rebuild/daily/$TODAY.html" "ts-rebuild/daily/index.html" || true
    if ! git -C "$PLAN_REPO" diff --cached --quiet -- "ts-rebuild/daily/$TODAY.html" "ts-rebuild/daily/index.html"; then
      git -C "$PLAN_REPO" commit -q -m "docs(daily): auto-sync $TODAY" \
        -- "ts-rebuild/daily/$TODAY.html" "ts-rebuild/daily/index.html" || true
      TO=""; command -v timeout  >/dev/null 2>&1 && TO="timeout 20"
      command -v gtimeout >/dev/null 2>&1 && TO="gtimeout 20"
      GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=5' GIT_TERMINAL_PROMPT=0 \
        $TO git -C "$PLAN_REPO" push -q origin main || true
    fi
  fi
fi

exit 0
