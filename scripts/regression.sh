#!/usr/bin/env bash
# =============================================================================
# regression.sh — re-run the accepted live corpus and demand it is still green.
#
# This is what makes "accepted" mean something over time: every case listed in
# harness/regression-corpus.txt is re-run live, and any case that was GREEN at
# acceptance coming back RED fails this script (treat as BLOCKER: stop new
# work, fix or record first). Use it
#   - as the round-start gate before beginning a new skill's build loop, and
#   - on a schedule (cron / /loop) as an unattended guardian.
# Runs green.sh first (no point burning live calls on a red repo). Reports land
# in ~/.autobroker-ts/regression/ (dated file + latest.txt).
#
# Safety: the corpus is read-only / approve_safe skills only — mutation-capable
# skills never enter an unattended loop. The runner's preflight is the real
# floor (isolated DB under ~/.autobroker-ts, BLOCK fuse armed, no auto-approve);
# this script arms the env but the enforcement lives in the runner, fail-closed.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

CORPUS="harness/regression-corpus.txt"
REPORT_DIR="$HOME/.autobroker-ts/regression"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
REPORT="$REPORT_DIR/$STAMP.txt"
mkdir -p "$REPORT_DIR"

# The BLOCK fuse is armed PER HARNESS CALL below, never for green.sh: the unit
# suite legitimately exercises approved-submit branches with the fuse unarmed
# (the fuse's own tests arm it per-test). Caught live by the first regression
# run on 2026-06-10 — 3 gate tests red under a script-wide export.
unset AUTOBROKER_TEST_AUTO_APPROVE
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "regression: DEEPSEEK_API_KEY not set (env or .env) — refusing to start." >&2
  exit 1
fi

echo "== regression $STAMP ==" | tee "$REPORT"

if bash scripts/green.sh >"$REPORT_DIR/$STAMP.green.log" 2>&1; then
  echo "green.sh: GREEN" | tee -a "$REPORT"
else
  echo "green.sh: FAILED (see $STAMP.green.log) — fix the repo before burning live calls." | tee -a "$REPORT"
  cp "$REPORT" "$REPORT_DIR/latest.txt"
  exit 1
fi

fail=0
while IFS= read -r case_file; do
  case "$case_file" in ''|\#*) continue ;; esac
  log="$REPORT_DIR/$STAMP.$(basename "$case_file" .toml).log"
  t0=$SECONDS
  if AUTOBROKER_DATA_DIR="${AUTOBROKER_DATA_DIR:-$HOME/.autobroker-ts/harness-runs}" \
     AUTOBROKER_MODE=test \
     MASTRA_TELEMETRY_DISABLED=1 \
     pnpm -s harness intake --case "$case_file" --layer L2 >"$log" 2>&1; then ok=1; else ok=0; fi
  dt=$((SECONDS - t0))
  # last verdict in the log wins (api lane prints {"harness":"intake",...},
  # ui lane {"harness":"ui",...} per step plus a case-summary line)
  verdict="$(grep -o '"verdict":"[A-Z_]*"' "$log" | tail -1 | sed 's/.*"verdict":"\([A-Z_]*\)".*/\1/')"
  [ -n "$verdict" ] || verdict="?"
  if [ "$ok" = 1 ]; then
    echo "GREEN  $case_file (verdict=$verdict, ${dt}s)" | tee -a "$REPORT"
  else
    echo "RED    $case_file (verdict=$verdict, ${dt}s, log=$log)" | tee -a "$REPORT"
    fail=1
  fi
done <"$CORPUS"

if [ "$fail" = 1 ]; then
  echo "REGRESSION RED — a previously-accepted case is no longer green. BLOCKER: stop new work, fix or record first." | tee -a "$REPORT"
else
  echo "REGRESSION GREEN — all accepted cases still green." | tee -a "$REPORT"
fi
cp "$REPORT" "$REPORT_DIR/latest.txt"
exit "$fail"
