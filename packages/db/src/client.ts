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

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

/** Resolve the SQLite file path from AUTOBROKER_DATA_DIR (parity dir default).
 *  Tilde is expanded here — Node does NOT expand "~" in paths, so a literal
 *  "~/.autobroker-ts" from the environment would create a directory named "~"
 *  in the cwd. AUTOBROKER_DB (explicit file path) overrides everything. */
function resolveDbPath(): string {
  const explicit = process.env.AUTOBROKER_DB;
  if (explicit !== undefined && explicit !== "") return expandTilde(explicit);
  const dataDir = process.env.AUTOBROKER_DATA_DIR ?? join(homedir(), ".autobroker-ts");
  return join(expandTilde(dataDir), "autobroker.db");
}

function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Open the AutoBroker SQLite connection with the mandated PRAGMAs.
 * Copy-not-share: this process is the sole writer of its own cold-copied file.
 */
export function openDb(dbPath: string = resolveDbPath()) {
  // M1 既定项: the first intake disk write must not fail on a fresh machine, so
  // create the resolved data directory before better-sqlite3 opens the file.
  // Covers both the AUTOBROKER_DATA_DIR default (dir holds autobroker.db) and an
  // explicit AUTOBROKER_DB file override (mkdir ITS parent). recursive: true is
  // idempotent — a no-op when the directory already exists.
  mkdirSync(dirname(dbPath), { recursive: true });

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
