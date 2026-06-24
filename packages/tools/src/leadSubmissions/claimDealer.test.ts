/**
 * L1 unit tests — the dealership-exclusivity claim/release tools. Freezes:
 *   - claimDealer flips a 'candidate' row → 'bound' (this profile holds it);
 *   - a SECOND profile claiming the SAME dealer_id hits the partial-unique
 *     index (uq_profile_dealers_bound_dealer) → 'conflict', with the holder's
 *     id + a human vehicle label; the loser's row becomes 'excluded_conflict'
 *     with exclusion_reason='engaged_by:<holder>'; the holder's row stays bound;
 *   - the holder re-claiming is idempotent → 'claimed' (no conflict);
 *   - releaseDealerClaims flips this profile's 'bound' rows → 'closed_out' and
 *     returns the count, after which another profile CAN claim the dealer;
 *   - heldByVehicle carries the vehicle label and NEVER any budget value (inv #9).
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

import { claimDealer, releaseDealerClaims } from "./claimDealer.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const DEALER = "dealer-1";

// ---------------------------------------------------------------------------
// Seed helpers (raw SQL — all NOT NULL columns satisfied)
// ---------------------------------------------------------------------------

function seedProfile(opts: {
  id: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string | null;
  budgetMax?: number | null;
}): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, budget_max, status) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      opts.id,
      opts.year ?? 2026,
      opts.make ?? "Honda",
      opts.model ?? "Accord",
      opts.trim ?? null,
      opts.budgetMax ?? null,
      "active",
    );
}

function seedDealer(id: string): void {
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?, ?)").run(id, "Test Dealer");
}

function seedProfileDealer(profileId: string, dealerId: string, status = "candidate"): void {
  db.$client
    .prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?,?,?)")
    .run(profileId, dealerId, status);
}

function readStatus(profileId: string, dealerId: string): { status: string; exclusion_reason: string | null } {
  return db.$client
    .prepare(
      "SELECT status, exclusion_reason FROM profile_dealers WHERE search_profile_id = ? AND dealer_id = ?",
    )
    .get(profileId, dealerId) as { status: string; exclusion_reason: string | null };
}

function clearAll(): void {
  for (const t of ["profile_dealers", "dealers", "search_profiles"]) {
    db.$client.prepare(`DELETE FROM ${t}`).run();
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-claim-"));
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
  seedDealer(DEALER);
});

// ===========================================================================
// claimDealer — claim a candidate
// ===========================================================================

describe("claimDealer: first claim", () => {
  it("flips a 'candidate' row → 'bound' and returns claimed", () => {
    seedProfile({ id: "prof-A" });
    seedProfileDealer("prof-A", DEALER, "candidate");

    const res = claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db });

    expect(res.kind).toBe("claimed");
    expect(readStatus("prof-A", DEALER).status).toBe("bound");
  });
});

// ===========================================================================
// claimDealer — conflict (a different profile already holds it)
// ===========================================================================

describe("claimDealer: conflict with a held dealer", () => {
  it("second profile gets conflict; loser → excluded_conflict; holder stays bound", () => {
    seedProfile({ id: "prof-A", make: "Honda", model: "Accord", trim: "EX-L", year: 2026 });
    seedProfile({ id: "prof-B", make: "Toyota", model: "Camry", trim: "XSE", year: 2025 });
    seedProfileDealer("prof-A", DEALER, "candidate");
    seedProfileDealer("prof-B", DEALER, "candidate");

    // A wins.
    expect(claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db }).kind).toBe("claimed");

    // B loses.
    const res = claimDealer({ searchProfileId: "prof-B", dealerId: DEALER, db });
    expect(res.kind).toBe("conflict");
    if (res.kind !== "conflict") throw new Error("expected conflict");
    expect(res.heldByProfileId).toBe("prof-A");
    expect(res.heldByVehicle).toContain("Honda");
    expect(res.heldByVehicle).toContain("Accord");

    // Loser row mutated to excluded_conflict with the engaged_by reason.
    const loser = readStatus("prof-B", DEALER);
    expect(loser.status).toBe("excluded_conflict");
    expect(loser.exclusion_reason).toBe("engaged_by:prof-A");

    // Holder row untouched.
    expect(readStatus("prof-A", DEALER).status).toBe("bound");
  });
});

// ===========================================================================
// claimDealer — idempotent re-claim by the holder
// ===========================================================================

describe("claimDealer: idempotent re-claim", () => {
  it("the holder re-claiming returns claimed (no conflict)", () => {
    seedProfile({ id: "prof-A" });
    seedProfileDealer("prof-A", DEALER, "candidate");

    expect(claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db }).kind).toBe("claimed");
    // Re-claim: row already 'bound' for this profile.
    expect(claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db }).kind).toBe("claimed");
    expect(readStatus("prof-A", DEALER).status).toBe("bound");
  });
});

// ===========================================================================
// claimDealer — RETRY a previously-excluded dealer once the holder released it
// ===========================================================================

describe("claimDealer: re-claim an excluded_conflict row after the holder releases", () => {
  it("a row that lost (excluded_conflict) becomes claimable once the holder closes out", () => {
    seedProfile({ id: "prof-A" });
    seedProfile({ id: "prof-B" });
    seedProfileDealer("prof-A", DEALER, "candidate");
    seedProfileDealer("prof-B", DEALER, "candidate");

    // A wins, B loses (B's row → excluded_conflict).
    expect(claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db }).kind).toBe("claimed");
    expect(claimDealer({ searchProfileId: "prof-B", dealerId: DEALER, db }).kind).toBe("conflict");
    expect(readStatus("prof-B", DEALER).status).toBe("excluded_conflict");

    // The holder releases the dealer.
    expect(releaseDealerClaims({ searchProfileId: "prof-A", db })).toBe(1);
    expect(readStatus("prof-A", DEALER).status).toBe("closed_out");

    // B retries: the dealer is now free, so the excluded_conflict row re-binds.
    const retry = claimDealer({ searchProfileId: "prof-B", dealerId: DEALER, db });
    expect(retry.kind).toBe("claimed");
    expect(readStatus("prof-B", DEALER).status).toBe("bound");
  });
});

describe("claimDealer: re-claim an excluded_conflict row while the holder STILL holds it", () => {
  it("returns conflict again (NOT claimed); the loser row stays excluded_conflict", () => {
    seedProfile({ id: "prof-A", make: "Honda", model: "Accord", trim: "EX-L", year: 2026 });
    seedProfile({ id: "prof-B" });
    seedProfileDealer("prof-A", DEALER, "candidate");
    seedProfileDealer("prof-B", DEALER, "candidate");

    expect(claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db }).kind).toBe("claimed");
    expect(claimDealer({ searchProfileId: "prof-B", dealerId: DEALER, db }).kind).toBe("conflict");
    expect(readStatus("prof-B", DEALER).status).toBe("excluded_conflict");

    // B retries while A still holds the dealer bound → conflict again, never claimed.
    const retry = claimDealer({ searchProfileId: "prof-B", dealerId: DEALER, db });
    expect(retry.kind).toBe("conflict");
    if (retry.kind !== "conflict") throw new Error("expected conflict");
    expect(retry.heldByProfileId).toBe("prof-A");
    expect(retry.heldByVehicle).toContain("Accord");
    // Row stays excluded_conflict; A still bound.
    expect(readStatus("prof-B", DEALER).status).toBe("excluded_conflict");
    expect(readStatus("prof-A", DEALER).status).toBe("bound");
  });
});

// ===========================================================================
// claimDealer — the fail-open guard: 0-rows-affected must NEVER be 'claimed'
// ===========================================================================

describe("claimDealer: a 'closed_out' row is NOT silently re-claimed", () => {
  it("returns unavailable (closed_out), never claimed; the row is untouched", () => {
    seedProfile({ id: "prof-A" });
    seedProfileDealer("prof-A", DEALER, "closed_out");

    const res = claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db });
    expect(res.kind).not.toBe("claimed");
    expect(res.kind).toBe("unavailable");
    if (res.kind !== "unavailable") throw new Error("expected unavailable");
    expect(res.reason).toBe("closed_out");
    // The row is left as-is — no false bind.
    expect(readStatus("prof-A", DEALER).status).toBe("closed_out");
  });

  it("a (profile,dealer) with NO profile_dealers row returns unavailable (no_row), never claimed", () => {
    seedProfile({ id: "prof-A" });
    // No seedProfileDealer — there is no row for (prof-A, DEALER).

    const res = claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db });
    expect(res.kind).not.toBe("claimed");
    expect(res.kind).toBe("unavailable");
    if (res.kind !== "unavailable") throw new Error("expected unavailable");
    expect(res.reason).toBe("no_row");
    // No row was created.
    expect(readStatus("prof-A", DEALER)).toBeUndefined();
  });

  it("a 'closed_out' row whose dealer is held by ANOTHER profile returns conflict, never claimed", () => {
    // Even when this profile's own row is closed_out, if the dealer is held by
    // someone else the safe answer is conflict (the dealer is not free).
    seedProfile({ id: "prof-A", make: "Honda", model: "Accord", trim: "EX-L", year: 2026 });
    seedProfile({ id: "prof-B" });
    seedProfileDealer("prof-A", DEALER, "candidate");
    seedProfileDealer("prof-B", DEALER, "closed_out");

    expect(claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db }).kind).toBe("claimed");

    const res = claimDealer({ searchProfileId: "prof-B", dealerId: DEALER, db });
    expect(res.kind).not.toBe("claimed");
    expect(res.kind).toBe("conflict");
    if (res.kind !== "conflict") throw new Error("expected conflict");
    expect(res.heldByProfileId).toBe("prof-A");
    // B's row is marked excluded_conflict to record the loss.
    expect(readStatus("prof-B", DEALER).status).toBe("excluded_conflict");
  });
});

// ===========================================================================
// releaseDealerClaims — bound → closed_out, frees the dealer
// ===========================================================================

describe("releaseDealerClaims", () => {
  it("flips this profile's bound rows → closed_out, returns the count, frees the dealer", () => {
    seedProfile({ id: "prof-A" });
    seedProfile({ id: "prof-B" });
    seedProfileDealer("prof-A", DEALER, "candidate");
    seedProfileDealer("prof-B", DEALER, "candidate");

    claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db });
    expect(readStatus("prof-A", DEALER).status).toBe("bound");

    const released = releaseDealerClaims({ searchProfileId: "prof-A", db });
    expect(released).toBe(1);
    expect(readStatus("prof-A", DEALER).status).toBe("closed_out");

    // The dealer is now claimable by B (no live 'bound' row blocks it).
    expect(claimDealer({ searchProfileId: "prof-B", dealerId: DEALER, db }).kind).toBe("claimed");
    expect(readStatus("prof-B", DEALER).status).toBe("bound");
  });

  it("returns 0 when this profile holds no bound rows", () => {
    seedProfile({ id: "prof-A" });
    seedProfileDealer("prof-A", DEALER, "candidate");
    expect(releaseDealerClaims({ searchProfileId: "prof-A", db })).toBe(0);
    // Candidate row left untouched.
    expect(readStatus("prof-A", DEALER).status).toBe("candidate");
  });
});

// ===========================================================================
// heldByVehicle never leaks budget (inv #9)
// ===========================================================================

describe("claimDealer: heldByVehicle redaction", () => {
  it("the conflict label carries the vehicle but NEVER any budget value", () => {
    seedProfile({ id: "prof-A", make: "Honda", model: "Accord", trim: "EX-L", year: 2026, budgetMax: 41234 });
    seedProfile({ id: "prof-B" });
    seedProfileDealer("prof-A", DEALER, "candidate");
    seedProfileDealer("prof-B", DEALER, "candidate");

    claimDealer({ searchProfileId: "prof-A", dealerId: DEALER, db });
    const res = claimDealer({ searchProfileId: "prof-B", dealerId: DEALER, db });

    expect(res.kind).toBe("conflict");
    if (res.kind !== "conflict") throw new Error("expected conflict");
    expect(res.heldByVehicle).toContain("Accord");
    // The budget figure must NOT appear anywhere in the human label.
    expect(res.heldByVehicle).not.toContain("41234");
    expect(res.heldByVehicle).not.toContain("41,234");
  });
});
