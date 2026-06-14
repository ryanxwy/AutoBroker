/**
 * inbox read closures — the profile-scoped projections the Threads Canvas
 * section renders. Read-only, raw better-sqlite3 (db.$client) only. The server
 * route delegates DOWN into these (the SQLite invariant: routes never open the
 * product DB directly).
 *
 * Both are scoped `WHERE search_profile_id = ?` so a reply ingested for one
 * search never surfaces under another (the orphan-row fix's read-side mirror).
 *
 * Dependency wall: imports @autobroker/db (the Db handle type) only.
 */

import type { Db } from "@autobroker/db";

/**
 * The threads bound to one profile, joined to the dealer for its display name,
 * newest-touched first. snake_case rows for the HTTP view. Read-only.
 */
export function listProfileThreadRows(db: Db, profileId: string): Record<string, unknown>[] {
  return db.$client
    .prepare(
      "SELECT t.thread_id, t.gmail_thread_id, t.subject, t.state, t.updated_at, " +
        "t.dealer_id, d.name AS dealer_name " +
        "FROM threads t LEFT JOIN dealers d ON d.dealer_id = t.dealer_id " +
        "WHERE t.search_profile_id = ? " +
        "ORDER BY t.updated_at DESC, t.thread_id",
    )
    .all(profileId) as Record<string, unknown>[];
}

/**
 * The set of gmail_thread_ids already suppressed (any scope/action) — the sweep
 * reads this BEFORE the approval gate so an already-suppressed thread is never
 * re-surfaced as a fresh hit. Read-only.
 */
export function listSuppressedGmailThreadIds(db: Db): Set<string> {
  const rows = db.$client
    .prepare("SELECT DISTINCT gmail_thread_id AS id FROM thread_suppression WHERE gmail_thread_id IS NOT NULL")
    .all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * The set of gmail_message_ids already ingested (any profile) — the sweep reads
 * this BEFORE the gate so a re-seen, already-ingested message is not counted as
 * a new hit (the apply also dedups, but the count must reflect only genuinely
 * new messages). Read-only.
 */
export function listIngestedGmailMessageIds(db: Db): Set<string> {
  const rows = db.$client
    .prepare("SELECT DISTINCT gmail_message_id AS id FROM messages WHERE gmail_message_id IS NOT NULL")
    .all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * The dealer-contact emails bound to one profile (its dealers' known contact
 * mailboxes) — the input pass C of the discovery query builder batches into
 * `from:` queries. Read-only.
 */
export function listProfileContactEmails(db: Db, profileId: string): string[] {
  const rows = db.$client
    .prepare(
      "SELECT DISTINCT dc.normalized_email AS email " +
        "FROM dealer_contacts dc " +
        "JOIN profile_dealers pd ON pd.dealer_id = dc.dealer_id " +
        "WHERE pd.search_profile_id = ? AND dc.normalized_email IS NOT NULL " +
        "ORDER BY dc.normalized_email",
    )
    .all(profileId) as Array<{ email: string }>;
  return rows.map((r) => r.email);
}

/**
 * The inbound messages ingested for one profile, newest first. snake_case rows
 * for the HTTP view. Read-only.
 */
export function listProfileMessageRows(db: Db, profileId: string): Record<string, unknown>[] {
  return db.$client
    .prepare(
      "SELECT message_id, thread_id, direction, sender, sender_email, sender_name, " +
        "subject, received_at, quote_extraction_status " +
        "FROM messages " +
        "WHERE search_profile_id = ? " +
        "ORDER BY received_at DESC, message_id",
    )
    .all(profileId) as Record<string, unknown>[];
}
