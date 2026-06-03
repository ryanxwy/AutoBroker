# @autobroker/db

> Status: Phase 0 (foundation) · 2026-06-02 · SCAFFOLD STUB. This package owns
> the AutoBroker persistence layer for the new full-TypeScript repo: the Drizzle
> schema (introspected from a cold-copied legacy SQLite), the better-sqlite3
> connection, and the `test_run_records` cost/time ledger. Canonical decisions
> live in
> [`../../../AutoBroker-dev-plan/architecture/ARCH_PERSISTENCE.md`](../../../AutoBroker-dev-plan/architecture/ARCH_PERSISTENCE.md)
> and [`DECISIONS.md`](../../../AutoBroker-dev-plan/architecture/DECISIONS.md)
> ("DB 驱动 + schema 迁移").

The persistence layer for **AutoBroker** (the TS rebuild). Drizzle ORM over
better-sqlite3. This is one of only two layers (the other is `packages/tools`)
permitted to touch SQLite — `packages/core` must never import it.

## Stack

- **drizzle-orm `~0.45`** + **better-sqlite3 `^12`** (runtime)
- **drizzle-kit `~0.31`** (dev — introspection + migration generation)

## How the schema is produced (NOT hand-authored)

1. `pnpm db:pull` introspects the **cold-copied** legacy SQLite produced by
   [`../../scripts/cold-copy-sqlite.sh`](../../scripts/cold-copy-sqlite.sh)
   (copy-not-share — the legacy file at `~/.autobroker/autobroker.db` is never
   opened by this repo). The output overwrites `src/schema.ts` as the baseline.
2. **All 23 legacy Alembic revisions are discarded.** The live introspected DB
   is the single source of truth.
3. **Re-apply the manual corrections** drizzle-kit cannot round-trip (documented
   at the top of [`src/schema.ts`](src/schema.ts)):
   - **3 partial indexes** — drizzle-kit drops the `WHERE` predicate on pull
     (one-active-search uniqueness; dealer-email conflict; `uq_il_profile_dealer_vin`).
   - **7 CHECK-constraint tables** — including `ck_lead_submissions_xor`, the XOR
     invariant that a `lead_submissions` row is reached via **exactly one** of
     {web-form submit, email send}. This is the structural twin of the
     `no_external_mutation` harness anchor.
   - **Foreign keys** — verify ON DELETE / ON UPDATE actions survived.
4. **CI empty-diff gate** (`pnpm db:check`): `drizzle-kit generate` against the
   introspected live schema must be a no-op. A non-empty diff fails the build,
   catching any hand-edit that drifts from introspection.

## Files

| file | purpose |
|---|---|
| `src/schema.ts` | Drizzle schema **stub** — generated via `db:pull`; 7 CHECK tables + 3 partial indexes need manual correction (see header). |
| `src/client.ts` | better-sqlite3 connection: WAL + `busy_timeout = 5000` (legacy ran `0` → instant `SQLITE_BUSY`). Sole writer of its own cold-copied file. |
| `src/testRunRecords.ts` | the `test_run_records` ledger — `layer / provider / model_alias / cost_usd / latency_ms / prompt_version / schema_version / fail_reason`; **missing usage = NULL + `pricing_source='unavailable'`, never silent $0**. |
| `drizzle.config.ts` | drizzle-kit config (introspect cold-copied DB; CI empty-diff gate). |

## Data isolation

Parity-period data dir is **`~/.autobroker-ts/`** (via `AUTOBROKER_DATA_DIR`),
physically isolated from the legacy `~/.autobroker/`. At the single-point flip
(all 17 skills parity-GREEN) the TS repo takes over `~/.autobroker/`.

## TODO

- [ ] Run `db:pull` against a cold-copied DB and re-apply the 3+7+FK corrections.
- [ ] Finalize `test_run_records` columns/indexes with the evaluator's
      `cost_and_time` anchor and `harness/export_daily.ts`.
- [ ] Wire `foreign_keys = ON` once FK actions are re-asserted.
