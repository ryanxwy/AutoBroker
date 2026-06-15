/**
 * resolveTargetedListing — the READ-ONLY validator for the targeted-VIN OTD
 * sub-path. Given an inventory listing id, it confirms the listing exists and
 * that its dealer has at least one inbound thread for the listing's profile
 * (the defensive empty-thread guard), and reports whether the inbound message
 * it would reuse as draft context was already processed.
 *
 * HARD RULE: this NEVER mutates a single row — not messages.processed_at, not
 * anything. The `reusesProcessedInbound` flag is informational only (it drives
 * the Mode-A "this reuses an already-processed reply as context" notice the
 * draft surface shows the user); reading processed_at must not write it back.
 *
 * Typed failures (the caller branches on these, never on a string):
 *   - TargetedListingNotFound — the listing id resolves to no row.
 *   - NoInboundThread         — the listing's dealer has no inbound thread for
 *                               the profile (a targeted dealer with zero
 *                               inbound is a defensive abort, not a send).
 *
 * SQLITE INVARIANT: raw better-sqlite3 reads via db.$client (no drizzle-orm).
 */

import type { Db } from "@autobroker/db";

/** The listing id resolved to no inventory_listings row. */
export class TargetedListingNotFound extends Error {
  constructor(readonly listingId: string) {
    super(`resolveTargetedListing: no inventory listing for id ${listingId}`);
    this.name = "TargetedListingNotFound";
  }
}

/** The listing's dealer has no inbound thread for the listing's profile. */
export class NoInboundThread extends Error {
  constructor(
    readonly dealerId: string,
    readonly searchProfileId: string,
  ) {
    super(
      `resolveTargetedListing: dealer ${dealerId} has no inbound thread for profile ${searchProfileId}`,
    );
    this.name = "NoInboundThread";
  }
}

/** The validated listing row fields the targeted draft path consumes. */
export interface TargetedListing {
  listingId: string;
  searchProfileId: string;
  dealerId: string;
  vin: string | null;
  stockNumber: string | null;
}

/** The inbound thread the targeted draft would reply into. */
export interface TargetedInboundThread {
  threadId: string;
  dealerId: string;
  searchProfileId: string | null;
}

export interface ResolveTargetedListingArgs {
  targetListingId: string;
  db?: Db;
}

export interface ResolveTargetedListingResult {
  listing: TargetedListing;
  inboundThread: TargetedInboundThread;
  /** True iff the most-recent inbound message on the matched thread already
   *  carries a processed_at — informational only, never written back. */
  reusesProcessedInbound: boolean;
}

const SELECT_LISTING = `
SELECT listing_id, search_profile_id, dealer_id, vin, stock_number
  FROM inventory_listings
 WHERE listing_id = ?
 LIMIT 1
`;

// The dealer's inbound thread for the listing's profile. A thread with NULL
// search_profile_id is a legacy/aggregate thread; we require the profile match.
const SELECT_INBOUND_THREAD = `
SELECT t.thread_id, t.dealer_id, t.search_profile_id
  FROM threads t
 WHERE t.dealer_id = ?
   AND t.search_profile_id = ?
   AND EXISTS (
         SELECT 1
           FROM messages m
          WHERE m.thread_id = t.thread_id
            AND m.direction = 'inbound'
       )
 ORDER BY t.updated_at DESC
 LIMIT 1
`;

// The most-recent inbound message on the matched thread — read processed_at to
// set the reuse flag. READ ONLY.
const SELECT_LATEST_INBOUND_PROCESSED = `
SELECT m.processed_at
  FROM messages m
 WHERE m.thread_id = ?
   AND m.direction = 'inbound'
 ORDER BY m.received_at DESC
 LIMIT 1
`;

/**
 * Validate a targeted listing for the OTD sub-path. Throws TargetedListingNotFound
 * when the listing is absent and NoInboundThread when its dealer has no inbound
 * thread for the profile. Performs ZERO writes.
 */
export function resolveTargetedListing(
  args: ResolveTargetedListingArgs,
): ResolveTargetedListingResult {
  const db = args.db;
  if (db === undefined) {
    throw new Error("resolveTargetedListing: a db handle is required");
  }

  const row = db.$client.prepare(SELECT_LISTING).get(args.targetListingId) as
    | {
        listing_id: string;
        search_profile_id: string;
        dealer_id: string;
        vin: string | null;
        stock_number: string | null;
      }
    | undefined;
  if (row === undefined) {
    throw new TargetedListingNotFound(args.targetListingId);
  }

  const listing: TargetedListing = {
    listingId: row.listing_id,
    searchProfileId: row.search_profile_id,
    dealerId: row.dealer_id,
    vin: row.vin,
    stockNumber: row.stock_number,
  };

  const threadRow = db.$client
    .prepare(SELECT_INBOUND_THREAD)
    .get(listing.dealerId, listing.searchProfileId) as
    | { thread_id: string; dealer_id: string; search_profile_id: string | null }
    | undefined;
  if (threadRow === undefined) {
    throw new NoInboundThread(listing.dealerId, listing.searchProfileId);
  }

  const inboundThread: TargetedInboundThread = {
    threadId: threadRow.thread_id,
    dealerId: threadRow.dealer_id,
    searchProfileId: threadRow.search_profile_id,
  };

  const inboundRow = db.$client
    .prepare(SELECT_LATEST_INBOUND_PROCESSED)
    .get(inboundThread.threadId) as { processed_at?: unknown } | undefined;
  const reusesProcessedInbound =
    inboundRow !== undefined &&
    inboundRow.processed_at !== null &&
    inboundRow.processed_at !== undefined;

  return { listing, inboundThread, reusesProcessedInbound };
}
