/**
 * inbox watermark — the PER-PROFILE "last time I swept THIS search's inbox"
 * timestamp, one pipeline_state row keyed `inbox.last_check_at.<profileId>`.
 *
 * This is distinct from the GLOBAL Gmail historyId watermark (one mailbox, one
 * server cursor — sync.ts owns it). The historyId tells the sync engine "what
 * changed in the mailbox"; this per-profile timestamp feeds `computeWindow` so
 * each search gets an honest "everything since I last looked at THIS search"
 * window — profile A swept yesterday and profile B swept last week each get
 * their own window without fragmenting the cheap incremental historyId sync.
 *
 * It advances ONLY after a successful apply (a decline leaves it untouched, so a
 * re-run re-discovers the same threads — the decline-does-not-advance invariant).
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle (db.$client) only, mirroring
 * sync.ts's historyId store — the tools layer never imports drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db (getDb + the Db handle type) only.
 */

import type { Db } from "@autobroker/db";

/** The pipeline_state key for a profile's last inbox-sweep timestamp. */
export function lastInboxCheckKey(profileId: string): string {
  return `inbox.last_check_at.${profileId}`;
}

const SELECT_CHECK_AT = "SELECT value FROM pipeline_state WHERE key = ?";
// pipeline_state.key is the PRIMARY KEY — upsert so each sweep overwrites the
// prior timestamp (exactly one row per profile). search_profile_id is stamped
// for the profile-scoped projection / audit.
const UPSERT_CHECK_AT =
  "INSERT INTO pipeline_state (key, value, search_profile_id) VALUES (?, ?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value, search_profile_id = excluded.search_profile_id";

/** Read a profile's last inbox-sweep timestamp (ISO string), or null when it
 *  has never been swept (computeWindow then uses the first-run lookback). */
export function readLastInboxCheckAt(db: Db, profileId: string): string | null {
  const row = db.$client.prepare(SELECT_CHECK_AT).get(lastInboxCheckKey(profileId)) as
    | { value: string | null }
    | undefined;
  const raw = row?.value;
  return raw === undefined || raw === null || raw === "" ? null : raw;
}

/** Persist a profile's last inbox-sweep timestamp (ISO string). Upsert on the
 *  profile key so a later sweep overwrites the earlier value. */
export function writeLastInboxCheckAt(db: Db, profileId: string, iso: string): void {
  db.$client.prepare(UPSERT_CHECK_AT).run(lastInboxCheckKey(profileId), iso, profileId);
}
