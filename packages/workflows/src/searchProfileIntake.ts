/**
 * search_profile_intake — the first skill workflow. ONE flat linear Mastra
 * `createWorkflow`: 9 named steps chained with
 * `.then()`, no nested workflow (flatness is the design convention — the old
 * nested-resume defect cluster #4630/#5650/#6065 is fixed in 1.x, but flatness
 * stays the rule; a structural test asserts no nested step here).
 *
 * STEP MAP:
 *   0 prefill           — conditional (freeform launch only): harness.generate
 *                         (intake_freeform_prefill) seeds the form. Slash launch
 *                         passes through. Prefill OUTPUT NEVER PERSISTS.
 *   0.5 trimSuggestion  — conditional (freeform + make/model/year present + trim
 *                         null): fetchTrimSources (tools, web) → intake_trim_lookup
 *                         extraction → suspend a trim_suggestion picker. resume
 *                         pick (seeds trim, marks trimGrounded) | skip (manual) |
 *                         retry (re-lookup) | decline (terminal). Web/LLM failure
 *                         or 0 trims passes through → blank-trim form (never blocks).
 *   1 collect           — suspend ① (data_collection). resume submit|decline|cancel.
 *                         decline/cancel → terminal {outcome:'declined'}, and every
 *                         later step short-circuits → ZERO writes.
 *   2 validate          — pure: SearchProfileIntakeInputSchema.strict().parse.
 *   3 trimVerify        — skip when trim null OR trimGrounded (a web-grounded
 *                         pick from step 0.5); else harness.generate
 *                         (intake_trim_verify).
 *   4 forceOverrideGate — suspend ② only when trimVerify said invalid. resume
 *                         force_override (audited) | revise (re-verify) | decline.
 *                         A `revise` whose re-verify STILL returns invalid
 *                         RE-SUSPENDS the gate with the new trim + new attestation
 *                         (fail-closed) — it NEVER proceeds unaudited.
 *   5 resolveLocation   — goplaces.resolveLocation. resolved → carry coords;
 *                         ambiguous/failed → suspend ③ (same channel);
 *                         resume pick | retry (re-resolve) | decline. NEVER carries
 *                         NULL coords forward (coordinate-resolution invariant).
 *                         The shown candidate list + effective
 *                         query ride the suspend payload (read back via suspendData)
 *                         so a `pick` indexes the SAME list shown (no re-resolution,
 *                         no Google re-order nondeterminism); a `retry`'s new list
 *                         REPLACES the stored one.
 *   6 persist           — profileService.create (the ONLY DB write); returns
 *                         {profileId, auditId}. ActiveSlotConflict propagates typed.
 *   7 confirm           — structured created summary + redactions + handoff.
 *
 * STATE THREADING: Mastra feeds each step the prior step's OUTPUT as `inputData`.
 * We thread one accumulating `IntakeState` object through every step so each step
 * sees the full evolving picture; a step that should not run (declined, or a
 * conditional that doesn't apply) returns the state UNCHANGED (pass-through). This
 * is how a flat linear chain encodes conditional branches "inside the step
 * closure" without a nested workflow.
 *
 * SUSPEND/RESUME (live-probed @mastra/core@1.41): a suspending step runs TWICE —
 * once with `resumeData === undefined` (it calls `suspend(payload)` and the run
 * goes to status 'suspended'); once on resume with `resumeData` populated (it
 * skips the suspend and acts on the resume payload). The step execute params carry
 * `runId` directly (ExecuteFunctionParams.runId) — that is the ledger runId for
 * each harness.generate call.
 *
 * #1244: harness.generate returns a HarnessSuspend (not a throw) when a
 * malformed tool call is detected and hitlAvailable=true; the LLM steps map that
 * to a malformed_tool_call suspend with a {retry_step|decline} resume. With no
 * HITL it throws MalformedToolCallAbort and the run fails — but intake always runs
 * with hitlAvailable=true (the rail/form is the human).
 *
 * FORCED-AUDIT PERSISTENCE (product ruling 2026-06-04): a
 * confirmed `force_override` writes its 'intake_verification_forced' audit row
 * IMMEDIATELY at step 4. If the user LATER declines (e.g. at resolveLocation), the
 * run terminates declined with ZERO search_profiles writes — but the forced-audit
 * row REMAINS. This is INTENDED, not a leak: a decision that genuinely happened
 * (the user forced an unverified trim) stays audited even when the surrounding run
 * later aborts. Invariant: decline writes zero search_profiles rows; a confirmed
 * force always writes the forced-audit row. The forced-audit row is NOT linked to a profile id
 * (searchProfileId: null) — the profile does not exist yet at force-override time
 * (persist is step 6), so there is nothing to point at.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/core (types),
 * @autobroker/model (HarnessSuspend type), @autobroker/tools (goplaces +
 * profileService + writeAuditLog + getDb — the ONLY DB path), and this layer's
 * harness facade + intake contracts. NEVER opens the product DB directly: the
 * tools closures (create / resolveLocation / writeAuditLog) own every side effect.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  SearchProfileIntakeInputSchema,
  type SearchProfileIntakeInput,
} from "@autobroker/core";
import type { HarnessSuspend } from "@autobroker/model";
import {
  AUDIT_ACTIONS,
  create as createProfileImpl,
  resolveLocation as resolveLocationImpl,
  fetchTrimSources as fetchTrimSourcesImpl,
  writeAuditLog,
  getDb,
  type CreateResult,
  type ResolvedCoordinates,
} from "@autobroker/tools";

import { harness, type HarnessLedgerContext } from "./harness.js";
import {
  AmbiguousLocationResumeSchema,
  buildPrefillPrompt,
  buildTrimSuggestionPrompt,
  buildTrimVerifyPrompt,
  CollectResumeSchema,
  ForceOverrideResumeSchema,
  IntakePrefillSchema,
  MalformedRetryResumeSchema,
  sanitizePrefillTrim,
  TrimSuggestionResumeSchema,
  TrimSuggestionSchema,
  TrimVerifyResultSchema,
  type IntakePrefill,
  type TrimSuggestion,
  type TrimVerifyResult,
} from "./intakeContracts.js";

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, like harness _testOverrides)
// ---------------------------------------------------------------------------

/**
 * The three runtime collaborators the workflow steps call. Injectable so the
 * offline tests drive the REAL flat Mastra workflow → REAL suspend/resume → REAL
 * step chain against deterministic stubs and an isolated tmp DB, WITHOUT a vitest
 * module mock (the workflow/suspend/resume/ledger path stays genuinely exercised).
 *
 * Design (justify): a module-level mutable holder over a workflow-factory. The
 * steps are constructed ONCE at module load (createStep), and the workflow must
 * be registered by a stable id with createMastraInstance — a factory would force
 * re-registration plumbing for every test. A single guarded holder keeps the REAL
 * wiring as the default and is reset between cases. The harness already proved
 * this pattern (its _testOverrides seam); we mirror it.
 */
export interface IntakeWorkflowDeps {
  harnessGenerate: typeof harness.generate;
  resolveLocation: typeof resolveLocationImpl;
  /** Read-only web lookup of a make/model/year's trim lineup (tools layer). The
   *  trimSuggestion step calls this for grounding text; the LLM extraction stays
   *  in the workflow (external-API wall). */
  fetchTrimSources: typeof fetchTrimSourcesImpl;
  createProfile: typeof createProfileImpl;
  /** The DB accessor the persist/audit steps write through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: IntakeWorkflowDeps = {
  harnessGenerate: harness.generate,
  resolveLocation: resolveLocationImpl,
  fetchTrimSources: fetchTrimSourcesImpl,
  createProfile: createProfileImpl,
  getDb,
};

let injectedDeps: IntakeWorkflowDeps | undefined;

/** The deps the steps use: injected (tests) or the real wiring (production). */
function deps(): IntakeWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/**
 * TEST-ONLY seam. Refused outside a test runner (same guard rule as the harness
 * _testOverrides seam): a production caller must never redirect the harness, the
 * geocoder, or the DB write path. Pass a partial; unspecified collaborators keep
 * their real implementation.
 */
export function __setIntakeDepsForTests(partial: Partial<IntakeWorkflowDeps>): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setIntakeDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetIntakeDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// ledger identity for the intake LLM calls
// ---------------------------------------------------------------------------

/** Build the per-call ledger context from the step's runId (live-probed: a step
 *  reads its own runId off ExecuteFunctionParams.runId in 1.41). The row's
 *  provider/model_alias are derived from policy(useCase) inside harness.generate,
 *  not supplied here. */
function intakeLedger(runId: string): HarnessLedgerContext {
  return {
    runId,
    skill: "search_profile_intake",
    layer: "L2",
    promptVersion: "m1-v1",
    schemaVersion: "m1-v1",
  };
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

/** Resolved geo carried forward after step 5 (coordinate-resolution invariant:
 *  never null past resolve). */
const ResolvedCoordsSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  resolvedAddress: z.string().nullable(),
  postalCode: z.string().nullable(),
});

/** One ambiguous candidate, stored in state so a `pick` resume indexes the SAME
 *  list that was shown (no re-resolution → no wrong-list bug, no Google
 *  nondeterminism). Mirrors the goplaces GeoLocation shape. */
type LocationCandidate = z.infer<typeof LocationCandidateSchema>;
const LocationCandidateSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  formattedAddress: z.string(),
  postalCode: z.string().nullable(),
});

/**
 * The accumulating intake state threaded through the 8 steps. A flat object so
 * Mastra's snapshot stays a plain JSON blob (suspend/resume serializes it).
 */
const IntakeStateSchema = z.object({
  inputMode: z.enum(["slash", "freeform"]),
  freeformText: z.string().nullable(),
  /** Form seed (prefill output or caller seed); NEVER persisted directly. */
  seed: z.record(z.string(), z.unknown()).nullable(),
  /** True once the buyer PICKED a web-grounded trim suggestion. trimVerify skips
   *  when set — re-verifying a freshly web-grounded trim with the conservative
   *  ungrounded LLM only risks a needless force-override on a real trim. Defaulted
   *  so a run snapshot taken before this field existed still parses on resume. */
  trimGrounded: z.boolean().default(false),
  /** Terminal-declined flag: once true, every later step passes through. */
  declined: z.boolean(),
  /** Validated form fields (after step 2); null until then. */
  fields: z.record(z.string(), z.unknown()).nullable(),
  /** Resolved coordinates (after step 5); null until then. */
  coordinates: ResolvedCoordsSchema.nullable(),
  /** Effective location query for step 5 — starts as the form's location_query,
   *  replaced by a `retry` resume's better query. Threaded so a re-resolve uses
   *  the query the user actually corrected to. Null until step 5 sets it. */
  locationQuery: z.string().nullable(),
  /** The candidates last shown at the ambiguous suspend (capped at 5 into the
   *  snapshot). A `pick` resume indexes THIS list directly. Null until shown. */
  shownCandidates: z.array(LocationCandidateSchema).nullable(),
  /** Persist result (after step 6); null until then. */
  profileId: z.string().nullable(),
  auditId: z.string().nullable(),
});
type IntakeState = z.infer<typeof IntakeStateSchema>;

/** The workflow input shape. */
const IntakeInputSchema = z.object({
  input_mode: z.enum(["slash", "freeform"]),
  freeform_text: z.string().nullable(),
  seed_fields: z.record(z.string(), z.unknown()).nullable(),
});

/** The workflow output — created | declined union. */
const IntakeOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("created"),
    profileId: z.string(),
    vehicle: z.string(),
    location: z.string(),
    redactions: z.object({ budget_excluded: z.literal(true) }),
    handoffPointer: z.string(),
  }),
  z.object({ outcome: z.literal("declined") }),
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Re-hydrate a typed IntakeState from a step's loosely-typed inputData. */
function asState(inputData: unknown): IntakeState {
  return IntakeStateSchema.parse(inputData);
}

/** Narrow a harness.generate result to the HarnessSuspend branch. */
function isHarnessSuspend(r: unknown): r is HarnessSuspend {
  return typeof r === "object" && r !== null && "suspended" in r;
}

/**
 * Run `fn` against the SHARED tools-layer DB connection (getDb — one cached
 * handle per resolved data dir, created on first use). No per-step open/close:
 * the shared handle stays open for the process; tests release it via closeDb().
 */
function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  return fn(deps().getDb());
}

// ---------------------------------------------------------------------------
// step 0 — prefill (conditional: freeform launch only)
// ---------------------------------------------------------------------------

const prefillStep = createStep({
  id: "prefill",
  inputSchema: IntakeInputSchema,
  outputSchema: IntakeStateSchema,
  resumeSchema: MalformedRetryResumeSchema,
  suspendSchema: z.object({ kind: z.literal("malformed_tool_call"), signals: z.array(z.string()) }),
  execute: async ({ inputData, runId, resumeData, suspend }) => {
    const base: IntakeState = {
      inputMode: inputData.input_mode,
      freeformText: inputData.freeform_text,
      seed: inputData.seed_fields,
      trimGrounded: false,
      declined: false,
      fields: null,
      coordinates: null,
      locationQuery: null,
      shownCandidates: null,
      profileId: null,
      auditId: null,
    };

    // Slash launch (or no prose) skips prefill entirely — the form renders with
    // the caller-supplied seed (or empty). Prefill is freeform-only.
    if (inputData.input_mode !== "freeform" || inputData.freeform_text === null) {
      return base;
    }

    // On resume from a malformed_tool_call suspend: decline → pass through with an
    // empty seed (prefill failure is transient/recoverable — the form fills it).
    // retry falls through to re-run the generate below.
    if (resumeData !== undefined && resumeData.action === "decline") {
      return base;
    }

    const result = await deps().harnessGenerate(
      { useCase: "intake_freeform_prefill", schema: IntakePrefillSchema, prompt: buildPrefillPrompt(inputData.freeform_text), hitlAvailable: true },
      intakeLedger(runId),
    );

    // #1244 fail-closed: a malformed tool call suspends to the human.
    if (isHarnessSuspend(result)) {
      return (await suspend({ kind: "malformed_tool_call", signals: result.signals })) as never;
    }

    // Prefill OUTPUT ONLY SEEDS THE FORM (never persists). Drop nulls so the seed
    // carries only what the model actually saw. Sanitize trim FIRST: a price/superlative
    // qualifier ("cheapest") is never a real trim — null it so it does not seed the form
    // AND does not suppress the web-grounded trimSuggestion picker (which fires only when
    // make+model+year are present but trim is absent).
    const prefill: IntakePrefill = { ...result.object, trim: sanitizePrefillTrim(result.object.trim) };
    const seed: Record<string, unknown> = { ...(inputData.seed_fields ?? {}) };
    for (const [k, v] of Object.entries(prefill)) {
      if (v !== null) seed[k] = v;
    }
    return { ...base, seed };
  },
});

// ---------------------------------------------------------------------------
// step 0.5 — trimSuggestion (web-grounded): when freeform gave make+model+year
// but NO trim, look up the real trim lineup on the web and let the buyer pick.
// ---------------------------------------------------------------------------

/** Read a string seed field (prefill output), or null when absent/blank/non-string. */
function seedStr(seed: Record<string, unknown> | null, key: string): string | null {
  const v = seed?.[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
/** Read a numeric seed field, or null when absent/non-number. */
function seedNum(seed: Record<string, unknown> | null, key: string): number | null {
  const v = seed?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The trim_suggestion suspend payload. candidates carry everything a `pick`
 *  needs (the trim name), read back off suspendData — no re-fetch on pick. */
const TrimSuggestionSuspendSchema = z.object({
  kind: z.literal("trim_suggestion"),
  make: z.string(),
  model: z.string(),
  year: z.number().int(),
  candidates: z.array(
    z.object({ index: z.number().int(), name: z.string(), summary: z.string() }),
  ),
});

const MAX_TRIM_CANDIDATES = 8;

const trimSuggestionStep = createStep({
  id: "trimSuggestion",
  inputSchema: IntakeStateSchema,
  outputSchema: IntakeStateSchema,
  resumeSchema: TrimSuggestionResumeSchema,
  suspendSchema: TrimSuggestionSuspendSchema,
  execute: async ({ inputData, runId, resumeData, suspendData, suspend }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    // Applicability guard: freeform launch only, with make+model+year present and
    // NO trim. (Slash collects everything in the form; a present trim needs no
    // suggestion.) Any non-fire branch passes state through UNCHANGED.
    const make = seedStr(state.seed, "make");
    const model = seedStr(state.seed, "model");
    const year = seedNum(state.seed, "year");
    const hasTrim = seedStr(state.seed, "trim") !== null;
    const applicable =
      state.inputMode === "freeform" && make !== null && model !== null && year !== null && !hasTrim;
    if (!applicable) return state;

    // Resume actions (the picker came back).
    if (resumeData !== undefined) {
      if (resumeData.action === "decline") {
        return { ...state, declined: true }; // terminal cancel, zero write.
      }
      if (resumeData.action === "skip") {
        return state; // "enter it myself" → proceed to the form, trim blank.
      }
      if (resumeData.action === "pick") {
        const chosen = suspendData?.candidates[resumeData.picked_index];
        if (chosen === undefined) {
          // Out-of-range pick → re-render the SAME shown list (fail-closed).
          return (await suspend({
            kind: "trim_suggestion",
            make,
            model,
            year,
            candidates: suspendData?.candidates ?? [],
          })) as never;
        }
        // Seed the form's trim field with the web-grounded pick; mark grounded so
        // trimVerify (step 3) does not re-distrust it.
        return {
          ...state,
          seed: { ...(state.seed ?? {}), trim: chosen.name },
          trimGrounded: true,
        };
      }
      // retry falls through to a fresh lookup (optionally refined).
    }

    const refine =
      resumeData !== undefined && resumeData.action === "retry" && resumeData.refine_query !== null
        ? resumeData.refine_query
        : undefined;

    // GROUNDING FETCH (tools layer). A non-resolved result (web unreachable /
    // nothing usable) degrades gracefully to the blank-trim form — the suggestion
    // is a non-authoritative helper and must NEVER block intake.
    const sources = await deps().fetchTrimSources(
      refine !== undefined ? { make, model, year, refine } : { make, model, year },
    );
    if (sources.kind !== "resolved") return state;

    // STRUCTURED EXTRACTION (workflow layer; #1244-safe single emit_result tool).
    const result = await deps().harnessGenerate(
      {
        useCase: "intake_trim_lookup",
        schema: TrimSuggestionSchema,
        prompt: buildTrimSuggestionPrompt({ year, make, model, sourceText: sources.text }),
        hitlAvailable: true,
      },
      intakeLedger(runId),
    );
    // #1244 on a non-authoritative helper → degrade to the blank-trim form (do not
    // hard-fail intake, do not surface a malformed gate for an optional suggestion).
    if (isHarnessSuspend(result)) return state;

    // Zip parallel arrays (tolerate length mismatch), dedup by normalized name, cap.
    const sug: TrimSuggestion = result.object;
    const n = Math.min(sug.trim_names.length, sug.trim_summaries.length);
    const seen = new Set<string>();
    const candidates: { index: number; name: string; summary: string }[] = [];
    for (let i = 0; i < n && candidates.length < MAX_TRIM_CANDIDATES; i++) {
      const name = (sug.trim_names[i] ?? "").trim();
      if (name === "") continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ index: candidates.length, name, summary: (sug.trim_summaries[i] ?? "").trim() });
    }
    // 0 usable trims → proceed to the blank-trim form (graceful).
    if (candidates.length === 0) return state;

    return (await suspend({
      kind: "trim_suggestion",
      make,
      model,
      year,
      candidates,
    })) as never;
  },
});

// ---------------------------------------------------------------------------
// step 1 — collect (suspend ①): render the form, await submit/decline/cancel
// ---------------------------------------------------------------------------

const collectStep = createStep({
  id: "collect",
  inputSchema: IntakeStateSchema,
  outputSchema: IntakeStateSchema,
  resumeSchema: CollectResumeSchema,
  suspendSchema: z.object({
    kind: z.literal("data_collection"),
    form_kind: z.literal("intake"),
    spec_hint: z.string(),
    seed_fields: z.record(z.string(), z.unknown()).nullable(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = asState(inputData);

    // Already declined UPSTREAM (the trimSuggestion picker's terminal cancel) →
    // pass straight through, never render the form. (A decline AT collect is the
    // resume path below; this guards a decline that happened before collect.)
    if (state.declined) return state;

    // First pass: render the form (gate before prose — the suspend payload is the
    // form spec). No resume yet → suspend.
    if (resumeData === undefined) {
      return (await suspend({
        kind: "data_collection",
        form_kind: "intake",
        spec_hint: "search_profile_intake",
        seed_fields: state.seed,
      })) as never;
    }

    // decline/cancel → terminal declined, zero write. Mark and let every
    // later step pass through.
    if (resumeData.action === "decline" || resumeData.action === "cancel") {
      return { ...state, declined: true };
    }

    // submit → carry the submitted fields into validate (step 2 parses them).
    return { ...state, fields: resumeData.fields };
  },
});

// ---------------------------------------------------------------------------
// step 2 — validate (pure): SearchProfileIntakeInputSchema.strict().parse
// ---------------------------------------------------------------------------

const validateStep = createStep({
  id: "validate",
  inputSchema: IntakeStateSchema,
  outputSchema: IntakeStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state; // pass-through (zero write).

    // Fail-LOUD: a ZodError here is a real contract violation (the form sent bad
    // data). No silent repair.
    const fields: SearchProfileIntakeInput = SearchProfileIntakeInputSchema.parse(state.fields);
    return { ...state, fields };
  },
});

// ---------------------------------------------------------------------------
// step 3 — trimVerify (LLM): skip when trim null
// ---------------------------------------------------------------------------

/**
 * Run the trim-verify LLM call for a given trim. Returns the verdict, or a
 * {malformed, signals} sentinel when harness.generate fail-closed-suspended on a
 * #1244 malformed tool call (the CALLER performs the actual Mastra suspend with
 * its own correctly-typed `suspend`, since each step's suspend is narrowed to its
 * own suspendSchema).
 */
async function runTrimVerify(
  fields: SearchProfileIntakeInput,
  runId: string,
): Promise<{ verdict: TrimVerifyResult } | { malformed: true; signals: string[] }> {
  const result = await deps().harnessGenerate(
    {
      useCase: "intake_trim_verify",
      schema: TrimVerifyResultSchema,
      prompt: buildTrimVerifyPrompt({
        year: fields.year,
        make: fields.make,
        model: fields.model,
        trim: fields.trim ?? "",
      }),
      hitlAvailable: true,
    },
    intakeLedger(runId),
  );
  if (isHarnessSuspend(result)) {
    return { malformed: true, signals: result.signals };
  }
  return { verdict: result.object };
}

/** The malformed_tool_call suspend payload shape (shared by the LLM steps). */
const MalformedSuspendSchema = z.object({
  kind: z.literal("malformed_tool_call"),
  signals: z.array(z.string()),
});

/** trimVerify carries its verdict forward in a side field of the state so the
 *  force-override gate (step 4) can read it. */
const TrimVerdictSchema = TrimVerifyResultSchema.nullable();

const trimVerifyStep = createStep({
  id: "trimVerify",
  inputSchema: IntakeStateSchema,
  outputSchema: IntakeStateSchema.extend({ trimVerdict: TrimVerdictSchema }),
  resumeSchema: MalformedRetryResumeSchema,
  suspendSchema: MalformedSuspendSchema,
  execute: async ({ inputData, runId, resumeData, suspend }) => {
    const state = asState(inputData);
    if (state.declined) return { ...state, trimVerdict: null };

    const fields = state.fields as SearchProfileIntakeInput;
    // No trim to verify → skip straight to resolveLocation (verdict null).
    if (fields.trim === null) return { ...state, trimVerdict: null };
    // A web-grounded picked trim is already grounded against current web data —
    // re-verifying with the conservative ungrounded LLM only risks a needless
    // force-override on a real trim. Skip (the post-scan inventory check still
    // grounds it). The form is the source of truth: if the user EDITED the trim
    // away from the pick, trimGrounded still holds — acceptable, the edited value
    // is still a buyer-typed string the inventory cross-check grounds downstream.
    if (state.trimGrounded) return { ...state, trimVerdict: null };

    if (resumeData !== undefined && resumeData.action === "decline") {
      return { ...state, declined: true, trimVerdict: null };
    }

    const r = await runTrimVerify(fields, runId);
    if ("malformed" in r) {
      // #1244 fail-closed: suspend to the human (retry_step | decline).
      return (await suspend({ kind: "malformed_tool_call", signals: r.signals })) as never;
    }
    return { ...state, trimVerdict: r.verdict };
  },
});

const TrimStateSchema = IntakeStateSchema.extend({ trimVerdict: TrimVerdictSchema });
type TrimState = z.infer<typeof TrimStateSchema>;

// ---------------------------------------------------------------------------
// step 4 — forceOverrideGate (suspend ②, conditional on invalid trim)
// ---------------------------------------------------------------------------

/**
 * The force-override gate can suspend two ways: the force_override approval card,
 * OR a malformed_tool_call (when the `revise` re-verify itself trips #1244). Both
 * resume paths are folded into the exported ForceOverrideResumeSchema (single
 * `decline` member so the discriminated union stays valid).
 */
const ForceOverrideStepSuspendSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("force_override"),
    question: z.string(),
    trim: z.string(),
    reason: z.string(),
  }),
  MalformedSuspendSchema,
]);

const forceOverrideStep = createStep({
  id: "forceOverrideGate",
  inputSchema: TrimStateSchema,
  outputSchema: IntakeStateSchema,
  resumeSchema: ForceOverrideResumeSchema,
  suspendSchema: ForceOverrideStepSuspendSchema,
  execute: async ({ inputData, runId, resumeData, suspendData, suspend }) => {
    const state = TrimStateSchema.parse(inputData) as TrimState;
    const { trimVerdict, ...rest } = state;
    const base: IntakeState = rest;
    if (base.declined) return base;

    // No verdict, or trim is valid → no gate, pass through.
    if (trimVerdict === null || trimVerdict.valid) return base;

    const fields = base.fields as SearchProfileIntakeInput;

    // The force_override card the user is responding to (suspendData) holds the
    // trim + attestation actually shown — which is the REVISED trim/attestation
    // after a still-invalid revise re-suspend, or the original on the first card.
    // Audit and persist the trim the user actually approved (not the stale input).
    const carded =
      suspendData !== undefined && suspendData.kind === "force_override" ? suspendData : null;
    const approvedTrim = carded ? carded.trim : (fields.trim ?? "");
    const approvedAttestation = carded ? carded.reason : trimVerdict.attestation;

    // First pass: render the approval card (gate before prose).
    if (resumeData === undefined) {
      return (await suspend({
        kind: "force_override",
        question:
          "We couldn't verify this trim from our records — we'll cross-check it against " +
          "real dealer inventory after the search. Keep it, revise it, or cancel?",
        trim: fields.trim ?? "",
        reason: trimVerdict.attestation,
      })) as never;
    }

    if (resumeData.action === "decline") {
      return { ...base, declined: true };
    }

    if (resumeData.action === "force_override") {
      // Audited: the user knowingly kept an unverified trim (reason REQUIRED). The
      // forced-audit row writes IMMEDIATELY and is NOT linked to a profile id (the
      // profile does not exist yet — see the forced-audit persistence note in the
      // file header).
      withDb((db) =>
        writeAuditLog(db, {
          action: AUDIT_ACTIONS.intakeVerificationForced,
          actor: null,
          targetTable: "search_profiles",
          searchProfileId: null,
          reason: resumeData.reason,
          payloadJson: JSON.stringify({ trim: approvedTrim, attestation: approvedAttestation }),
        }),
      );
      // Continue with the now-audited approved trim (revised, if the user revised).
      return { ...base, fields: { ...fields, trim: approvedTrim } };
    }

    // retry_step → re-run the re-verify (the malformed suspend was on a revise);
    // we cannot reconstruct the revised trim from a bare retry, so fall back to
    // re-rendering the approval card (fail-closed; the user re-chooses).
    if (resumeData.action === "retry_step") {
      return (await suspend({
        kind: "force_override",
        question: "Re-verify failed earlier. Keep the trim, revise it, or cancel?",
        trim: fields.trim ?? "",
        reason: trimVerdict.attestation,
      })) as never;
    }

    // revise → change the trim and re-verify once. Trim is now REQUIRED at the
    // form contract (owner-directed, 2026-06-22), so a cleared/empty trim can no
    // longer proceed — it would fail the required-form persist late. Re-suspend the
    // gate so the user provides a trim, forces the current one, or cancels:
    // fail-closed, never a null-trim profile, never a late crash.
    if (resumeData.trim === null || resumeData.trim.trim() === "") {
      return (await suspend({
        kind: "force_override",
        question: "A trim is required — keep the current trim, revise it, or cancel.",
        trim: fields.trim ?? "",
        reason: trimVerdict.attestation,
      })) as never;
    }
    const revisedFields: SearchProfileIntakeInput = { ...fields, trim: resumeData.trim };
    const revised: IntakeState = { ...base, fields: revisedFields };

    const r = await runTrimVerify(revisedFields, runId);
    if ("malformed" in r) {
      // #1244 on the re-verify → suspend (retry_step | decline | revise again).
      return (await suspend({ kind: "malformed_tool_call", signals: r.signals })) as never;
    }
    if (r.verdict.valid) {
      // Re-verify confirmed the revised trim → no gate needed, continue.
      return revised;
    }
    // STILL invalid after revise → never proceed unaudited. Re-suspend the gate
    // with the NEW trim + NEW attestation so the user must force_override (which
    // writes the forced-audit row), revise again, or decline (fail-closed).
    return (await suspend({
      kind: "force_override",
      question:
        "The revised trim also couldn't be verified from our records — we'll cross-check it " +
        "against dealer inventory after the search. Keep it, revise it again, or cancel?",
      trim: resumeData.trim,
      reason: r.verdict.attestation,
    })) as never;
  },
});

// ---------------------------------------------------------------------------
// step 5 — resolveLocation (tools/goplaces, suspend ③: ambiguous + geocode fail)
// ---------------------------------------------------------------------------

/** Map a goplaces GeoLocation to the persist-layer ResolvedCoordinates shape. */
function toResolvedCoords(loc: {
  lat: number;
  lng: number;
  formattedAddress: string;
  postalCode?: string;
}): IntakeState["coordinates"] {
  return {
    latitude: loc.lat,
    longitude: loc.lng,
    resolvedAddress: loc.formattedAddress,
    postalCode: loc.postalCode ?? null,
  };
}

/**
 * resolveLocation suspend payload. Beyond the human-facing {kind, candidates,
 * failure_reason} it carries the FULL shown candidate coords + the effective
 * query, so a `pick`/`retry` resume reads them back off `suspendData` (Mastra
 * re-feeds the prior suspend payload there). This is what lets `pick` index the
 * SAME list that was shown — no re-resolution → no wrong-list bug, no Google
 * re-order nondeterminism — and what carries the corrected query forward. The
 * candidate list is capped at 5 (LocationCandidateSchema, snapshot-bounded).
 */
const ResolveLocationSuspendSchema = z.object({
  kind: z.literal("ambiguous_location"),
  candidates: z.array(z.object({ index: z.number().int(), label: z.string() })),
  failure_reason: z.string().nullable(),
  /** Full coords of the shown candidates (resume reads these to pick directly). */
  stored_candidates: z.array(LocationCandidateSchema),
  /** The query that produced this list (a retry's corrected query persists here). */
  effective_query: z.string(),
});

const resolveLocationStep = createStep({
  id: "resolveLocation",
  inputSchema: IntakeStateSchema,
  outputSchema: IntakeStateSchema,
  resumeSchema: AmbiguousLocationResumeSchema,
  suspendSchema: ResolveLocationSuspendSchema,
  execute: async ({ inputData, resumeData, suspendData, suspend }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    const fields = state.fields as SearchProfileIntakeInput;

    // The list/query carried by the suspend the user is responding to (suspendData
    // re-feeds the prior suspend payload). These ARE the last-shown candidates and
    // the effective query — threaded through the snapshot, not re-resolved.
    // Explicitly typed: inference across the suspendData generic boundary is
    // fragile under a pristine frozen-lockfile install (CI-only TS7006 repro,
    // 2026-06-05) — annotate rather than lean on it.
    const shownCandidates: LocationCandidate[] =
      suspendData?.stored_candidates ?? state.shownCandidates ?? [];
    let query = suspendData?.effective_query ?? state.locationQuery ?? fields.location_query;

    // pick indexes the STORED candidate list DIRECTLY (no re-resolution) — this
    // eliminates the wrong-list bug (a prior retry replaces the list) AND Google
    // re-order nondeterminism. retry/decline are handled before any resolve.
    if (resumeData !== undefined) {
      if (resumeData.action === "decline") {
        return { ...state, declined: true };
      }
      if (resumeData.action === "pick") {
        const chosen = shownCandidates[resumeData.picked_index];
        if (chosen === undefined) {
          // Out-of-range pick → re-render the SAME stored list (fail-closed).
          return (await suspend({
            kind: "ambiguous_location",
            candidates: shownCandidates.map((c, i) => ({ index: i, label: c.formattedAddress })),
            failure_reason: null,
            stored_candidates: shownCandidates,
            effective_query: query,
          })) as never;
        }
        return {
          ...state,
          coordinates: toResolvedCoords({
            lat: chosen.lat,
            lng: chosen.lng,
            formattedAddress: chosen.formattedAddress,
            ...(chosen.postalCode !== null ? { postalCode: chosen.postalCode } : {}),
          }),
        };
      }
      if (resumeData.action === "retry") {
        query = resumeData.retry_query; // re-resolve with the corrected query.
      }
    }

    const result = await deps().resolveLocation(query);

    if (result.kind === "resolved") {
      return { ...state, coordinates: toResolvedCoords(result.location), locationQuery: query };
    }

    if (result.kind === "ambiguous") {
      // Capture the shown list (capped at 5) so a later pick indexes THIS list — a
      // retry's new list REPLACES it (the suspendData re-fed next time is fresh).
      const shown = result.candidates.slice(0, 5).map((c) => ({
        lat: c.lat,
        lng: c.lng,
        formattedAddress: c.formattedAddress,
        postalCode: c.postalCode ?? null,
      }));
      return (await suspend({
        kind: "ambiguous_location",
        candidates: shown.map((c, i) => ({ index: i, label: c.formattedAddress })),
        failure_reason: null,
        stored_candidates: shown,
        effective_query: query,
      })) as never;
    }

    // failed (coordinate-resolution invariant): no_result / network_exhausted /
    // api_error → SAME suspend channel, NEVER carry NULL coords forward.
    // resume retry|decline.
    return (await suspend({
      kind: "ambiguous_location",
      candidates: [],
      failure_reason: result.reason,
      stored_candidates: [],
      effective_query: query,
    })) as never;
  },
});

// ---------------------------------------------------------------------------
// step 6 — persist (tools closure, the ONLY DB write)
// ---------------------------------------------------------------------------

const persistStep = createStep({
  id: "persist",
  inputSchema: IntakeStateSchema,
  outputSchema: IntakeStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state; // zero write.

    const fields = state.fields as SearchProfileIntakeInput;
    const coords = state.coordinates;
    if (coords === null) {
      // Defensive: resolveLocation must have produced coords or suspended
      // (coordinate-resolution invariant). Never reach persist with null coords —
      // fail LOUD rather than NULL-to-DB.
      throw new Error("persist: coordinates not resolved (coordinate-resolution invariant breached)");
    }

    const resolved: ResolvedCoordinates = {
      latitude: coords.latitude,
      longitude: coords.longitude,
      resolvedAddress: coords.resolvedAddress,
      ...(coords.postalCode !== null ? { postalCode: coords.postalCode } : {}),
    };

    // ActiveSlotConflict (and any typed profile error) propagates — NOT swallowed.
    const created: CreateResult = withDb((db) =>
      deps().createProfile(db, fields, {
        coordinates: resolved,
        actor: "search_profile_intake",
      }),
    );
    return { ...state, profileId: created.profile.id, auditId: created.auditId };
  },
});

// ---------------------------------------------------------------------------
// step 7 — confirm (pure): the created summary + redactions + handoff pointer
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: IntakeStateSchema,
  outputSchema: IntakeOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined || state.profileId === null) {
      return { outcome: "declined" as const };
    }
    const fields = state.fields as SearchProfileIntakeInput;
    return {
      outcome: "created" as const,
      profileId: state.profileId,
      vehicle: `${fields.year} ${fields.make} ${fields.model}${fields.trim ? ` ${fields.trim}` : ""}`,
      location: fields.location_query,
      // budget_max is INTERNAL-ONLY and never enters dealer-facing output (§9).
      redactions: { budget_excluded: true as const },
      handoffPointer: "dealer_geosearch",
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (8 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const searchProfileIntakeWorkflow = createWorkflow({
  id: "search_profile_intake",
  inputSchema: IntakeInputSchema,
  outputSchema: IntakeOutputSchema,
})
  .then(prefillStep)
  .then(trimSuggestionStep)
  .then(collectStep)
  .then(validateStep)
  .then(trimVerifyStep)
  .then(forceOverrideStep)
  .then(resolveLocationStep)
  .then(persistStep)
  .then(confirmStep)
  .commit();

/** The workflow id, exported for registration + runtimeGlue workflowIds. */
export const SEARCH_PROFILE_INTAKE_WORKFLOW_ID = "search_profile_intake" as const;
