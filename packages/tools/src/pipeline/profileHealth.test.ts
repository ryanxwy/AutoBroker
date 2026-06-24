/**
 * L1 unit tests — the active/hot/warm/cold projection (Phase-3 portfolio dot).
 * Freezes the thin contract the portfolio board reads:
 *   - only status∈{active,NULL} profiles are projected (closed are excluded);
 *   - a profile with a live/suspended run id (passed in) is HOT;
 *   - a profile with NO dealers and NO routed threads is COLD;
 *   - a profile with dealers or threads (but no live run) is WARM;
 *   - newest-first (rowid DESC), mirroring generateDigest.
 *
 * INTEGRATION: the full impl (PROMPT-phase0-remainder) enriches HOT/COLD with
 * detectPipelineState flags, thread gate/cap, pin recency, and the durable
 * `pipeline.last_progress_at.<id>` dormancy clock — this thin version proves the
 * shape + the three buckets the UI renders.
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

import { profileHealth } from "./profileHealth.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

function seedProfile(id: string, status: string | null = "active"): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, status) VALUES (?,?,?,?,?,?)",
    )
    .run(id, 2026, "Honda", "Accord", null, status);
}

function seedDealer(id: string): void {
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?, ?)").run(id, "Test Dealer");
}

function seedProfileDealer(profileId: string, dealerId: string): void {
  db.$client
    .prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?,?,?)")
    .run(profileId, dealerId, "candidate");
}

function seedThreadRouting(profileId: string, threadId: string): void {
  db.$client
    .prepare("INSERT INTO thread_routing (thread_id, search_profile_id) VALUES (?, ?)")
    .run(threadId, profileId);
}

function clearAll(): void {
  for (const t of ["thread_routing", "profile_dealers", "dealers", "search_profiles"]) {
    db.$client.prepare(`DELETE FROM ${t}`).run();
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-health-"));
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

describe("profileHealth: scope", () => {
  it("projects only active (status='active' or NULL) profiles, newest-first", () => {
    seedProfile("p-old", "active");
    seedProfile("p-null", null);
    seedProfile("p-closed", "closed");

    const rows = profileHealth(db, []);
    expect(rows.map((r) => r.profileId)).toEqual(["p-null", "p-old"]);
  });
});

describe("profileHealth: buckets", () => {
  it("HOT when the profile has a live/suspended run", () => {
    seedProfile("p-live");
    const rows = profileHealth(db, ["p-live"]);
    expect(rows[0]?.health).toBe("hot");
    expect(rows[0]?.reasons).toContain("live_run");
  });

  it("COLD when no dealers and no routed threads and no live run", () => {
    seedProfile("p-cold");
    const rows = profileHealth(db, []);
    expect(rows[0]?.health).toBe("cold");
    expect(rows[0]?.reasons).toContain("no_activity");
  });

  it("WARM when it has dealers or threads but no live run", () => {
    seedProfile("p-warm");
    seedDealer("d-1");
    seedProfileDealer("p-warm", "d-1");
    const rows = profileHealth(db, []);
    expect(rows[0]?.health).toBe("warm");
  });

  it("a live run beats activity: HOT even with dealers", () => {
    seedProfile("p-both");
    seedDealer("d-2");
    seedProfileDealer("p-both", "d-2");
    seedThreadRouting("p-both", "t-1");
    const rows = profileHealth(db, ["p-both"]);
    expect(rows[0]?.health).toBe("hot");
  });
});
