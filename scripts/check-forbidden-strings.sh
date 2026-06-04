#!/usr/bin/env bash
# =============================================================================
# check-forbidden-strings.sh — stale-name guard (CI + local).
#
# CLAUDE.md (naming, authoritative 2026-06-03): never write the stale repo
# names "AutoBroker-ts" or "AutoBroker-legacy-py". The only permitted
# occurrences are the rule statements themselves (CLAUDE.md,
# design-docs/README.md) and this script.
#
# Exit 0 = clean; exit 1 = violations printed.
# (The lowercase data-dir ~/.autobroker-ts is fine — match is case-sensitive.)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if git grep -nE 'AutoBroker-ts|AutoBroker-legacy-py' -- \
  ':!pnpm-lock.yaml' \
  ':!CLAUDE.md' \
  ':!design-docs/README.md' \
  ':!scripts/check-forbidden-strings.sh'; then
  echo "ERROR: stale repo names found (see above). Use 'AutoBroker' (TS repo) / 'AutoBroker-Python' (frozen oracle)." >&2
  exit 1
fi
echo "OK: no forbidden stale names."
