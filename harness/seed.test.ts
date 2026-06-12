/**
 * seed.test.ts — the case-seed writer (the one sanctioned harness DB write).
 * Asserts the dealer-name resolution contract (exact first, unique substring
 * second, LOUD failure on zero/ambiguous), the frozen-id pending rows landing
 * in the explicit isolated DB, and idempotent re-apply.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path (the runner passes --db
 * the same way); never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb } from "@autobroker/db";
import { computeSourceId, urlNormalize } from "@autobroker/tools";

import { applyInventorySourceSeeds, resolveSeedDealer } from "./seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "packages", "db", "drizzle");

let tmpDir: string;
let dbPath: string;

const PROFILE_ID = "prof-seed-1";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-harness-seed-"));
  dbPath = join(tmpDir, "autobroker.db");
  const db = openDb(dbPath);
  try {
    db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
    db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
    const insDealer = db.$client.prepare(
      "INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')",
    );
    const bind = db.$client.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')",
    );
    for (const [id, name] of [
      ["d-tustin", "Tustin Hyundai"],
      ["d-anaheim", "Russell Westbrook Hyundai of Anaheim"],
      ["d-gg", "Garden Grove Hyundai"],
    ] as const) {
      insDealer.run(id, name);
      bind.run(PROFILE_ID, id);
    }
    // A dealer bound to a DIFFERENT profile must be invisible to resolution.
    insDealer.run("d-other", "Tustin Kia");
    bind.run("prof-other", "d-other");
  } finally {
    db.$client.close();
  }
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveSeedDealer — exact first, unique substring second, loud failure", () => {
  const dealers = [
    { dealerId: "d-1", name: "Tustin Hyundai" },
    { dealerId: "d-2", name: "Russell Westbrook Hyundai of Anaheim" },
    { dealerId: "d-3", name: "Garden Grove Hyundai" },
  ];

  it("exact name wins", () => {
    expect(resolveSeedDealer("Tustin Hyundai", dealers).dealerId).toBe("d-1");
  });

  it("a unique case-insensitive substring resolves", () => {
    expect(resolveSeedDealer("hyundai of anaheim", dealers).dealerId).toBe("d-2");
  });

  it("zero matches fail LOUD with the available names listed", () => {
    expect(() => resolveSeedDealer("Irvine BMW", dealers)).toThrow(/matched NO bound dealer/);
    expect(() => resolveSeedDealer("Irvine BMW", dealers)).toThrow(/Tustin Hyundai/);
  });

  it("ambiguous substrings fail LOUD", () => {
    expect(() => resolveSeedDealer("Hyundai", dealers)).toThrow(/ambiguous/);
  });
});

describe("applyInventorySourceSeeds — pending rows in the explicit isolated DB", () => {
  const SEEDS = [
    {
      dealer: "Tustin Hyundai",
      url: "https://www.tustinhyundai.com/new-inventory/index.htm?model=Tucson",
      sourceType: "manual",
    },
    {
      dealer: "Hyundai of Anaheim", // unique substring of the bound name
      url: "https://www.hyundaianaheim.com/new-inventory/index.htm",
      sourceType: "manual",
    },
  ];

  it("writes frozen-id pending rows scoped to the profile", () => {
    const result = applyInventorySourceSeeds({ dbPath, profileId: PROFILE_ID, seeds: SEEDS });
    expect(result.seeded).toBe(2);
    expect(result.sourceIds).toEqual([
      computeSourceId(PROFILE_ID, "d-tustin", urlNormalize(SEEDS[0]!.url)),
      computeSourceId(PROFILE_ID, "d-anaheim", urlNormalize(SEEDS[1]!.url)),
    ]);

    const db = openDb(dbPath);
    try {
      const rows = db.$client
        .prepare(
          "SELECT dealer_id, last_status, source_type, discovery_method FROM dealer_inventory_sources " +
            "WHERE search_profile_id = ? ORDER BY rowid",
        )
        .all(PROFILE_ID) as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        { dealer_id: "d-tustin", last_status: "pending", source_type: "manual", discovery_method: "manual" },
        { dealer_id: "d-anaheim", last_status: "pending", source_type: "manual", discovery_method: "manual" },
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("re-applying is idempotent (0 new rows, same ids)", () => {
    const again = applyInventorySourceSeeds({ dbPath, profileId: PROFILE_ID, seeds: SEEDS });
    expect(again.seeded).toBe(0);
    expect(again.sourceIds).toHaveLength(2);
  });

  it("a seed naming an unbound dealer fails LOUD and writes nothing new", () => {
    expect(() =>
      applyInventorySourceSeeds({
        dbPath,
        profileId: PROFILE_ID,
        seeds: [{ dealer: "Tustin Kia", url: "https://www.tustinkia.com/new/", sourceType: "manual" }],
      }),
    ).toThrow(/matched NO bound dealer/);
  });
});
