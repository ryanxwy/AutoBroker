/**
 * L1 unit tests — the live digest view (the GET /api/digest projection).
 * Freezes: the empty/_NO_ACTIVE_SEARCHES flag, the populated projection shape
 * (quotes with otd + freshness + a single highlighted best row), the headline
 * passthrough, generatedAt ISO, and that no budget number is shaped in.
 *
 * Isolated under an os.tmpdir() throwaway dir + the committed migration SQL.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import { assertNoBudget } from "../validators.js";
import { buildDigestView } from "./digestView.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");
const NOW = 1_750_000_000_000;

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-digestview-"));
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
  for (const t of ["dealer_quotes", "dealers", "search_profiles"]) {
    db.$client.prepare(`DELETE FROM ${t}`).run();
  }
});

function addProfile(id: string): void {
  db.$client
    .prepare("INSERT INTO search_profiles (search_profile_id, year, make, model, status) VALUES (?,?,?,?,?)")
    .run(id, 2026, "Hyundai", "Tucson", "active");
}
function addDealer(id: string, name: string): void {
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?,?)").run(id, name);
}
function addQuote(quoteId: string, profileId: string, dealerId: string, otd: number | null): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, otd_total, financing_mode) VALUES (?,?,?,?,?,?,?)",
    )
    .run(quoteId, dealerId, `m-${quoteId}`, `g-${quoteId}`, profileId, otd, "cash");
}

describe("buildDigestView", () => {
  it("empty world → empty:true + _NO_ACTIVE_SEARCHES", () => {
    const view = buildDigestView(db, { nowMs: NOW });
    expect(view.empty).toBe(true);
    expect(view.state).toBe("_NO_ACTIVE_SEARCHES");
    expect(view.profiles).toHaveLength(0);
    expect(view.generatedAt).toBe(new Date(NOW).toISOString());
    expect(() => assertNoBudget(view.headline)).not.toThrow();
  });

  it("populated world → quote rows with otd + freshness + a single best row", () => {
    addProfile("p1");
    addDealer("d1", "Alpha");
    addDealer("d2", "Beta");
    addQuote("hi", "p1", "d1", 41000);
    addQuote("lo", "p1", "d2", 38000);
    const view = buildDigestView(db, { nowMs: NOW });
    expect(view.empty).toBe(false);
    expect(view.profiles).toHaveLength(1);
    const p = view.profiles[0]!;
    expect(p.quotes.map((q) => q.otdTotal)).toEqual([38000, 41000]); // OTD-ascending
    expect(p.bestOtd).toBe(38000);
    expect(p.quotes.filter((q) => q.isBest)).toHaveLength(1);
    expect(p.quotes[0]!.isBest).toBe(true);
    expect(p.quotes[0]!.freshness).toBe("missing"); // no source listing
    expect(view.overallBestOtd).toBe(38000);
    expect(() => assertNoBudget(view.headline)).not.toThrow();
  });

  it("profileId pins exactly one search", () => {
    addProfile("p1");
    addProfile("p2");
    const view = buildDigestView(db, { profileId: "p2", nowMs: NOW });
    expect(view.profiles.map((p) => p.searchProfileId)).toEqual(["p2"]);
  });
});
