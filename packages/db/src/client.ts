/**
 * AutoBroker SQLite connection — STUB.
 *
 * PROVENANCE (architectureStack "持久化 / DB"; risks "双语言/双栈共写一个 SQLite"):
 *   The legacy machine runs `busy_timeout = 0`, so a second writer fails
 *   immediately with SQLITE_BUSY and no retry. The TS repo therefore NEVER
 *   shares the legacy file — it opens its OWN cold-copied DB (see
 *   ../../scripts/cold-copy-sqlite.sh) with WAL + a real busy_timeout, which is
 *   the only writer of that file.
 *
 * PARITY-PERIOD DATA DIR: ~/.autobroker-ts/ (AUTOBROKER_DATA_DIR), physically
 *   isolated from the legacy ~/.autobroker/. At the single-point flip (all 17
 *   skills parity-GREEN) the TS repo takes over ~/.autobroker/ and the Python
 *   repo retires.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

/** Resolve the SQLite file path from AUTOBROKER_DATA_DIR (parity dir default). */
function resolveDbPath(): string {
  // TODO(phase-0): resolve AUTOBROKER_DATA_DIR (default ~/.autobroker-ts) +
  // "autobroker.db"; honor an explicit AUTOBROKER_DB override; create the dir.
  const dataDir = process.env.AUTOBROKER_DATA_DIR ?? "~/.autobroker-ts";
  return `${dataDir}/autobroker.db`;
}

/**
 * Open the AutoBroker SQLite connection with the mandated PRAGMAs.
 * Copy-not-share: this process is the sole writer of its own cold-copied file.
 */
export function openDb(dbPath: string = resolveDbPath()) {
  const sqlite = new Database(dbPath);

  // Mandated PRAGMAs (architectureStack "持久化 / DB").
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000"); // NOT 0 — legacy's value caused SQLITE_BUSY.
  // TODO(phase-0): pragma("foreign_keys = ON") once FK actions are re-asserted
  // in schema.ts (correction 3).

  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof openDb>;

// TODO(phase-0): a single shared singleton accessor for the app/server process,
// and a per-test isolated-DB factory (throwaway file under the sandbox data dir)
// for the harness — NEVER the production ~/.autobroker/autobroker.db.
