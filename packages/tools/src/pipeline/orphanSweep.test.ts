/**
 * L1 unit tests — the boot-time orphan claim sweep. Freezes the CONSERVATIVE
 * release rule: a `'bound'` claim is released back to `'closed_out'` ONLY when
 * its profile is NOT live AND its dormancy timestamp is older than the dormancy
 * window. Specifically:
 *   - X: bound, NOT live, watermark 30d old        → released (1 row → closed_out);
 *   - Y: bound, NOT live, NULL watermark, bound_at  → released via the bound_at
 *        fallback (engage-then-abort, no watermark ever written);
 *   - Z: bound, NOT live, bound_at 1d ago, NULL wm  → NOT released (recent);
 *   - W: bound, IN liveProfileIds, watermark 99d    → NOT released (live wins);
 *   - a non-bound (`candidate`) profile is untouched.
 *   - bound_at is parsed as UTC ('YYYY-MM-DD HH:MM:SS') — not local time.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. NEVER touches ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import { sweepOrphanedBoundClaims } from "./orphanSweep.js";
import { writeLastProgressAt } from "./progressWatermark.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-24T12:00:00.000Z");

let tmpDir: string;
let db: Db;

// ---------------------------------------------------------------------------
// Seed helpers (raw SQL — all NOT NULL columns satisfied)
// ---------------------------------------------------------------------------

function seedProfile(id: string): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, budget_max, status) VALUES (?,?,?,?,?,?,?)",
    )
    .run(id, 2026, "Honda", "Accord", null, null, "active");
}

function seedDealer(id: string): void {
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?, ?)").run(id, "Test Dealer");
}

/** Format an epoch-ms as the UTC CURRENT_TIMESTAMP shape 'YYYY-MM-DD HH:MM:SS'. */
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function seedProfileDealer(
  profileId: string,
  dealerId: string,
  status: string,
  boundAt?: string,
): void {
  if (boundAt === undefined) {
    db.$client
      .prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?,?,?)")
      .run(profileId, dealerId, status);
  } else {
    db.$client
      .prepare(
        "INSERT INTO profile_dealers (search_profile_id, dealer_id, status, bound_at) VALUES (?,?,?,?)",
      )
      .run(profileId, dealerId, status, boundAt);
  }
}

function readStatus(profileId: string, dealerId: string): string {
  const row = db.$client
    .prepare("SELECT status FROM profile_dealers WHERE search_profile_id = ? AND dealer_id = ?")
    .get(profileId, dealerId) as { status: string };
  return row.status;
}

function clearAll(): void {
  for (const t of ["profile_dealers", "dealers", "search_profiles", "pipeline_state"]) {
    db.$client.prepare(`DELETE FROM ${t}`).run();
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-orphansweep-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0003_salty_jocasta.sql"), "utf8"));
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
  clearAll();
});

// ===========================================================================
// The conservative release matrix
// ===========================================================================

describe("sweepOrphanedBoundClaims", () => {
  it("releases dormant, not-live bound claims and leaves live/recent/non-bound ones alone", () => {
    // X: bound, NOT live, watermark 30 days old → released.
    seedProfile("prof-X");
    seedDealer("dealer-X");
    seedProfileDealer("prof-X", "dealer-X", "bound", utcStamp(NOW - 1 * DAY_MS));
    writeLastProgressAt(db, "prof-X", new Date(NOW - 30 * DAY_MS).toISOString());

    // Y: bound, NOT live, NULL watermark, bound_at 30 days ago → released (fallback).
    seedProfile("prof-Y");
    seedDealer("dealer-Y");
    seedProfileDealer("prof-Y", "dealer-Y", "bound", utcStamp(NOW - 30 * DAY_MS));

    // Z: bound, NOT live, NULL watermark, bound_at 1 day ago → NOT released (recent).
    seedProfile("prof-Z");
    seedDealer("dealer-Z");
    seedProfileDealer("prof-Z", "dealer-Z", "bound", utcStamp(NOW - 1 * DAY_MS));

    // W: bound, IN liveProfileIds, watermark 99 days old → NOT released (live wins).
    seedProfile("prof-W");
    seedDealer("dealer-W");
    seedProfileDealer("prof-W", "dealer-W", "bound", utcStamp(NOW - 99 * DAY_MS));
    writeLastProgressAt(db, "prof-W", new Date(NOW - 99 * DAY_MS).toISOString());

    // C: a candidate (non-bound) profile → never a sweep target.
    seedProfile("prof-C");
    seedDealer("dealer-C");
    seedProfileDealer("prof-C", "dealer-C", "candidate");

    const result = sweepOrphanedBoundClaims({
      liveProfileIds: new Set(["prof-W"]),
      nowMs: NOW,
      db,
    });

    // Exactly X and Y released (one bound row each).
    expect([...result.releasedProfileIds].sort()).toEqual(["prof-X", "prof-Y"]);
    expect(result.releasedRows).toBe(2);

    // Verify the actual row states.
    expect(readStatus("prof-X", "dealer-X")).toBe("closed_out");
    expect(readStatus("prof-Y", "dealer-Y")).toBe("closed_out");
    expect(readStatus("prof-Z", "dealer-Z")).toBe("bound"); // recent, untouched
    expect(readStatus("prof-W", "dealer-W")).toBe("bound"); // live, untouched
    expect(readStatus("prof-C", "dealer-C")).toBe("candidate"); // non-bound, untouched
  });

  it("returns an empty result when nothing is bound", () => {
    seedProfile("prof-C");
    seedDealer("dealer-C");
    seedProfileDealer("prof-C", "dealer-C", "candidate");

    const result = sweepOrphanedBoundClaims({ liveProfileIds: [], nowMs: NOW, db });
    expect(result.releasedProfileIds).toEqual([]);
    expect(result.releasedRows).toBe(0);
  });

  it("parses bound_at as UTC (not local) so a barely-dormant claim is judged correctly", () => {
    // bound_at exactly dormancyDays+1h ago in UTC. If parsed as local time in a
    // negative-offset zone (e.g. America/Los_Angeles) the value would shift hours
    // and could flip the verdict — pin UTC parsing.
    const dormancyDays = 14;
    seedProfile("prof-U");
    seedDealer("dealer-U");
    seedProfileDealer(
      "prof-U",
      "dealer-U",
      "bound",
      utcStamp(NOW - (dormancyDays * DAY_MS + 60 * 60 * 1000)),
    );

    const result = sweepOrphanedBoundClaims({
      liveProfileIds: [],
      nowMs: NOW,
      dormancyDays,
      db,
    });
    expect(result.releasedProfileIds).toEqual(["prof-U"]);
    expect(readStatus("prof-U", "dealer-U")).toBe("closed_out");
  });

  it("respects a custom dormancyDays window", () => {
    seedProfile("prof-P");
    seedDealer("dealer-P");
    // 10 days dormant: released under a 7-day window, kept under a 30-day window.
    seedProfileDealer("prof-P", "dealer-P", "bound", utcStamp(NOW - 10 * DAY_MS));

    const kept = sweepOrphanedBoundClaims({
      liveProfileIds: [],
      nowMs: NOW,
      dormancyDays: 30,
      db,
    });
    expect(kept.releasedProfileIds).toEqual([]);
    expect(readStatus("prof-P", "dealer-P")).toBe("bound");

    const released = sweepOrphanedBoundClaims({
      liveProfileIds: [],
      nowMs: NOW,
      dormancyDays: 7,
      db,
    });
    expect(released.releasedProfileIds).toEqual(["prof-P"]);
    expect(readStatus("prof-P", "dealer-P")).toBe("closed_out");
  });
});
