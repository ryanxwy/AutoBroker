/**
 * Programmatic schema migrator — the runtime path that instantiates the product
 * schema on a fresh DB from the committed migration files.
 *
 * WHY THIS EXISTS: the repo generates migrations with drizzle-kit and commits
 * them under `drizzle/`, but nothing ran them at runtime — a freshly opened
 * `autobroker.db` stayed schema-empty until the first hand-applied SQL. This
 * wraps drizzle-orm's better-sqlite3 migrator so the full schema can be built
 * (or rebuilt) in code: boot can instantiate the schema on a fresh install, and
 * the destructive reset can recreate every table after deleting the file.
 *
 * The committed migrations (0000 → 0001 → 0002, ordered by the drizzle journal)
 * together produce the complete current schema; running them against an empty
 * better-sqlite3 DB yields every table. The migrator stamps a
 * `__drizzle_migrations` bookkeeping table and is idempotent — re-running it on
 * an already-migrated DB is a no-op.
 *
 * Dependency wall: @autobroker/db is one of the two layers permitted to touch
 * SQLite; the migrator is a schema concern and belongs here beside schema.ts.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";

import type { Db } from "./client.js";
import * as schema from "./schema.js";
import { testRunRecords } from "./testRunRecords.js";

/**
 * The absolute path to the committed `drizzle/` migrations folder, resolved
 * relative to THIS module so it is correct whether the code runs from `src`
 * (ts/test) or `dist` (built). Both `src/migrator.ts` and `dist/migrator.js`
 * sit one directory below the package root, so `../drizzle` is the folder in
 * both layouts.
 */
export const DEFAULT_MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

/**
 * The product table MANIFEST — every table the committed migrations create,
 * derived from the package's declared `sqliteTable`s (schema.ts + the TS-owned
 * `test_run_records` ledger). This is the authoritative "what tables should
 * exist" list, so consumers (the reset verifier) never hardcode a count: it
 * tracks the schema automatically. Sorted for stable comparisons.
 */
export function productTableNames(): string[] {
  const names: string[] = [];
  for (const value of [...Object.values(schema), testRunRecords]) {
    if (is(value, SQLiteTable)) names.push(getTableName(value));
  }
  return [...new Set(names)].sort();
}

/** Options for {@link migrate}. */
export interface MigrateOptions {
  /** The committed migrations folder; defaults to the package's `drizzle/`. */
  migrationsFolder?: string;
}

/**
 * Apply the committed migrations to `db`, instantiating (or completing) the full
 * product schema. Idempotent: a DB already at the latest migration is left
 * unchanged. After a fresh-empty migrate every product table exists and is
 * queryable.
 */
export function migrate(db: Db, options: MigrateOptions = {}): void {
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  drizzleMigrate(db, { migrationsFolder });
}
