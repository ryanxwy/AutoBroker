/**
 * AutoBroker SQLite connection.
 *
 * Two stacks must never share one SQLite file: the legacy machine runs
 *   `busy_timeout = 0`, so a second writer fails immediately with SQLITE_BUSY
 *   and no retry. The TS repo therefore NEVER shares the legacy file — it opens
 *   its OWN cold-copied DB (see
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
import { dirname, join, resolve } from "node:path";
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
  // The first intake disk write must not fail on a fresh machine, so create the
  // resolved data directory before better-sqlite3 opens the file.
  // Covers both the AUTOBROKER_DATA_DIR default (dir holds autobroker.db) and an
  // explicit AUTOBROKER_DB file override (mkdir ITS parent). recursive: true is
  // idempotent — a no-op when the directory already exists.
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);

  // Mandated PRAGMAs.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000"); // NOT 0 — legacy's value caused SQLITE_BUSY.
  // Matches the legacy oracle, which enforces FKs on every connection. SQLite
  // FK enforcement is write-time only: the cold-copied parity DB carries a few
  // pre-existing orphan message_analysis rows (foreign_key_check, 2026-06-10)
  // that stay inert until touched — new writes are checked from here on.
  sqlite.pragma("foreign_keys = ON");

  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof openDb>;

/** Shared-connection cache, keyed by the RESOLVED absolute DB file path so an
 *  AUTOBROKER_DATA_DIR / AUTOBROKER_DB override (tests point each case at its
 *  own tmp dir) maps to its own entry — two data dirs never share a handle. */
const sharedDbs = new Map<string, Db>();

/**
 * Shared lazy connection — ONE cached handle per resolved DB path, created on
 * first use. Long-lived processes (server, workflows, the ledger writer) use
 * this instead of openDb-per-call: a fresh never-closed connection per call
 * leaks file handles, and every lingering WAL reader pins the -wal file so it
 * cannot be truncated back into the main DB.
 *
 * Lifetime: held until closeDb() or process exit. No exit hook is needed —
 * better-sqlite3 handles left open at exit are safe to abandon, and SQLite's
 * WAL crash recovery replays a leftover -wal file on the next open, so
 * committed writes never depend on an explicit close.
 *
 * Callers that genuinely need a PRIVATE handle (isolated per-test files with
 * an explicit open-use-close scope) keep using openDb().
 */
export function getDb(dbPath: string = resolveDbPath()): Db {
  const key = resolve(dbPath);
  let db = sharedDbs.get(key);
  if (db === undefined) {
    db = openDb(key);
    sharedDbs.set(key, db);
  }
  return db;
}

/**
 * Close every cached shared connection and clear the cache. Test teardown
 * hook: releases the file handles so a tmp data dir can be removed cleanly and
 * the next getDb() reopens fresh. Production never needs to call this (see
 * getDb's lifetime note). Handles obtained from openDb() are caller-owned and
 * unaffected.
 */
export function closeDb(): void {
  for (const db of sharedDbs.values()) db.$client.close();
  sharedDbs.clear();
}
