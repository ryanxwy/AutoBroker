#!/usr/bin/env bash
#
# cold-copy-sqlite.sh — STUB.
#
# Cold-copy the legacy AutoBroker-Python SQLite into the TS repo's parity path.
# COPY-NOT-SHARE: the two repos NEVER open the same file, and we NEVER two-way
# sync. (DECISIONS.md "DB 驱动 + schema 迁移"; risks "双语言/双栈共写一个 SQLite".)
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

echo "cold-copy-sqlite.sh (STUB)"
echo "  legacy : $LEGACY_DB"
echo "  ts     : $TS_DB"

# TODO(phase-0): step 1 — verify no legacy writer is running (pgrep autobroker;
#   bail loudly if one is, rather than risk a torn copy).

# TODO(phase-0): step 2 — checkpoint-truncate the legacy WAL into the main file:
#   sqlite3 "$LEGACY_DB" "PRAGMA wal_checkpoint(TRUNCATE);"
#   (read-only on legacy is fine; this only folds the -wal in.)

# TODO(phase-0): step 3 — mkdir -p "$TS_DATA_DIR" && cp "$LEGACY_DB" "$TS_DB"
#   (plus a guard: refuse to overwrite an existing $TS_DB without --force, so we
#    don't clobber accumulated parity-period TS data).

# TODO(phase-0): step 4 — the TS app applies WAL + busy_timeout=5000 on open
#   (packages/db/src/client.ts); nothing to do here beyond leaving a clean file.

echo "TODO(phase-0): implement the four steps above."
exit 1
