/**
 * L1 unit tests — tools-layer profileService + resolver + fakePhone + adapter
 * (BACKEND_SERVICES §8/§9, B2). Freezes the persist discipline:
 *   - create writes EXACTLY 1 search_profiles row + 1 audit_log row
 *     (action='search_profile_intake', payload = full input).
 *   - double-fire idempotent (same input → same id, no re-write).
 *   - ActiveSlotConflict on a second active row for the same (account, brand).
 *   - 裁定⑨ NULL-coordinate persist is rejected (typed CoordinatesNotResolvedError).
 *   - resolver 1/0/2+ branches incl. inferred_newest LOGGING (W-C invariant).
 *   - fakePhone keeps the first 6, randomizes the last 4 (deterministic w/ rng).
 *   - assertNoBudget catches a budget figure in a draft string.
 *   - adapter round-trips all 33 columns.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * the committed migration SQL is applied to the throwaway DB. NEVER touches
 * ~/.autobroker-ts or ~/.autobroker.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "@autobroker/db";
import type { SearchProfileIntakeInput, SearchProfile } from "@autobroker/core";
import {
  create,
  replace,
  validate,
  update,
  parseLocation,
  synthProfileId,
  type ResolvedCoordinates,
} from "./profileService.js";
import { resolveActiveProfile } from "./resolver.js";
import { makeFakePhone, resolveStoredPhone } from "./fakePhone.js";
import { rowToProfile, profileToRow, type SearchProfileRow } from "./adapter.js";
import {
  ActiveSlotConflict,
  CoordinatesNotResolvedError,
  IdentityLockedError,
} from "./errors.js";
import { assertNoBudget, BudgetLeakError } from "../validators.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = join(here, "..", "..", "..", "db", "drizzle", "0000_military_red_skull.sql");

let tmpDir: string;
let db: Db;

/** A coordinate set the upstream workflow would have resolved (裁定⑨). */
const COORDS: ResolvedCoordinates = { latitude: 33.6695, longitude: -117.8231, resolvedAddress: "Irvine, CA 92614" };

/** A complete, form-valid intake input. */
function baseInput(overrides: Partial<SearchProfileIntakeInput> = {}): SearchProfileIntakeInput {
  return {
    make: "Toyota",
    model: "RAV4",
    year: 2025,
    location_query: "Irvine, CA 92614",
    follow_up_email: "buyer@example.com",
    financing_preference: "finance",
    trim: "XLE",
    search_radius_miles: null,
    budget_max: null,
    follow_up_phone: null,
    phone_policy: null,
    preferred_exterior_colors_json: null,
    preferred_interior_colors_json: null,
    acceptable_trims_json: null,
    feature_preferences_json: null,
    trade_in_description: null,
    military_first_responder: null,
    current_brand_owner: null,
    ...overrides,
  };
}

function seedAccount(id: string, email: string): void {
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run(id, email);
}

function seedDealer(id: string): void {
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?, ?)").run(id, "Test Dealer");
}

/** Insert a lead_submissions row referencing a profile (satisfying the dealer FK). */
function seedLead(submissionId: string, dealerId: string, profileId: string): void {
  seedDealer(dealerId);
  db.$client
    .prepare(
      "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, outcome) VALUES (?, ?, ?, 'pending')",
    )
    .run(submissionId, dealerId, profileId);
}

function countProfiles(): number {
  return (db.$client.prepare("SELECT COUNT(*) AS n FROM search_profiles").get() as { n: number }).n;
}
function countAudit(action: string): number {
  return (
    db.$client.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(action) as { n: number }
  ).n;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-profile-"));
  mkdirSync(tmpDir, { recursive: true });
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  db.$client.exec(
    "DELETE FROM audit_log; DELETE FROM lead_submissions; DELETE FROM search_profiles; DELETE FROM dealers; DELETE FROM accounts;",
  );
});

// ---------------------------------------------------------------------------
describe("create — exactly 1 row + 1 audit, persist discipline", () => {
  it("writes exactly 1 search_profiles row + 1 audit_log('search_profile_intake')", () => {
    const { profile, auditId } = create(db, baseInput(), { coordinates: COORDS, actor: "test" });
    expect(countProfiles()).toBe(1);
    expect(countAudit("search_profile_intake")).toBe(1);
    expect(auditId).not.toBe("");

    const row = db.$client
      .prepare("SELECT * FROM search_profiles WHERE search_profile_id = ?")
      .get(profile.id) as SearchProfileRow;
    expect(row.status).toBe("active");
    expect(row.brand).toBe("Toyota"); // brand = make
    expect(row.location).toBe("Irvine, CA 92614"); // location = location_query
    expect(row.search_radius_miles).toBe(25); // default
    expect(row.country).toBe("US");
    expect(row.military_first_responder).toBe(0);
    expect(row.current_brand_owner).toBe(0);
    expect(row.phone_policy).toBe("fake");
    expect(row.latitude).toBe(COORDS.latitude);
    expect(row.longitude).toBe(COORDS.longitude);
    // parsed location columns
    expect(row.city).toBe("Irvine");
    expect(row.state).toBe("CA");
    expect(row.postal_code).toBe("92614");

    const audit = db.$client
      .prepare("SELECT * FROM audit_log WHERE action = 'search_profile_intake'")
      .get() as { target_table: string; target_id: string; payload_json: string };
    expect(audit.target_table).toBe("search_profiles");
    expect(audit.target_id).toBe(profile.id);
    expect(JSON.parse(audit.payload_json).make).toBe("Toyota");
  });

  it("synth id = SHA-256 first-16-hex of make|model|trim|year|postal_code", () => {
    const { profile } = create(db, baseInput(), { coordinates: COORDS });
    expect(profile.id).toBe(
      synthProfileId({ make: "Toyota", model: "RAV4", trim: "XLE", year: 2025, postalCode: "92614" }),
    );
    expect(profile.id).toHaveLength(16);
  });

  it("geocoded postal threads into the synth id (FIX 4): same input, different postal → different id", () => {
    // Free-text location parses to a NULL postal locally; the geocoded postal on
    // coordinates is what differentiates the two ids.
    const input = baseInput({ location_query: "near the airport" });
    const withGeo = create(db, input, {
      coordinates: { ...COORDS, postalCode: "92614" },
    });
    db.$client.exec("DELETE FROM audit_log; DELETE FROM search_profiles;");
    const withoutGeo = create(db, input, { coordinates: COORDS });
    expect(withGeo.profile.id).not.toBe(withoutGeo.profile.id);
    // The geocoded id matches a synth over the geocoded postal.
    expect(withGeo.profile.id).toBe(
      synthProfileId({ make: "Toyota", model: "RAV4", trim: "XLE", year: 2025, postalCode: "92614" }),
    );
  });

  it("double-fire is idempotent: same input → same id, no second row/audit", () => {
    const first = create(db, baseInput(), { coordinates: COORDS });
    const second = create(db, baseInput(), { coordinates: COORDS });
    expect(second.profile.id).toBe(first.profile.id);
    expect(second.auditId).toBe(""); // no re-write
    expect(countProfiles()).toBe(1);
    expect(countAudit("search_profile_intake")).toBe(1);
  });

  it("裁定⑨: NULL coordinates are rejected with a typed error, zero write", () => {
    expect(() =>
      // @ts-expect-error — deliberately passing null lat to exercise the last wall.
      create(db, baseInput(), { coordinates: { latitude: null, longitude: null } }),
    ).toThrow(CoordinatesNotResolvedError);
    expect(countProfiles()).toBe(0);
    expect(countAudit("search_profile_intake")).toBe(0);
  });

  it("ActiveSlotConflict: second active for same (account, brand) is rejected", () => {
    seedAccount("acc-1", "owner@example.com"); // sole account → account_id resolves non-null
    create(db, baseInput({ model: "RAV4" }), { coordinates: COORDS });
    // Same make (brand=Toyota) + same sole account, different model → different id,
    // but the active (account, brand) slot is taken.
    expect(() =>
      create(db, baseInput({ model: "Camry" }), { coordinates: COORDS }),
    ).toThrow(ActiveSlotConflict);
    expect(countProfiles()).toBe(1);
  });

  it("rejects when the persist parity-minimum is unmet (empty make)", () => {
    // The .strict() form schema (.min(1)) rejects an empty make before the LC-1
    // floor; either way create must throw and write nothing.
    expect(() => create(db, baseInput({ make: "" }), { coordinates: COORDS })).toThrow();
    expect(countProfiles()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("update — typo window + identity lock (§9.4)", () => {
  it("allows an in-place identity edit while in the typo window (no lead yet)", () => {
    const { profile } = create(db, baseInput({ trim: "XLE" }), { coordinates: COORDS });
    const updated = update(db, { trim: "Limited" }, { profileId: profile.id });
    expect(updated.trim).toBe("Limited");
  });

  it("throws IdentityLockedError once a lead_submissions row references the profile", () => {
    const { profile } = create(db, baseInput(), { coordinates: COORDS });
    seedLead("sub-1", "dealer-1", profile.id);
    expect(() => update(db, { make: "Honda" }, { profileId: profile.id })).toThrow(
      IdentityLockedError,
    );
  });

  it("a non-identity edit is allowed even after a lead (only identity locks)", () => {
    const { profile } = create(db, baseInput(), { coordinates: COORDS });
    seedLead("sub-2", "dealer-1", profile.id);
    const updated = update(db, { followUpEmail: "new@example.com" }, { profileId: profile.id });
    expect(updated.followUpEmail).toBe("new@example.com");
  });
});

// ---------------------------------------------------------------------------
describe("replace — atomic supersede→create→link→audit (FIX 1)", () => {
  it("rolls back the supersede when create() throws mid-replace (no partial write)", () => {
    seedAccount("acc-1", "owner@example.com");
    const { profile: original } = create(db, baseInput({ make: "Toyota", model: "RAV4" }), {
      coordinates: COORDS,
    });
    expect(countProfiles()).toBe(1);

    // Force create() to throw INSIDE replace's transaction: NULL coords trip the
    // 裁定⑨ last-wall guard after the old row was set 'superseded'.
    expect(() =>
      replace(
        db,
        original.id,
        baseInput({ make: "Toyota", model: "Camry" }),
        // @ts-expect-error — deliberately passing null coords to make create throw.
        { reason: "typo", actor: "test", coordinates: { latitude: null, longitude: null } },
      ),
    ).toThrow(CoordinatesNotResolvedError);

    // The supersede rolled back: old profile stays active, zero new rows/audit.
    const oldRow = db.$client
      .prepare("SELECT * FROM search_profiles WHERE search_profile_id = ?")
      .get(original.id) as SearchProfileRow;
    expect(oldRow.status).toBe("active");
    expect(oldRow.superseded_by).toBeNull();
    expect(countProfiles()).toBe(1);
    expect(countAudit("profile_replace")).toBe(0);
    expect(countAudit("search_profile_intake")).toBe(1); // only the original create's audit
  });
});

// ---------------------------------------------------------------------------
describe("validate (LC-1, pure)", () => {
  it("passes year/make/model; reports each missing field", () => {
    expect(validate({ make: "Toyota", model: "RAV4", year: 2025 }).ok).toBe(true);
    const r = validate({ make: "", model: "RAV4", year: "nope" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith("make"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("year"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("resolveActiveProfile — three branches (§9)", () => {
  it("0 active → kind:'none'", () => {
    expect(resolveActiveProfile(db).kind).toBe("none");
  });

  it("1 active → kind:'inferred_newest' and LOGS (W-C never silently picks)", () => {
    create(db, baseInput(), { coordinates: COORDS });
    const trace = vi.fn();
    const result = resolveActiveProfile(db, {}, trace);
    expect(result.kind).toBe("inferred_newest");
    expect(trace).toHaveBeenCalledOnce();
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({ event: "inferred_newest_resolution" }),
    );
  });

  it("2+ active → kind:'ambiguous' with candidates, newest (ROWID DESC) first", () => {
    // Two active rows under NULL account (NULLs distinct in the partial index, so
    // both stay active — see api_findings).
    create(db, baseInput({ make: "Toyota", model: "RAV4" }), { coordinates: COORDS });
    create(db, baseInput({ make: "Honda", model: "CR-V" }), { coordinates: COORDS });
    const result = resolveActiveProfile(db);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      // newest insert (Honda) first under ROWID DESC.
      expect(result.candidates[0]!.make).toBe("Honda");
    }
  });

  it("pinned: a non-empty + active threadPin wins", () => {
    const { profile } = create(db, baseInput(), { coordinates: COORDS });
    const result = resolveActiveProfile(db, { threadPin: profile.id });
    expect(result.kind).toBe("pinned");
    if (result.kind === "pinned") expect(result.profile.id).toBe(profile.id);
  });

  it("a stale/unknown threadPin falls through to the count branch", () => {
    const result = resolveActiveProfile(db, { threadPin: "does-not-exist" });
    expect(result.kind).toBe("none");
  });
});

// ---------------------------------------------------------------------------
describe("fakePhone — keep first 6, randomize last 4", () => {
  it("keeps the leading 6 digits and replaces the last 4 (deterministic rng)", () => {
    const seq = [0.05, 0.15, 0.25, 0.35]; // → 0,1,2,3
    let i = 0;
    const rng = () => seq[i++ % seq.length]!;
    const out = makeFakePhone("(949) 555-8137", rng);
    expect(out).toHaveLength(10);
    expect(out.slice(0, 6)).toBe("949555"); // area + prefix preserved
    expect(out.slice(6)).toBe("0123"); // randomized last 4 from the seeded rng
  });

  it("strips a leading country code before keeping 6", () => {
    const rng = () => 0; // last4 → 0000
    expect(makeFakePhone("+1 949 555 8137", rng)).toBe("9495550000");
  });

  it("throws on fewer than 10 digits (fail-loud, no misleading pad)", () => {
    expect(() => makeFakePhone("555-1234")).toThrow();
  });

  it("resolveStoredPhone honors policy: fake masks, real passes through, null stays null", () => {
    const rng = () => 0;
    expect(resolveStoredPhone("9495558137", "fake", rng)).toBe("9495550000");
    expect(resolveStoredPhone("9495558137", "real", rng)).toBe("9495558137");
    expect(resolveStoredPhone(null, "fake", rng)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("assertNoBudget — budget red-line (§8.4, CLAUDE.md §9)", () => {
  it("throws BudgetLeakError when a draft frames a number as the budget cap", () => {
    expect(() =>
      assertNoBudget("Hi, my budget is around $35,000 out the door, can you do better?"),
    ).toThrow(BudgetLeakError);
  });

  it("throws on 'no more than 40000' ceiling language", () => {
    expect(() => assertNoBudget("I can pay no more than 40000 total.")).toThrow(BudgetLeakError);
  });

  // The probed misses (FIX 3) — each previously slipped past the scan.
  it.each([
    "I cannot spend more than 42000.",
    "I can't spend more than 42000.",
    "I won't spend more than 42000.",
    "my ceiling is $42,000",
    "keep it below 45000",
    "my limit is 39k",
    "anything below 45000 works",
    "I'd stay under $40k",
  ])("throws on probed-miss ceiling phrasing: %s", (text) => {
    expect(() => assertNoBudget(text)).toThrow(BudgetLeakError);
  });

  it("passes a clean quote-request that mentions no budget cap", () => {
    expect(
      assertNoBudget("Please send your best out-the-door price on a 2025 RAV4 XLE.").ok,
    ).toBe(true);
  });

  // Negative precision guard — plain best-price asks must NOT trip.
  it.each([
    "What is the out-the-door price on a 2025 RAV4?",
    "Can you quote me an OTD price for the Tucson Hybrid?",
    "Please share current availability and your best price.",
  ])("does not flag a plain best-price ask: %s", (text) => {
    expect(assertNoBudget(text).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("adapter — 33-column round-trip", () => {
  it("rowToProfile ∘ profileToRow is identity for a full row", () => {
    const { profile } = create(db, baseInput({ budget_max: 42000, follow_up_phone: "9495558137", phone_policy: "fake" }), {
      coordinates: COORDS,
    });
    const row = db.$client
      .prepare("SELECT * FROM search_profiles WHERE search_profile_id = ?")
      .get(profile.id) as SearchProfileRow;
    const back: SearchProfile = rowToProfile(row);
    const roundTripped = profileToRow(back);
    // every one of the 33 columns survives the round-trip
    expect(roundTripped).toEqual(row);
    // budget present internally; fake_phone masked (last 4 differ from real)
    expect(back.budgetMax).toBe(42000);
    expect(back.fakePhone).not.toBeNull();
    expect(back.fakePhone!.slice(0, 6)).toBe("949555");
    expect(back.followUpPhone).toBe("9495558137");
  });
});

// ---------------------------------------------------------------------------
describe("parseLocation (§8.3)", () => {
  it("parses 'City, ST ZIP'", () => {
    expect(parseLocation("Irvine, CA 92614")).toEqual({
      city: "Irvine", state: "CA", postalCode: "92614", country: "US",
    });
  });
  it("parses a bare ZIP", () => {
    expect(parseLocation("92614")).toEqual({ city: null, state: null, postalCode: "92614", country: "US" });
  });
  it("leaves city/state/zip null on free text", () => {
    expect(parseLocation("near the airport")).toEqual({
      city: null, state: null, postalCode: null, country: "US",
    });
  });
});
