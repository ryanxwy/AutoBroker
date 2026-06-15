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

import { hostStem } from "./discovery.js";

/**
 * The threads bound to one profile, joined to the dealer for its display name,
 * newest-touched first. snake_case rows for the HTTP view. Read-only.
 *
 * `extract_failed` (0|1) is a per-thread flag: 1 when SOME message in that
 * thread (profile-scoped) carries quote_extraction_status='failed' — the signal
 * the Threads canvas section renders the "extraction failed, will retry" badge
 * from. A correlated EXISTS subquery keeps it SELECT-only and per-row.
 */
export function listProfileThreadRows(db: Db, profileId: string): Record<string, unknown>[] {
  return db.$client
    .prepare(
      "SELECT t.thread_id, t.gmail_thread_id, t.subject, t.state, t.updated_at, " +
        "t.dealer_id, d.name AS dealer_name, " +
        "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.thread_id " +
        "AND m.search_profile_id = t.search_profile_id " +
        "AND m.quote_extraction_status = 'failed') AS extract_failed " +
        "FROM threads t LEFT JOIN dealers d ON d.dealer_id = t.dealer_id " +
        "WHERE t.search_profile_id = ? " +
        "ORDER BY t.updated_at DESC, t.thread_id",
    )
    .all(profileId) as Record<string, unknown>[];
}

/**
 * The dealer quotes extracted for one profile, joined to the dealer for its
 * display name, newest-received first (quote_received_at, then extracted_at).
 * snake_case rows for the HTTP view — the RAW per-quote extraction projection
 * the "Extracted quotes" Canvas section renders (ALL financing modes, incl.
 * cash/unspecified, distinct from the ranked quote-compare buckets). Read-only.
 *
 * Budget red line: quote_id is projected as the React key only (never rendered);
 * the row carries the dealer, mode, prices, format, intent and provenance —
 * NEVER a budget.
 */
export function listProfileQuoteRows(db: Db, profileId: string): Record<string, unknown>[] {
  return db.$client
    .prepare(
      "SELECT q.quote_id, q.financing_mode, q.otd_total, q.selling_price, q.vin, " +
        "q.quote_format, q.intent, q.extractor_provider, q.extraction_method, " +
        "q.quote_received_at, d.name AS dealer_name " +
        "FROM dealer_quotes q LEFT JOIN dealers d ON d.dealer_id = q.dealer_id " +
        "WHERE q.search_profile_id = ? " +
        "ORDER BY q.quote_received_at DESC, q.extracted_at DESC, q.quote_id",
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
 * The registrable host stems of THIS profile's bound dealers' websites — the
 * dealer-domain allow-set the routing ladder's host rung matches a sender
 * against. A dealer with no/unparseable website contributes nothing; the list
 * is deduped stable (first-seen order). Read-only, profile-scoped.
 */
export function listProfileDealerDomains(db: Db, profileId: string): string[] {
  const rows = db.$client
    .prepare(
      "SELECT d.website AS website " +
        "FROM dealers d " +
        "JOIN profile_dealers pd ON pd.dealer_id = d.dealer_id " +
        "WHERE pd.search_profile_id = ? AND d.website IS NOT NULL",
    )
    .all(profileId) as Array<{ website: string | null }>;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const raw = r.website;
    if (raw === null || raw.trim() === "") continue;
    const stem = hostStem(raw);
    if (stem === null || stem === "") continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(stem);
  }
  return out;
}

/**
 * The earliest successful lead-submit timestamp (epoch ms) for one profile — the
 * window anchor the first inbox sweep uses instead of a blind default (the sweep
 * only looks for replies AFTER any dealer was contacted). Reads MIN over the
 * `submitted` rows; returns null when none exist (no lead yet → the caller
 * STOPs rather than sweeping pre-outreach noise). The column carries the submit
 * timestamp as an ISO string per the codebase convention, so the raw is parsed
 * with `Date.parse`; a numeric (epoch-ms) value is returned directly. null/
 * empty/non-finite → null. Read-only, profile-scoped.
 */
export function readFirstLeadSubmitAtMs(db: Db, profileId: string): number | null {
  const row = db.$client
    .prepare(
      "SELECT MIN(submitted_at) AS first_at " +
        "FROM lead_submissions " +
        "WHERE search_profile_id = ? AND outcome = 'submitted' AND submitted_at IS NOT NULL",
    )
    .get(profileId) as { first_at: string | number | null };
  const raw = row.first_at;
  if (raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (raw.trim() === "") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
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
