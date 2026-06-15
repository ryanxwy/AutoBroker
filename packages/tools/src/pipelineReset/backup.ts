/**
 * The pre-wipe backup — a `VACUUM INTO` snapshot of the product DB taken BEFORE
 * the destructive reset deletes it (the local rollback story).
 *
 * `VACUUM INTO` writes a clean, self-contained copy of the live DB (it reads
 * through the WAL, so the snapshot is consistent without needing a checkpoint).
 * The copy is written to a `.tmp` path first, then atomically renamed to the
 * final `.db` name — a crash mid-copy never leaves a half-written file that
 * looks like a valid backup. The last 7 backups are kept; older ones are pruned.
 *
 * REFUSES to run against the production data tree ~/.autobroker (the prod-DB
 * reject guard — mirrors gmail.ts). Honors AUTOBROKER_DATA_DIR isolation.
 *
 * SQLITE INVARIANT: the snapshot is produced through the shared product-DB
 * connection (`getDb().$client`), not a directly-imported better-sqlite3 — the
 * same way every other tools-layer write reaches SQLite. The ONLY place a backup
 * snapshot is produced.
 */

import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getDb } from "../db.js";
import { assertIsolatedDataDir } from "./isolation.js";

/** How many backup snapshots to retain (newest-first); older ones are pruned. */
export const BACKUPS_TO_KEEP = 7;

/** A backup file name: `autobroker-<nowMs>.db`. The numeric suffix sorts
 *  chronologically as a string (fixed-width epoch-ms), so a lexical sort is a
 *  chronological sort for the retention prune. */
function backupFileName(nowMs: number): string {
  return `autobroker-${nowMs}.db`;
}

const BACKUP_NAME_RE = /^autobroker-\d+\.db$/;

/** Prune all but the newest {@link BACKUPS_TO_KEEP} backups in `dir`. */
function pruneOldBackups(dir: string): void {
  const names = readdirSync(dir)
    .filter((n) => BACKUP_NAME_RE.test(n))
    .sort(); // lexical == chronological (fixed-shape epoch-ms suffix)
  const excess = names.slice(0, Math.max(0, names.length - BACKUPS_TO_KEEP));
  for (const name of excess) {
    rmSync(join(dir, name), { force: true });
  }
}

/** Arguments for {@link backupProductDb}. */
export interface BackupProductDbArgs {
  /** The isolated data dir (must NOT be the production tree). */
  dataDir: string;
  /** The backup timestamp (epoch ms) — supplied for deterministic tests. */
  nowMs: number;
}

/**
 * Take a `VACUUM INTO` snapshot of the product DB into
 * `<dataDir>/backups/autobroker-<nowMs>.db` (atomic tmp→rename), prune to the
 * last {@link BACKUPS_TO_KEEP}, and return the final backup path.
 *
 * REFUSES (throws {@link import("./isolation.js").PipelineResetRefusedError})
 * when `dataDir` is the production tree.
 */
export function backupProductDb(args: BackupProductDbArgs): string {
  assertIsolatedDataDir(args.dataDir);

  const backupsDir = join(args.dataDir, "backups");
  mkdirSync(backupsDir, { recursive: true });

  const finalPath = join(backupsDir, backupFileName(args.nowMs));
  const tmpPath = `${finalPath}.tmp`;
  // A stale tmp from a previous crashed run would make VACUUM INTO fail (it
  // refuses to overwrite an existing target), so clear it first.
  rmSync(tmpPath, { force: true });

  // VACUUM INTO through the shared product-DB connection. SQLite forbids binding
  // the target, so the path is quoted + single-quote-escaped inline; the path is
  // a process-local resolved fs path (never user content), so this is not an
  // injection surface.
  const escaped = tmpPath.replace(/'/g, "''");
  getDb().$client.exec(`VACUUM INTO '${escaped}'`);

  renameSync(tmpPath, finalPath);
  pruneOldBackups(backupsDir);
  return finalPath;
}
