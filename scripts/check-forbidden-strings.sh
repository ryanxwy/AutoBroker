#!/usr/bin/env bash
# =============================================================================
# check-forbidden-strings.sh — stale-name + removed-env-var guard (CI + local).
#
# (1) NAMING (CLAUDE.md, authoritative 2026-06-03): never write the stale repo
#     names "AutoBroker-ts" or "AutoBroker-legacy-py".
# (2) SEND-CONTROL: AUTOBROKER_MODE is the SOLE send-control variable. The two
#     legacy send-control vars AUTOBROKER_GMAIL_BACKEND and
#     AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS are REMOVED — re-introducing either
#     (a second name for the same bit) is a forbidden architecture change.
#
# The only permitted occurrences are the rule statements themselves (CLAUDE.md)
# and this script.
#
# Exit 0 = clean; exit 1 = violations printed.
# (The lowercase data-dir ~/.autobroker-ts is fine — match is case-sensitive.)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

status=0

if git grep -nE 'AutoBroker-ts|AutoBroker-legacy-py' -- \
  ':!pnpm-lock.yaml' \
  ':!CLAUDE.md' \
  ':!scripts/check-forbidden-strings.sh'; then
  echo "ERROR: stale repo names found (see above). Use 'AutoBroker' (TS repo) / 'AutoBroker-Python' (frozen oracle)." >&2
  status=1
fi

if git grep -nE 'AUTOBROKER_GMAIL_BACKEND|AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS' -- \
  ':!pnpm-lock.yaml' \
  ':!CLAUDE.md' \
  ':!scripts/check-forbidden-strings.sh'; then
  echo "ERROR: a removed send-control env var found (see above). AUTOBROKER_MODE is the SOLE send-control variable; AUTOBROKER_GMAIL_BACKEND and AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS are removed and must not be re-introduced." >&2
  status=1
fi

if [ "$status" -ne 0 ]; then
  exit 1
fi
echo "OK: no forbidden stale names or removed env vars."
