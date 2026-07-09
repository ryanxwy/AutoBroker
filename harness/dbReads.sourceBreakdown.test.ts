/**
 * dbReads.sourceBreakdown.test.ts — the F9 per-site evidence read: GROUP BY
 * discovery_method over dealer_inventory_sources, LEFT JOIN'd to
 * inventory_listings by source_id. Covers profile scoping, a zero-listing
 * source still reporting its row, and multiple discovery methods (e.g. the
 * site_scan "geosearch_website" method alongside an aggregator site's
 * "aggregator_<site_id>" method) staying separate rows.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import { sourceBreakdown } from "./dbReads.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "packages", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE = "srcbreak-profile-1";
const OTHER = "srcbreak-profile-2";
const DEALER = "srcbreak-dealer-1";

function insertSource(opts: {
  sourceId: string;
  profileId: string;
  discoveryMethod: string;
  lastStatus?: string;
}): void {
  // normalized_url is part of the (profile, dealer, url) unique key — each
  // source row needs a distinct URL, so key it off sourceId.
  const url = `https://example.test/srp/${opts.sourceId}`;
  db.$client
    .prepare(
      "INSERT INTO dealer_inventory_sources " +
        "(source_id, search_profile_id, dealer_id, source_type, source_url, normalized_url, " +
        "discovery_method, first_seen_at, last_status) " +
        "VALUES (?, ?, ?, 'srp', ?, ?, ?, '2026-07-01', ?)",
    )
    .run(opts.sourceId, opts.profileId, DEALER, url, url, opts.discoveryMethod, opts.lastStatus ?? "scanned");
}

function insertListing(opts: { listingId: string; profileId: string; sourceId: string | null }): void {
  db.$client
    .prepare(
      "INSERT INTO inventory_listings " +
        "(listing_id, search_profile_id, dealer_id, source_id, inventory_status, match_status, " +
        "raw_listing_json, first_seen_at, last_seen_at, observed_at) " +
        "VALUES (?, ?, ?, ?, 'in_stock', 'exact', '{}', '2026-07-01', '2026-07-01', '2026-07-01')",
    )
    .run(opts.listingId, opts.profileId, DEALER, opts.sourceId);
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-srcbreak-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  for (const f of ["0000_military_red_skull.sql", "0001_redundant_ozymandias.sql", "0002_pale_thunderball.sql"]) {
    db.$client.exec(readFileSync(join(DRIZZLE_DIR, f), "utf8"));
  }
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, account_id, brand, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson Hybrid', 'acct-srcbreak', 'Hyundai', 'active')",
    )
    .run(PROFILE);
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, account_id, brand, status) " +
        "VALUES (?, 2026, 'Toyota', 'RAV4', 'acct-srcbreak', 'Toyota', 'active')",
    )
    .run(OTHER);
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, 'Test Dealer', 'US')").run(DEALER);
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("sourceBreakdown", () => {
  it("a profile with no sources returns []", () => {
    expect(sourceBreakdown(db, "srcbreak-no-such-profile")).toEqual([]);
  });

  it("groups by discovery_method, counting distinct sources + joined listings", () => {
    insertSource({ sourceId: "src-site-scan-1", profileId: PROFILE, discoveryMethod: "geosearch_website" });
    insertListing({ listingId: "lst-1", profileId: PROFILE, sourceId: "src-site-scan-1" });
    insertListing({ listingId: "lst-2", profileId: PROFILE, sourceId: "src-site-scan-1" });

    insertSource({ sourceId: "src-visor-1", profileId: PROFILE, discoveryMethod: "aggregator_visor_vin" });
    insertListing({ listingId: "lst-3", profileId: PROFILE, sourceId: "src-visor-1" });

    // A source with ZERO joined listings still reports its row (listings=0).
    insertSource({ sourceId: "src-cars-1", profileId: PROFILE, discoveryMethod: "aggregator_cars_com" });

    const rows = sourceBreakdown(db, PROFILE);
    expect(rows).toEqual(
      expect.arrayContaining([
        { discoveryMethod: "geosearch_website", sources: 1, listings: 2 },
        { discoveryMethod: "aggregator_visor_vin", sources: 1, listings: 1 },
        { discoveryMethod: "aggregator_cars_com", sources: 1, listings: 0 },
      ]),
    );
    expect(rows).toHaveLength(3);
  });

  it("is profile-scoped: another profile's sources/listings never leak in", () => {
    insertSource({ sourceId: "src-other-1", profileId: OTHER, discoveryMethod: "aggregator_visor_vin" });
    insertListing({ listingId: "lst-other-1", profileId: OTHER, sourceId: "src-other-1" });

    const mine = sourceBreakdown(db, PROFILE);
    const other = sourceBreakdown(db, OTHER);
    expect(mine.find((r) => r.discoveryMethod === "aggregator_visor_vin")).toEqual({
      discoveryMethod: "aggregator_visor_vin",
      sources: 1,
      listings: 1,
    });
    expect(other).toEqual([{ discoveryMethod: "aggregator_visor_vin", sources: 1, listings: 1 }]);
  });
});
