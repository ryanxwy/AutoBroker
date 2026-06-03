/**
 * DB tool — the SQLite write surface. This (with the read helpers) is the ONLY
 * place in the codebase that opens a SQLite handle.
 *
 * Backed by Drizzle ORM + better-sqlite3 (WAL, busy_timeout=5000). Schema lives
 * in @autobroker/db (drizzle-kit pull baseline + the 3 partial-index WHERE
 * clauses, 7 CHECK tables incl. ck_lead_submissions_xor, and FKs hand-corrected).
 *
 * ISOLATION INVARIANT: never touch production ~/.autobroker/autobroker.db. The
 * data dir comes from AUTOBROKER_DATA_DIR (parity period => ~/.autobroker-ts,
 * isolated from the legacy Python repo). Subprocesses inherit and re-resolve it.
 */

// TODO(phase-4): import the Drizzle schema + typed tables from @autobroker/db.
// import { drizzle } from "drizzle-orm/better-sqlite3";
// import Database from "better-sqlite3";
// import * as schema from "@autobroker/db";

/** Resolve the active data directory, honoring the isolation env. */
export function resolveDataDir(): string {
  // TODO(phase-4): default to ~/.autobroker-ts during the parity period.
  return process.env.AUTOBROKER_DATA_DIR ?? "TODO-default-~/.autobroker-ts";
}

/**
 * Open the better-sqlite3 connection with WAL + busy_timeout=5000 and wrap it in
 * Drizzle. The single connection factory for the whole app.
 * TODO(phase-4): real `new Database(path)`, `pragma journal_mode=WAL`,
 * `pragma busy_timeout=5000`, then `drizzle(db, { schema })`.
 */
export function openDb(): { dataDir: string } {
  const dataDir = resolveDataDir();
  // TODO(phase-4): return the Drizzle handle, not this stub.
  return { dataDir };
}
