/**
 * verifySchema — assert a freshly-reset product DB is at the manifest schema and
 * empty.
 *
 * After the destructive reset recreates the DB via the programmatic migrator and
 * re-seeds the single default account, this is the proof: every table the
 * package declares exists, AND every table is empty EXCEPT `accounts`, which is
 * allowed exactly its one default row. The expected manifest is DERIVED from the
 * db package (`productTableNames()`), never a hardcoded count — it tracks the
 * schema automatically.
 *
 * Read-only: opens nothing, runs SELECTs through the passed `db` handle.
 */

import { productTableNames } from "@autobroker/db/migrator";

import type { Db } from "../db.js";

/** The one table allowed to be non-empty after a reset (the accounts exception:
 *  exactly 1 default row so resolveSoleAccountId() returns a usable id). */
const ACCOUNTS_TABLE = "accounts";

/** The result of a schema verification. */
export interface VerifySchemaResult {
  /** True iff every expected table exists AND emptiness holds (accounts ≤ 1). */
  ok: boolean;
  /** How many tables from the manifest are physically present. */
  tablesCreated: number;
  /** One human-readable line per failed assertion (empty when ok). */
  issues: string[];
}

/** Options for {@link verifySchema}. */
export interface VerifySchemaOptions {
  /** The expected table manifest; defaults to the db package's declared set. */
  expectedTables?: string[];
}

/** The set of physical table names in `db` (excluding sqlite internals + the
 *  migrator's bookkeeping table). */
function physicalTables(db: Db): Set<string> {
  const rows = db.$client
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' " +
        "AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'",
    )
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Row count for one table (the table is known to exist when called). */
function rowCount(db: Db, table: string): number {
  return (db.$client.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

/**
 * Verify the post-reset schema. `ok` is true only when every expected table is
 * present and every table is empty except `accounts` (allowed ≤ 1 row).
 */
export function verifySchema(db: Db, options: VerifySchemaOptions = {}): VerifySchemaResult {
  const expected = options.expectedTables ?? productTableNames();
  const present = physicalTables(db);
  const issues: string[] = [];

  let tablesCreated = 0;
  for (const name of expected) {
    if (!present.has(name)) {
      issues.push(`missing table: ${name}`);
      continue;
    }
    tablesCreated += 1;
    const n = rowCount(db, name);
    if (name === ACCOUNTS_TABLE) {
      if (n > 1) issues.push(`accounts has ${n} rows (expected the single default row)`);
    } else if (n !== 0) {
      issues.push(`table ${name} is not empty (${n} row(s))`);
    }
  }

  return { ok: issues.length === 0, tablesCreated, issues };
}
