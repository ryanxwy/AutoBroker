#!/usr/bin/env bash
# =============================================================================
# debt-sweep.sh — read-only debt inventory across the code repo and the plan
# repo. Prints a report; NEVER edits and never gates (always exits 0).
# Pair with the /debt-sweep skill or a /loop for a recurring sweep.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
PLAN="$(pwd)/../AutoBroker-dev-plan"
TODAY="$(date +%F)"

echo "== debt sweep $TODAY =="

echo "-- deferred harness cases (parked debt):"
ls harness/cases/*.deferred.toml 2>/dev/null || echo "  (none)"

echo "-- step-6 cross-provider smoke debt (cases exist, runs deferred in dev period):"
ls harness/cases/*anthropic*.toml harness/cases/*openai*.toml 2>/dev/null || echo "  (none)"

echo "-- regression freshness:"
latest="$HOME/.autobroker-ts/regression/latest.txt"
if [ -f "$latest" ]; then
  age_days=$(( ( $(date +%s) - $(stat -f %m "$latest") ) / 86400 ))
  echo "  latest report: ${age_days} day(s) old ($latest)"
  if [ "$age_days" -gt 7 ]; then
    echo "  WARN: older than 7 days — run scripts/regression.sh (or re-arm the guardian loop)"
  fi
  tail -2 "$latest" | sed 's/^/  /'
else
  echo "  WARN: no regression report yet — run scripts/regression.sh"
fi

if [ -d "$PLAN/ts-rebuild" ]; then
  echo "-- plan-repo round dirs not registered in ts-rebuild/index.html:"
  found=0
  for d in "$PLAN"/ts-rebuild/2026*/; do
    name="$(basename "$d")"
    if ! grep -q "$name" "$PLAN/ts-rebuild/index.html"; then
      echo "  $name"
      found=1
    fi
  done
  [ "$found" = 0 ] && echo "  (none — index current)"
  echo "-- today's daily report:"
  if [ -f "$PLAN/ts-rebuild/daily/$TODAY.html" ]; then
    echo "  present"
  else
    echo "  WARN: missing — run /daily-sync"
  fi
else
  echo "-- plan repo not found at $PLAN (doc checks skipped)"
fi

echo "== end sweep (report-only; nothing was modified) =="
exit 0
