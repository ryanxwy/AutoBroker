/**
 * dealer_inventory_sources — the link_scan source loader + the pending-row
 * seeder (the dev-period manual bootstrap; the dealer_reply_extract handoff
 * writes the same rows when that skill lands).
 *
 * KEY DISCIPLINE: a source row's identity is the FROZEN parity construction —
 * source_id = computeSourceId(profile, dealer, urlNormalize(source_url)) —
 * so a row seeded here, a row the scan's persist writer touches, and the
 * site_scan↔link_scan reconciliation all converge on the SAME id for the same
 * (profile, dealer, url). Never mint a source row any other way.
 *
 * Reads/writes go through the raw better-sqlite3 handle (db.$client) like the
 * sibling persist writer (tools must not import drizzle-orm operators).
 */

import type { Db } from "@autobroker/db";
import { getDb } from "../db.js";
import { computeSourceId, urlNormalize } from "./pure.js";

/** One pending source row joined with its dealer (the link_scan loadSources
 *  read: the dealer fields feed the US gate + the review-card label). */
export interface PendingSourceRow {
  sourceId: string;
  dealerId: string;
  dealerName: string;
  sourceUrl: string;
  normalizedUrl: string;
  sourceType: string;
  /** Dealer geography/site signals for the batched US gate. */
  website: string | null;
  country: string | null;
  state: string | null;
  postalCode: string | null;
  city: string | null;
}

const SELECT_PENDING = `
SELECT s.source_id, s.dealer_id, s.source_url, s.normalized_url, s.source_type,
       d.name, d.website, d.country, d.state, d.postal_code, d.city
  FROM dealer_inventory_sources s
  JOIN dealers d ON d.dealer_id = s.dealer_id
 WHERE s.search_profile_id = ? AND s.last_status = 'pending'
 ORDER BY s.rowid ASC
`;

/** Read the profile's not-yet-scanned source rows (last_status='pending'),
 *  oldest-seeded first. Sources whose dealer row is missing cannot be US-gated
 *  or labeled, so the JOIN is deliberately inner — an orphan source row is
 *  invisible here (and a seeded row always has its dealer by construction). */
export function listPendingSources(db: Db, searchProfileId: string): PendingSourceRow[] {
  const rows = db.$client.prepare(SELECT_PENDING).all(searchProfileId) as Array<
    Record<string, unknown>
  >;
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return rows.map((r) => ({
    sourceId: String(r["source_id"]),
    dealerId: String(r["dealer_id"]),
    dealerName: typeof r["name"] === "string" ? r["name"] : "(unnamed)",
    sourceUrl: String(r["source_url"]),
    normalizedUrl: String(r["normalized_url"]),
    sourceType: String(r["source_type"]),
    website: str(r["website"]),
    country: str(r["country"]),
    state: str(r["state"]),
    postalCode: str(r["postal_code"]),
    city: str(r["city"]),
  }));
}

const INSERT_PENDING_SOURCE = `
INSERT INTO dealer_inventory_sources (
  source_id, search_profile_id, dealer_id, source_type, source_url,
  normalized_url, discovery_method, parent_source_id, first_seen_at,
  last_status, blocked_count
) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', 0)
ON CONFLICT(source_id) DO NOTHING
`;

export interface SeedInventorySourceOptions {
  searchProfileId: string;
  dealerId: string;
  sourceUrl: string;
  /** Default "manual" (the dev-period bootstrap; the reply-link handoff
   *  passes "reply_link" when dealer_reply_extract lands). */
  sourceType?: string;
  /** Default "manual". */
  discoveryMethod?: string;
  db?: Db;
  now?: string;
}

/**
 * Idempotent pending-source upsert: mints the FROZEN source id off
 * (profile, dealer, urlNormalize(url)) and inserts a last_status='pending'
 * row; an existing row (same id) is left untouched — first_seen_at, status
 * and blocked_count all survive a re-seed.
 */
export function seedInventorySource(opts: SeedInventorySourceOptions): {
  sourceId: string;
  normalizedUrl: string;
  inserted: boolean;
} {
  const db = opts.db ?? getDb();
  const normalizedUrl = urlNormalize(opts.sourceUrl);
  const sourceId = computeSourceId(opts.searchProfileId, opts.dealerId, normalizedUrl);
  const result = db.$client
    .prepare(INSERT_PENDING_SOURCE)
    .run(
      sourceId,
      opts.searchProfileId,
      opts.dealerId,
      opts.sourceType ?? "manual",
      opts.sourceUrl,
      normalizedUrl,
      opts.discoveryMethod ?? "manual",
      opts.now ?? new Date().toISOString(),
    );
  return { sourceId, normalizedUrl, inserted: result.changes > 0 };
}
