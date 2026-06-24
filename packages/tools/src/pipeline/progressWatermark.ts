/**
 * progress watermark — the PER-PROFILE "last time THIS search's pipeline made
 * forward progress" timestamp, one pipeline_state row keyed
 * `pipeline.last_progress_at.<profileId>`.
 *
 * It is the durable dormancy marker the read-only profileHealth projection reads
 * to decide whether an otherwise-quiet profile has gone COLD: a profile whose
 * watermark is older than COLD_DORMANCY_DAYS (and whose threads are all
 * skip/capped) is dormant. A profile that has never been written has a NULL
 * watermark and is treated as fresh (WARM), never cold.
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle (db.$client) only, mirroring the
 * sibling inbox watermark — the tools layer never imports drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db (the Db handle type) only.
 */

import type { Db } from "@autobroker/db";

/** The number of days without progress after which a quiet profile is dormant. */
export const COLD_DORMANCY_DAYS = 14;

/** The pipeline_state key for a profile's last pipeline-progress timestamp. */
export function lastProgressKey(profileId: string): string {
  return `pipeline.last_progress_at.${profileId}`;
}

const SELECT_PROGRESS_AT = "SELECT value FROM pipeline_state WHERE key = ?";
// pipeline_state.key is the PRIMARY KEY — upsert so each advance overwrites the
// prior timestamp (exactly one row per profile). search_profile_id is stamped
// for the profile-scoped projection / audit.
const UPSERT_PROGRESS_AT =
  "INSERT INTO pipeline_state (key, value, search_profile_id) VALUES (?, ?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value, search_profile_id = excluded.search_profile_id";

/** Read a profile's last pipeline-progress timestamp (ISO string), or null when
 *  the pipeline has never advanced for it (a fresh profile, treated as WARM). */
export function readLastProgressAt(db: Db, profileId: string): string | null {
  const row = db.$client.prepare(SELECT_PROGRESS_AT).get(lastProgressKey(profileId)) as
    | { value: string | null }
    | undefined;
  const raw = row?.value;
  return raw === undefined || raw === null || raw === "" ? null : raw;
}

/** Persist a profile's last pipeline-progress timestamp (ISO string). Upsert on
 *  the profile key so a later advance overwrites the earlier value. */
export function writeLastProgressAt(db: Db, profileId: string, iso: string): void {
  db.$client.prepare(UPSERT_PROGRESS_AT).run(lastProgressKey(profileId), iso, profileId);
}
