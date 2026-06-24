/**
 * boot — unit coverage for the stale-run age policy (the pure decision; the
 * restart/cancel glue itself is exercised by the workflows-layer crash-resume
 * spike against a real mastra.db) PLUS the reboot reconcile + orphan-sweep
 * helper (sweepOrphansOnBoot) against a throwaway product DB.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openDb,
  closeDb,
  recordActivation,
  lookupProfileIdForRunId,
  claimDealer,
  type Db,
} from "@autobroker/tools";
import type { BootRecoveryReport } from "@autobroker/workflows";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { STALE_RESTART_MAX_AGE_MS, staleDisposition, sweepOrphansOnBoot } from "./boot.js";

describe("staleDisposition — restart young, cancel old/unknown", () => {
  const NOW = 1_750_000_000_000;

  it("a run updated moments ago restarts", () => {
    expect(staleDisposition(NOW - 5_000, NOW)).toBe("restart");
  });

  it("exactly at the age limit still restarts (inclusive boundary)", () => {
    expect(staleDisposition(NOW - STALE_RESTART_MAX_AGE_MS, NOW)).toBe("restart");
  });

  it("one ms past the limit cancels", () => {
    expect(staleDisposition(NOW - STALE_RESTART_MAX_AGE_MS - 1, NOW)).toBe("cancel");
  });

  it("unknown age cancels (never auto-re-execute work of unknown staleness)", () => {
    expect(staleDisposition(undefined, NOW)).toBe("cancel");
  });
});

// ===========================================================================
// sweepOrphansOnBoot — the simulated-reboot reconcile + orphan-sweep wiring.
// ISOLATION mirrors the tools-layer orphanSweep test: a fresh os.tmpdir() DB
// with the committed migrations applied; NEVER touches ~/.autobroker-ts.
// ===========================================================================

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");

const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;
let db: Db;

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

/** A BootRecoveryReport whose only live runs are the given runIds (all surfaced
 *  as 'suspended' — the runId is all sweepOrphansOnBoot reads). */
function recoveryWith(...runIds: string[]): BootRecoveryReport {
  return {
    suspended: runIds.map((runId) => ({ workflowId: "wf", runId })),
    stale: [],
    other: [],
  };
}

function clearAll(): void {
  for (const t of ["profile_dealers", "dealers", "search_profiles", "pipeline_state"]) {
    db.$client.prepare(`DELETE FROM ${t}`).run();
  }
}

describe("sweepOrphansOnBoot — reboot reconcile + orphan sweep", () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autobroker-boot-orphansweep-"));
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

  it("releases an orphaned (no live run, dormant) claim so another profile can claim the dealer", () => {
    // Profile A: bound to dealer-D 30 days ago, NO activation entry, NO live run.
    seedProfile("prof-A");
    seedDealer("dealer-D");
    seedProfileDealer("prof-A", "dealer-D", "bound", utcStamp(Date.now() - 30 * DAY_MS));

    // Profile B: a candidate row on the SAME dealer — cannot bind while A holds it.
    seedProfile("prof-B");
    seedProfileDealer("prof-B", "dealer-D", "candidate");

    // Simulated reboot with an EMPTY live set → A's orphaned claim is released.
    const sweep = sweepOrphansOnBoot(recoveryWith(), db);
    expect(sweep.releasedProfileIds).toEqual(["prof-A"]);
    expect(sweep.releasedRows).toBe(1);
    expect(readStatus("prof-A", "dealer-D")).toBe("closed_out");

    // The freed dealer is now claimable by B.
    expect(claimDealer({ searchProfileId: "prof-B", dealerId: "dealer-D", db })).toEqual({
      kind: "claimed",
    });
  });

  it("does NOT release a bound claim whose profile still has a live (suspended) run", () => {
    // Profile B: bound 30 days ago, WITH an activation entry whose runId is live.
    seedProfile("prof-B");
    seedDealer("dealer-E");
    seedProfileDealer("prof-B", "dealer-E", "bound", utcStamp(Date.now() - 30 * DAY_MS));
    recordActivation({ profileId: "prof-B", runId: "run-live-1", db });

    // Reboot with run-live-1 in the live set → the registry keeps prof-B, and the
    // sweep treats prof-B as live (never released).
    const sweep = sweepOrphansOnBoot(recoveryWith("run-live-1"), db);
    expect(sweep.releasedProfileIds).toEqual([]);
    expect(sweep.releasedRows).toBe(0);
    expect(readStatus("prof-B", "dealer-E")).toBe("bound");
  });

  it("the activation registry survives a reboot: live entries remain, dead ones are pruned", () => {
    seedProfile("prof-keep");
    seedProfile("prof-drop");
    recordActivation({ profileId: "prof-keep", runId: "run-keep", db });
    recordActivation({ profileId: "prof-drop", runId: "run-dead", db });

    // Reboot surfaces only run-keep as live → run-dead's entry is pruned.
    sweepOrphansOnBoot(recoveryWith("run-keep"), db);

    expect(lookupProfileIdForRunId("run-keep", db)).toBe("prof-keep");
    expect(lookupProfileIdForRunId("run-dead", db)).toBeNull();
  });
});
