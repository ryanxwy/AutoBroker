/**
 * L1 unit tests — the ProfileId → live runId activation registry. Freezes:
 *   - recordActivation(A, run1) registers the row; lookupRunIdForProfile(A)=run1,
 *     lookupProfileIdForRunId(run1)=A, listActiveProfileIds()=[A];
 *   - a second connection cannot overwrite A's owner; the same runId is an
 *     idempotent re-claim;
 *   - clearActivationByRunId(run2) removes the row (lookup gone); an unknown or
 *     losing run clears 0 with no throw and never clobbers the owner;
 *   - reconcileActivations(live) prunes every entry whose runId is not live (the
 *     reboot-survival reconcile) and keeps the live ones;
 *   - NONE of the registry SQL ever touches a `pipeline.last_progress_at.*`
 *     watermark row (a seeded watermark survives reconcile + clear).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. NEVER touches ~/.autobroker-ts
 * or ~/.autobroker.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import {
  ActivationClaimConflictError,
  activeRunKey,
  clearActivationByRunId,
  listActiveProfileIds,
  lookupProfileIdForRunId,
  lookupRunIdForProfile,
  recordActivation,
  reconcileActivations,
  tryClaimActivation,
} from "./activationRegistry.js";
import { lastProgressKey, readLastProgressAt, writeLastProgressAt } from "./progressWatermark.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

function clearPipelineState(): void {
  db.$client.prepare("DELETE FROM pipeline_state").run();
}

function countRowsForKey(key: string): number {
  const row = db.$client
    .prepare("SELECT COUNT(*) AS n FROM pipeline_state WHERE key = ?")
    .get(key) as { n: number };
  return row.n;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-activation-"));
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
  clearPipelineState();
});

// ===========================================================================
// activeRunKey — the keyspace contract
// ===========================================================================

describe("activeRunKey", () => {
  it("namespaces under pipeline.active_run.<profileId>", () => {
    expect(activeRunKey("prof-A")).toBe("pipeline.active_run.prof-A");
  });
});

// ===========================================================================
// recordActivation + lookups
// ===========================================================================

describe("recordActivation: first registration", () => {
  it("registers a profile→runId entry resolvable both directions", () => {
    recordActivation({ profileId: "prof-A", runId: "run1", db });

    expect(lookupRunIdForProfile("prof-A", db)).toBe("run1");
    expect(lookupProfileIdForRunId("run1", db)).toBe("prof-A");
    expect(listActiveProfileIds(db)).toEqual(["prof-A"]);
  });
});

describe("activation claim: one durable owner across connections", () => {
  it("a second activation for the same profile fails without overwriting the first", () => {
    recordActivation({ profileId: "prof-A", runId: "run1", db });
    expect(() =>
      recordActivation({ profileId: "prof-A", runId: "run2", db }),
    ).toThrow(ActivationClaimConflictError);

    expect(lookupRunIdForProfile("prof-A", db)).toBe("run1");
    expect(lookupProfileIdForRunId("run1", db)).toBe("prof-A");
    expect(lookupProfileIdForRunId("run2", db)).toBeNull();
    expect(countRowsForKey(activeRunKey("prof-A"))).toBe(1);
    expect(listActiveProfileIds(db)).toEqual(["prof-A"]);
  });

  it("the same runId re-claims idempotently without inserting a second row", () => {
    expect(tryClaimActivation({ profileId: "prof-A", runId: "run1", db })).toEqual({
      acquired: true,
      inserted: true,
      liveRunId: "run1",
    });
    expect(tryClaimActivation({ profileId: "prof-A", runId: "run1", db })).toEqual({
      acquired: true,
      inserted: false,
      liveRunId: "run1",
    });
    expect(countRowsForKey(activeRunKey("prof-A"))).toBe(1);
  });

  it("two private SQLite connections racing the same profile produce one winner", () => {
    const second = openDb(join(tmpDir, "autobroker.db"));
    try {
      const firstClaim = tryClaimActivation({ profileId: "prof-A", runId: "run1", db });
      const secondClaim = tryClaimActivation({ profileId: "prof-A", runId: "run2", db: second });
      expect(firstClaim.acquired).toBe(true);
      expect(secondClaim).toEqual({ acquired: false, inserted: false, liveRunId: "run1" });
      expect(lookupRunIdForProfile("prof-A", second)).toBe("run1");
    } finally {
      second.$client.close();
    }
  });
});

describe("lookups: misses", () => {
  it("return null for an unregistered profile / runId", () => {
    expect(lookupRunIdForProfile("nobody", db)).toBeNull();
    expect(lookupProfileIdForRunId("nobody", db)).toBeNull();
    expect(listActiveProfileIds(db)).toEqual([]);
  });
});

// ===========================================================================
// clearActivationByRunId
// ===========================================================================

describe("clearActivationByRunId", () => {
  it("removes the entry whose value is the runId and returns 1", () => {
    recordActivation({ profileId: "prof-A", runId: "run2", db });

    expect(clearActivationByRunId({ runId: "run2", db })).toBe(1);
    expect(lookupRunIdForProfile("prof-A", db)).toBeNull();
    expect(lookupProfileIdForRunId("run2", db)).toBeNull();
    expect(listActiveProfileIds(db)).toEqual([]);
  });

  it("an unknown runId clears 0 and does not throw", () => {
    recordActivation({ profileId: "prof-A", runId: "run2", db });
    expect(clearActivationByRunId({ runId: "ghost", db })).toBe(0);
    // The real entry is left intact.
    expect(lookupRunIdForProfile("prof-A", db)).toBe("run2");
  });

  it("clearing a losing runId clears 0 (never clobbers the durable owner)", () => {
    recordActivation({ profileId: "prof-A", runId: "run2", db });
    expect(clearActivationByRunId({ runId: "run1", db })).toBe(0);
    expect(lookupRunIdForProfile("prof-A", db)).toBe("run2");
    expect(lookupProfileIdForRunId("run2", db)).toBe("prof-A");
  });
});

// ===========================================================================
// reconcileActivations — reboot-survival reconcile
// ===========================================================================

describe("reconcileActivations", () => {
  it("prunes entries whose runId is not in the live set, keeps the live ones", () => {
    recordActivation({ profileId: "prof-A", runId: "run2", db });
    recordActivation({ profileId: "prof-B", runId: "run3", db });

    // Only run3 is live after a (simulated) reboot.
    const pruned = reconcileActivations(new Set(["run3"]), db);

    expect(pruned).toBe(1);
    expect(lookupRunIdForProfile("prof-A", db)).toBeNull(); // run2 pruned
    expect(lookupRunIdForProfile("prof-B", db)).toBe("run3"); // run3 survives
    expect(listActiveProfileIds(db)).toEqual(["prof-B"]);
  });

  it("accepts an array live set too and prunes everything when the live set is empty", () => {
    recordActivation({ profileId: "prof-A", runId: "run1", db });
    recordActivation({ profileId: "prof-B", runId: "run2", db });

    expect(reconcileActivations([], db)).toBe(2);
    expect(listActiveProfileIds(db)).toEqual([]);
  });
});

// ===========================================================================
// keyspace isolation — the watermark keyspace is NEVER touched
// ===========================================================================

describe("registry SQL is scoped to the active_run keyspace", () => {
  it("never deletes/overwrites a pipeline.last_progress_at.* watermark row", () => {
    // Seed a watermark for the SAME profile that owns an activation entry.
    writeLastProgressAt(db, "prof-A", "2026-06-01T00:00:00.000Z");
    recordActivation({ profileId: "prof-A", runId: "run2", db });
    recordActivation({ profileId: "prof-B", runId: "run3", db });

    // Reconcile prunes run2 but must leave the watermark alone.
    reconcileActivations(new Set(["run3"]), db);
    expect(readLastProgressAt(db, "prof-A")).toBe("2026-06-01T00:00:00.000Z");
    expect(countRowsForKey(lastProgressKey("prof-A"))).toBe(1);

    // Clearing the surviving run must also leave the watermark untouched.
    clearActivationByRunId({ runId: "run3", db });
    expect(readLastProgressAt(db, "prof-A")).toBe("2026-06-01T00:00:00.000Z");

    // A watermark value must never be mistaken for an activation entry.
    expect(lookupProfileIdForRunId("2026-06-01T00:00:00.000Z", db)).toBeNull();
    expect(listActiveProfileIds(db)).toEqual([]);
  });
});
