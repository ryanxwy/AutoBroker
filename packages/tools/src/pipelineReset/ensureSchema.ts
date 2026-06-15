/**
 * ensureProductSchema — the tools-layer wrapper boot delegates to so a fresh
 * install instantiates the product schema WITHOUT the app opening the DB itself.
 *
 * Before this existed, a freshly opened autobroker.db stayed schema-empty until
 * the first hand-applied SQL. boot calls this (tools owns the DB connection) to
 * run the committed migrations on startup. It honors the shared getDb handle the
 * server already holds.
 *
 * Idempotency across BOTH setup paths: a fresh-empty DB gets the full schema via
 * the migrator; a DB whose schema was already applied — by a prior boot, OR by
 * code that hand-exec's the committed migration SQL (the harness/test fixtures
 * and any manual install) WITHOUT writing drizzle's `__drizzle_migrations`
 * tracking row — is left untouched. We must NOT run the raw migrator there: it
 * would see zero tracked migrations and try to re-apply 0000 onto live tables.
 * So boot skips when a sentinel product table is already present. (pipeline_reset
 * recreates a truly-empty file and calls migrate() directly — always a fresh
 * apply, never through this guard.)
 *
 * Stays inside the tools layer (the SQLite invariant): the app delegates DOWN to
 * this function and never touches @autobroker/db or a DB connection directly.
 */

import { migrate } from "@autobroker/db/migrator";

import { getDb } from "../db.js";

/** A stable core table present once migration 0000 has been applied (by the
 *  migrator OR a hand-exec of the SQL). Its presence means the schema is already
 *  there, so the migrator must not re-run. */
const SCHEMA_SENTINEL_TABLE = "search_profiles";

function productSchemaPresent(db: ReturnType<typeof getDb>): boolean {
  const row = db.$client
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(SCHEMA_SENTINEL_TABLE);
  return row !== undefined;
}

/**
 * Ensure the product DB at the active data dir has the full schema. A fresh-empty
 * DB is migrated; an already-applied schema is left untouched (see the header).
 * Returns the shared Db handle (so a caller can chain reads without re-resolving).
 */
export function ensureProductSchema(): ReturnType<typeof getDb> {
  const db = getDb();
  if (!productSchemaPresent(db)) {
    migrate(db);
  }
  return db;
}
