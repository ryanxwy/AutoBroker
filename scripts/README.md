# scripts/ — CI / engineering scripts

> Status: Phase 0 (foundation) · 2026-06-02 · SCAFFOLD. This directory holds
> repo-level engineering scripts. Long-form rationale lives in the plan repo at
> [`../../AutoBroker-dev-plan/ts-rebuild/architecture/DECISIONS.md`](../../AutoBroker-dev-plan/ts-rebuild/architecture/DECISIONS.md)
> ("DB 驱动 + schema 迁移") and
> [`ARCH_PERSISTENCE.md`](../../AutoBroker-dev-plan/ts-rebuild/architecture/ARCH_PERSISTENCE.md).

## Scripts

### `cold-copy-sqlite.sh`

Cold-copies the legacy **AutoBroker-Python** SQLite into the TS repo's parity
path — **copy-not-share, never two-way sync**.

The legacy machine runs `busy_timeout = 0`, so two writers on one SQLite file
fail instantly with `SQLITE_BUSY` and no retry. A one-time cold copy eliminates
the entire shared-writer failure class. Four steps:

1. **Quiesce** the legacy writer (no `autobroker up` running — a live writer
   mid-checkpoint yields a torn copy).
2. **`wal_checkpoint(TRUNCATE)`** — fold the legacy `-wal` back into the main db
   so the copy is one self-contained file.
3. **`cp`** legacy `~/.autobroker/autobroker.db` → the TS path under
   `~/.autobroker-ts/`.
4. The TS app opens the copy and applies **WAL + `busy_timeout=5000`** itself
   (`packages/db/src/client.ts`). One direction, one time. No reverse path, no
   sync daemon.

### CI drizzle-kit generate empty-diff gate

After a cold copy, `pnpm --filter @autobroker/db db:pull` re-introspects the
copied file into `packages/db/src/schema.ts`. Then **`db:check` (drizzle-kit
generate) must be a no-op** — a non-empty diff means the committed schema drifted
from what introspection emits, and the **CI gate fails the build**. Re-apply the
manual corrections (3 partial indexes, 7 CHECK tables incl.
`ck_lead_submissions_xor`, FK actions; see
[`../packages/db/src/schema.ts`](../packages/db/src/schema.ts)) until the diff is
empty. This gate is the standing guard that the hand-corrected schema never
silently diverges from the live DB.

## TODO

- [x] Implement the four steps of `cold-copy-sqlite.sh` (refuses to overwrite an
      existing TS DB without `--force`).
- [ ] Add the `db:generate` empty-diff check to CI (it already exists as the
      `db:check` npm script in `@autobroker/db`).
- [ ] Add the intake schema ↔ TS sync check (port of the legacy `intake:check`).
