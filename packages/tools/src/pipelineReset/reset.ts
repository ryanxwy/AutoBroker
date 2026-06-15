/**
 * pipelineReset — the DESTRUCTIVE orchestrator: back up the product DB, wipe it,
 * recreate the full schema, re-seed the single default account, and clear the
 * workflow runtime state. ONLY reachable after the typed-YES gate approved.
 *
 * ORDER (each step leaves a recoverable state; a throw aborts before the next):
 *   1. assertIsolatedDataDir — REFUSE the production tree ~/.autobroker.
 *   2. backupProductDb — VACUUM INTO snapshot BEFORE any deletion (the rollback).
 *   3. close every cached connection + delete the product DB file (+ its WAL/SHM
 *      sidecars) — a lingering WAL reader would pin the file, so close first.
 *   4. openDb (recreates an empty file) → migrate() → the full schema exists.
 *   5. INSERT exactly one default accounts row (the accounts 1-row exception) so
 *      resolveSoleAccountId() returns a usable id and the app lands on a clean
 *      empty-home.
 *   6. clearWorkflowRuntimeState — DELETE the mastra.db workflow snapshots +
 *      suspended handles (orphan-run safety); Memory chat threads PRESERVED.
 *
 * IDEMPOTENT ON REPLAY: re-running yields the same fresh schema + one account
 * (step 4's migrate is idempotent; step 5 inserts only when accounts is empty).
 *
 * Side-effect tool: opens/deletes/recreates the product DB file and writes
 * mastra.db. The destructive path lives ONLY here.
 */

import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { migrate } from "@autobroker/db/migrator";

import { closeDb, openDb } from "../db.js";
import { backupProductDb } from "./backup.js";
import { assertIsolatedDataDir } from "./isolation.js";
import { clearWorkflowRuntimeState } from "./mastraRuntime.js";
import { resolveProductDbPath, resolveMastraDbPath } from "./paths.js";
import { verifySchema } from "./verifySchema.js";

/** The email stamped on the single re-seeded default account. */
export const DEFAULT_ACCOUNT_EMAIL = "owner@localhost" as const;

/** Delete the product DB file and its WAL/SHM sidecars (a clean slate for the
 *  fresh schema). Missing files are a no-op. */
function deleteProductDbFile(productDbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${productDbPath}${suffix}`, { force: true });
  }
}

/** Re-seed exactly one default account when none exists (idempotent on replay). */
function seedDefaultAccount(db: ReturnType<typeof openDb>): void {
  const existing = db.$client.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
  if (existing.n > 0) return;
  db.$client
    .prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)")
    .run(randomUUID(), DEFAULT_ACCOUNT_EMAIL);
}

/** Arguments for {@link pipelineReset}. */
export interface PipelineResetArgs {
  /** The isolated data dir (must NOT be the production tree). */
  dataDir: string;
  /** The backup timestamp (epoch ms); defaults to Date.now(). */
  nowMs?: number;
  /**
   * Skip the internal VACUUM INTO backup. Set by a caller that already took the
   * user-facing backup in a prior step (the workflow's separate `backup` step),
   * so the DB is not snapshotted twice. The returned backupPath is "" when
   * skipped. Defaults to false (the standalone tool backs up).
   */
  skipBackup?: boolean;
}

/** The result of a successful reset. */
export interface PipelineResetResult {
  /** How many tables the fresh schema created (the verified manifest size). */
  tablesCreated: number;
  /** The VACUUM INTO backup file path (the local rollback artifact). */
  backupPath: string;
}

/**
 * Run the full destructive reset. Throws (before any deletion) when `dataDir` is
 * the production tree; otherwise backs up, wipes, recreates, re-seeds, and
 * clears the workflow runtime. Throws if the post-reset schema fails verification
 * (a recoverable state: the backup is still on disk).
 */
export function pipelineReset(args: PipelineResetArgs): PipelineResetResult {
  assertIsolatedDataDir(args.dataDir);

  const nowMs = args.nowMs ?? Date.now();
  const productDbPath = resolveProductDbPath(args.dataDir);

  // The dataDir guard alone is not enough: resolveProductDbPath / resolveMastraDbPath
  // honor an AUTOBROKER_DB override that can point ANYWHERE (incl. the production
  // ~/.autobroker tree) even when dataDir is an isolated tmp dir. Re-assert
  // isolation on the RESOLVED delete/clear targets so an override can never
  // escape the guard onto a production DB. Throws BEFORE any deletion.
  assertIsolatedDataDir(dirname(productDbPath));
  assertIsolatedDataDir(dirname(resolveMastraDbPath(args.dataDir)));

  // (2) Backup BEFORE any deletion. Skip when the caller already took the
  // user-facing backup (skipBackup) or when there is no DB yet (a reset on a
  // never-initialized data dir still recreates the schema, no rollback needed).
  // The backup is the rollback artifact for everything that follows.
  let backupPath = "";
  if (args.skipBackup !== true && existsSync(productDbPath)) {
    backupPath = backupProductDb({ dataDir: args.dataDir, nowMs });
  }

  // (3) Release every cached connection (the shared getDb handle pins the WAL),
  // then delete the product DB file + sidecars.
  closeDb();
  deleteProductDbFile(productDbPath);

  // (4) Recreate an empty file and migrate to the full schema.
  const db = openDb(productDbPath);
  migrate(db);

  // (5) Re-seed the single default account (the accounts 1-row exception).
  seedDefaultAccount(db);

  // Verify the fresh schema is present + empty (accounts ≤ 1). A failure throws
  // — the backup is still on disk for recovery.
  const verdict = verifySchema(db);
  db.$client.close();
  closeDb();
  if (!verdict.ok) {
    throw new Error(`pipeline reset schema verification failed: ${verdict.issues.join("; ")}`);
  }

  // (6) Clear the mastra.db workflow runtime state (orphan-run safety); Memory
  // chat threads are preserved. NOTE: when this runs AS a workflow step, the
  // delete also drops THIS reset run's own snapshot row — that is intentional
  // and safe: Mastra re-persists the snapshot after each subsequent step
  // (verify/notify/confirm), so the run still reaches a terminal `success` and
  // the row left behind is a COMPLETED record, never a suspended orphan.
  clearWorkflowRuntimeState(args.dataDir);

  return { tablesCreated: verdict.tablesCreated, backupPath };
}
