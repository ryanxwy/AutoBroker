/**
 * In-stack tests — the inventory_compare flat workflow.
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start chain
 * (in-process against a tmp mastra.db) → REAL step closures, with the profile
 * resolver + the ranking glue running REAL against an ISOLATED tmp
 * autobroker.db (the committed migrations applied). NO LLM, no network, no
 * suspend — the whole run is a deterministic read.
 *
 * Acceptance (read-only / infer-ok three-branch):
 *   - 1 active → runs, resolution "inferred_newest", a ranked candidate render;
 *   - a valid pin → runs, resolution "pinned";
 *   - 0 active → no_active_profile STOP (run failed, zero candidates);
 *   - 2+ active → multiple_active_profiles STOP (candidate vehicles listed).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db both live there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import {
  inventoryCompareWorkflow,
  INVENTORY_COMPARE_WORKFLOW_ID,
  __resetInventoryCompareDepsForTests,
} from "./inventoryCompare.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
].map((f) => join(here, "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const PROFILE_ID = "prof-invcmp-1";
const DEALER_NEAR = "dealer-near";
const FULL_VIN = "KM8JBCAE3RU000001";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-invcmp-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetInventoryCompareDepsForTests();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

// ---------------------------------------------------------------------------
// seed helpers
// ---------------------------------------------------------------------------

function seedProfile(over: { id?: string; make?: string; model?: string; brand?: string } = {}): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "budget_max, search_radius_miles, account_id, brand, status) " +
        "VALUES (?, 2026, ?, ?, 'Limited', 50000, 25, 'acct-test-1', ?, 'active')",
    )
    .run(
      over.id ?? PROFILE_ID,
      over.make ?? "Hyundai",
      over.model ?? "Tucson",
      over.brand ?? over.make ?? "Hyundai",
    );
}

function seedDealer(): void {
  db.$client
    .prepare("INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, 'Near Hyundai', 0.0, 'US')")
    .run(DEALER_NEAR);
}

function seedListing(over: { listingId: string; profileId?: string } ): void {
  db.$client
    .prepare(
      "INSERT INTO inventory_listings " +
        "(listing_id, search_profile_id, dealer_id, vin, year, make, model, trim, " +
        "msrp, listed_price, inventory_status, match_status, raw_listing_json, " +
        "first_seen_at, last_seen_at, observed_at) " +
        "VALUES (?, ?, ?, ?, 2026, 'Hyundai', 'Tucson', 'Limited', 46500, 44175, " +
        "'in_stock', 'exact', '{}', '2026-06-01', '2026-06-10', '2026-06-01')",
    )
    .run(over.listingId, over.profileId ?? PROFILE_ID, DEALER_NEAR, FULL_VIN);
}

// ---------------------------------------------------------------------------
// run driver
// ---------------------------------------------------------------------------

function compareWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [INVENTORY_COMPARE_WORKFLOW_ID]: inventoryCompareWorkflow as never },
  });
  return mastra.getWorkflow(INVENTORY_COMPARE_WORKFLOW_ID);
}

async function startRun(runId: string, searchProfileId: string | null = null) {
  const wf = compareWorkflow();
  const run = await wf.createRun({ runId });
  const result = await run.start({ inputData: { search_profile_id: searchProfileId } });
  return { run, result };
}

function errorMessageOf(result: unknown): string {
  const err = (result as { error?: unknown }).error;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err !== null && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "";
}

// ---------------------------------------------------------------------------
// cases
// ---------------------------------------------------------------------------

describe("inventory_compare — read-only three-branch", () => {
  it("runs with resolution 'inferred_newest' on exactly 1 active profile and renders a ranked candidate", async () => {
    seedProfile();
    seedDealer();
    seedListing({ listingId: "lst_a" });

    const { result } = await startRun("invcmp-infer-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const out = result.result as {
      outcome: string;
      resolution: string;
      candidates: Array<{ listing_id: string; vin: string | null; match_status: string }>;
      totalListings: number;
      recommendedCount: number;
      summary: string;
      scannedAtMax: string | null;
    };
    expect(out.outcome).toBe("ranked");
    expect(out.resolution).toBe("inferred_newest");
    expect(out.totalListings).toBe(1);
    expect(out.candidates).toHaveLength(1);
    // The full 17-char VIN survives end-to-end.
    expect(out.candidates[0]!.vin).toBe(FULL_VIN);
    expect(out.candidates[0]!.match_status).toBe("exact");
    expect(out.recommendedCount).toBe(1);
    expect(out.scannedAtMax).toBe("2026-06-10");
    expect(out.summary).toBe("Listed 1 inventory candidates (recommended: 1).");
    // Budget red line: the summary never carries a budget number.
    expect(out.summary).not.toContain("50000");
  });

  it("grounds the requested trim against real inventory: a trim no dealer carries gets a 'closest in stock' note", async () => {
    // Profile wants 'Limited'; the only in-stock car is a 'SEL' → the post-scan
    // grounding flags the absent trim and names the real in-stock trim.
    seedProfile();
    seedDealer();
    db.$client
      .prepare(
        "INSERT INTO inventory_listings " +
          "(listing_id, search_profile_id, dealer_id, vin, year, make, model, trim, " +
          "msrp, listed_price, inventory_status, match_status, raw_listing_json, " +
          "first_seen_at, last_seen_at, observed_at) " +
          "VALUES ('lst_sel', ?, ?, ?, 2026, 'Hyundai', 'Tucson', 'SEL Convenience', 40000, 38000, " +
          "'in_stock', 'near', '{}', '2026-06-01', '2026-06-10', '2026-06-01')",
      )
      .run(PROFILE_ID, DEALER_NEAR, FULL_VIN);

    const { result } = await startRun("invcmp-trimnote-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as { summary: string };
    expect(out.summary).toContain('No in-stock car matches the "Limited" trim');
    expect(out.summary).toContain("SEL Convenience"); // the real in-stock trim suggested
  });

  it("runs with resolution 'pinned' when a valid pin is supplied", async () => {
    seedProfile();
    const { result } = await startRun("invcmp-pinned-1", PROFILE_ID);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as { resolution: string; totalListings: number; summary: string };
    expect(out.resolution).toBe("pinned");
    expect(out.totalListings).toBe(0);
    // Nothing scanned → actionable next step, not a bare "Listed 0".
    expect(out.summary).toBe(
      "No inventory to compare yet — no dealer sites have been scanned. " +
        "Scan the dealers' inventory to see what they have in stock.",
    );
  });

  it("STOPs with no_active_profile on a pin-less input with 0 active profiles", async () => {
    const { result } = await startRun("invcmp-none-1", null);
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("No active search profile");
  });

  it("STOPs with multiple_active_profiles on 2+ active profiles (candidates listed)", async () => {
    seedProfile({ id: "prof-x", make: "Hyundai", model: "Tucson", brand: "Hyundai" });
    seedProfile({ id: "prof-y", make: "Toyota", model: "RAV4", brand: "Toyota" });
    const { result } = await startRun("invcmp-ambig-1", null);
    expect(result.status).toBe("failed");
    const msg = errorMessageOf(result);
    expect(msg).toContain("Multiple active search profiles");
    expect(msg).toContain("Tucson");
    expect(msg).toContain("RAV4");
  });
});
