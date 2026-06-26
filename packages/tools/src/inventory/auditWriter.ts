/**
 * inventory/auditWriter — the inventory price-change trail. When a daily re-scan
 * changes a listing's price, persistScanResults appends one row to the GENERIC
 * audit_log (no new table, no migration) using its field/old_value/new_value
 * columns, and readInventoryChangesSince reads them back so the digest / canvas can
 * surface "price dropped $X since you last looked".
 *
 * Mirrors the auditLogWriter.ts pattern (raw better-sqlite3 via db.$client). The
 * emit is COALESCE-aware: persist only calls it when a NON-NULL new price actually
 * differs from a prior price — a sparse re-scan whose price is null keeps the old
 * value (COALESCE) and is NOT a change, so no bogus "35000 -> null" row is written.
 */

import { randomUUID } from "node:crypto";

import type { Db } from "@autobroker/db";

/** The action discriminator the read side filters audit_log on. */
export const INVENTORY_PRICE_CHANGE_ACTION = "inventory.price_change" as const;

const INSERT_PRICE_CHANGE = `
INSERT INTO audit_log
  (audit_id, action, target_table, target_id, search_profile_id, field, old_value, new_value, payload_json, at)
VALUES (?, ?, 'inventory_listings', ?, ?, 'listed_price', ?, ?, ?, ?)
`;

export interface EmitPriceChangeArgs {
  db: Db;
  listingId: string;
  searchProfileId: string;
  dealerId: string | null;
  vin: string | null;
  oldPrice: number;
  newPrice: number;
  /** The run's write time (ISO) — set explicitly so `at` is ISO (the read compares
   *  ISO-to-ISO; the CURRENT_TIMESTAMP default would be a space-separated format
   *  that doesn't lexicographically compare against an ISO `since`). */
  at: string;
}

/** Append one inventory.price_change audit row. Old/new prices are stored as text
 *  in old_value/new_value (the generic audit columns); the dealer + vin ride in
 *  payload_json. */
export function emitInventoryPriceChange(args: EmitPriceChangeArgs): void {
  args.db.$client
    .prepare(INSERT_PRICE_CHANGE)
    .run(
      randomUUID(),
      INVENTORY_PRICE_CHANGE_ACTION,
      args.listingId,
      args.searchProfileId,
      String(args.oldPrice),
      String(args.newPrice),
      JSON.stringify({ dealer_id: args.dealerId, vin: args.vin }),
      args.at,
    );
}

/** One surfaced price change for the digest / canvas (budget-free: only dealer
 *  listing prices). dropUsd = oldPrice - newPrice, so a POSITIVE value is a drop. */
export interface InventoryPriceChange {
  listingId: string;
  dealerId: string | null;
  vin: string | null;
  oldPrice: number;
  newPrice: number;
  /** oldPrice - newPrice: positive = the price DROPPED, negative = it rose. */
  dropUsd: number;
  at: string;
}

const SELECT_CHANGES_SINCE = `
SELECT target_id AS listing_id, old_value AS old_price, new_value AS new_price, payload_json, at
FROM audit_log
WHERE action = ? AND search_profile_id = ? AND at >= ?
ORDER BY at DESC, audit_id
`;

/**
 * The inventory price changes recorded for one profile since `sinceIso` (an ISO
 * timestamp — typically the last digest watermark, NOT a fresh second clock).
 * Returns every change (drops and rises) with a signed dropUsd; the consumer
 * filters to drops (dropUsd > 0) for "price dropped since you last looked".
 * Read-only.
 */
export function readInventoryChangesSince(
  db: Db,
  profileId: string,
  sinceIso: string,
): InventoryPriceChange[] {
  const rows = db.$client
    .prepare(SELECT_CHANGES_SINCE)
    .all(INVENTORY_PRICE_CHANGE_ACTION, profileId, sinceIso) as Array<{
    listing_id: string;
    old_price: string | null;
    new_price: string | null;
    payload_json: string | null;
    at: string;
  }>;
  return rows.map((r) => {
    const oldPrice = Number(r.old_price);
    const newPrice = Number(r.new_price);
    let dealerId: string | null = null;
    let vin: string | null = null;
    if (r.payload_json !== null) {
      try {
        const p = JSON.parse(r.payload_json) as { dealer_id?: string | null; vin?: string | null };
        dealerId = p.dealer_id ?? null;
        vin = p.vin ?? null;
      } catch {
        // a malformed payload leaves dealer/vin null — the price delta still stands.
      }
    }
    return { listingId: r.listing_id, dealerId, vin, oldPrice, newPrice, dropUsd: oldPrice - newPrice, at: r.at };
  });
}
