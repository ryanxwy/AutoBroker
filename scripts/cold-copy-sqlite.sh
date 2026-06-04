#!/usr/bin/env bash
#
# cold-copy-sqlite.sh
#
# Cold-copy the legacy AutoBroker-Python SQLite into the TS repo's parity path.
# COPY-NOT-SHARE: the two repos NEVER open the same file, and we NEVER two-way
# sync. (DECISIONS.html "DB 驱动 + schema 迁移"; risks "双语言/双栈共写一个 SQLite".)
#
# WHY: the legacy machine runs `busy_timeout = 0`, so two writers on one SQLite
# file fail immediately with SQLITE_BUSY and no retry. A one-time cold copy
# eliminates the entire shared-writer failure class. The TS repo then opens its
# OWN copy with WAL + busy_timeout=5000 (see packages/db/src/client.ts) and is the
# sole writer of that file.
#
# Procedure (the four steps that make the copy safe):
#   1. QUIESCE the legacy writer  — ensure no AutoBroker-Python process is writing
#      (stop `autobroker up` / any backend). A live writer mid-checkpoint yields a
#      torn copy.
#   2. wal_checkpoint(TRUNCATE)    — fold the legacy -wal back into the main db so
#      the copy is a single self-contained file (no orphaned -wal/-shm).
#   3. cp legacy -> TS path        — copy ~/.autobroker/autobroker.db to the TS
#      parity path under ~/.autobroker-ts/.
#   4. TS sets its OWN pragmas     — the TS repo opens the copy and applies
#      journal_mode=WAL + busy_timeout=5000 (done in packages/db/src/client.ts at
#      connection open; this script just leaves a clean file).
#
# This is a ONE-DIRECTION, ONE-TIME operation per parity refresh. There is no
# reverse path and no sync daemon.
#
# CI NOTE — drizzle-kit generate empty-diff gate:
#   After a cold copy, `pnpm --filter @autobroker/db db:pull` re-introspects the
#   copied file into packages/db/src/schema.ts, and `pnpm --filter @autobroker/db
#   db:check` (drizzle-kit generate) MUST be a no-op. A non-empty diff means the
#   committed schema drifted from what introspection emits — the CI gate fails the
#   build. Re-apply the manual corrections (3 partial indexes, 7 CHECK tables incl
#   ck_lead_submissions_xor, FK actions) and re-run until the diff is empty.

set -euo pipefail

LEGACY_DB="${LEGACY_DB:-$HOME/.autobroker/autobroker.db}"
TS_DATA_DIR="${AUTOBROKER_DATA_DIR:-$HOME/.autobroker-ts}"
TS_DB="${TS_DB:-$TS_DATA_DIR/autobroker.db}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

echo "cold-copy-sqlite.sh"
echo "  legacy : $LEGACY_DB"
echo "  ts     : $TS_DB"

if [[ ! -f "$LEGACY_DB" ]]; then
  echo "legacy DB not found at $LEGACY_DB (set LEGACY_DB to override)" >&2
  exit 1
fi

# step 1 — verify no legacy writer is running; bail loudly rather than risk a
# torn copy. The read-mostly sqlite MCP servers are not writers — exclude them.
writers="$(pgrep -fl autobroker | grep -vE 'mcp-server-sqlite|uvx|cold-copy-sqlite' || true)"
if [[ -n "$writers" ]]; then
  echo "refusing to copy: possible legacy writer(s) running:" >&2
  echo "$writers" >&2
  echo "stop them (autobroker up / backend) and re-run." >&2
  exit 1
fi

# step 2 — checkpoint-truncate the legacy WAL into the main file, so the copy
# is a single self-contained file (no orphaned -wal/-shm).
sqlite3 "$LEGACY_DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null

# step 3 — copy legacy -> TS path. Refuse to overwrite an existing $TS_DB
# without --force, so we don't clobber accumulated parity-period TS data.
if [[ -f "$TS_DB" && "$FORCE" -ne 1 ]]; then
  echo "refusing to overwrite existing $TS_DB (pass --force to refresh)" >&2
  exit 1
fi
mkdir -p "$TS_DATA_DIR"
cp "$LEGACY_DB" "$TS_DB"

# step 4 — the TS app applies WAL + busy_timeout=5000 on open
# (packages/db/src/client.ts); nothing to do here beyond leaving a clean file.

echo "integrity_check: $(sqlite3 "$TS_DB" 'PRAGMA integrity_check;')"
echo "cold copy complete: $TS_DB"
