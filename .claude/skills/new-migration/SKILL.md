---
name: new-migration
description: Scaffold a Drizzle product-DB migration the house way — edit schema.ts, GENERATE the migration (never hand-write SQL), keep db:check empty-diff, update the hardcoded MIGRATION_SQLS test arrays, and use sentinel-0 (not COALESCE) merge semantics. Use when adding or altering a product-DB table/column in packages/db.
disable-model-invocation: true
---

You scaffold a **product-DB schema migration** for the AutoBroker (TS) repo with
the project's hard-won patterns baked in, so the change lands without tripping the
`db:check` gate or silently running tests against a stale schema. This is
user-invoked because it writes migration files.

The source of truth is `packages/db/src/schema.ts`; migrations are GENERATED with
`pnpm db:generate` and committed under `packages/db/drizzle/NNNN_*.sql`. The runtime
migrator (`packages/db/src/migrator.ts`) replays the whole `drizzle/` journal, so a
new migration is picked up automatically on a fresh / reset DB.

## Steps

1. **Edit the schema, not the SQL.** Make the table/column change in
   `packages/db/src/schema.ts` (or `testRunRecords.ts`). For a new column that may be
   re-derived later, prefer nullable + a 0/null sentinel over `NOT NULL` — a
   `NOT NULL` column with no default breaks the migrator against an existing
   non-empty DB.

2. **Generate the migration — never hand-write it.** Run `pnpm db:generate`
   (drizzle-kit). It writes the next `packages/db/drizzle/NNNN_*.sql` and updates the
   journal. Read the generated SQL to confirm it does only what you intended.

3. **Prove the gate is satisfied.** Run `pnpm db:check` — it regenerates and asserts
   `git diff --exit-code drizzle/` is empty. A non-empty diff means the committed
   migration does not match the schema; regenerate, don't hand-patch.

4. **Update the hardcoded MIGRATION_SQLS test arrays (the trap).** Many
   `packages/tools/src/**` tests build a throwaway DB from a hardcoded `MIGRATION_SQLS`
   filename list. Find them: `git grep -l MIGRATION_SQLS -- packages/tools/src`. For
   every test whose tables/columns your new migration touches, append the new
   `NNNN_*.sql` filename — otherwise that test runs against a STALE schema and only the
   FULL `vitest run` (not a focused single-file run) catches it. Leave the
   deliberately-pinned `[0000,0001,0002]` projection/give-up tests alone unless the new
   column is genuinely on their path.

5. **Use sentinel-0 merge semantics for any re-scan / harvest upsert.** If a writer
   merges fresh data onto the new columns, distinguish `0` = explicit clear from
   `null` = preserve. Do NOT `COALESCE(new, old)` / `new ?? old` — that can never lower
   or clear a value and creates a monotonic ratchet (a price/markup that only climbs).

6. **Confirm the migrator/reset path.** No migrator code change is normally needed (it
   replays the journal). Only if you added a table that a destructive reset enumerates
   or a hard-delete cascade/tombstone path references, update that path too.

7. **Run the full gate.** `bash scripts/green.sh` — `typecheck` + `db:check` + `test`
   must pass. (If the change also touched UI/testids/harness, use
   `RUN_UI_FUNCTIONAL=1 bash scripts/green.sh`.)

## Guardrails

- The committed `drizzle/NNNN_*.sql` is the only schema-change artifact — never apply
  ad-hoc SQL at runtime to "fix" a schema.
- Only `@autobroker/db` (+ `packages/tools`) may open the product DB or migrate; never
  migrate from `model` / `workflows` / `app`.
- After step 2, a quick `drizzle-migration-reviewer` subagent pass catches a stale
  MIGRATION_SQLS array or a ratchet merge before you commit.
