/**
 * In-stack tests — the search_profile_intake flat workflow.
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start/resume
 * suspend/resume chain (in-process against a tmp mastra.db) → REAL step closures,
 * with the three runtime collaborators (harness.generate, goplaces.resolveLocation,
 * profileService.create) injected through the test-only deps seam. The persist
 * step writes through the REAL profileService.create + REAL openDb against an
 * ISOLATED tmp autobroker.db (the committed migration applied). NO live LLM, no
 * network — the harness call is replaced by a deterministic stub, but EVERYTHING
 * else (the workflow engine, suspend/resume serialization, the DB write + audit
 * row, the Zod validate step) is genuinely exercised.
 *
 * Coverage:
 *   - slash happy path           → exactly 1 profile row + 1 audit row, success.
 *   - freeform path              → prefill seeds; PII/budget absent by schema.
 *   - decline at collect         → zero rows anywhere, terminal declined.
 *   - force-override             → audit 'intake_verification_forced' + created.
 *   - force-override decline     → zero profile rows.
 *   - ambiguous location         → suspend → pick(1) → created with picked coords.
 *   - geocode failure            → suspend (NOT null coords) → retry → created;
 *                                   and decline → zero rows.
 *   - flat-shape structural check (no nested workflow step).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db both live there; NEVER ~/.autobroker* . The Mastra
 * singleton is reset between cases. AUTOBROKER_TEST_AUTO_APPROVE is never set —
 * there is no auto-approve here; the suspend gate is exercised for real.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db, type GoplacesResult } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import {
  searchProfileIntakeWorkflow,
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
  __resetIntakeDepsForTests,
  __setIntakeDepsForTests,
  type IntakeWorkflowDeps,
} from "./searchProfileIntake.js";
import { IntakePrefillSchema } from "./intakeContracts.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = join(here, "..", "..", "db", "drizzle", "0000_military_red_skull.sql");

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-intake-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb(); // <tmpDir>/autobroker.db
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
  // Seed a sole accounts row so resolveSoleAccountId() returns a real account
  // (the active-slot uniqueness guard is only armed when account is non-null).
  db.$client
    .prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)")
    .run("acct-test-1", "acct@example.com");
});

afterEach(() => {
  __resetIntakeDepsForTests();
  db.$client.close();
  closeDb(); // release the shared getDb() handle the persist/audit steps cached.
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Read a step's suspend payload from a suspended WorkflowResult. The per-step
 * entry (`result.steps[stepId].suspendPayload`) is the unambiguous source — the
 * top-level `suspendPayload` is keyed by step id, so the per-step view is cleaner.
 */
function suspendPayloadOf(result: unknown, stepId: string): Record<string, unknown> {
  const steps = (result as { steps?: Record<string, { suspendPayload?: unknown }> }).steps;
  const payload = steps?.[stepId]?.suspendPayload;
  return (payload ?? {}) as Record<string, unknown>;
}

/** Count rows in a table. */
function rowCount(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

/** Count audit_log rows for a given action. */
function auditCount(action: string): number {
  const r = db.$client
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
    .get(action) as { n: number };
  return r.n;
}

/** A complete, valid submitted-form payload (the 7 required fields, incl. trim). */
function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    make: "Hyundai",
    model: "Tucson",
    year: 2026,
    location_query: "Irvine, CA 92602",
    follow_up_email: "buyer@example.com",
    financing_preference: "finance",
    trim: "SEL",
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
    ...over,
  };
}

const RESOLVED: GoplacesResult = {
  kind: "resolved",
  location: { lat: 33.6695, lng: -117.7669, formattedAddress: "Irvine, CA 92602, USA", postalCode: "92602" },
  traceSpans: [],
};

const NO_USAGE = {
  costUsd: null,
  durationMs: 0,
  pricingSource: "unavailable" as const,
  promptTokens: null,
  completionTokens: null,
};

/**
 * A harness.generate stub. Returns the trim-verify verdict for the trim_verify
 * useCase and a fixed prefill seed for the prefill useCase. Cast to the deps
 * type: the real signature is generic over the caller's Zod schema, so a stub
 * that branches on useCase must be typed loosely and asserted at the boundary.
 */
function harnessStub(verdict: { valid: boolean; attestation?: string; suggested_trims?: string[] }) {
  const fn = async (input: { useCase: string }) => {
    if (input.useCase === "intake_trim_verify") {
      return {
        object: {
          valid: verdict.valid,
          attestation: verdict.attestation ?? (verdict.valid ? "trim exists" : "trim not found"),
          suggested_trims: verdict.suggested_trims ?? [],
        },
        usage: NO_USAGE,
      };
    }
    // intake_freeform_prefill — a partial seed (PII/budget absent by schema).
    return {
      object: IntakePrefillSchema.parse({
        make: "Hyundai",
        model: "Tucson",
        year: 2026,
        trim: null,
        location_query: "Irvine, CA",
        search_radius_miles: null,
        financing_preference: "finance",
      }),
      usage: NO_USAGE,
    };
  };
  return fn as unknown as IntakeWorkflowDeps["harnessGenerate"];
}

/** A resolveLocation stub that returns a fixed sequence of results per call. */
function locationStub(sequence: GoplacesResult[]) {
  let i = 0;
  const fn: IntakeWorkflowDeps["resolveLocation"] = async () => {
    const r = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return r!;
  };
  return fn;
}

/** Default fetchTrimSources stub — {none} so the trimSuggestion step passes
 *  straight through to collect (NO real web, NO trim_suggestion suspend). The
 *  trim-suggestion describe overrides it with a resolved stub. */
const noneTrimSources: IntakeWorkflowDeps["fetchTrimSources"] = async () => ({ kind: "none" });

/** A fetchTrimSources stub that returns fixed grounding text (the trim-suggestion
 *  describe pairs it with a harnessGenerate stub that extracts the trim list). */
function trimSourcesStub(text: string): IntakeWorkflowDeps["fetchTrimSources"] {
  return async () => ({ kind: "resolved", text, sources: ["https://example.test/trims"] });
}

/** harnessGenerate stub for the trim-suggestion path: intake_trim_lookup → the
 *  given parallel arrays; intake_trim_verify → the given verdict (proves grounded
 *  pick SKIPS verify even when verify would say invalid). */
function trimLookupStub(args: {
  names: string[];
  summaries: string[];
  verifyValid?: boolean;
}): IntakeWorkflowDeps["harnessGenerate"] {
  const fn = async (input: { useCase: string }) => {
    if (input.useCase === "intake_trim_lookup") {
      return { object: { trim_names: args.names, trim_summaries: args.summaries }, usage: NO_USAGE };
    }
    if (input.useCase === "intake_trim_verify") {
      return {
        object: {
          valid: args.verifyValid ?? true,
          attestation: "from stub",
          suggested_trims: [],
        },
        usage: NO_USAGE,
      };
    }
    return {
      object: IntakePrefillSchema.parse({
        make: "Honda", model: "Civic", year: 2026, trim: null,
        location_query: "Irvine, CA", search_radius_miles: null, financing_preference: "finance",
      }),
      usage: NO_USAGE,
    };
  };
  return fn as unknown as IntakeWorkflowDeps["harnessGenerate"];
}

/** Wire deps with the real createProfile/openDb (writes the tmp DB). A {none}
 *  fetchTrimSources is the default (no real web) unless the case overrides it. */
function wireDeps(over: Partial<IntakeWorkflowDeps>): void {
  __setIntakeDepsForTests({ fetchTrimSources: noneTrimSources, ...over });
}

/** Build a fresh in-process Mastra instance with the intake workflow registered,
 *  return the registered Workflow handle. */
function intakeWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [SEARCH_PROFILE_INTAKE_WORKFLOW_ID]: searchProfileIntakeWorkflow as never },
  });
  return mastra.getWorkflow(SEARCH_PROFILE_INTAKE_WORKFLOW_ID);
}

// ---------------------------------------------------------------------------
// slash happy path
// ---------------------------------------------------------------------------

describe("search_profile_intake — slash happy path", () => {
  it("start → suspend at collect → submit → trimVerify ok → resolved → persist → created (1 row + 1 audit)", async () => {
    wireDeps({
      harnessGenerate: harnessStub({ valid: true }),
      resolveLocation: locationStub([RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-slash-1" });
    const started = await run.start({
      inputData: { input_mode: "slash", freeform_text: null, seed_fields: null },
    });

    // First suspend is the collect form.
    expect(started.status).toBe("suspended");

    const resumed = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields() },
    });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("created");

    expect(rowCount("search_profiles")).toBe(1);
    expect(auditCount("search_profile_intake")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// freeform path (prefill seeds; PII/budget absent by construction)
// ---------------------------------------------------------------------------

describe("search_profile_intake — freeform path", () => {
  it("prefill schema excludes PII/budget by construction", () => {
    const keys = Object.keys(IntakePrefillSchema.shape);
    expect(keys).not.toContain("follow_up_email");
    expect(keys).not.toContain("follow_up_phone");
    expect(keys).not.toContain("budget_max");
  });

  it("freeform → prefill runs and seeds → collect suspends → submit → created", async () => {
    wireDeps({
      harnessGenerate: harnessStub({ valid: true }),
      resolveLocation: locationStub([RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-freeform-1" });
    const started = await run.start({
      inputData: {
        input_mode: "freeform",
        freeform_text: "I want a 2026 Tucson in Irvine",
        seed_fields: null,
      },
    });

    // Prefill ran (no #1244), then collect suspends with the seeded form.
    expect(started.status).toBe("suspended");
    if (started.status !== "suspended") return;
    // The collect suspend payload carries the prefill seed.
    const payload = suspendPayloadOf(started, "collect");
    const seed = payload["seed_fields"] as Record<string, unknown>;
    expect(seed["make"]).toBe("Hyundai");
    expect(seed).not.toHaveProperty("follow_up_email");

    const resumed = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields() },
    });
    expect(resumed.status).toBe("success");
    expect(rowCount("search_profiles")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// decline at collect → zero rows, terminal declined
// ---------------------------------------------------------------------------

describe("search_profile_intake — decline at collect", () => {
  it("decline → terminal declined, ZERO rows in search_profiles AND audit_log", async () => {
    wireDeps({
      harnessGenerate: harnessStub({ valid: true }),
      resolveLocation: locationStub([RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-decline-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });

    const resumed = await run.resume({ step: "collect", resumeData: { action: "decline" } });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("declined");

    expect(rowCount("search_profiles")).toBe(0);
    expect(rowCount("audit_log")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// force-override
// ---------------------------------------------------------------------------

describe("search_profile_intake — force-override", () => {
  it("invalid trim → suspend at force gate → force_override(reason) → audit forced row + created", async () => {
    wireDeps({
      harnessGenerate: harnessStub({ valid: false, suggested_trims: ["SE", "Limited"] }),
      resolveLocation: locationStub([RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-force-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });

    // collect → submit
    const afterSubmit = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields({ trim: "Bogus" }) },
    });
    // Now suspended at the force-override gate.
    expect(afterSubmit.status).toBe("suspended");
    if (afterSubmit.status !== "suspended") return;
    const gate = suspendPayloadOf(afterSubmit, "forceOverrideGate");
    expect(gate["kind"]).toBe("force_override");

    const resumed = await run.resume({
      step: "forceOverrideGate",
      resumeData: { action: "force_override", reason: "I know this trim exists" },
    });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("created");

    expect(auditCount("intake_verification_forced")).toBe(1);
    expect(rowCount("search_profiles")).toBe(1);
  });

  it("force-override decline → zero profile rows", async () => {
    wireDeps({
      harnessGenerate: harnessStub({ valid: false }),
      resolveLocation: locationStub([RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-force-decline-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "Bogus" }) } });

    const resumed = await run.resume({ step: "forceOverrideGate", resumeData: { action: "decline" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("declined");
    expect(rowCount("search_profiles")).toBe(0);
    expect(auditCount("intake_verification_forced")).toBe(0);
  });

  // FIX A — a revise whose re-verify is STILL invalid must RE-SUSPEND the gate
  // (never proceed unaudited). The trim_verify stub here always returns invalid,
  // so the revise re-verify is invalid too.
  it("revise → still invalid → re-suspend → force_override(reason) → created WITH forced-audit row", async () => {
    wireDeps({
      harnessGenerate: harnessStub({ valid: false }),
      resolveLocation: locationStub([RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-revise-still-invalid-force-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "Bogus" }) } });

    // revise to another (still unverifiable) trim → re-verify still invalid →
    // the gate RE-SUSPENDS rather than proceeding.
    const afterRevise = await run.resume({
      step: "forceOverrideGate",
      resumeData: { action: "revise", trim: "AlsoBogus" },
    });
    expect(afterRevise.status).toBe("suspended");
    if (afterRevise.status !== "suspended") return;
    const gate = suspendPayloadOf(afterRevise, "forceOverrideGate");
    expect(gate["kind"]).toBe("force_override");
    expect(gate["trim"]).toBe("AlsoBogus"); // the NEW trim is on the fresh card.
    expect(rowCount("search_profiles")).toBe(0); // nothing persisted yet.

    // Now the user forces the revised trim → audited + created with the revised trim.
    const resumed = await run.resume({
      step: "forceOverrideGate",
      resumeData: { action: "force_override", reason: "I checked the dealer site" },
    });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("created");
    expect(auditCount("intake_verification_forced")).toBe(1);
    expect(rowCount("search_profiles")).toBe(1);
    // The persisted profile carries the REVISED trim (not the original "Bogus").
    const row = db.$client
      .prepare("SELECT trim FROM search_profiles LIMIT 1")
      .get() as { trim: string };
    expect(row.trim).toBe("AlsoBogus");
  });

  it("revise → still invalid → re-suspend → decline → zero profile rows", async () => {
    wireDeps({
      harnessGenerate: harnessStub({ valid: false }),
      resolveLocation: locationStub([RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-revise-still-invalid-decline-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "Bogus" }) } });

    const afterRevise = await run.resume({
      step: "forceOverrideGate",
      resumeData: { action: "revise", trim: "AlsoBogus" },
    });
    expect(afterRevise.status).toBe("suspended");
    if (afterRevise.status !== "suspended") return;
    expect(suspendPayloadOf(afterRevise, "forceOverrideGate")["kind"]).toBe("force_override");

    const resumed = await run.resume({ step: "forceOverrideGate", resumeData: { action: "decline" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("declined");
    expect(rowCount("search_profiles")).toBe(0);
    expect(auditCount("intake_verification_forced")).toBe(0);
  });

  it("revise → clear (trim:null) → re-suspends the gate (trim is required), never a null-trim profile, no crash", async () => {
    // Trim is required at the form, so the gate's clear/empty-revise can no longer
    // proceed to persist (which would fail-loud late). It must re-suspend instead.
    wireDeps({
      harnessGenerate: harnessStub({ valid: false }),
      resolveLocation: locationStub([RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-revise-clear-resuspend-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "Bogus" }) } });

    const afterClear = await run.resume({
      step: "forceOverrideGate",
      resumeData: { action: "revise", trim: null },
    });
    expect(afterClear.status).toBe("suspended"); // re-suspended, NOT proceeded/crashed.
    if (afterClear.status !== "suspended") return;
    expect(suspendPayloadOf(afterClear, "forceOverrideGate")["kind"]).toBe("force_override");
    expect(rowCount("search_profiles")).toBe(0); // nothing persisted.

    // The user can still decline out cleanly (fail-closed).
    const resumed = await run.resume({ step: "forceOverrideGate", resumeData: { action: "decline" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("declined");
    expect(rowCount("search_profiles")).toBe(0);
  });

  // FIX D — a confirmed force_override writes its forced-audit row immediately; a
  // LATER decline (at resolveLocation) terminates the run declined with ZERO
  // search_profiles writes but the forced-audit row REMAINS (intended).
  it("force_override(reason) → later decline at resolveLocation → declined, 0 profiles, 1 forced-audit row", async () => {
    const failed: GoplacesResult = {
      kind: "failed",
      reason: "no_result",
      detail: "ZERO_RESULTS",
      traceSpans: [],
    };
    wireDeps({
      harnessGenerate: harnessStub({ valid: false }),
      resolveLocation: locationStub([failed]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-force-then-decline-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "Bogus" }) } });

    // Force the unverified trim → forced-audit row written immediately.
    const afterForce = await run.resume({
      step: "forceOverrideGate",
      resumeData: { action: "force_override", reason: "I know it exists" },
    });
    // Now suspended at resolveLocation (the geocode failed).
    expect(afterForce.status).toBe("suspended");
    if (afterForce.status !== "suspended") return;
    expect(suspendPayloadOf(afterForce, "resolveLocation")["kind"]).toBe("ambiguous_location");
    expect(auditCount("intake_verification_forced")).toBe(1); // already written.

    // The user declines at the location gate → terminal declined, zero profiles.
    const resumed = await run.resume({ step: "resolveLocation", resumeData: { action: "decline" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("declined");
    expect(rowCount("search_profiles")).toBe(0); // decline writes zero search_profiles rows.
    expect(auditCount("intake_verification_forced")).toBe(1); // force always writes the forced-audit row.
  });
});

// ---------------------------------------------------------------------------
// ambiguous location
// ---------------------------------------------------------------------------

describe("search_profile_intake — ambiguous location", () => {
  it("ambiguous → suspend → pick(1) → created with the picked candidate's coords", async () => {
    const ambiguous: GoplacesResult = {
      kind: "ambiguous",
      candidates: [
        { lat: 1, lng: 1, formattedAddress: "Irvine, CA, USA", postalCode: "92602" },
        { lat: 2, lng: 2, formattedAddress: "Irvine, KY, USA", postalCode: "40336" },
      ],
      traceSpans: [],
    };
    wireDeps({
      harnessGenerate: harnessStub({ valid: true }),
      // ambiguous on the first resolve, ambiguous again on the pick-resume re-resolve.
      resolveLocation: locationStub([ambiguous, ambiguous]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-ambig-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    const afterSubmit = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields() },
    });

    expect(afterSubmit.status).toBe("suspended");
    if (afterSubmit.status !== "suspended") return;
    const payload = suspendPayloadOf(afterSubmit, "resolveLocation");
    expect(payload["kind"]).toBe("ambiguous_location");
    expect((payload["candidates"] as unknown[]).length).toBe(2);

    const resumed = await run.resume({
      step: "resolveLocation",
      resumeData: { action: "pick", picked_index: 1 },
    });
    expect(resumed.status).toBe("success");
    expect(rowCount("search_profiles")).toBe(1);
    // The picked candidate (index 1) coords landed.
    const row = db.$client
      .prepare("SELECT latitude, longitude FROM search_profiles LIMIT 1")
      .get() as { latitude: number; longitude: number };
    expect(row.latitude).toBe(2);
    expect(row.longitude).toBe(2);
  });

  // FIX B — a retry replaces the candidate list; a subsequent pick must index the
  // LATEST shown list (listB), not the original (listA). The two lists carry
  // DIFFERENT coords so the wrong-list bug would land listA[1] instead of listB[1].
  it("ambiguous(listA) → retry(better query) → ambiguous(listB, different coords) → pick(1) → coords === listB[1]", async () => {
    const listA: GoplacesResult = {
      kind: "ambiguous",
      candidates: [
        { lat: 10, lng: 10, formattedAddress: "Springfield, IL, USA", postalCode: "62701" },
        { lat: 11, lng: 11, formattedAddress: "Springfield, MO, USA", postalCode: "65801" },
      ],
      traceSpans: [],
    };
    const listB: GoplacesResult = {
      kind: "ambiguous",
      candidates: [
        { lat: 20, lng: 20, formattedAddress: "Portland, OR, USA", postalCode: "97201" },
        { lat: 21, lng: 21, formattedAddress: "Portland, ME, USA", postalCode: "04101" },
      ],
      traceSpans: [],
    };
    wireDeps({
      harnessGenerate: harnessStub({ valid: true }),
      // First resolve → listA; the retry's re-resolve → listB. No further resolves
      // (pick indexes the stored list directly — FIX B).
      resolveLocation: locationStub([listA, listB]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-retry-newlist-pick-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    const afterSubmit = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields() },
    });

    // Suspended showing listA.
    expect(afterSubmit.status).toBe("suspended");
    if (afterSubmit.status !== "suspended") return;
    const payloadA = suspendPayloadOf(afterSubmit, "resolveLocation");
    expect((payloadA["candidates"] as Array<{ label: string }>)[0]!.label).toBe("Springfield, IL, USA");

    // retry with a corrected query → re-resolve → listB REPLACES the stored list.
    const afterRetry = await run.resume({
      step: "resolveLocation",
      resumeData: { action: "retry", retry_query: "Portland" },
    });
    expect(afterRetry.status).toBe("suspended");
    if (afterRetry.status !== "suspended") return;
    const payloadB = suspendPayloadOf(afterRetry, "resolveLocation");
    expect((payloadB["candidates"] as Array<{ label: string }>)[0]!.label).toBe("Portland, OR, USA");

    // pick(1) → must land listB[1] (Portland, ME: 21,21), NOT listA[1] (11,11).
    const resumed = await run.resume({
      step: "resolveLocation",
      resumeData: { action: "pick", picked_index: 1 },
    });
    expect(resumed.status).toBe("success");
    expect(rowCount("search_profiles")).toBe(1);
    const row = db.$client
      .prepare("SELECT latitude, longitude FROM search_profiles LIMIT 1")
      .get() as { latitude: number; longitude: number };
    expect(row.latitude).toBe(21);
    expect(row.longitude).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// coordinate-resolution invariant: geocode failure
// ---------------------------------------------------------------------------

describe("search_profile_intake — geocode failure (never null coords)", () => {
  it("failed(no_result) → suspend (NOT proceeded) → retry → resolved → created", async () => {
    const failed: GoplacesResult = {
      kind: "failed",
      reason: "no_result",
      detail: "ZERO_RESULTS",
      traceSpans: [],
    };
    wireDeps({
      harnessGenerate: harnessStub({ valid: true }),
      resolveLocation: locationStub([failed, RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-fail-retry-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    const afterSubmit = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields() },
    });

    // Failed geocode SUSPENDED (did not proceed, did not persist null coords).
    expect(afterSubmit.status).toBe("suspended");
    if (afterSubmit.status !== "suspended") return;
    const payload = suspendPayloadOf(afterSubmit, "resolveLocation");
    expect(payload["kind"]).toBe("ambiguous_location");
    expect(payload["failure_reason"]).toBe("no_result");
    expect(rowCount("search_profiles")).toBe(0); // nothing persisted yet.

    const resumed = await run.resume({
      step: "resolveLocation",
      resumeData: { action: "retry", retry_query: "Irvine, CA 92602" },
    });
    expect(resumed.status).toBe("success");
    expect(rowCount("search_profiles")).toBe(1);
  });

  it("failed → suspend → decline → ZERO rows", async () => {
    const failed: GoplacesResult = {
      kind: "failed",
      reason: "network_exhausted",
      detail: "retries exhausted",
      traceSpans: [],
    };
    wireDeps({
      harnessGenerate: harnessStub({ valid: true }),
      resolveLocation: locationStub([failed]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-fail-decline-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields() } });

    const resumed = await run.resume({ step: "resolveLocation", resumeData: { action: "decline" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("declined");
    expect(rowCount("search_profiles")).toBe(0);
    expect(rowCount("audit_log")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #1244 fail-closed → suspend
// ---------------------------------------------------------------------------

describe("search_profile_intake — #1244 malformed_tool_call → suspend", () => {
  it("trimVerify malformed → suspend → retry_step → re-verify ok → created", async () => {
    // First trim_verify call fail-closed-suspends (HarnessSuspend, hitlAvailable
    // true); the retry_step re-runs trimVerify and the second call returns a
    // verdict. The harness itself returns the suspend (suspend not thrown);
    // the workflow maps it to a malformed_tool_call Mastra suspend.
    let calls = 0;
    const harnessGenerate = (async (input: { useCase: string }) => {
      if (input.useCase === "intake_trim_verify") {
        calls += 1;
        if (calls === 1) {
          return { suspended: true, reason: "malformed_tool_call", signals: ["empty_tool_calls"] };
        }
        return {
          object: { valid: true, attestation: "ok", suggested_trims: [] },
          usage: NO_USAGE,
        };
      }
      throw new Error("unexpected useCase");
    }) as unknown as IntakeWorkflowDeps["harnessGenerate"];

    wireDeps({ harnessGenerate, resolveLocation: locationStub([RESOLVED]) });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-1244-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    const afterSubmit = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields() },
    });

    // Suspended at trimVerify with a malformed_tool_call payload (NOT thrown).
    expect(afterSubmit.status).toBe("suspended");
    if (afterSubmit.status !== "suspended") return;
    const payload = suspendPayloadOf(afterSubmit, "trimVerify");
    expect(payload["kind"]).toBe("malformed_tool_call");
    expect(rowCount("search_profiles")).toBe(0);

    const resumed = await run.resume({ step: "trimVerify", resumeData: { action: "retry_step" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("created");
    expect(rowCount("search_profiles")).toBe(1);
  });

  it("trimVerify malformed → suspend → decline → zero rows", async () => {
    const harnessGenerate = (async (input: { useCase: string }) => {
      if (input.useCase === "intake_trim_verify") {
        return { suspended: true, reason: "malformed_tool_call", signals: ["empty_tool_calls"] };
      }
      throw new Error("unexpected useCase");
    }) as unknown as IntakeWorkflowDeps["harnessGenerate"];

    wireDeps({ harnessGenerate, resolveLocation: locationStub([RESOLVED]) });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-1244-decline-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields() } });

    const resumed = await run.resume({ step: "trimVerify", resumeData: { action: "decline" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("declined");
    expect(rowCount("search_profiles")).toBe(0);
    expect(rowCount("audit_log")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// trim suggestion (web-grounded pre-collect picker)
// ---------------------------------------------------------------------------

const TRIM_TEXT = "SOURCE: 2026 Honda Civic trims: LX, Sport, Sport Touring.";

describe("search_profile_intake — trim suggestion", () => {
  it("freeform without a trim → suspends a trim_suggestion picker with the web-extracted trims", async () => {
    wireDeps({
      harnessGenerate: trimLookupStub({ names: ["LX", "Sport", "Sport Touring"], summaries: ["base", "sporty", "loaded"] }),
      fetchTrimSources: trimSourcesStub(TRIM_TEXT),
      resolveLocation: locationStub([RESOLVED]),
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-1" });
    const started = await run.start({
      inputData: { input_mode: "freeform", freeform_text: "i want a 2026 honda civic in Irvine", seed_fields: null },
    });
    expect(started.status).toBe("suspended");
    const payload = suspendPayloadOf(started, "trimSuggestion");
    expect(payload["kind"]).toBe("trim_suggestion");
    expect((payload["candidates"] as unknown[]).length).toBe(3);
  });

  it("pick → the chosen trim seeds the form AND trimVerify is SKIPPED (grounded), even when verify would say invalid → created", async () => {
    wireDeps({
      // verifyValid:false would normally force the force_override gate — but a
      // grounded pick must SKIP trimVerify entirely.
      harnessGenerate: trimLookupStub({ names: ["LX", "Sport"], summaries: ["base", "sporty"], verifyValid: false }),
      fetchTrimSources: trimSourcesStub(TRIM_TEXT),
      resolveLocation: locationStub([RESOLVED]),
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-2" });
    await run.start({ inputData: { input_mode: "freeform", freeform_text: "2026 honda civic Irvine", seed_fields: null } });
    const afterPick = await run.resume({ step: "trimSuggestion", resumeData: { action: "pick", picked_index: 1 } });
    expect(afterPick.status).toBe("suspended"); // now the collect form
    const collect = suspendPayloadOf(afterPick, "collect");
    expect(collect["kind"]).toBe("data_collection");
    expect((collect["seed_fields"] as Record<string, unknown>)["trim"]).toBe("Sport");

    const created = await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "Sport" }) } });
    expect(created.status).toBe("success");
    if (created.status !== "success") return;
    expect(created.result.outcome).toBe("created"); // NOT a force_override suspend → grounded skipped verify
    expect(rowCount("search_profiles")).toBe(1);
  });

  it("skip → proceeds to the form with the trim still blank (manual entry)", async () => {
    wireDeps({
      harnessGenerate: trimLookupStub({ names: ["LX", "Sport"], summaries: ["base", "sporty"] }),
      fetchTrimSources: trimSourcesStub(TRIM_TEXT),
      resolveLocation: locationStub([RESOLVED]),
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-3" });
    await run.start({ inputData: { input_mode: "freeform", freeform_text: "2026 honda civic Irvine", seed_fields: null } });
    const afterSkip = await run.resume({ step: "trimSuggestion", resumeData: { action: "skip" } });
    expect(afterSkip.status).toBe("suspended");
    const collect = suspendPayloadOf(afterSkip, "collect");
    expect(collect["kind"]).toBe("data_collection");
    const seed = (collect["seed_fields"] as Record<string, unknown>) ?? {};
    expect(seed["trim"] ?? null).toBeNull(); // skip seeded NO trim
  });

  it("decline → terminal declined, ZERO write", async () => {
    wireDeps({
      harnessGenerate: trimLookupStub({ names: ["LX"], summaries: ["base"] }),
      fetchTrimSources: trimSourcesStub(TRIM_TEXT),
      resolveLocation: locationStub([RESOLVED]),
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-4" });
    await run.start({ inputData: { input_mode: "freeform", freeform_text: "2026 honda civic Irvine", seed_fields: null } });
    const declined = await run.resume({ step: "trimSuggestion", resumeData: { action: "decline" } });
    expect(declined.status).toBe("success");
    if (declined.status !== "success") return;
    expect(declined.result.outcome).toBe("declined");
    expect(rowCount("search_profiles")).toBe(0);
  });

  it("retry → re-runs the lookup and re-suspends the picker", async () => {
    wireDeps({
      harnessGenerate: trimLookupStub({ names: ["LX", "Sport"], summaries: ["base", "sporty"] }),
      fetchTrimSources: trimSourcesStub(TRIM_TEXT),
      resolveLocation: locationStub([RESOLVED]),
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-5" });
    await run.start({ inputData: { input_mode: "freeform", freeform_text: "2026 honda civic Irvine", seed_fields: null } });
    const afterRetry = await run.resume({ step: "trimSuggestion", resumeData: { action: "retry", refine_query: "hatchback" } });
    expect(afterRetry.status).toBe("suspended");
    expect(suspendPayloadOf(afterRetry, "trimSuggestion")["kind"]).toBe("trim_suggestion");
  });

  it("fetchTrimSources {none} → NO trim_suggestion suspend, straight to the collect form (existing freeform behavior preserved)", async () => {
    wireDeps({
      harnessGenerate: harnessStub({ valid: true }),
      resolveLocation: locationStub([RESOLVED]),
      // fetchTrimSources defaults to {none}
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-6" });
    const started = await run.start({ inputData: { input_mode: "freeform", freeform_text: "2026 honda civic Irvine", seed_fields: null } });
    expect(started.status).toBe("suspended");
    // The FIRST suspend is the collect form, not the trim picker.
    expect(suspendPayloadOf(started, "collect")["kind"]).toBe("data_collection");
  });

  it("0 trims extracted → graceful pass-through to the collect form", async () => {
    wireDeps({
      harnessGenerate: trimLookupStub({ names: [], summaries: [] }),
      fetchTrimSources: trimSourcesStub(TRIM_TEXT),
      resolveLocation: locationStub([RESOLVED]),
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-7" });
    const started = await run.start({ inputData: { input_mode: "freeform", freeform_text: "2026 honda civic Irvine", seed_fields: null } });
    expect(started.status).toBe("suspended");
    expect(suspendPayloadOf(started, "collect")["kind"]).toBe("data_collection");
  });

  it("freeform WITH a trim already extracted → the picker does NOT fire (only fires when trim is missing)", async () => {
    const prefillWithTrim = (async (input: { useCase: string }) => {
      if (input.useCase === "intake_trim_lookup") {
        return { object: { trim_names: ["LX"], trim_summaries: ["base"] }, usage: NO_USAGE };
      }
      if (input.useCase === "intake_trim_verify") {
        return { object: { valid: true, attestation: "ok", suggested_trims: [] }, usage: NO_USAGE };
      }
      return {
        object: IntakePrefillSchema.parse({
          make: "Honda", model: "Civic", year: 2026, trim: "Sport",
          location_query: "Irvine, CA", search_radius_miles: null, financing_preference: "finance",
        }),
        usage: NO_USAGE,
      };
    }) as unknown as IntakeWorkflowDeps["harnessGenerate"];
    wireDeps({ harnessGenerate: prefillWithTrim, fetchTrimSources: trimSourcesStub(TRIM_TEXT), resolveLocation: locationStub([RESOLVED]) });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-present" });
    const started = await run.start({ inputData: { input_mode: "freeform", freeform_text: "2026 honda civic Sport Irvine", seed_fields: null } });
    expect(started.status).toBe("suspended");
    // The trim was extracted → straight to the form, no picker.
    expect(suspendPayloadOf(started, "collect")["kind"]).toBe("data_collection");
  });

  it("slash launch → the trim picker NEVER fires (freeform-only guard)", async () => {
    wireDeps({
      harnessGenerate: trimLookupStub({ names: ["LX"], summaries: ["base"] }),
      fetchTrimSources: trimSourcesStub(TRIM_TEXT),
      resolveLocation: locationStub([RESOLVED]),
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-8" });
    const started = await run.start({
      inputData: { input_mode: "slash", freeform_text: null, seed_fields: { make: "Honda", model: "Civic", year: 2026 } },
    });
    expect(started.status).toBe("suspended");
    expect(suspendPayloadOf(started, "collect")["kind"]).toBe("data_collection");
  });

  it("#1244 on the lookup extraction → graceful pass-through (non-authoritative helper never blocks intake)", async () => {
    const malformedLookup = (async (input: { useCase: string }) => {
      if (input.useCase === "intake_trim_lookup") {
        return { suspended: true, reason: "malformed_tool_call", signals: ["finish_reason_not_tool_calls"] };
      }
      return {
        object: IntakePrefillSchema.parse({
          make: "Honda", model: "Civic", year: 2026, trim: null,
          location_query: "Irvine, CA", search_radius_miles: null, financing_preference: "finance",
        }),
        usage: NO_USAGE,
      };
    }) as unknown as IntakeWorkflowDeps["harnessGenerate"];
    wireDeps({
      harnessGenerate: malformedLookup,
      fetchTrimSources: trimSourcesStub(TRIM_TEXT),
      resolveLocation: locationStub([RESOLVED]),
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-9" });
    const started = await run.start({ inputData: { input_mode: "freeform", freeform_text: "2026 honda civic Irvine", seed_fields: null } });
    expect(started.status).toBe("suspended");
    // Degrades to the form (NOT a malformed_tool_call gate) — the suggestion is optional.
    expect(suspendPayloadOf(started, "collect")["kind"]).toBe("data_collection");
  });
});

// ---------------------------------------------------------------------------
// flat-shape structural assertion (no nested workflow step)
// ---------------------------------------------------------------------------

describe("search_profile_intake — flat shape (design convention)", () => {
  it("the workflow registers exactly the 9 named steps, none of them a nested workflow", () => {
    const wf = intakeWorkflow();
    const stepIds = Object.keys(wf.steps);
    expect(stepIds.sort()).toEqual(
      [
        "collect",
        "confirm",
        "forceOverrideGate",
        "persist",
        "prefill",
        "resolveLocation",
        "trimSuggestion",
        "trimVerify",
        "validate",
      ].sort(),
    );
    // No registered step is itself a Workflow (flat: no nested workflow).
    for (const id of stepIds) {
      const step = wf.steps[id] as { component?: string };
      expect(step.component).not.toBe("WORKFLOW");
    }
  });
});
