/**
 * The mastra.db runtime-state partition for the destructive reset.
 *
 * After the product DB is wiped, any orphan SUSPENDED workflow run that points
 * at a now-deleted profile is a dangling bomb: a resume would land on rows that
 * no longer exist. So the reset clears the WORKFLOW RUNTIME STATE in mastra.db —
 * the workflow snapshots + suspended-run handles, which all live in the single
 * `mastra_workflow_snapshot` table (the @mastra/libsql workflows store).
 *
 * PRESERVE (never deleted): Memory chat threads — `mastra_threads`,
 * `mastra_messages`, `mastra_resources` — are USER ASSETS, not in reset scope.
 * This module CANNOT touch them: it has an explicit ALLOWLIST of exactly one
 * table to clear and deletes nothing else. Fail-closed by construction — if a
 * future Mastra version split the workflow store across more tables, this would
 * preserve the unknown table rather than guess (and the reset's consequence-line
 * promise stays "in-progress runs are cleared", which only ever over-preserves).
 *
 * mastra.db is @mastra/libsql-managed and is NOT in the product schema or the
 * parity gate. We open a PRIVATE short-lived connection to the file (a plain
 * on-disk SQLite DB) via the @autobroker/db openDb factory (the tools-layer
 * SQLite owner) and DELETE FROM the snapshot table — we never DROP it (a future
 * getStorage().init() expects it to exist) and never create the file if it is
 * absent (a fresh data dir has no mastra.db yet → nothing to clear).
 *
 * Self-contained; does not import @mastra/* (the dependency wall keeps @mastra
 * out of tools).
 */

import { existsSync } from "node:fs";

import { openDb } from "../db.js";
import { resolveMastraDbPath } from "./paths.js";

/**
 * The ONE table cleared on reset — the @mastra/libsql workflow snapshot +
 * suspended-handle store. Everything else in mastra.db (Memory threads, messages,
 * resources, …) is preserved.
 */
export const WORKFLOW_RUNTIME_TABLE = "mastra_workflow_snapshot" as const;

/** The outcome of a runtime clear. */
export interface ClearWorkflowRuntimeResult {
  /** False when there was no mastra.db / no snapshot table to clear (no-op). */
  cleared: boolean;
  /** How many snapshot rows were removed. */
  rowsCleared: number;
}

/**
 * Clear the product workflow runtime state in `<dataDir>/mastra.db`, preserving
 * Memory chat threads. A missing file or a missing snapshot table is a clean
 * no-op (a fresh data dir, or a mastra.db that has not initialized its workflow
 * store yet). NEVER deletes any other table; NEVER drops; NEVER creates the file.
 */
export function clearWorkflowRuntimeState(dataDir: string): ClearWorkflowRuntimeResult {
  const mastraDbPath = resolveMastraDbPath(dataDir);
  if (!existsSync(mastraDbPath)) return { cleared: false, rowsCleared: 0 };

  // A private (uncached) handle on the mastra.db file — open-use-close so the
  // file handle is released immediately.
  const db = openDb(mastraDbPath);
  const c = db.$client;
  try {
    const table = c
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(WORKFLOW_RUNTIME_TABLE) as { name: string } | undefined;
    if (table === undefined) return { cleared: false, rowsCleared: 0 };

    const info = c.prepare(`DELETE FROM "${WORKFLOW_RUNTIME_TABLE}"`).run();
    return { cleared: true, rowsCleared: info.changes };
  } finally {
    c.close();
  }
}
