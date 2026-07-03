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
 *   - slash happy path           → confirm → exactly 1 profile + 1 audit, success.
 *   - freeform path              → prefill seeds; PII/budget absent by schema.
 *   - decline at collect         → zero rows anywhere, terminal declined.
 *   - confirmVehicle             → unconditional suspend on all four launch/resume
 *                                   paths; accept → created; decline → zero rows;
 *                                   edit → re-collect → re-confirm → persists new trim;
 *                                   the card carries year/make/model/trim and NO
 *                                   budget/email/phone (inv #9).
 *   - ambiguous location         → suspend → pick(1) → confirm → created.
 *   - geocode failure            → suspend (NOT null coords) → retry → confirm;
 *                                   and decline → zero rows.
 *   - prefill fail-closed         → a fail-closed prefill generation errors the run.
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

import { EmitResultNotCalledError } from "./harness.js";
import { createMastraInstance } from "./mastra.js";
import {
  searchProfileIntakeWorkflow,
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
  __resetIntakeDepsForTests,
  __setIntakeDepsForTests,
  type IntakeWorkflowDeps,
} from "./searchProfileIntake.js";
import { IntakePrefillSchema, sanitizePrefillTrim } from "./intakeContracts.js";

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
 * A harness.generate stub. Intake's only remaining LLM useCases are
 * intake_freeform_prefill (returns a fixed seed) and intake_trim_lookup (the
 * trim-suggestion describe overrides this). Cast to the deps type: the real
 * signature is generic over the caller's Zod schema, so a stub that branches on
 * useCase must be typed loosely and asserted at the boundary.
 */
function harnessStub() {
  const fn = async (_input: { useCase: string }) => {
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
 *  given parallel arrays; intake_freeform_prefill → a fixed Civic seed (trim null
 *  so the picker fires). */
function trimLookupStub(args: {
  names: string[];
  summaries: string[];
}): IntakeWorkflowDeps["harnessGenerate"] {
  const fn = async (input: { useCase: string }) => {
    if (input.useCase === "intake_trim_lookup") {
      return { object: { trim_names: args.names, trim_summaries: args.summaries }, usage: NO_USAGE };
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

/** Resume the confirmVehicle suspend with accept (the common happy-path tail). */
async function acceptConfirm(run: { resume: (a: { step: string; resumeData: unknown }) => Promise<{ status: string; result?: { outcome: string } }> }) {
  return run.resume({ step: "confirmVehicle", resumeData: { action: "accept" } });
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
  it("start → suspend at collect → submit → resolved → confirm → persist → created (1 row + 1 audit)", async () => {
    wireDeps({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-slash-1" });
    const started = await run.start({
      inputData: { input_mode: "slash", freeform_text: null, seed_fields: null },
    });

    // First suspend is the collect form.
    expect(started.status).toBe("suspended");

    // submit → resolveLocation resolves → the buyer-confirmation card suspends.
    const afterSubmit = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields() },
    });
    expect(afterSubmit.status).toBe("suspended");
    if (afterSubmit.status !== "suspended") return;
    const card = suspendPayloadOf(afterSubmit, "confirmVehicle");
    expect(card["kind"]).toBe("intake_confirm");
    expect(rowCount("search_profiles")).toBe(0); // nothing persisted before accept.

    const resumed = await acceptConfirm(run);
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result?.outcome).toBe("created");

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
      harnessGenerate: harnessStub(),
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

    // Prefill ran cleanly, then collect suspends with the seeded form.
    expect(started.status).toBe("suspended");
    if (started.status !== "suspended") return;
    // The collect suspend payload carries the prefill seed.
    const payload = suspendPayloadOf(started, "collect");
    const seed = payload["seed_fields"] as Record<string, unknown>;
    expect(seed["make"]).toBe("Hyundai");
    expect(seed).not.toHaveProperty("follow_up_email");

    const afterSubmit = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields() },
    });
    expect(afterSubmit.status).toBe("suspended"); // confirmVehicle card.
    const resumed = await acceptConfirm(run);
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
      harnessGenerate: harnessStub(),
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
// confirmVehicle — unconditional buyer confirmation (the only DB write follows it)
// ---------------------------------------------------------------------------

describe("search_profile_intake — confirmVehicle (unconditional buyer confirmation)", () => {
  it("the confirm card carries year/make/model/trim and NO budget/email/phone (inv #9)", async () => {
    wireDeps({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-confirm-card-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    const afterSubmit = await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields({ trim: "SEL", budget_max: 45000, follow_up_email: "x@y.com", follow_up_phone: "949-555-0100" }) },
    });
    expect(afterSubmit.status).toBe("suspended");
    if (afterSubmit.status !== "suspended") return;
    const card = suspendPayloadOf(afterSubmit, "confirmVehicle");
    expect(card).toEqual({ kind: "intake_confirm", year: 2026, make: "Hyundai", model: "Tucson", trim: "SEL" });
    // PII / budget never ride the confirm card.
    expect(card).not.toHaveProperty("budget_max");
    expect(card).not.toHaveProperty("follow_up_email");
    expect(card).not.toHaveProperty("follow_up_phone");
  });

  it("accept → created with the confirmed trim", async () => {
    wireDeps({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-confirm-accept-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "SEL" }) } });
    const resumed = await acceptConfirm(run);
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result?.outcome).toBe("created");
    expect(rowCount("search_profiles")).toBe(1);
    const row = db.$client.prepare("SELECT trim FROM search_profiles LIMIT 1").get() as { trim: string };
    expect(row.trim).toBe("SEL");
  });

  it("decline → terminal declined, ZERO rows (search_profiles AND audit_log)", async () => {
    wireDeps({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-confirm-decline-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    const afterSubmit = await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields() } });
    expect(afterSubmit.status).toBe("suspended");
    const resumed = await run.resume({ step: "confirmVehicle", resumeData: { action: "decline" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("declined");
    expect(rowCount("search_profiles")).toBe(0);
    expect(rowCount("audit_log")).toBe(0);
  });

  it("edit → re-open the collect form → change the trim → submit → persists the NEW trim", async () => {
    wireDeps({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-confirm-edit-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "SEL" }) } });

    // edit → the collect form re-renders (the ONE editing surface), seeded.
    const afterEdit = await run.resume({ step: "confirmVehicle", resumeData: { action: "edit" } });
    expect(afterEdit.status).toBe("suspended");
    if (afterEdit.status !== "suspended") return;
    expect(suspendPayloadOf(afterEdit, "confirmVehicle")["kind"]).toBe("data_collection");

    // submit a NEW trim → the re-submitted form IS the affirmation → persist.
    const resumed = await run.resume({
      step: "confirmVehicle",
      resumeData: { action: "submit", fields: validFields({ trim: "Limited" }) },
    });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("created");
    expect(rowCount("search_profiles")).toBe(1);
    const row = db.$client.prepare("SELECT trim FROM search_profiles LIMIT 1").get() as { trim: string };
    expect(row.trim).toBe("Limited");
  });

  it("edit → change a NON-vehicle field (follow_up_email) → submit → the edit is PERSISTED, never silently dropped", async () => {
    wireDeps({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-confirm-edit-nonvehicle-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields({ follow_up_email: "old@example.com" }) },
    });
    await run.resume({ step: "confirmVehicle", resumeData: { action: "edit" } });

    // Fix a typo'd email (a NON-vehicle field) in the edit form → submit.
    const resumed = await run.resume({
      step: "confirmVehicle",
      resumeData: { action: "submit", fields: validFields({ follow_up_email: "fixed@example.com" }) },
    });
    expect(resumed.status).toBe("success");
    expect(rowCount("search_profiles")).toBe(1);
    const row = db.$client
      .prepare("SELECT follow_up_email FROM search_profiles LIMIT 1")
      .get() as { follow_up_email: string };
    expect(row.follow_up_email).toBe("fixed@example.com"); // the edit reached persist.
  });

  it("edit → change the LOCATION → submit → re-geocodes so persisted coords match the new location", async () => {
    const FIRST: GoplacesResult = RESOLVED; // Irvine (33.6695, -117.7669) for the initial resolve.
    const REGEOCODED: GoplacesResult = {
      kind: "resolved",
      location: { lat: 40.7128, lng: -74.006, formattedAddress: "New York, NY, USA", postalCode: "10001" },
      traceSpans: [],
    };
    // First resolve (collect) → Irvine; the re-geocode after the location edit → NYC.
    wireDeps({ harnessGenerate: harnessStub(), resolveLocation: locationStub([FIRST, REGEOCODED]) });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-confirm-edit-location-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({
      step: "collect",
      resumeData: { action: "submit", fields: validFields({ location_query: "Irvine, CA 92602" }) },
    });
    await run.resume({ step: "confirmVehicle", resumeData: { action: "edit" } });

    const resumed = await run.resume({
      step: "confirmVehicle",
      resumeData: { action: "submit", fields: validFields({ location_query: "New York, NY" }) },
    });
    expect(resumed.status).toBe("success");
    expect(rowCount("search_profiles")).toBe(1);
    const row = db.$client
      .prepare("SELECT latitude, longitude, location_query FROM search_profiles LIMIT 1")
      .get() as { latitude: number; longitude: number; location_query: string };
    expect(row.location_query).toBe("New York, NY");
    expect(row.latitude).toBe(40.7128); // coords match the EDITED location, not the stale Irvine ones.
    expect(row.longitude).toBe(-74.006);
  });

  it("edit → submit a blank (whitespace) trim → re-suspends the form (trim required), never persists", async () => {
    wireDeps({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-confirm-edit-empty-1" });
    await run.start({ inputData: { input_mode: "slash", freeform_text: null, seed_fields: null } });
    await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "SEL" }) } });
    await run.resume({ step: "confirmVehicle", resumeData: { action: "edit" } });

    // A blank (whitespace-only) trim re-suspends the edit form (trim is required) —
    // no crash, no null-trim profile. (The form min(1) blocks a truly empty string;
    // a whitespace value exercises the step's own required-trim guard.)
    const afterEmpty = await run.resume({
      step: "confirmVehicle",
      resumeData: { action: "submit", fields: validFields({ trim: " " }) },
    });
    expect(afterEmpty.status).toBe("suspended");
    if (afterEmpty.status !== "suspended") return;
    expect(suspendPayloadOf(afterEmpty, "confirmVehicle")["kind"]).toBe("data_collection");
    expect(rowCount("search_profiles")).toBe(0);

    // The buyer can still decline out cleanly.
    const resumed = await run.resume({ step: "confirmVehicle", resumeData: { action: "decline" } });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") return;
    expect(resumed.result.outcome).toBe("declined");
    expect(rowCount("search_profiles")).toBe(0);
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
      harnessGenerate: harnessStub(),
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

    const afterPick = await run.resume({
      step: "resolveLocation",
      resumeData: { action: "pick", picked_index: 1 },
    });
    expect(afterPick.status).toBe("suspended"); // confirmVehicle card.
    const resumed = await acceptConfirm(run);
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
      harnessGenerate: harnessStub(),
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
    const afterPick = await run.resume({
      step: "resolveLocation",
      resumeData: { action: "pick", picked_index: 1 },
    });
    expect(afterPick.status).toBe("suspended"); // confirmVehicle card.
    const resumed = await acceptConfirm(run);
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
      harnessGenerate: harnessStub(),
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

    const afterRetry = await run.resume({
      step: "resolveLocation",
      resumeData: { action: "retry", retry_query: "Irvine, CA 92602" },
    });
    expect(afterRetry.status).toBe("suspended"); // confirmVehicle card.
    const resumed = await acceptConfirm(run);
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
      harnessGenerate: harnessStub(),
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
// prefill fail-closed errors the run
// ---------------------------------------------------------------------------

describe("search_profile_intake — prefill fail-closed errors the run", () => {
  it("a fail-closed prefill generation (emit_result never fires) throws → run errors, zero rows", async () => {
    // prefill is not gated behind a suspend: a fail-closed generation
    // (EmitResultNotCalledError) propagates → the run errors (no new degrade path).
    const harnessGenerate = (async (input: { useCase: string }) => {
      if (input.useCase === "intake_freeform_prefill") {
        throw new EmitResultNotCalledError("intake_freeform_prefill");
      }
      throw new Error("unexpected useCase");
    }) as unknown as IntakeWorkflowDeps["harnessGenerate"];

    wireDeps({ harnessGenerate, resolveLocation: locationStub([RESOLVED]) });

    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-prefill-failclosed-1" });
    const started = await run.start({
      inputData: { input_mode: "freeform", freeform_text: "2026 Tucson in Irvine", seed_fields: null },
    });

    expect(started.status).toBe("failed");
    expect(rowCount("search_profiles")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// trim suggestion (web-grounded pre-collect picker)
// ---------------------------------------------------------------------------

const TRIM_TEXT = "SOURCE: 2026 Honda Civic trims: LX, Sport, Sport Touring.";

describe("sanitizePrefillTrim — price/superlative qualifiers are never a trim", () => {
  it("nulls price/superlative words (case- and space-insensitive)", () => {
    for (const q of ["cheapest", "Cheapest", "  cheapest  ", "BEST", "fully loaded", "least expensive", "lowest-priced", "nicest"]) {
      expect(sanitizePrefillTrim(q)).toBeNull();
    }
  });
  it("nulls non-value placeholder strings an LLM emits instead of JSON null", () => {
    for (const q of ["null", "NULL", "none", "N/A", "na", "undecided", "unknown", "any", "tbd", "-", "", "  "]) {
      expect(sanitizePrefillTrim(q)).toBeNull();
    }
  });
  it("leaves real trim names (even adjective-like ones) intact", () => {
    for (const t of ["LX", "EX-L", "XLE", "Limited", "Base", "Sport", "Premium", "Touring", "Premier", "cheapest LX"]) {
      expect(sanitizePrefillTrim(t)).toBe(t);
    }
  });
  it("passes null through", () => {
    expect(sanitizePrefillTrim(null)).toBeNull();
  });
});

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

  it("pick → the chosen trim seeds the form → submit → confirm → created (freeform-picker-pick path)", async () => {
    wireDeps({
      harnessGenerate: trimLookupStub({ names: ["LX", "Sport"], summaries: ["base", "sporty"] }),
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

    const afterSubmit = await run.resume({ step: "collect", resumeData: { action: "submit", fields: validFields({ trim: "Sport" }) } });
    expect(afterSubmit.status).toBe("suspended"); // the buyer STILL confirms the picked trim.
    expect(suspendPayloadOf(afterSubmit, "confirmVehicle")).toMatchObject({ kind: "intake_confirm", trim: "Sport" });
    const created = await acceptConfirm(run);
    expect(created.status).toBe("success");
    if (created.status !== "success") return;
    expect(created.result?.outcome).toBe("created");
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
      harnessGenerate: harnessStub(),
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

  it("freeform with a SUPERLATIVE mis-extracted as trim (\"cheapest\") → sanitized to null → the picker FIRES", async () => {
    // The prefill model fills trim="cheapest" (a price intent, not a real trim).
    // The sanitizer nulls it BEFORE the seed, so the trimSuggestion guard sees no
    // trim and offers the grounded picker — the buyer is not silently saddled with a
    // bogus trim, and gets the trim assist they should have. (Regression for the
    // "the cheapest honda crv" → trim=cheapest live finding, run 70c96be9.)
    const prefillSuperlative = (async (input: { useCase: string }) => {
      if (input.useCase === "intake_trim_lookup") {
        return { object: { trim_names: ["LX", "Sport", "Sport Touring"], trim_summaries: ["base", "sporty", "loaded"] }, usage: NO_USAGE };
      }
      return {
        object: IntakePrefillSchema.parse({
          make: "Honda", model: "Civic", year: 2026, trim: "cheapest",
          location_query: "Irvine, CA", search_radius_miles: null, financing_preference: "finance",
        }),
        usage: NO_USAGE,
      };
    }) as unknown as IntakeWorkflowDeps["harnessGenerate"];
    wireDeps({ harnessGenerate: prefillSuperlative, fetchTrimSources: trimSourcesStub(TRIM_TEXT), resolveLocation: locationStub([RESOLVED]) });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-superlative" });
    const started = await run.start({
      inputData: { input_mode: "freeform", freeform_text: "the cheapest honda civic in Irvine this year", seed_fields: null },
    });
    expect(started.status).toBe("suspended");
    // The bogus "cheapest" trim was sanitized away → the picker fires (not the form).
    const payload = suspendPayloadOf(started, "trimSuggestion");
    expect(payload["kind"]).toBe("trim_suggestion");
    expect((payload["candidates"] as unknown[]).length).toBe(3);
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

  it("a fail-closed lookup extraction → graceful pass-through (non-authoritative helper never blocks intake)", async () => {
    // The trimSuggestion step CATCHES a fail-closed generation (EmitResultNotCalledError)
    // and degrades to the blank-trim collect form — never gates, never errors the run.
    const failClosedLookup = (async (input: { useCase: string }) => {
      if (input.useCase === "intake_trim_lookup") {
        throw new EmitResultNotCalledError("intake_trim_lookup");
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
      harnessGenerate: failClosedLookup,
      fetchTrimSources: trimSourcesStub(TRIM_TEXT),
      resolveLocation: locationStub([RESOLVED]),
    });
    const wf = intakeWorkflow();
    const run = await wf.createRun({ runId: "intake-trim-suggest-9" });
    const started = await run.start({ inputData: { input_mode: "freeform", freeform_text: "2026 honda civic Irvine", seed_fields: null } });
    expect(started.status).toBe("suspended");
    // Degrades to the blank-trim form — the suggestion is optional.
    expect(suspendPayloadOf(started, "collect")["kind"]).toBe("data_collection");
  });
});

// ---------------------------------------------------------------------------
// flat-shape structural assertion (no nested workflow step)
// ---------------------------------------------------------------------------

describe("search_profile_intake — flat shape (design convention)", () => {
  it("the workflow registers exactly the 8 named steps, none of them a nested workflow", () => {
    const wf = intakeWorkflow();
    const stepIds = Object.keys(wf.steps);
    expect(stepIds.sort()).toEqual(
      [
        "collect",
        "confirm",
        "confirmVehicle",
        "persist",
        "prefill",
        "resolveLocation",
        "trimSuggestion",
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
