/**
 * @autobroker/db barrel.
 *
 * The ONLY layer (with packages/tools) permitted to touch SQLite — core/ must
 * never import this (the five-layer one-way dependency rule — see CLAUDE.md).
 */

export * from "./schema.js";
export * from "./client.js";
export * from "./testRunRecords.js";

// The programmatic migrator — recreates the full product schema from the
// committed drizzle/ migrations on a fresh empty DB (drizzle-orm's
// better-sqlite3 migrator). Used by boot (fresh-install schema) and by
// pipeline_reset (atomic recreate after a wipe).
export {
  migrate,
  productTableNames,
  DEFAULT_MIGRATIONS_FOLDER,
  type MigrateOptions,
} from "./migrator.js";
