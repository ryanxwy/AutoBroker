/**
 * incentive_scrape persist writer — the ONLY write path for
 * manufacturer_incentives, plus the read the 7-day cache gate decides on.
 *
 * The table has NO natural unique key BY DESIGN (a brand legitimately
 * carries multiple concurrent offers), so idempotency is programmatic:
 * DELETE-then-INSERT over the (make, model, zip) slice in ONE transaction —
 * the slice is replaced as a unit, a mid-insert failure rolls the whole
 * block back and the previous rows survive untouched. An empty row set is a
 * legal refresh (the slice's current truth is "no cash incentives") — the
 * DELETE still runs, so stale offers never linger.
 *
 * scraped_at / scrape_source_url are stamped HERE (run provenance), never an
 * LLM product. make/model are matched case-insensitively on the DELETE and
 * the cache read so one logical slice cannot fork on letter case; the
 * inserted values keep the caller's casing.
 *
 * Reads/writes go through the raw better-sqlite3 handle (db.$client) like
 * the sibling inventory persist writer (tools must not import drizzle-orm
 * operators).
 */

import type { Db } from "@autobroker/db";
import type { Incentive } from "@autobroker/core";

import { getDb } from "../db.js";
import type { IncentiveCacheState } from "./pure.js";

const DELETE_SLICE = `
DELETE FROM manufacturer_incentives
WHERE LOWER(make) = LOWER(?) AND LOWER(model) = LOWER(?) AND zip = ?
`;

const INSERT_ROW = `
INSERT INTO manufacturer_incentives
  (make, model, zip, type, amount, expires, eligibility, scraped_at, scrape_source_url)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_LATEST = `
SELECT scraped_at, scrape_source_url
  FROM manufacturer_incentives
 WHERE LOWER(make) = LOWER(?) AND LOWER(model) = LOWER(?) AND zip = ?
 ORDER BY scraped_at DESC
 LIMIT 1
`;

export interface PersistIncentivesArgs {
  make: string;
  model: string;
  zip: string;
  /** The final truth rows for the slice (already whitelist-filtered). */
  rows: readonly Incentive[];
  /** The source URL the capture actually used (the cache gate's URL arm). */
  scrapeSourceUrl: string;
  /** ISO observation timestamp, stamped on every row. */
  scrapedAt: string;
  db?: Db;
}

/**
 * Replace the (make, model, zip) slice with `rows` in one transaction.
 * Returns the number of rows inserted. Partial failure rolls back — the
 * pre-existing rows survive exactly as they were.
 */
export function persistIncentives(args: PersistIncentivesArgs): number {
  const db = args.db ?? getDb();
  const txn = db.$client.transaction((): number => {
    db.$client.prepare(DELETE_SLICE).run(args.make, args.model, args.zip);
    const insert = db.$client.prepare(INSERT_ROW);
    for (const row of args.rows) {
      insert.run(
        args.make,
        args.model,
        args.zip,
        row.type,
        row.amount,
        row.expires,
        row.eligibility,
        args.scrapedAt,
        args.scrapeSourceUrl,
      );
    }
    return args.rows.length;
  });
  return txn();
}

/** Read the newest scrape marker for one (make, model, zip) slice — the
 *  input the pure cacheGateDecision decides on. */
export function readIncentiveCacheState(
  db: Db,
  key: { make: string; model: string; zip: string },
): IncentiveCacheState {
  const row = db.$client.prepare(SELECT_LATEST).get(key.make, key.model, key.zip) as
    | { scraped_at?: unknown; scrape_source_url?: unknown }
    | undefined;
  if (row === undefined) return { latestScrapedAt: null, latestSourceUrl: null };
  return {
    latestScrapedAt: typeof row.scraped_at === "string" ? row.scraped_at : null,
    latestSourceUrl: typeof row.scrape_source_url === "string" ? row.scrape_source_url : null,
  };
}
