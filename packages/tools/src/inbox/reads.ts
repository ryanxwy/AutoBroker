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
import { flagCodesFromJson } from "../quotes/flags.js";

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
        // The HONEST last-touch: the newest message timestamp on the thread, EITHER
        // direction. threads.updated_at is clobbered by the inbox upsert on any
        // non-status edit, so it is NOT a truthful "last update". Inbound rows carry
        // received_at; OUTBOUND rows carry processed_at (received_at is NULL on a
        // send), so COALESCE captures both — otherwise a thread we just followed up
        // on would still read by the dealer's older inbound time. The negotiation-
        // status projection orders + displays by THIS (parsed in JS — ISO or epoch-ms).
        "(SELECT MAX(COALESCE(m.received_at, m.processed_at)) FROM messages m " +
        "WHERE m.thread_id = t.thread_id " +
        "AND m.search_profile_id = t.search_profile_id) AS last_activity_at, " +
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
 * the row carries the dealer, mode, the full price stack + finance/lease terms,
 * format, intent, provenance, the latest audit's flag codes and the source email
 * (subject/body/sender/received-at) — NEVER a budget. The message FK
 * (q.message_id) is a JOIN KEY only and is NOT projected (id red line).
 *
 * audit_flag_summary: the codes from the latest quote_audits row per quote (same
 * correlated-latest join the quote-compare ranker uses), so a flagged quote that
 * the ranker buckets out (cash/unspecified mode) still surfaces its audit pills
 * in the raw foldout instead of being silently un-flagged.
 */
export function listProfileQuoteRows(db: Db, profileId: string): Record<string, unknown>[] {
  const rows = db.$client
    .prepare(
      "SELECT q.quote_id, q.financing_mode, q.otd_total, q.selling_price, q.vin, " +
        "q.quote_format, q.intent, q.extractor_provider, q.extraction_method, " +
        "q.quote_received_at, q.quote_expires_at, q.confidence, q.inventory_status, " +
        // full price stack
        "q.msrp, q.dealer_discount, q.doc_fee, q.dealer_fee, q.sales_tax, q.dmv_fees, " +
        "q.title_fee, q.registration_fee, q.license_fee, q.other_fees_json, q.rebates_json, " +
        "q.add_ons_json, " +
        // finance terms
        "q.finance_apr, q.finance_term_months, q.finance_down_payment, " +
        "q.finance_monthly_payment, q.finance_amount_financed, " +
        // lease terms
        "q.lease_term_months, q.lease_money_factor, q.lease_residual_pct, " +
        "q.lease_residual_value, q.lease_due_at_signing, q.lease_monthly_payment, " +
        "q.lease_miles_per_year, q.lease_acquisition_fee, q.lease_disposition_fee, " +
        "q.lease_cap_cost_gross, q.lease_cap_cost_adjusted, q.lease_rent_charge, " +
        // source email (m.message_id is the join key only — never projected)
        "m.subject AS source_subject, m.body_text AS source_body_text, " +
        "m.received_at AS source_received_at, " +
        "COALESCE(m.sender_name, m.sender_email) AS source_sender, " +
        "d.name AS dealer_name, qa.flags_json AS flags_json " +
        "FROM dealer_quotes q LEFT JOIN dealers d ON d.dealer_id = q.dealer_id " +
        "LEFT JOIN messages m ON m.message_id = q.message_id " +
        "LEFT JOIN quote_audits qa ON qa.audit_id = ( " +
        "  SELECT qa2.audit_id FROM quote_audits qa2 WHERE qa2.dealer_quote_id = q.quote_id " +
        "  ORDER BY qa2.audited_at DESC, qa2.audit_id DESC LIMIT 1 " +
        ") " +
        "WHERE q.search_profile_id = ? " +
        "ORDER BY q.quote_received_at DESC, q.extracted_at DESC, q.quote_id",
    )
    .all(profileId) as Record<string, unknown>[];
  return rows.map(({ flags_json, ...rest }) => ({
    ...rest,
    audit_flag_summary: flagCodesFromJson(flags_json),
  }));
}

/**
 * The manufacturer incentives scraped for one profile's vehicle, freshest first
 * (scraped_at, then soonest-expiring). snake_case rows for the HTTP view — the
 * cash-incentive projection the Incentives Canvas section renders. Read-only.
 *
 * The manufacturer_incentives table is keyed on (make, model, zip), not on a
 * search_profile_id, so the profile scope is a join to the profile's own
 * make/model/postal_code — make/model match case-insensitively (stored casing
 * varies across scrapes), zip stays exact (mirroring the persist writer + the
 * audit slice reader). A profile with no postal_code matches nothing.
 *
 * Budget red line: id is projected as the React key only (never rendered); the
 * row carries the program type, cash amount, eligibility, expiry and the source
 * url provenance — NEVER a budget.
 */
export function listProfileIncentiveRows(db: Db, profileId: string): Record<string, unknown>[] {
  return db.$client
    .prepare(
      "SELECT i.id, i.type, i.amount, i.expires, i.eligibility, " +
        "i.scrape_source_url, i.scraped_at " +
        "FROM manufacturer_incentives i " +
        "JOIN search_profiles p ON p.search_profile_id = ? " +
        "WHERE LOWER(i.make) = LOWER(p.make) AND LOWER(i.model) = LOWER(p.model) " +
        "AND i.zip = p.postal_code " +
        "ORDER BY i.scraped_at DESC, i.expires ASC, i.id",
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
