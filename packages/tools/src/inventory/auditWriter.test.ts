/**
 * L1 unit tests — the inventory price-change read surface. Pins the `since` filter
 * (ISO compare), the signed dropUsd (positive = dropped, negative = rose), the
 * payload (dealer/vin) round-trip, profile-scoping, and the newest-first order.
 *
 * ISOLATION: fresh os.tmpdir() AUTOBROKER_DATA_DIR; committed migrations.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../db.js";
import { emitInventoryPriceChange, readInventoryChangesSince } from "./auditWriter.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = ["0000_military_red_skull.sql", "0001_redundant_ozymandias.sql", "0002_pale_thunderball.sql"].map(
  (f) => join(here, "..", "..", "..", "db", "drizzle", f),
);
const PROFILE = "prof-1";
let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-invaudit-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env["AUTOBROKER_DB"];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
});

describe("readInventoryChangesSince", () => {
  it("filters by `since`, signs dropUsd, round-trips dealer/vin, scopes by profile, newest-first", () => {
    emitInventoryPriceChange({ db, listingId: "L1", searchProfileId: PROFILE, dealerId: "D1", vin: "V1", oldPrice: 35000, newPrice: 33500, at: "2026-06-26T10:00:00.000Z" });
    emitInventoryPriceChange({ db, listingId: "L2", searchProfileId: PROFILE, dealerId: "D2", vin: null, oldPrice: 40000, newPrice: 41000, at: "2026-06-26T11:00:00.000Z" }); // a RISE
    emitInventoryPriceChange({ db, listingId: "L3", searchProfileId: PROFILE, dealerId: "D3", vin: "V3", oldPrice: 30000, newPrice: 29000, at: "2026-06-25T09:00:00.000Z" }); // BEFORE since
    emitInventoryPriceChange({ db, listingId: "LX", searchProfileId: "other-profile", dealerId: "DX", vin: null, oldPrice: 1, newPrice: 2, at: "2026-06-26T12:00:00.000Z" }); // other profile

    const changes = readInventoryChangesSince(db, PROFILE, "2026-06-26T00:00:00.000Z");
    // L2 (11:00) then L1 (10:00); L3 is before `since`, LX is another profile.
    expect(changes.map((c) => c.listingId)).toEqual(["L2", "L1"]);

    const drop = changes.find((c) => c.listingId === "L1")!;
    expect(drop.oldPrice).toBe(35000);
    expect(drop.newPrice).toBe(33500);
    expect(drop.dropUsd).toBe(1500); // positive = DROPPED
    expect(drop.dealerId).toBe("D1");
    expect(drop.vin).toBe("V1");

    const rise = changes.find((c) => c.listingId === "L2")!;
    expect(rise.dropUsd).toBe(-1000); // negative = rose
    expect(rise.vin).toBeNull();
  });
});
