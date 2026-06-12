/**
 * L1 unit tests — the inventory_site_scan persist writer. Freezes:
 *   - both upsert arms are idempotent on re-run (VIN arm; VIN-absent URL arm
 *     incl. tracking-param variants of the same href);
 *   - null-preserving merge on refresh (a sparser re-scan never blanks known
 *     fields; status/match/raw + freshness timestamps overwrite);
 *   - vin_promoted: an SRP URL-keyed row + the VDP-recovered VIN for the same
 *     car collapse to ONE live VIN-keyed row, in either capture order;
 *   - rows with neither VIN nor URL are dropped and counted;
 *   - cross-dealer same-VIN is two rows (two quotes);
 *   - supersedeStale retires only not-re-observed rows of SCANNED sources —
 *     blocked/skipped scans never supersede;
 *   - a non-scanned outcome carrying rows throws (fail-loud).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved /
 * restored); the committed migration SQL runs against the throwaway DB.
 * NEVER touches ~/.autobroker-ts or ~/.autobroker.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, openDb, type Db } from "@autobroker/db";
import type { InventoryListing } from "@autobroker/core";
import {
  persistScanResults,
  supersedeStale,
  type ClassifiedListingRow,
  type DealerScanOutcome,
} from "./persist.js";
import { computeSourceId, urlNormalize } from "./pure.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE_ID = "profile-scan-1";
const DEALER_A = "aaaa111122223333";
const DEALER_B = "bbbb444455556666";
const SRP_A = "https://alpha-hyundai.example/new-inventory/index.htm?make=Hyundai&model=Tucson";
const SRP_B = "https://beta-hyundai.example/new-vehicles/";
const VIN = "KM8J33A2XPU100001";

// Run-1 and run-2 watermarks (ISO ordering == chronological ordering).
const T0 = "2026-06-12T01:00:00.000Z"; // run 1 start
const T1 = "2026-06-12T01:05:00.000Z"; // run 1 write time
const T2 = "2026-06-12T02:00:00.000Z"; // run 2 start
const T3 = "2026-06-12T02:05:00.000Z"; // run 2 write time

function listing(overrides: Partial<InventoryListing> = {}): InventoryListing {
  return {
    year: 2026,
    make: "Hyundai",
    model: "Tucson",
    trim: "SEL",
    vin: null,
    stock_number: null,
    price: 33999,
    exterior_color: "White",
    interior_color: null,
    inventory_status: "in_stock",
    listing_url: null,
    ...overrides,
  };
}

function row(overrides: Partial<InventoryListing> = {}, matchStatus: ClassifiedListingRow["matchStatus"] = "exact"): ClassifiedListingRow {
  return { listing: listing(overrides), matchStatus, raw: { via: "test" } };
}

function scanned(dealerId: string, sourceUrl: string, rows: ClassifiedListingRow[]): DealerScanOutcome {
  return { dealerId, sourceUrl, status: "scanned", rows };
}

function allListings(): Array<Record<string, unknown>> {
  return db.$client
    .prepare("SELECT * FROM inventory_listings ORDER BY listing_id")
    .all() as Array<Record<string, unknown>>;
}

function liveListings(): Array<Record<string, unknown>> {
  return db.$client
    .prepare("SELECT * FROM inventory_listings WHERE superseded_at IS NULL ORDER BY listing_id")
    .all() as Array<Record<string, unknown>>;
}

function sourceRow(dealerId: string, sourceUrl: string): Record<string, unknown> | undefined {
  const id = computeSourceId(PROFILE_ID, dealerId, urlNormalize(sourceUrl));
  return db.$client
    .prepare("SELECT * FROM dealer_inventory_sources WHERE source_id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-invscan-"));
  mkdirSync(tmpDir, { recursive: true });
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  db.$client.exec("DELETE FROM inventory_listings; DELETE FROM dealer_inventory_sources;");
});

describe("persistScanResults — VIN arm", () => {
  it("is idempotent on re-run and merges null-preserving on refresh", () => {
    const r1 = persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T0,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ vin: VIN, stock_number: "H123" })])],
      db,
      now: T1,
    });
    expect(r1.listingsWritten).toBe(1);
    expect(r1.sourcesScanned).toBe(1);

    // Re-run: sparser row (stock/trim now null) + a different status.
    const r2 = persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T2,
      outcomes: [
        scanned(DEALER_A, SRP_A, [
          row({ vin: VIN, stock_number: null, trim: null, inventory_status: "in_transit" }, "near"),
        ]),
      ],
      db,
      now: T3,
    });
    expect(r2.listingsWritten).toBe(1);
    expect(r2.vinPromoted).toBe(0);
    expect(r2.staleSuperseded).toBe(0); // the row WAS re-observed

    const rows = allListings();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.vin).toBe(VIN);
    expect(r.stock_number).toBe("H123"); // null-preserving merge
    expect(r.trim).toBe("SEL");
    expect(r.inventory_status).toBe("in_transit"); // unconditional overwrite
    expect(r.match_status).toBe("near");
    expect(r.first_seen_at).toBe(T1); // insert time survives the refresh
    expect(r.last_seen_at).toBe(T3);
    expect(r.observed_at).toBe(T3);
  });

  it("the same VIN at TWO dealers is two rows (two quotes)", () => {
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T0,
      outcomes: [
        scanned(DEALER_A, SRP_A, [row({ vin: VIN })]),
        scanned(DEALER_B, SRP_B, [row({ vin: VIN })]),
      ],
      db,
      now: T1,
    });
    const rows = allListings();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dealer_id))).toEqual(new Set([DEALER_A, DEALER_B]));
  });
});

describe("persistScanResults — VIN-absent (URL) arm", () => {
  it("is idempotent on re-run, including tracking-param variants of the same href", () => {
    const url1 = "https://alpha-hyundai.example/vdp/tucson-sel?stock=H123&utm_source=srp";
    const url2 = "https://alpha-hyundai.example/vdp/tucson-sel?stock=H123"; // same car, no utm
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T0,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ listing_url: url1 })])],
      db,
      now: T1,
    });
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T2,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ listing_url: url2 })])],
      db,
      now: T3,
    });
    const rows = allListings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vin).toBeNull();
    expect(rows[0]!.normalized_listing_url).toBe(
      "https://alpha-hyundai.example/vdp/tucson-sel?stock=H123",
    );
  });

  it("drops (and counts) rows with neither VIN nor listing URL", () => {
    const result = persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T0,
      outcomes: [scanned(DEALER_A, SRP_A, [row(), row({ vin: VIN })])],
      db,
      now: T1,
    });
    expect(result.droppedNoKey).toBe(1);
    expect(result.listingsWritten).toBe(1);
    expect(allListings()).toHaveLength(1);
  });
});

describe("persistScanResults — vin_promoted", () => {
  const VDP_URL = "https://alpha-hyundai.example/vdp/tucson-sel?stock=H123";

  it("SRP row then VDP VIN: the URL row is superseded by the VIN row atomically", () => {
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T0,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ listing_url: VDP_URL })])],
      db,
      now: T1,
    });
    const r2 = persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T2,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ vin: VIN, listing_url: VDP_URL })])],
      db,
      now: T3,
    });
    expect(r2.vinPromoted).toBe(1);

    const all = allListings();
    expect(all).toHaveLength(2); // superseded URL row kept as history
    const live = liveListings();
    expect(live).toHaveLength(1);
    expect(live[0]!.vin).toBe(VIN);
    const retired = all.find((r) => r.superseded_at !== null)!;
    expect(retired.superseded_reason).toBe("vin_promoted");
    expect(retired.vin).toBeNull();

    // Idempotent thereafter: re-running the VIN row changes nothing more.
    const r3 = persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T2,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ vin: VIN, listing_url: VDP_URL })])],
      db,
      now: T3,
    });
    expect(r3.vinPromoted).toBe(0);
    expect(allListings()).toHaveLength(2);
  });

  it("VIN row first, URL row second: the URL row merges INTO the live VIN row", () => {
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T0,
      outcomes: [
        scanned(DEALER_A, SRP_A, [
          row({ vin: VIN, listing_url: VDP_URL }),
          row({ listing_url: VDP_URL, exterior_color: "Blue" }),
        ]),
      ],
      db,
      now: T1,
    });
    const rows = allListings();
    expect(rows).toHaveLength(1); // no NULL-VIN companion row
    expect(rows[0]!.vin).toBe(VIN); // the stronger key survives the merge
    expect(rows[0]!.exterior_color).toBe("Blue"); // fresher non-null value wins
  });
});

describe("persistScanResults — sources and staleness", () => {
  it("a fresh scanned source retires rows it no longer observes (not_observed)", () => {
    const keepUrl = "https://alpha-hyundai.example/vdp/kept";
    const goneUrl = "https://alpha-hyundai.example/vdp/gone";
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T0,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ listing_url: keepUrl }), row({ listing_url: goneUrl })])],
      db,
      now: T1,
    });

    const r2 = persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T2,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ listing_url: keepUrl })])],
      db,
      now: T3,
    });
    expect(r2.staleSuperseded).toBe(1);

    const live = liveListings();
    expect(live).toHaveLength(1);
    expect(String(live[0]!.normalized_listing_url)).toContain("/vdp/kept");
    const all = allListings();
    const retired = all.find((r) => r.superseded_at !== null)!;
    expect(retired.superseded_reason).toBe("not_observed");
  });

  it("a BLOCKED scan supersedes nothing and persists no rows", () => {
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T0,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ vin: VIN })])],
      db,
      now: T1,
    });

    const r2 = persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T2,
      outcomes: [
        {
          dealerId: DEALER_A,
          sourceUrl: SRP_A,
          status: "blocked",
          errorJson: '{"reason":"cloudflare"}',
        },
      ],
      db,
      now: T3,
    });
    expect(r2.sourcesBlocked).toBe(1);
    expect(r2.staleSuperseded).toBe(0);
    expect(liveListings()).toHaveLength(1); // the old row SURVIVES a blocked scan

    const src = sourceRow(DEALER_A, SRP_A)!;
    expect(src.last_status).toBe("blocked");
    expect(src.blocked_count).toBe(1);
    expect(src.error_json).toBe('{"reason":"cloudflare"}');

    // A later successful scan resets the strike count.
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T2,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ vin: VIN })])],
      db,
      now: T3,
    });
    expect(sourceRow(DEALER_A, SRP_A)!.blocked_count).toBe(0);
  });

  it("a non-scanned outcome carrying rows throws (fail-loud, nothing persisted)", () => {
    expect(() =>
      persistScanResults({
        searchProfileId: PROFILE_ID,
        runStartedAt: T0,
        outcomes: [{ dealerId: DEALER_A, sourceUrl: SRP_A, status: "skipped", rows: [row({ vin: VIN })] }],
        db,
        now: T1,
      }),
    ).toThrow(/never persisted/);
    expect(allListings()).toHaveLength(0);
    expect(sourceRow(DEALER_A, SRP_A)).toBeUndefined(); // the transaction rolled back
  });
});

describe("supersedeStale — gated to scanned sources IN the verb", () => {
  it("returns 0 for non-scanned and unknown sources, retires for scanned only", () => {
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: T0,
      outcomes: [scanned(DEALER_A, SRP_A, [row({ vin: VIN })])],
      db,
      now: T1,
    });
    const sourceId = computeSourceId(PROFILE_ID, DEALER_A, urlNormalize(SRP_A));

    // Flip the source to skipped: nothing may be retired through it.
    db.$client
      .prepare("UPDATE dealer_inventory_sources SET last_status = 'skipped' WHERE source_id = ?")
      .run(sourceId);
    expect(
      supersedeStale({ searchProfileId: PROFILE_ID, sourceId, runStartedAt: T2, db, now: T3 }),
    ).toBe(0);
    expect(liveListings()).toHaveLength(1);

    // Unknown source id proves nothing → 0.
    expect(
      supersedeStale({ searchProfileId: PROFILE_ID, sourceId: "src_nope", runStartedAt: T2, db, now: T3 }),
    ).toBe(0);

    // Back to scanned: rows older than the watermark retire.
    db.$client
      .prepare("UPDATE dealer_inventory_sources SET last_status = 'scanned' WHERE source_id = ?")
      .run(sourceId);
    expect(
      supersedeStale({ searchProfileId: PROFILE_ID, sourceId, runStartedAt: T2, db, now: T3 }),
    ).toBe(1);
    expect(liveListings()).toHaveLength(0);
  });
});
