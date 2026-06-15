/**
 * quotes/quotesRead — read helpers feeding the quote audit. Raw better-sqlite3
 * via `db.$client` (no drizzle-orm in this layer). Each DB row is mapped to the
 * local float-dollar `AuditQuote` shape, JSON-parsing the `*_json` text columns
 * defensively into arrays.
 *
 * `listQuotesForProfile` is the audit candidate set: with `recent`, it applies
 * the four-predicate filter (succeeded extraction, unaudited at this pass,
 * received in the last 7 days or undated); otherwise all of the profile's
 * quotes. `listPeerQuotes` is the unfiltered peer set for the median checks.
 * `listIncentivesSlice` is the (make,model,zip)-exact incentive slice.
 */

import type { Db } from "@autobroker/db";

import type { AuditIncentive, AuditQuote, NamedAmount } from "./audit.js";

/** Default audit-pass label written alongside each audit row. */
export const DEFAULT_AUDIT_PASS_VERSION = "v1";

/** Coerce a DB value to a finite number, or null. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** JSON-parse a `*_json` text column into an array of dicts; non-array → []. */
function jsonArray(value: unknown): NamedAmount[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value as NamedAmount[];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as NamedAmount[]) : [];
  } catch {
    return [];
  }
}

/** Map a raw `dealer_quotes` row to the float-dollar AuditQuote shape. */
function rowToAuditQuote(row: Record<string, unknown>): AuditQuote {
  return {
    selling_price: num(row["selling_price"]),
    dealer_fee: num(row["dealer_fee"]),
    doc_fee: num(row["doc_fee"]),
    sales_tax: num(row["sales_tax"]),
    dmv_fees: num(row["dmv_fees"]),
    title_fee: num(row["title_fee"]),
    registration_fee: num(row["registration_fee"]),
    license_fee: num(row["license_fee"]),
    other_fees_json: jsonArray(row["other_fees_json"]),
    add_ons_json: jsonArray(row["add_ons_json"]),
    rebates_json: jsonArray(row["rebates_json"]),
    otd_total: num(row["otd_total"]),
    confidence: num(row["confidence"]),
    extraction_method: typeof row["extraction_method"] === "string" ? row["extraction_method"] : null,
    financing_mode: typeof row["financing_mode"] === "string" ? row["financing_mode"] : "",
    finance_apr: num(row["finance_apr"]),
    lease_money_factor: num(row["lease_money_factor"]),
  };
}

/** A quote row carrying its own id alongside the audit-readable fields. */
export interface AuditQuoteWithId extends AuditQuote {
  quote_id: string;
}

function rowToAuditQuoteWithId(row: Record<string, unknown>): AuditQuoteWithId {
  return { quote_id: String(row["quote_id"]), ...rowToAuditQuote(row) };
}

const RECENT_SQL =
  "SELECT dq.* FROM dealer_quotes dq " +
  "JOIN messages m ON m.message_id = dq.message_id " +
  "LEFT JOIN quote_audits qa " +
  "  ON qa.dealer_quote_id = dq.quote_id AND qa.audit_pass_version = ? " +
  "WHERE dq.search_profile_id = ? " +
  "  AND m.quote_extraction_status = 'succeeded' " +
  "  AND qa.audit_id IS NULL " +
  "  AND (dq.quote_received_at IS NULL OR dq.quote_received_at >= datetime('now', '-7 days'))";

const ALL_FOR_PROFILE_SQL = "SELECT dq.* FROM dealer_quotes dq WHERE dq.search_profile_id = ?";

export interface ListQuotesOpts {
  /** Apply the recent/unaudited/succeeded-extraction filter. */
  recent?: boolean;
  /** Pass version for the unaudited anti-join (default "v1"). */
  passVersion?: string;
}

/**
 * The audit candidate set for a profile. `recent` applies the four-predicate
 * filter (succeeded extraction + unaudited at this pass + received in the last
 * 7 days or undated); without it, every quote on the profile.
 */
export function listQuotesForProfile(
  db: Db,
  profileId: string,
  opts: ListQuotesOpts = {},
): AuditQuoteWithId[] {
  const rows = opts.recent
    ? (db.$client
        .prepare(RECENT_SQL)
        .all(opts.passVersion ?? DEFAULT_AUDIT_PASS_VERSION, profileId) as Record<string, unknown>[])
    : (db.$client.prepare(ALL_FOR_PROFILE_SQL).all(profileId) as Record<string, unknown>[]);
  return rows.map(rowToAuditQuoteWithId);
}

/** Read one quote by id, mapped to the audit shape; null when absent. */
export function getQuote(db: Db, quoteId: string): AuditQuoteWithId | null {
  const row = db.$client
    .prepare("SELECT * FROM dealer_quotes WHERE quote_id = ?")
    .get(quoteId) as Record<string, unknown> | undefined;
  return row ? rowToAuditQuoteWithId(row) : null;
}

/**
 * The peer set for the median checks: ALL of the profile's quotes (not the
 * recent-filtered set). The audit caller excludes the quote under audit itself
 * if needed; this returns the full profile slice.
 */
export function listPeerQuotes(db: Db, profileId: string): AuditQuoteWithId[] {
  const rows = db.$client
    .prepare(ALL_FOR_PROFILE_SQL)
    .all(profileId) as Record<string, unknown>[];
  return rows.map(rowToAuditQuoteWithId);
}

/** The (make,model,zip) manufacturer-incentive slice for MISSING_REBATE.
 *  make/model match case-insensitively (stored casing varies across scrapes);
 *  zip stays exact. */
export function listIncentivesSlice(
  db: Db,
  make: string,
  model: string,
  zip: string,
): AuditIncentive[] {
  const rows = db.$client
    .prepare(
      "SELECT make, eligibility, type, amount FROM manufacturer_incentives WHERE LOWER(make) = LOWER(?) AND LOWER(model) = LOWER(?) AND zip = ?",
    )
    .all(make, model, zip) as Record<string, unknown>[];
  return rows.map((row) => ({
    make: String(row["make"] ?? ""),
    eligibility: String(row["eligibility"] ?? ""),
    type: String(row["type"] ?? ""),
    amount: num(row["amount"]),
  }));
}
