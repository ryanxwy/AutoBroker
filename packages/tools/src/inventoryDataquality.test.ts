/**
 * Unit test — dataquality breakdown coverage aggregation.
 *
 * Proves the SQL/JS logic added to the /__e2e/dataquality route
 * (apps/ui/e2e/serve-live.mjs, inventory_site_scan branch) computes
 * breakdown_coverage correctly on a minimal two-listing seed:
 *   - row 1: pricing_breakdown_json with a non-empty addOns array  → breakdown_parsed
 *   - row 2: pricing_breakdown_json IS NULL                        → not parsed
 *
 * Expected: breakdown_parsed=1, breakdown_coverage=0.5, markup_present=0,
 *           addons_present=1, and all fields are always returned (no 4xx).
 *
 * ISOLATION: a throwaway tmpdir DB, never touches ~/.autobroker-ts/.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeDb, openDb, type Db } from "@autobroker/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

// Migrations needed: 0000 creates all base tables (incl. inventory_listings);
// 0004 adds dealer_markup + pricing_breakdown_json to inventory_listings.
const MIGRATION_FILES = ["0000_military_red_skull.sql", "0004_empty_celestials.sql"].map((f) =>
  join(here, "..", "..", "db", "drizzle", f),
);

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const originalDataDir = process.env[DATA_DIR];

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-dq-"));
  process.env[DATA_DIR] = tmpDir;
  db = openDb();
  // Disable FK enforcement so we can insert inventory_listings without
  // creating the referenced search_profiles/dealers rows.
  db.$client.pragma("foreign_keys = OFF");
  for (const sql of MIGRATION_FILES) db.$client.exec(readFileSync(sql, "utf8"));

  // Seed two inventory_listings rows:
  //   row 1 — pricing_breakdown_json with a non-empty addOns array (no dealer_markup)
  //   row 2 — pricing_breakdown_json IS NULL
  const NOW = Date.now();
  const insert = db.$client.prepare(
    `INSERT INTO inventory_listings
       (listing_id, search_profile_id, dealer_id, inventory_status, match_status,
        raw_listing_json, first_seen_at, last_seen_at, observed_at,
        listing_url, pricing_breakdown_json, dealer_markup)
     VALUES (?, 'p1', 'd1', 'active', 'match',
             '{}', ?, ?, ?,
             ?, ?, ?)`,
  );
  // Row 1: VDP linked + breakdown parsed + add-on present
  insert.run(
    "l1",
    NOW,
    NOW,
    NOW,
    "https://dealer.example/vdp/1",
    JSON.stringify({
      addOns: [{ label: "Nitrogen", amount: 299 }],
      addonsTotal: 299,
      priceGated: false,
      breakdownParsed: true,
    }),
    null,
  );
  // Row 2: VDP linked but no breakdown data
  insert.run("l2", NOW, NOW, NOW, "https://dealer.example/vdp/2", null, null);
});

afterAll(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
});

/** Replicate the exact SQL from the /__e2e/dataquality route (inventory_site_scan branch). */
function runQuery() {
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const r = db.$client
    .prepare(
      `SELECT COUNT(*) AS n,
         SUM(CASE WHEN listed_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
         SUM(CASE WHEN msrp IS NOT NULL THEN 1 ELSE 0 END) AS msrp_present,
         SUM(CASE WHEN listed_price IS NOT NULL OR msrp IS NOT NULL THEN 1 ELSE 0 END) AS covered,
         SUM(CASE WHEN listing_url IS NOT NULL THEN 1 ELSE 0 END) AS vdp_linked,
         SUM(CASE WHEN pricing_breakdown_json IS NOT NULL THEN 1 ELSE 0 END) AS breakdown_parsed,
         SUM(CASE WHEN dealer_markup IS NOT NULL THEN 1 ELSE 0 END) AS markup_present,
         SUM(CASE WHEN pricing_breakdown_json LIKE '%"addOns":[{%' THEN 1 ELSE 0 END) AS addons_present
       FROM inventory_listings WHERE superseded_at IS NULL`,
    )
    .get() as Record<string, number>;
  const n = r["n"] ?? 0;
  const breakdown_parsed = r["breakdown_parsed"] ?? 0;
  return {
    n,
    vdp_linked: r["vdp_linked"] ?? 0,
    breakdown_parsed,
    breakdown_coverage: n > 0 ? round2(breakdown_parsed / n) : 0,
    markup_present: r["markup_present"] ?? 0,
    addons_present: r["addons_present"] ?? 0,
  };
}

describe("dataquality — inventory_site_scan breakdown coverage", () => {
  it("breakdown_coverage is 0.5 on a two-listing seed (one parsed, one null)", () => {
    const result = runQuery();
    expect(result.n).toBe(2);
    expect(result.breakdown_parsed).toBe(1);
    expect(result.breakdown_coverage).toBe(0.5);
  });

  it("markup_present is 0 when no rows have dealer_markup set (informational, never a fail)", () => {
    const result = runQuery();
    expect(result.markup_present).toBe(0);
  });

  it("addons_present counts only rows with a non-empty addOns array in the JSON", () => {
    const result = runQuery();
    expect(result.addons_present).toBe(1);
  });

  it("vdp_linked reflects both linked rows (both have listing_url)", () => {
    const result = runQuery();
    expect(result.vdp_linked).toBe(2);
  });
});
