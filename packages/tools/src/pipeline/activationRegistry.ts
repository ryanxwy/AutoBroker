/**
 * activation registry — the durable ProfileId → live runId map, one
 * pipeline_state row per active profile keyed `pipeline.active_run.<profileId>`.
 *
 * THE VIRTUAL-ACTOR INVARIANT: a search profile has AT-MOST-ONE live pipeline
 * run at a time. The registry encodes that by keying on the profileId (PK) and
 * acquiring it with INSERT ... ON CONFLICT DO NOTHING. A competing process can
 * never overwrite a live owner; it loses before creating a workflow run. The
 * stored value is the live runId; the reverse lookup (runId → profileId) scans
 * the active_run keyspace.
 *
 * It survives a reboot in the same pipeline_state table that holds the
 * watermarks. After a crash the only truly-live runs are the ones the app's
 * recover-on-boot surfaces, so `reconcileActivations` prunes every entry whose
 * runId is not in that live set — abandoned/terminal runs leave no zombie entry.
 * `clearActivationByRunId` is the normal terminal teardown: it deletes by VALUE
 * (the runId), so a losing/unknown run is a harmless no-op and never clobbers
 * the durable owner.
 *
 * KEYSPACE ISOLATION: every statement is scoped with
 * `key LIKE 'pipeline.active_run.%'`, so the registry never reads, deletes, or
 * overwrites a watermark (`pipeline.last_progress_at.*`) or any other
 * pipeline_state key.
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle (db.$client) only — the tools
 * layer never imports drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db (getDb + the Db handle type) only.
 */

import { getDb, type Db } from "@autobroker/db";

const ACTIVE_RUN_PREFIX = "pipeline.active_run.";
// LIKE pattern scoping every keyspace-wide statement to the active_run rows.
const ACTIVE_RUN_LIKE = `${ACTIVE_RUN_PREFIX}%`;

/** The pipeline_state key for a profile's live-run entry. */
export function activeRunKey(profileId: string): string {
  return `${ACTIVE_RUN_PREFIX}${profileId}`;
}

// pipeline_state.key is the PRIMARY KEY. A new owner may INSERT but may never
// overwrite an existing owner. The same (profileId, runId) is treated as an
// idempotent re-claim after the insert reports a conflict.
const INSERT_ACTIVATION =
  "INSERT INTO pipeline_state (key, value, search_profile_id) VALUES (?, ?, ?) " +
  "ON CONFLICT(key) DO NOTHING";

const SELECT_RUN_FOR_PROFILE = "SELECT value FROM pipeline_state WHERE key = ?";

const SELECT_PROFILE_FOR_RUN =
  "SELECT search_profile_id FROM pipeline_state " +
  "WHERE key LIKE ? AND value = ? LIMIT 1";

const SELECT_ACTIVE_PROFILES =
  "SELECT DISTINCT search_profile_id FROM pipeline_state " +
  "WHERE key LIKE ? AND search_profile_id IS NOT NULL";

// DELETE by VALUE within the active_run keyspace — idempotent: 0 rows for a
// losing/unknown runId (never clobbers the actual owner).
const DELETE_BY_RUN = "DELETE FROM pipeline_state WHERE key LIKE ? AND value = ?";

export interface ActivationClaimResult {
  /** True for a newly inserted claim or an idempotent claim by the same runId. */
  acquired: boolean;
  /** True only when this call inserted the durable row. */
  inserted: boolean;
  /** The durable owner observed after the insert attempt, when one exists. */
  liveRunId: string | null;
}

/** Typed conflict used by callers that require ownership or fail loud. */
export class ActivationClaimConflictError extends Error {
  constructor(
    readonly profileId: string,
    readonly attemptedRunId: string,
    readonly liveRunId: string | null,
  ) {
    super(
      `profile '${profileId}' already has live run '${liveRunId ?? "unknown"}'; ` +
        `refusing concurrent run '${attemptedRunId}'`,
    );
    this.name = "ActivationClaimConflictError";
  }
}

/**
 * Atomically try to own a profile. Two SQLite connections racing the same key
 * produce exactly one INSERT winner; the loser observes the durable owner and
 * returns acquired=false without changing it. Repeating the same runId is
 * idempotent and reports acquired=true, inserted=false.
 */
export function tryClaimActivation(args: {
  profileId: string;
  runId: string;
  db?: Db;
}): ActivationClaimResult {
  const db = args.db ?? getDb();
  const key = activeRunKey(args.profileId);
  const inserted =
    db.$client.prepare(INSERT_ACTIVATION).run(key, args.runId, args.profileId).changes === 1;
  if (inserted) return { acquired: true, inserted: true, liveRunId: args.runId };
  const liveRunId = lookupRunIdForProfile(args.profileId, db);
  return {
    acquired: liveRunId === args.runId,
    inserted: false,
    liveRunId,
  };
}

/** Register a profile owner or throw without overwriting a live competitor. */
export function recordActivation(args: { profileId: string; runId: string; db?: Db }): void {
  const claim = tryClaimActivation(args);
  if (!claim.acquired) {
    throw new ActivationClaimConflictError(args.profileId, args.runId, claim.liveRunId);
  }
}

/**
 * Tear down the activation entry for a terminating run. Deletes the active_run
 * row(s) whose VALUE equals runId. Idempotent: returns 0 (a no-op) when an
 * unknown/losing run is cleared — it never clobbers the actual owner.
 */
export function clearActivationByRunId(args: { runId: string; db?: Db }): number {
  const db = args.db ?? getDb();
  return db.$client.prepare(DELETE_BY_RUN).run(ACTIVE_RUN_LIKE, args.runId).changes;
}

/** The live runId for a profile, or null when the profile has no active run. */
export function lookupRunIdForProfile(profileId: string, db?: Db): string | null {
  const conn = (db ?? getDb()).$client;
  const row = conn.prepare(SELECT_RUN_FOR_PROFILE).get(activeRunKey(profileId)) as
    | { value: string | null }
    | undefined;
  const raw = row?.value;
  return raw === undefined || raw === null || raw === "" ? null : raw;
}

/** The profile that owns a given live runId, or null when no active entry holds it. */
export function lookupProfileIdForRunId(runId: string, db?: Db): string | null {
  const conn = (db ?? getDb()).$client;
  const row = conn.prepare(SELECT_PROFILE_FOR_RUN).get(ACTIVE_RUN_LIKE, runId) as
    | { search_profile_id: string | null }
    | undefined;
  const raw = row?.search_profile_id;
  return raw === undefined || raw === null || raw === "" ? null : raw;
}

/** Every profileId with an active-run entry (distinct). */
export function listActiveProfileIds(db?: Db): string[] {
  const conn = (db ?? getDb()).$client;
  const rows = conn.prepare(SELECT_ACTIVE_PROFILES).all(ACTIVE_RUN_LIKE) as Array<{
    search_profile_id: string;
  }>;
  return rows.map((r) => r.search_profile_id);
}

/**
 * Reboot-survival reconcile: prune every active-run entry whose runId is NOT in
 * the live set. After a crash, the only truly-live runs are the ones
 * recover-on-boot surfaces; every other entry is terminal/gone and is pruned.
 * Returns the number of entries pruned. Scoped to the active_run keyspace, so
 * watermarks and other pipeline_state rows are untouched.
 */
export function reconcileActivations(
  liveRunIds: ReadonlySet<string> | readonly string[],
  db?: Db,
): number {
  const conn = (db ?? getDb()).$client;
  const live = liveRunIds instanceof Set ? liveRunIds : new Set(liveRunIds);
  const rows = conn
    .prepare("SELECT key, value FROM pipeline_state WHERE key LIKE ?")
    .all(ACTIVE_RUN_LIKE) as Array<{ key: string; value: string | null }>;
  const stale = rows.filter((r) => !(typeof r.value === "string" && live.has(r.value)));
  if (stale.length === 0) return 0;
  const del = conn.prepare("DELETE FROM pipeline_state WHERE key = ?");
  const txn = conn.transaction((keys: string[]) => {
    let n = 0;
    for (const k of keys) n += del.run(k).changes;
    return n;
  });
  return txn(stale.map((r) => r.key));
}
