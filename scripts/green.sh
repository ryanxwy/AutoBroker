#!/usr/bin/env bash
# =============================================================================
# green.sh — THE single pass/fail signal for this repo.
#
# Agent self-checks, the Stop-hook gate, and the pre-acceptance check all ask
# "is the repo green?" through this one command. Any step failing makes the
# whole script exit non-zero — no `| tail`-style blind spots, no partial green.
#
# Order is fail-fast: cheap deterministic checks first, the full suite last.
# Known load-flakes (telemetryEgress, spike2.crashResume): rerun the failing
# file isolated before believing a red — but never weaken this script to retry.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm typecheck
# The root `tsc --build` follows project references and skips the harness
# package; gate the harness's own type-soundness explicitly.
pnpm --filter @autobroker/harness run typecheck
pnpm lint:deps
pnpm check:strings
pnpm db:check
pnpm test

# Real-DOM functional UI lane: builds the dashboard and drives the
# harness/cases/*.func.toml cases through Playwright. This is the gate's only
# defense against
# UI / runtime-bump regressions the deterministic checks above cannot see (the
# "gates insufficient" gap surfaced by the Node 22->24 migration). A browser
# launch makes it heavy (~1m), so it is OFF by default to keep the inner loop
# and the Stop-hook fast; CI runs it unconditionally, and a manual full gate
# opts in with RUN_UI_FUNCTIONAL=1.
if [ "${RUN_UI_FUNCTIONAL:-0}" = "1" ]; then
  pnpm ui:functional
fi
echo "GREEN"
