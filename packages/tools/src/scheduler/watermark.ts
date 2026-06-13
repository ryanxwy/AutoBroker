/**
 * scheduler watermark — the per-job last-success store, persisted in the
 * product DB's pipeline_state table (a generic key/value scratch table). This is
 * the durable watermark the catch-up logic reads on boot / resume / heartbeat to
 * decide whether a scheduled job's most-recent fire was missed while the process
 * was down or the machine was asleep.
 *
 * SQLITE INVARIANT (CLAUDE.md "The SQLite / external-API invariant"):
 *   Only packages/tools (and packages/db beneath it) may touch the product DB.
 *   The scheduler lives in the server app layer and reaches the watermark ONLY
 *   through these accessors — it never opens the product DB itself. Writes go
 *   through the raw better-sqlite3 client (db.$client) like the sibling persist
 *   writers, so tools never imports drizzle-orm (the SQLite-ownership wall).
 *
 * STORAGE SHAPE: one pipeline_state row per job, keyed
 *   `scheduler.last_success.<jobName>`, whose `value` is the epoch-ms of the last
 *   successful run as a decimal string. A missing row = "never ran" (epoch 0),
 *   so a fresh install treats the first boot as catch-up-due exactly once.
 *
 * Dependency wall: imports @autobroker/db (getDb only) like the other tools.
 */

import { getDb, type Db } from "@autobroker/db";

/** The pipeline_state key for a job's last-success watermark. */
export function watermarkKey(jobName: string): string {
  return `scheduler.last_success.${jobName}`;
}

const SELECT_WATERMARK = "SELECT value FROM pipeline_state WHERE key = ?";
// pipeline_state.key is the PRIMARY KEY — upsert so a second success overwrites
// the first (exactly one watermark row per job).
const UPSERT_WATERMARK =
  "INSERT INTO pipeline_state (key, value) VALUES (?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value";

/**
 * Read a job's last-success watermark as epoch-ms. A missing / unparseable row
 * is epoch 0 ("never ran"), which makes the first scheduled fire catch-up-due.
 */
export function readLastSuccess(jobName: string, db: Db = getDb()): number {
  const row = db.$client.prepare(SELECT_WATERMARK).get(watermarkKey(jobName)) as
    | { value: string | null }
    | undefined;
  const raw = row?.value;
  if (raw === undefined || raw === null) return 0;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Persist a job's last-success watermark (epoch-ms). Upsert on the job key so a
 * second success overwrites the first — there is exactly one watermark per job.
 */
export function writeLastSuccess(jobName: string, atMs: number, db: Db = getDb()): void {
  db.$client.prepare(UPSERT_WATERMARK).run(watermarkKey(jobName), String(atMs));
}
