/**
 * profileHealth — the read-only hot/warm/cold projection the Phase-3 portfolio
 * board renders as a per-card dot. Pure SQL over the live DB; no writes, no
 * stored health column (that would dirty the empty-diff schema gate). Scoped to
 * status∈{active,NULL} profiles only (closed searches are not portfolio rows).
 *
 *   HOT  — the profile has a live or suspended run right now (its id is in the
 *          caller-supplied `liveRunProfileIds`, derived from the run registry).
 *   COLD — no live run AND no activity at all (zero bound/candidate dealers and
 *          zero routed threads): a dormant, untouched search.
 *   WARM — anything in between (has dealers or threads, but nothing live).
 *
 * INTEGRATION: the full classifier (PROMPT-phase0-remainder) widens HOT/COLD
 * with a true detectPipelineState flag, a thread gate='ready'+cap='ok' signal,
 * a session pinnedProfileId + recent lastActivityAt, and a single durable
 * `pipeline.last_progress_at.<id>` dormancy clock (COLD only past
 * COLD_DORMANCY_DAYS=14 with every thread skip/capped). This thin version keeps
 * the exact return shape so that richer impl drops in without a call-site change.
 *
 * SQLITE INVARIANT: reads go through the raw better-sqlite3 handle (db.$client),
 * like the sibling pipeline modules — tools never imports drizzle-orm operators.
 */

import type { Db } from "@autobroker/db";

/** The three buckets the board dot renders. */
export type ProfileHealthLevel = "hot" | "warm" | "cold";

/** One profile's derived health + the machine-readable reasons behind it (the
 *  header-by-counts strip turns these into named escalations). */
export interface ProfileHealth {
  profileId: string;
  health: ProfileHealthLevel;
  reasons: string[];
}

// Active profiles only, newest-first (mirrors generateDigest's ordering so the
// board and the digest agree on row order).
const SELECT_ACTIVE_PROFILE_IDS = `
SELECT search_profile_id
  FROM search_profiles
 WHERE status = 'active' OR status IS NULL
 ORDER BY rowid DESC
`;

const SELECT_DEALER_COUNT = `
SELECT COUNT(*) AS n FROM profile_dealers WHERE search_profile_id = ?
`;

const SELECT_THREAD_COUNT = `
SELECT COUNT(*) AS n FROM thread_routing WHERE search_profile_id = ?
`;

function countFor(db: Db, sql: string, profileId: string): number {
  const row = db.$client.prepare(sql).get(profileId) as { n?: unknown } | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

/**
 * Classify every active profile hot/warm/cold. `liveRunProfileIds` is the set of
 * profile ids with a live or suspended run (the run registry knows these); a
 * profile in that set is HOT. Pure read — safe to call per portfolio render.
 */
export function profileHealth(db: Db, liveRunProfileIds: readonly string[]): ProfileHealth[] {
  const live = new Set(liveRunProfileIds);
  const ids = db.$client.prepare(SELECT_ACTIVE_PROFILE_IDS).all() as {
    search_profile_id?: unknown;
  }[];

  const out: ProfileHealth[] = [];
  for (const row of ids) {
    const profileId = row.search_profile_id;
    if (typeof profileId !== "string") continue;

    if (live.has(profileId)) {
      out.push({ profileId, health: "hot", reasons: ["live_run"] });
      continue;
    }
    const dealers = countFor(db, SELECT_DEALER_COUNT, profileId);
    const threads = countFor(db, SELECT_THREAD_COUNT, profileId);
    if (dealers === 0 && threads === 0) {
      out.push({ profileId, health: "cold", reasons: ["no_activity"] });
      continue;
    }
    const reasons: string[] = [];
    if (dealers > 0) reasons.push("has_dealers");
    if (threads > 0) reasons.push("has_threads");
    out.push({ profileId, health: "warm", reasons });
  }
  return out;
}
