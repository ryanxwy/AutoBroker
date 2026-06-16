/**
 * skills/intake.test.ts — the PURE intake-soak assertion lib over a REAL isolated
 * tmp DB (mirrors harness/soak/verdict.test.ts: mkdtemp + openDb + exec the 3
 * drizzle migrations). NO live LLM, NO server boot, NO Playwright — only the pure
 * assertion functions + the read-only column reads that feed them.
 *
 * Covered:
 *  - never_guess_email / never_guess_phone / never_guess_budget over a captured
 *    prefill seed (ABSENT/null = clean; a non-null sensitive key = the red-line).
 *  - never_guess_budget's persisted-column half over a real created row.
 *  - fake_phone_default over a real created row (phone left blank → 'fake').
 *  - prefill_never_persists (Δ0 pre-confirm) + decline_zero_write (Δ0 + declined)
 *    over snapshotCounts deltas.
 *  - single_new_profile (exactly one profile + one intake audit row).
 *  - ask_0_stop_intake / ask_1_run / ask_2_stop_pick branch shapes.
 *  - readProfileColumns / countActiveProfiles read-only column channel over the DB.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import { snapshotCounts } from "../../dbReads.js";
import {
  assertAsk0StopIntake,
  assertAsk1Run,
  assertAsk2StopPick,
  assertDeclineZeroWrite,
  assertFakePhoneDefault,
  assertNeverGuessBudget,
  assertNeverGuessEmail,
  assertNeverGuessPhone,
  assertPrefillNeverPersists,
  assertSingleNewProfile,
  countActiveProfiles,
  readProfileColumns,
} from "./intake.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-soak-intake-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert a search_profiles row with explicit column values (the column-value
 *  read fixtures). Mirrors the schema's NOT NULL set (year/make/model). */
function insertProfile(
  id: string,
  cols: Partial<{
    budget_max: number | null;
    follow_up_email: string | null;
    follow_up_phone: string | null;
    phone_policy: string | null;
    fake_phone: string | null;
    status: string | null;
  }> = {},
): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, budget_max, follow_up_email, follow_up_phone, phone_policy, fake_phone, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      cols.budget_max ?? null,
      cols.follow_up_email ?? null,
      cols.follow_up_phone ?? null,
      cols.phone_policy ?? null,
      cols.fake_phone ?? null,
      cols.status === undefined ? "active" : cols.status,
    );
}

// ===========================================================================
// never_guess_email / phone / budget (seed half)
// ===========================================================================

describe("assertNeverGuessEmail (seed must not carry follow_up_email)", () => {
  it("clean when the seed has no follow_up_email key", () => {
    const r = assertNeverGuessEmail({ make: "Kia", model: "Sportage", location_query: "Irvine 92614" });
    expect(r.assertionId).toBe("intake_never_guess_email");
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("blocker");
  });
  it("clean when the key is present but null", () => {
    expect(assertNeverGuessEmail({ follow_up_email: null }).ok).toBe(true);
  });
  it("clean on a null seed (slash launch / prefill skipped)", () => {
    expect(assertNeverGuessEmail(null).ok).toBe(true);
  });
  it("FAILS (blocker) when the seed carried an email despite it being in the prose", () => {
    const r = assertNeverGuessEmail({ make: "Kia", follow_up_email: "buyer@x.com" });
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("blocker");
    expect(r.detail).toMatch(/never-guess/);
  });
});

describe("assertNeverGuessPhone (seed must not carry follow_up_phone)", () => {
  it("clean when absent", () => {
    expect(assertNeverGuessPhone({ make: "Kia" }).ok).toBe(true);
  });
  it("FAILS (blocker) when the seed carried a phone", () => {
    const r = assertNeverGuessPhone({ follow_up_phone: "949-555-0199" });
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("blocker");
  });
});

describe("assertNeverGuessBudget (seed half + persisted-column half)", () => {
  it("clean when neither the seed nor the persisted column carries a budget", () => {
    const r = assertNeverGuessBudget({ seed: { make: "Subaru" }, persistedBudgetMax: null });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("blocker");
  });
  it("FAILS (blocker) when the seed carried a budget_max", () => {
    const r = assertNeverGuessBudget({ seed: { budget_max: 38000 }, persistedBudgetMax: null });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/seeded a budget/);
  });
  it("FAILS (blocker) when the persisted column is non-null and the human did NOT type it", () => {
    const r = assertNeverGuessBudget({ seed: { make: "Subaru" }, persistedBudgetMax: 38000 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/persisted budget_max non-null/);
  });
  it("clean when the persisted column is non-null because the HUMAN typed it at the form", () => {
    const r = assertNeverGuessBudget({ seed: { make: "Subaru" }, persistedBudgetMax: 38000, humanTypedBudget: true });
    expect(r.ok).toBe(true);
  });
});

// ===========================================================================
// fake_phone_default + the column-value read channel (real DB rows)
// ===========================================================================

describe("readProfileColumns + assertFakePhoneDefault (real created rows)", () => {
  it("reads the sensitivity columns of a created row", () => {
    insertProfile("p-fake", { phone_policy: "fake", fake_phone: "(949) ***-0142" });
    const cols = readProfileColumns(db, "p-fake");
    expect(cols).not.toBeNull();
    expect(cols!.phonePolicy).toBe("fake");
    expect(cols!.fakePhone).toBe("(949) ***-0142");
    expect(cols!.followUpEmail).toBeNull();
  });
  it("returns null for a non-existent (declined / never-created) profile", () => {
    expect(readProfileColumns(db, "p-nope")).toBeNull();
  });
  it("clean when phone left blank → phone_policy='fake' + fake_phone non-null", () => {
    const cols = readProfileColumns(db, "p-fake");
    const r = assertFakePhoneDefault(cols);
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("FAILS when no created profile row exists (vacuous-pass guard)", () => {
    expect(assertFakePhoneDefault(null).ok).toBe(false);
  });
  it("FAILS when phone_policy is not 'fake'", () => {
    insertProfile("p-real-phone", { phone_policy: "real", fake_phone: null });
    const r = assertFakePhoneDefault(readProfileColumns(db, "p-real-phone"));
    expect(r.ok).toBe(false);
  });
});

describe("readProfileColumns reads a persisted budget_max for the never-guess column half", () => {
  it("budget_max NULL on a normal created row", () => {
    insertProfile("p-nobudget");
    const cols = readProfileColumns(db, "p-nobudget");
    const r = assertNeverGuessBudget({ seed: { make: "Hyundai" }, persistedBudgetMax: cols!.budgetMax });
    expect(r.ok).toBe(true);
  });
});

// ===========================================================================
// prefill_never_persists + decline_zero_write (snapshotCounts deltas)
// ===========================================================================

describe("assertPrefillNeverPersists (Δ0 pre-confirm)", () => {
  it("clean when search_profiles + audit_log are unchanged while suspended", () => {
    const before = snapshotCounts(null, db);
    const whileSuspended = snapshotCounts(null, db);
    const r = assertPrefillNeverPersists({ before, whileSuspended });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("blocker");
  });
  it("FAILS (blocker) when search_profiles grew before the human confirmed", () => {
    const before = snapshotCounts(null, db);
    const after = snapshotCounts(null, db);
    const grown = { ...after, global: { ...after.global, search_profiles: (after.global["search_profiles"] ?? 0) + 1 } };
    const r = assertPrefillNeverPersists({ before, whileSuspended: grown });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/persisted BEFORE/);
  });
});

describe("assertDeclineZeroWrite (declined + Δ0)", () => {
  it("clean when terminal 'declined' and the scoped deltas are zero", () => {
    const before = snapshotCounts(null, db);
    const after = snapshotCounts(null, db);
    const r = assertDeclineZeroWrite({ terminalStatus: "declined", before, after });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("blocker");
  });
  it("FAILS when the run did not terminate 'declined'", () => {
    const before = snapshotCounts(null, db);
    const after = snapshotCounts(null, db);
    expect(assertDeclineZeroWrite({ terminalStatus: "done", before, after }).ok).toBe(false);
  });
  it("FAILS when a row landed on the declined gate", () => {
    const before = snapshotCounts(null, db);
    const after = snapshotCounts(null, db);
    const grown = { ...after, global: { ...after.global, audit_log: (after.global["audit_log"] ?? 0) + 1 } };
    expect(assertDeclineZeroWrite({ terminalStatus: "declined", before, after: grown }).ok).toBe(false);
  });
});

// ===========================================================================
// single_new_profile
// ===========================================================================

describe("assertSingleNewProfile (exactly one profile + one intake audit row)", () => {
  it("clean when exactly one profile + one intake audit row landed", () => {
    const before = snapshotCounts(null, db);
    const after = { ...before, global: { ...before.global, search_profiles: (before.global["search_profiles"] ?? 0) + 1 } };
    const r = assertSingleNewProfile({ before, after, intakeAuditDelta: 1 });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("FAILS on a duplicate (two profile rows from a double-typed freeform)", () => {
    const before = snapshotCounts(null, db);
    const after = { ...before, global: { ...before.global, search_profiles: (before.global["search_profiles"] ?? 0) + 2 } };
    expect(assertSingleNewProfile({ before, after, intakeAuditDelta: 2 }).ok).toBe(false);
  });
  it("FAILS when the intake audit row is missing", () => {
    const before = snapshotCounts(null, db);
    const after = { ...before, global: { ...before.global, search_profiles: (before.global["search_profiles"] ?? 0) + 1 } };
    expect(assertSingleNewProfile({ before, after, intakeAuditDelta: 0 }).ok).toBe(false);
  });
});

// ===========================================================================
// the ASK 0/1/2 branch shapes + countActiveProfiles over the real DB
// ===========================================================================

describe("countActiveProfiles (resolver SELECT_ACTIVE parity)", () => {
  it("counts active (and v1-implicit-active NULL) rows, excludes closed/superseded", () => {
    const fresh = openDb(join(tmpDir, "active.db"));
    fresh.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
    fresh.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
    fresh.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
    const ins = (id: string, status: string | null) =>
      fresh.$client
        .prepare("INSERT INTO search_profiles (search_profile_id, year, make, model, status) VALUES (?, 2026, 'Honda', 'CR-V', ?)")
        .run(id, status);
    expect(countActiveProfiles(fresh)).toBe(0);
    ins("a1", "active");
    ins("a2", null); // v1-implicit-active
    ins("a3", "closed"); // excluded
    ins("a4", "superseded"); // excluded
    expect(countActiveProfiles(fresh)).toBe(2);
    fresh.$client.close();
  });
});

describe("ASK 0/1/2 branch assertions", () => {
  it("ask_0_stop_intake clean: 0 active → STOP intake CTA, no proceed", () => {
    const r = assertAsk0StopIntake({ activeProfileCount: 0, runProceeded: false, stopIntakeCtaShown: true });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("ask_0_stop_intake FAILS if the run proceeded with no active profile", () => {
    expect(assertAsk0StopIntake({ activeProfileCount: 0, runProceeded: true, stopIntakeCtaShown: false }).ok).toBe(false);
  });
  it("ask_1_run clean: 1 active → inferred_newest run + the resolution trace fired", () => {
    const r = assertAsk1Run({ activeProfileCount: 1, runProceeded: true, inferredNewestTraceFired: true });
    expect(r.ok).toBe(true);
  });
  it("ask_1_run FAILS if the inferred_newest trace never fired (silent pick)", () => {
    expect(assertAsk1Run({ activeProfileCount: 1, runProceeded: true, inferredNewestTraceFired: false }).ok).toBe(false);
  });
  it("ask_2_stop_pick clean: 2+ active → STOP picker listing both, no unpinned proceed", () => {
    const r = assertAsk2StopPick({ activeProfileCount: 2, runProceeded: false, pickerShown: true, pickerOptionCount: 2 });
    expect(r.ok).toBe(true);
  });
  it("ask_2_stop_pick FAILS if it auto-pinned and proceeded unpinned", () => {
    expect(
      assertAsk2StopPick({ activeProfileCount: 2, runProceeded: true, pickerShown: false, pickerOptionCount: 0 }).ok,
    ).toBe(false);
  });
});
