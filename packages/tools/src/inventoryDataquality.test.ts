/**
 * Unit test — dataquality breakdown coverage aggregation.
 *
 * Proves the SQL/JS logic added to the /__e2e/dataquality route
 * (apps/ui/e2e/serve-live.mjs, inventory_site_scan branch) computes
 * breakdown_coverage correctly on a three-listing seed:
 *   - row 1: pricing_breakdown_json with a non-empty addOns array + dealer_markup > 0
 *             → breakdown_parsed, addons_present, markup_present
 *   - row 2: pricing_breakdown_json IS NULL                        → not parsed
 *   - row 3: pricing_breakdown_json non-null + addOns:[] + dealer_markup = 0
 *             (production sentinel: breakdown harvested but no labeled markup)
 *             → breakdown_parsed only (neither markup_present nor addons_present)
 *
 * Expected: breakdown_parsed=2, breakdown_coverage=0.67, markup_present=1,
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

  // Seed three inventory_listings rows:
  //   row 1 — breakdown parsed + non-empty addOns + real dealer_markup > 0
  //   row 2 — no breakdown data (pricing_breakdown_json IS NULL)
  //   row 3 — breakdown parsed + addOns:[] + dealer_markup = 0
  //            (mirrors production: VDP was harvested, but no labeled dealer markup
  //            was found; persist.ts writes 0 via ?? 0 sentinel, NOT NULL)
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
  // Row 1: VDP linked + breakdown parsed + add-on present + real dealer markup
  insert.run(
    "l1",
    NOW,
    NOW,
    NOW,
    "https://dealer.example/vdp/1",
    JSON.stringify({
      addOns: [{ label: "Nitrogen", amount: 299 }],
      addonsTotal: 299,
      dealerMarkup: 995,
      priceGated: false,
      breakdownParsed: true,
    }),
    995,
  );
  // Row 2: VDP linked but no breakdown data
  insert.run("l2", NOW, NOW, NOW, "https://dealer.example/vdp/2", null, null);
  // Row 3: VDP linked + breakdown parsed + empty addOns + dealer_markup=0 sentinel
  // (production writes 0 for VDP rows that have no labeled dealer markup)
  insert.run(
    "l3",
    NOW,
    NOW,
    NOW,
    "https://dealer.example/vdp/3",
    JSON.stringify({
      addOns: [],
      addonsTotal: 0,
      priceGated: false,
      breakdownParsed: true,
    }),
    0,
  );
});

afterAll(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
});

/**
 * Replicate the exact SQL from the /__e2e/dataquality route (inventory_site_scan branch).
 * NOTE: this SQL is mirrored in apps/ui/e2e/serve-live.mjs — update both.
 */
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
         SUM(CASE WHEN dealer_markup IS NOT NULL AND dealer_markup <> 0 THEN 1 ELSE 0 END) AS markup_present,
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
  it("breakdown_coverage is 0.67 on a three-listing seed (two parsed, one null)", () => {
    const result = runQuery();
    expect(result.n).toBe(3);
    expect(result.breakdown_parsed).toBe(2);
    expect(result.breakdown_coverage).toBe(0.67);
  });

  it("markup_present counts only rows where dealer_markup > 0 (the 0-sentinel is excluded)", () => {
    const result = runQuery();
    // Row 1 has dealer_markup=995 → counted. Row 3 has dealer_markup=0 (production
    // sentinel for harvested rows with no labeled markup) → excluded by <> 0.
    expect(result.markup_present).toBe(1);
  });

  it("addons_present counts only rows with a non-empty addOns array in the JSON", () => {
    const result = runQuery();
    // Row 1 has addOns:[{...}] → counted. Row 3 has addOns:[] → pattern requires
    // at least one '{' after '[', so the empty array never matches.
    expect(result.addons_present).toBe(1);
  });

  it("vdp_linked reflects all linked rows", () => {
    const result = runQuery();
    expect(result.vdp_linked).toBe(3);
  });
});

/**
 * Per-dealer breakdown (GROUP BY dealer_id) — the measurement instrument for
 * "which dealer is losing breakdown" (the pooled GLOBAL ratio masks a single
 * dealer dropping every breakdown). Replicates the per-dealer SQL added to the
 * /__e2e/dataquality route. This suite seeds its OWN second dealer AFTER the
 * global suite has run (source order), then tears it down — so the global
 * counts above are untouched.
 *
 * NOTE: the per-dealer SQL is mirrored in apps/ui/e2e/serve-live.mjs — update both.
 */
function runByDealer() {
  return db.$client
    .prepare(
      `SELECT dealer_id,
         COUNT(*) AS n,
         SUM(CASE WHEN listed_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
         SUM(CASE WHEN msrp IS NOT NULL THEN 1 ELSE 0 END) AS msrp_present,
         SUM(CASE WHEN pricing_breakdown_json IS NOT NULL THEN 1 ELSE 0 END) AS breakdown_parsed,
         SUM(CASE WHEN dealer_markup IS NOT NULL AND dealer_markup <> 0 THEN 1 ELSE 0 END) AS markup_present,
         SUM(CASE WHEN pricing_breakdown_json LIKE '%"addOns":[{%' THEN 1 ELSE 0 END) AS addons_present
       FROM inventory_listings WHERE superseded_at IS NULL
       GROUP BY dealer_id
       ORDER BY dealer_id`,
    )
    .all() as Record<string, number | string>[];
}

describe("dataquality — per-dealer breakdown (GROUP BY dealer_id)", () => {
  // A second dealer 'd2' with NULL make → classified match_status='unknown' (a
  // single-brand dealer the make-axis can't classify). Two listings: one with a
  // parsed breakdown blob, one without. The route does NOT filter match_status,
  // so an 'unknown' dealer keeps ALL its rows — never zeroed (no had-and-lost).
  beforeAll(() => {
    const NOW = Date.now();
    const ins = db.$client.prepare(
      `INSERT INTO inventory_listings
         (listing_id, search_profile_id, dealer_id, make, inventory_status, match_status,
          raw_listing_json, first_seen_at, last_seen_at, observed_at,
          listing_url, pricing_breakdown_json, dealer_markup)
       VALUES (?, 'p1', 'd2', NULL, 'active', 'unknown',
               '{}', ?, ?, ?, ?, ?, ?)`,
    );
    ins.run(
      "l4",
      NOW,
      NOW,
      NOW,
      "https://d2.example/vdp/4",
      JSON.stringify({ addOns: [], addonsTotal: null, priceGated: false, breakdownParsed: true }),
      0,
    );
    ins.run("l5", NOW, NOW, NOW, "https://d2.example/vdp/5", null, null);
  });

  afterAll(() => {
    db.$client.prepare("DELETE FROM inventory_listings WHERE dealer_id = 'd2'").run();
  });

  it("returns a per-dealer row for EACH dealer (not just the pooled global)", () => {
    const byDealer = runByDealer();
    const ids = byDealer.map((d) => d.dealer_id);
    expect(ids).toContain("d1");
    expect(ids).toContain("d2");
  });

  it("a null-make 'unknown'-match single-brand dealer is NOT zeroed (keeps all its rows)", () => {
    const d2 = runByDealer().find((d) => d.dealer_id === "d2")!;
    expect(d2).toBeDefined();
    expect(d2.n).toBe(2); // both listings counted — no exact-only persist drop
    expect(d2.breakdown_parsed).toBe(1); // l4 parsed, l5 null
    expect(d2.markup_present).toBe(0); // l4 markup=0 sentinel → excluded
    expect(d2.addons_present).toBe(0);
  });

  it("d1's per-dealer aggregates match its three seeded rows", () => {
    const d1 = runByDealer().find((d) => d.dealer_id === "d1")!;
    expect(d1.n).toBe(3);
    expect(d1.breakdown_parsed).toBe(2);
    expect(d1.markup_present).toBe(1);
    expect(d1.addons_present).toBe(1);
  });
});

/**
 * Render-quality signal — the "rendered_empty" marker rides the SOURCE row
 * (dealer_inventory_sources.error_json) at last_status='scanned', NOT the
 * listings table, so a host-thrash blank SRP is distinguishable from a genuine
 * 0-stock dealer. Replicates the source-row aggregate added to the
 * /__e2e/dataquality route. NOTE: this SQL is mirrored in
 * apps/ui/e2e/serve-live.mjs — update both.
 */
function runRenderEmpty() {
  const r = db.$client
    .prepare(
      `SELECT COUNT(*) AS scanned_sources,
         SUM(CASE WHEN error_json LIKE '%rendered_empty%' THEN 1 ELSE 0 END) AS rendered_empty
       FROM dealer_inventory_sources WHERE last_status='scanned'`,
    )
    .get() as Record<string, number>;
  return {
    scanned_sources: r["scanned_sources"] ?? 0,
    rendered_empty_count: r["rendered_empty"] ?? 0,
  };
}

describe("dataquality — rendered_empty source marker", () => {
  // Two scanned source rows: one carries the {"rendered_empty":true} marker in
  // error_json (host-thrash blank render), the other is a clean scan (genuine
  // listings / real 0-stock). Both stay last_status='scanned'.
  beforeAll(() => {
    const NOW = Date.now();
    const ins = db.$client.prepare(
      `INSERT INTO dealer_inventory_sources
         (source_id, search_profile_id, dealer_id, source_type, source_url,
          normalized_url, discovery_method, first_seen_at, last_status, error_json)
       VALUES (?, 'p1', ?, 'srp', ?, ?, 'scan', ?, 'scanned', ?)`,
    );
    ins.run("s-blank", "dr1", "https://dr1.example/new", "https://dr1.example/new", NOW, '{"rendered_empty":true}');
    ins.run("s-clean", "dr2", "https://dr2.example/new", "https://dr2.example/new", NOW, null);
  });

  afterAll(() => {
    db.$client.prepare("DELETE FROM dealer_inventory_sources WHERE source_id IN ('s-blank','s-clean')").run();
  });

  it("counts exactly the scanned source carrying the rendered_empty marker", () => {
    const r = runRenderEmpty();
    expect(r.scanned_sources).toBe(2);
    expect(r.rendered_empty_count).toBe(1);
  });
});
