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

echo "-- implemented skills missing their SKILL.md (doc rides the acceptance commit):"
node -e '
  const fs = require("fs");
  const src = fs.readFileSync("packages/skills/src/registry.ts", "utf8");
  const consts = {};
  for (const m of src.matchAll(/const ([A-Z_]+_SKILL_ID) = "([a-z_]+)"/g)) consts[m[1]] = m[2];
  const missing = [];
  for (const m of src.matchAll(/id: (?:"([a-z_]+)"|([A-Z_]+_SKILL_ID)),[\s\S]{0,400}?status: "(implemented|planned)"/g)) {
    const id = m[1] ?? consts[m[2]];
    if (m[3] === "implemented" && id && !fs.existsSync(`packages/skills/${id}/SKILL.md`))
      missing.push(id);
  }
  if (missing.length) missing.forEach((id) => console.log(`  ${id} — create packages/skills/${id}/SKILL.md`));
  else console.log("  (none — every implemented skill has its SKILL.md)");
' 2>/dev/null || echo "  (check skipped — node unavailable)"

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

if [ -d "$PLAN/researches" ]; then
  echo "-- plan-repo round dirs not registered in index.html:"
  found=0
  for d in "$PLAN"/researches/*/2026*/; do
    name="$(basename "$d")"
    if ! grep -q "$name" "$PLAN/index.html"; then
      echo "  $name"
      found=1
    fi
  done
  [ "$found" = 0 ] && echo "  (none — index current)"
  echo "-- today's daily report:"
  if [ -f "$PLAN/daily/$TODAY.html" ]; then
    echo "  present"
  else
    echo "  WARN: missing — run /daily-sync"
  fi
else
  echo "-- plan repo not found at $PLAN (doc checks skipped)"
fi

echo "== end sweep (report-only; nothing was modified) =="
exit 0
