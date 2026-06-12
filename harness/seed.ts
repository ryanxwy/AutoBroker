/**
 * seed — the ONE sanctioned harness write into the product DB, and it is
 * strictly scoped: pending dealer_inventory_sources rows for an
 * inventory_link_scan case, written into the run's ISOLATED throwaway DB
 * (the --db file preflight already pinned) through the @autobroker/tools
 * seeder — the frozen parity id construction lives in product code, never
 * here. Everything else keeps the dbReads trust boundary: the harness only
 * ever CHANGES product state through the SUT's HTTP.
 *
 * Why a direct write at all: the skill's input is "rows already pending in
 * the DB" (dev-period sources are manual/seeded; the dealer_reply_extract
 * pipeline that will write them in production is a later skill). There is no
 * product HTTP surface that creates these rows yet, so the case bootstrap
 * writes them the same way an operator would — and ONLY into the isolated
 * case DB, after the server host booted it, before the consuming step runs.
 *
 * Dealer resolution: each seed entry names a dealer (exact name match first,
 * else a UNIQUE case-insensitive substring) among the profile's BOUND dealers
 * (profile_dealers ⋈ dealers) — the live geosearch step created those rows
 * minutes earlier, so exact names cannot be authored ahead of time. Zero or
 * ambiguous matches fail LOUD with the available names listed (the live
 * operator adjusts the case's dealer/url pairs to the real discovered world).
 *
 * Dependency wall: harness layer. Imports @autobroker/db (openDb at the
 * explicit isolated path) + @autobroker/tools (the seeder) — the same two
 * permitted channels serverHost.ts already uses for its boot-time bootstrap.
 */

import { openDb } from "@autobroker/db";
import { seedInventorySource } from "@autobroker/tools";

import type { CaseSeedSource } from "./cases.js";

/** One bound dealer row (the name-resolution domain). */
interface BoundDealer {
  dealerId: string;
  name: string;
}

/**
 * Resolve a seed entry's dealer name against the bound dealers: exact match
 * first, else a UNIQUE case-insensitive substring. Exported pure for tests.
 */
export function resolveSeedDealer(match: string, dealers: readonly BoundDealer[]): BoundDealer {
  const want = match.trim();
  const exact = dealers.filter((d) => d.name.trim() === want);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new Error(`seed: dealer "${want}" matches ${exact.length} bound dealers exactly`);
  }
  const wantLc = want.toLowerCase();
  const fuzzy = dealers.filter((d) => d.name.toLowerCase().includes(wantLc));
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length === 0) {
    throw new Error(
      `seed: dealer "${want}" matched NO bound dealer (bound: ${
        dealers.map((d) => d.name).join(" | ") || "(none)"
      })`,
    );
  }
  throw new Error(
    `seed: dealer "${want}" is ambiguous (${fuzzy.map((d) => d.name).join(" | ")})`,
  );
}

export interface ApplySeedsResult {
  /** Rows actually inserted (an idempotent re-apply inserts 0). */
  seeded: number;
  /** Every entry's resolved source id, in seed order. */
  sourceIds: string[];
}

/**
 * Apply a case's [[seed.dealer_inventory_sources]] entries to the ISOLATED
 * case DB at `dbPath`, scoped to `profileId`. Idempotent (the tools seeder's
 * frozen-id ON CONFLICT DO NOTHING). Opens its own short-lived handle.
 */
export function applyInventorySourceSeeds(opts: {
  dbPath: string;
  profileId: string;
  seeds: readonly CaseSeedSource[];
}): ApplySeedsResult {
  const db = openDb(opts.dbPath);
  try {
    const dealers = (
      db.$client
        .prepare(
          "SELECT d.dealer_id AS dealerId, d.name AS name FROM dealers d " +
            "JOIN profile_dealers pd ON pd.dealer_id = d.dealer_id " +
            "WHERE pd.search_profile_id = ?",
        )
        .all(opts.profileId) as Array<{ dealerId: string; name: string }>
    ).map((r) => ({ dealerId: r.dealerId, name: r.name }));

    let seeded = 0;
    const sourceIds: string[] = [];
    for (const seed of opts.seeds) {
      const dealer = resolveSeedDealer(seed.dealer, dealers);
      const result = seedInventorySource({
        searchProfileId: opts.profileId,
        dealerId: dealer.dealerId,
        sourceUrl: seed.url,
        sourceType: seed.sourceType,
        discoveryMethod: "manual",
        db,
      });
      if (result.inserted) seeded += 1;
      sourceIds.push(result.sourceId);
    }
    return { seeded, sourceIds };
  } finally {
    db.$client.close();
  }
}
