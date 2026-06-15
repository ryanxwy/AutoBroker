/**
 * digest watermark — the PER-PROFILE "last time a digest summarized THIS
 * search" timestamp, one pipeline_state row keyed `digest.last_at.<profileId>`.
 *
 * This is the PRODUCT watermark the daily_digest workflow advances for every
 * profile it summarizes. It is DISTINCT from the scheduler's own
 * `scheduler.last_success.daily_digest` key (one job, owned by the background
 * scheduler via readLastSuccess/writeLastSuccess) — keep both: the scheduler
 * key answers "did the cron fire?", this per-profile key answers "when was this
 * search last digested?".
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle (db.$client) only, mirroring the
 * inbox / scheduler watermark stores — the tools layer never imports drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db (the Db handle type) only.
 */

import type { Db } from "@autobroker/db";

/** The pipeline_state key for a profile's last-digest timestamp. */
export function lastDigestAtKey(profileId: string): string {
  return `digest.last_at.${profileId}`;
}

const SELECT_DIGEST_AT = "SELECT value FROM pipeline_state WHERE key = ?";
// pipeline_state.key is the PRIMARY KEY — upsert so each digest overwrites the
// prior timestamp (exactly one row per profile). search_profile_id is stamped
// for the profile-scoped projection / audit.
const UPSERT_DIGEST_AT =
  "INSERT INTO pipeline_state (key, value, search_profile_id) VALUES (?, ?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value, search_profile_id = excluded.search_profile_id";

/** Read a profile's last-digest timestamp (epoch-ms as a decimal string), or
 *  null when it has never been digested. */
export function readLastDigestAt(db: Db, profileId: string): string | null {
  const row = db.$client.prepare(SELECT_DIGEST_AT).get(lastDigestAtKey(profileId)) as
    | { value: string | null }
    | undefined;
  const raw = row?.value;
  return raw === undefined || raw === null || raw === "" ? null : raw;
}

/** Persist a profile's last-digest timestamp (epoch-ms). Upsert on the profile
 *  key so a later digest overwrites the earlier value. */
export function writeLastDigestAt(db: Db, profileId: string, atMs: number): void {
  db.$client.prepare(UPSERT_DIGEST_AT).run(lastDigestAtKey(profileId), String(atMs), profileId);
}
