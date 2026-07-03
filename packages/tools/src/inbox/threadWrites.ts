/**
 * threadWrites — thread-row state writes. The generic `state` setter the
 * negotiation-follow-up workflow uses to mark a thread it just replied to (e.g.
 * 'negotiating'); the 'closed'/'suppressed'-specific writers live in
 * closeout/sendCloseSuppress + hygiene/writes. Keeps the raw SQL in the tools
 * layer so the workflow never opens the product DB (the SQLite invariant).
 *
 * Dependency wall: imports @autobroker/db (the Db handle type) only.
 */

import type { Db } from "@autobroker/db";

/** Set a thread's `state` column. A NARROW single-purpose setter (only the state
 *  column), not a generic column setter — the value is the caller's chosen state. */
export function setThreadState(db: Db, threadId: string, state: string): void {
  db.$client.prepare("UPDATE threads SET state = ? WHERE thread_id = ?").run(state, threadId);
}
