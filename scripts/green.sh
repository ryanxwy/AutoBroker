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
pnpm lint:deps
pnpm check:strings
pnpm db:check
pnpm test
echo "GREEN"
