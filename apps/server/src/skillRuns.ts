/**
 * skillRuns — the app-side per-skill run seam. One RunDescriptor per skill
 * (skillId + workflowId + input/resume shaping) registered in a single map, and
 * one SkillRunService that drives ANY registered skill's workflow run:
 * start, form-decision (three-phase idempotent claim), status projection, and
 * the SSE frame translation. The skill-agnostic run machinery lives in the
 * service; everything skill-specific (input validation, per-step resume
 * schemas, terminal summary wording, driver_kind derivation) lives in the
 * skill's descriptor. search_profile_intake is the first registered
 * descriptor; dealer_geosearch (no-suspend browser skill) is the second.
 *
 * This is the "runtime glue" wiring on the app side: it drives the
 * workflows-layer Mastra run through the EXPORTED glue functions
 * (startRunGuarded) — it never imports @mastra directly (the Mastra/run types
 * flow in by inference from the workflows exports) and never opens the product DB.
 *
 * RUN DRIVE LOOP: a run can suspend MULTIPLE times (collect form, force-override
 * gate, ambiguous-location ask-pick, #1244 malformed). Each start()/resume()
 * returns a WorkflowResult discriminated on status:
 *   - suspended → emit awaiting_user{decision_id, form_kind, spec_inline, ...}
 *     from result.steps[suspendedStep].suspendPayload; the run waits for a
 *     form-decision that resumes that step. We DO NOT loop here — the human is
 *     the next event source.
 *   - success → if the workflow's own output is {outcome:'declined'} emit
 *     aborted (status projects to `declined`); else emit text(summary) + done.
 *   - failed/tripwire → emit error{reason}.
 *
 * THE THREE-PHASE IDEMPOTENT CLAIM (in-memory claim map + Mastra snapshot as
 * durable truth). The claim is keyed (runId, decisionId) — the decisionId rides
 * each awaiting_user frame so the form echoes it back.
 *   - Phase 1 (lock): pending → processing. Reject a double-claim of a DIFFERENT
 *     body (409 decision_conflict); REPLAY the stored ack for the SAME body once
 *     consumed (200, idempotent — NOT a second Mastra resume; a second resume of
 *     an already-resolved suspend THROWS "not suspended", live-probed); a
 *     concurrent processing claim → 409 decision_in_flight.
 *   - Phase 2 (no lock): dispatch the skill descriptor's resume shaping
 *     (validate content for accept; decline/cancel pass through), then Mastra
 *     resume({step, resumeData}). Validation failure → 400 content_invalid +
 *     rollback processing→pending.
 *   - Phase 3 (lock): consumed; store the ack snapshot; the resume's terminal/
 *     next-suspend translation already fanned out to SSE.
 *
 * Single-process topology (127.0.0.1:8100, one Node process): the claim map's
 * synchronous map ops ARE the lock (single-threaded JS). The runtimeGlue
 * startRunGuarded dup-runId guard covers the start path; this claim map covers
 * the resume path.
 *
 * Dependency wall: app layer. Imports core (schemas/status), skills (ids),
 * workflows (the run drive + glue) — NEVER @mastra, NEVER the DB.
 */

import { randomUUID } from "node:crypto";

import {
  SearchProfileIntakeInputSchema,
  providerDriverKind,
  type HarnessDriverKind,
} from "@autobroker/core";
import { policy } from "@autobroker/model";
import { GEOSEARCH_SKILL_ID, INTAKE_SKILL_ID } from "@autobroker/skills";
import {
  startRunGuarded,
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
  DEALER_GEOSEARCH_WORKFLOW_ID,
  REGISTERED_WORKFLOW_IDS,
  CollectResumeSchema,
  ForceOverrideResumeSchema,
  AmbiguousLocationResumeSchema,
  MalformedRetryResumeSchema,
  type createMastraInstance,
} from "@autobroker/workflows";
import { z } from "zod";

import type { RunPubSub } from "./runPubSub.js";
import { projectStatus, type MastraRunStatus } from "./statusProjection.js";

type MastraInstance = ReturnType<typeof createMastraInstance>;

/** A typed error the route maps to its HTTP code (the error envelope). */
export class FormDecisionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field?: string;
  readonly extra?: Record<string, unknown>;
  constructor(
    code: string,
    status: number,
    message: string,
    opts: { field?: string; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "FormDecisionError";
    this.code = code;
    this.status = status;
    if (opts.field !== undefined) this.field = opts.field;
    if (opts.extra !== undefined) this.extra = opts.extra;
  }
}

/** Thrown when a form-decision references a run this service never started. */
export class UnknownRunError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`no skill run ${runId}`);
    this.name = "UnknownRunError";
    this.runId = runId;
  }
}

/** Thrown when a start names a skill with no registered descriptor (route → 400). */
export class UnknownSkillError extends Error {
  readonly skillId: string;
  constructor(skillId: string) {
    super(`unknown skill '${skillId}'`);
    this.name = "UnknownSkillError";
    this.skillId = skillId;
  }
}

/** The form-decision request body. */
export const FormDecisionBodySchema = z.object({
  decision_id: z.string().min(1),
  decision: z.object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type FormDecisionBody = z.infer<typeof FormDecisionBodySchema>;

/**
 * One skill's run-seam contract: everything the SkillRunService needs that is
 * skill-SPECIFIC. The shape is exactly what driving a flat suspendable Mastra
 * workflow over the /api/skill-runs surface requires — no speculative hooks.
 */
export interface RunDescriptor {
  /** The registry skill id (the start body's `skill` value). */
  skillId: string;
  /** The @autobroker/workflows workflow id this skill's runs execute. */
  workflowId: string;
  /** The wire driver_kind for this skill's runs, DERIVED per call from the
   *  provider policy() actually routes the skill's LLM useCases to. A
   *  registry-string provider swap flips this label in lock-step with the
   *  harness runner's expectDriverKind. */
  driverKind(): HarnessDriverKind;
  /** Validate + shape the start-request body into the workflow inputData.
   *  Throws FormDecisionError("content_invalid", 400, …) with a JSON-pointer
   *  field on bad per-skill fields, so the route maps it onto the standard
   *  error envelope. */
  buildInput(body: Record<string, unknown>): unknown;
  /** Validate + shape a form-decision into the suspended step's typed
   *  resumeData plus the 200 ack body. Absent for skills with no HITL suspend
   *  (a form-decision then 400s as unsupported_action). Throws
   *  FormDecisionError (content_invalid / unsupported_action). */
  resume?(
    step: string,
    decision: FormDecisionBody["decision"],
  ): { resumeData: unknown; ackBody: Record<string, unknown> };
  /** The plain-speak summary for the terminal `text` frame on success. */
  summaryText(result: unknown): string;
}

// ===========================================================================
// search_profile_intake — the first registered descriptor.
// ===========================================================================

/** The intake start body fields (the per-skill slice of the start request). */
const IntakeStartBodySchema = z.object({
  input_mode: z.enum(["slash", "freeform"]),
  freeform_text: z.string().nullable().optional(),
  seed_fields: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** The intake workflow inputData shape. */
interface IntakeStartInput {
  input_mode: "slash" | "freeform";
  freeform_text: string | null;
  seed_fields: Record<string, unknown> | null;
}

/** The exported resume schema for a non-collect intake suspend step. */
function intakeResumeSchemaFor(step: string): z.ZodTypeAny {
  switch (step) {
    case "forceOverrideGate":
      return ForceOverrideResumeSchema;
    case "resolveLocation":
      return AmbiguousLocationResumeSchema;
    case "trimVerify":
    case "prefill":
      return MalformedRetryResumeSchema;
    default:
      // An unknown suspend step is a contract breach — fail LOUD (no silent
      // pass-through into a Mastra resume with un-typed data).
      throw new FormDecisionError(
        "unsupported_action",
        400,
        `no resume schema for suspended step '${step}'`,
      );
  }
}

/**
 * The intake resume shaping (the data_collection form handler). accept →
 * validate content against SearchProfileIntakeInputSchema.strict and map to the
 * collect step's submit resumeData; decline/cancel → the step's decline
 * resumeData + a {action, content:null} ack (terminal-non-write).
 *
 * The non-collect suspends (force-override gate, ambiguous-location, malformed)
 * resume with their own typed resume schemas; the form action vocabulary maps:
 * force_override/revise/retry_step (gate), pick/retry (location), retry_step
 * (malformed). Content threads through to the right schema by step.
 */
function intakeResume(
  step: string,
  decision: FormDecisionBody["decision"],
): { resumeData: unknown; ackBody: Record<string, unknown> } {
  const { action, content } = decision;

  // decline/cancel are terminal-non-write on ANY suspend step.
  if (action === "decline" || action === "cancel") {
    // Every step's resume schema accepts a bare {action:'decline'} member
    // (collect also accepts 'cancel'); normalize cancel → decline for the
    // non-collect steps whose schema has no 'cancel'.
    const resumeAction = step === "collect" ? action : "decline";
    return {
      resumeData: { action: resumeAction },
      ackBody: { action, content: null },
    };
  }

  // accept — the content shape depends on the suspended step.
  if (step === "collect") {
    // The intake form: validate against the strict 18-field schema.
    const parsed = SearchProfileIntakeInputSchema.safeParse(content ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "form content invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    const resume = CollectResumeSchema.parse({ action: "submit", fields: parsed.data });
    return { resumeData: resume, ackBody: { action: "accept", content: parsed.data } };
  }

  // The non-collect suspends carry a typed resume in content.action; validate
  // against the step's exported resume schema.
  const schema = intakeResumeSchemaFor(step);
  const parsed = schema.safeParse(content ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FormDecisionError("content_invalid", 400, "resume content invalid", {
      ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
      extra: { issues: parsed.error.issues },
    });
  }
  return { resumeData: parsed.data, ackBody: { action: "accept", content: parsed.data } };
}

/** The intake descriptor. */
export const intakeRunDescriptor: RunDescriptor = {
  skillId: INTAKE_SKILL_ID,
  workflowId: SEARCH_PROFILE_INTAKE_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the skill's LLM useCases to
  // (intake_trim_verify is the representative — both intake useCases share one
  // alias), so the wire label flips in lock-step with a registry-string swap.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("intake_trim_verify").provider);
  },

  buildInput(body: Record<string, unknown>): IntakeStartInput {
    const parsed = IntakeStartBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "request body invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    return {
      input_mode: parsed.data.input_mode,
      freeform_text: parsed.data.freeform_text ?? null,
      seed_fields: parsed.data.seed_fields ?? null,
    };
  },

  resume: intakeResume,

  // Plain-speak confirm summary (budget red-line: budget is never surfaced in
  // user/dealer-facing copy).
  summaryText(result: unknown): string {
    const r = result as { vehicle?: string; location?: string } | undefined;
    if (r?.vehicle === undefined) return "Search profile created.";
    return `Created search profile for ${r.vehicle}${r.location ? ` near ${r.location}` : ""}.`;
  },
};

// ===========================================================================
// dealer_geosearch — the second registered descriptor (no-suspend browser
// skill, skill #2). No `resume` member: the workflow has no HITL suspend, so a
// form-decision against a geosearch run 400s as unsupported_action.
// ===========================================================================

/** The geosearch start body fields. Only `search_profile_id` matters to the
 *  workflow; the start-route envelope fields (skill, input_mode, session ids…)
 *  ride the same body and are accepted + ignored (non-strict object). */
const GeosearchStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
});

/** The geosearch workflow inputData shape. */
interface GeosearchStartInput {
  search_profile_id: string | null;
}

/** The dealer_geosearch descriptor. */
export const dealerGeosearchDescriptor: RunDescriptor = {
  skillId: GEOSEARCH_SKILL_ID,
  workflowId: DEALER_GEOSEARCH_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the skill's single LLM useCase
  // (geosearch_extract, the snapshot-fallback parse) to — deepseek_apikey under
  // the default registry strings, flipping in lock-step with a provider swap.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("geosearch_extract").provider);
  },

  buildInput(body: Record<string, unknown>): GeosearchStartInput {
    const parsed = GeosearchStartBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "request body invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    return { search_profile_id: parsed.data.search_profile_id ?? null };
  },

  // The workflow's confirm step already templates the full plain-speak summary
  // (counts + nearest dealers + the no-auto-chain ending) — pass it through.
  summaryText(result: unknown): string {
    const r = result as { summary?: string } | undefined;
    return r?.summary ?? "Dealer geosearch complete.";
  },
};

// ===========================================================================
// The descriptor registry + the skill-agnostic run service.
// ===========================================================================

/** Every skill the server can start runs for, in registration order. */
export const RUN_DESCRIPTORS: readonly RunDescriptor[] = [
  intakeRunDescriptor,
  dealerGeosearchDescriptor,
];

const DESCRIPTORS_BY_SKILL = new Map(RUN_DESCRIPTORS.map((d) => [d.skillId, d]));

/** Workflow ids actually registered on the Mastra instance — a descriptor whose
 *  workflow has not landed yet is skipped when scanning storage, because
 *  getWorkflow() on an unregistered id throws. */
const REGISTERED_WORKFLOW_ID_SET = new Set(REGISTERED_WORKFLOW_IDS);

/** The stored ack snapshot for a consumed claim (replayed on idempotent retry). */
interface AckSnapshot {
  /** The HTTP body the first successful claim returned (200). */
  body: Record<string, unknown>;
}

/** A claim's lifecycle (three-phase). */
type ClaimPhase = "processing" | "consumed";
interface Claim {
  phase: ClaimPhase;
  /** A stable hash of the request body, to detect a same-vs-different replay. */
  bodyKey: string;
  /** The stored ack, present once consumed. */
  ack?: AckSnapshot;
}

/** Per-run state this service tracks: the current pending suspend (step +
 *  decisionId) and the claim table keyed by decisionId. */
interface RunState {
  skill: string;
  /** The session (Mastra thread) this run is associated with, or null for a
   *  headless start with no rail. The run↔session link is recorded here so
   *  status/turn rendering can find it; full turn-model rendering is the UI's read
   *  (skill_runs.session_id ↔ thread metadata). */
  sessionId: string | null;
  /** The step id + decisionId of the CURRENTLY pending suspend, or null when the
   *  run is running/terminal. The form-decision must reference this decisionId. */
  pending: { step: string; decisionId: string } | null;
  /** Whether a terminal frame has been emitted (the run is over). */
  terminal: boolean;
  claims: Map<string, Claim>;
}

/** Map a suspended step's payload → the awaiting_user form_kind. The gate/
 *  location/malformed suspends are approval-style forms but all resume through
 *  this same channel. */
function formKindFor(payload: Record<string, unknown>): string {
  const kind = payload["kind"];
  return typeof kind === "string" ? kind : "data_collection";
}

/** Stable body key for same-vs-different claim detection (Phase 1). */
function bodyKeyOf(body: FormDecisionBody): string {
  // Canonical: action + sorted-key content JSON. decline/cancel have no content.
  const content = body.decision.content ?? null;
  return JSON.stringify({ action: body.decision.action, content });
}

/**
 * The skill run service. One instance per server, holding the Mastra instance
 * (driven via the glue) and the per-run claim/pending state + the pubsub. The
 * skill-specific shaping is delegated to the run's RunDescriptor.
 */
export class SkillRunService {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly mastra: MastraInstance,
    private readonly pubsub: RunPubSub,
  ) {}

  /** The registered descriptor for a skill id, or undefined (route → 400). */
  descriptorFor(skillId: string): RunDescriptor | undefined {
    return DESCRIPTORS_BY_SKILL.get(skillId);
  }

  /** True when this service started (and still tracks) the run. */
  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** The descriptor a tracked run was started under — always registered, since
   *  run.skill is only ever set from a descriptor's own skillId. */
  private descriptorOf(run: RunState): RunDescriptor {
    const d = DESCRIPTORS_BY_SKILL.get(run.skill);
    if (d === undefined) throw new Error(`no run descriptor for skill '${run.skill}'`);
    return d;
  }

  /**
   * Re-attach a suspended run recovered by recoverOnBoot after a fresh boot
   * (crash-and-resume). The Mastra snapshot (mastra.db) is the durable truth —
   * the workflow + step closures were re-registered by module import,
   * the run is re-attachable. This re-builds the in-memory run state + a fresh
   * decisionId for the pending suspend, re-emits the init + awaiting_user frames
   * into a fresh pubsub channel, so a form-decision can resume the SAME run in
   * THIS process. The recovered suspend payload is read from
   * getWorkflowRunById(runId).steps[step].suspendPayload (live-probed).
   *
   * Idempotent: a second re-attach of an already-tracked run is a no-op. A run
   * whose workflowId no descriptor owns is left in storage untouched.
   */
  async reattach(runId: string, workflowId: string): Promise<void> {
    if (this.runs.has(runId)) return;
    const descriptor = RUN_DESCRIPTORS.find((d) => d.workflowId === workflowId);
    if (descriptor === undefined) return;
    const workflow = this.mastra.getWorkflow(descriptor.workflowId);
    const state = (await workflow.getWorkflowRunById(runId)) as {
      status?: string;
      steps?: Record<string, { status?: string; suspendPayload?: Record<string, unknown> }>;
    } | null;
    if (state === null || state.status !== "suspended") return;

    const entry = Object.entries(state.steps ?? {}).find(
      ([, s]) => s.status === "suspended" && s.suspendPayload !== undefined,
    );
    if (entry === undefined) return;
    const step = entry[0];
    const payload = entry[1].suspendPayload ?? {};

    this.pubsub.attachInit(runId, descriptor.skillId, descriptor.driverKind());
    const decisionId = randomUUID();
    this.runs.set(runId, {
      skill: descriptor.skillId,
      sessionId: null,
      pending: { step, decisionId },
      terminal: false,
      claims: new Map(),
    });
    this.pubsub.append(runId, {
      kind: "awaiting_user",
      payload: { form_kind: formKindFor(payload), spec_inline: payload, decision_id: decisionId, step },
    });
  }

  /**
   * Start a skill run. The input is the descriptor-built workflow inputData
   * (the route runs buildInput BEFORE any session fork so a bad body leaves no
   * side effects). Generates a uuid runId when absent. Opens the pubsub channel
   * (init frame, driver_kind injected), then drives the first start() and
   * translates the result. Returns the runId. A DuplicateRunIdError from
   * startRunGuarded propagates (the route maps it to 409).
   */
  async start(args: {
    skill: string;
    runId?: string;
    input: unknown;
    sessionId?: string | null;
  }): Promise<{ runId: string }> {
    const descriptor = DESCRIPTORS_BY_SKILL.get(args.skill);
    if (descriptor === undefined) {
      throw new UnknownSkillError(args.skill);
    }
    const runId = args.runId ?? randomUUID();

    // First frame: init {run_id, skill, driver_kind} (the pubsub injects
    // driver_kind). attachInit is idempotent; a re-used runId without a prior run
    // would already have a channel — but startRunGuarded below rejects a dup id.
    this.pubsub.attachInit(runId, descriptor.skillId, descriptor.driverKind());

    this.runs.set(runId, {
      skill: descriptor.skillId,
      sessionId: args.sessionId ?? null,
      pending: null,
      terminal: false,
      claims: new Map(),
    });

    const workflow = this.mastra.getWorkflow(descriptor.workflowId);
    // startRunGuarded is the dup-runId gate (DuplicateRunIdError → 409) AND the
    // ownership registration recoverOnBoot reads. It awaits the first start().
    const { result } = await startRunGuarded(workflow, {
      runId,
      inputData: args.input,
    });

    this.translate(runId, result);
    return { runId };
  }

  /**
   * Submit a form-decision (the three-phase idempotent claim). Returns the 200
   * ack body. Throws FormDecisionError (mapped to the error-envelope codes) on any
   * non-200 path, or UnknownRunError (404) for an untracked run.
   */
  async formDecision(runId: string, body: FormDecisionBody): Promise<Record<string, unknown>> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new UnknownRunError(runId);
    }

    const decisionId = body.decision_id;
    const key = bodyKeyOf(body);

    // ----- Phase 1 lookup (lock): a KNOWN (run_id, decision_id) is resolved by
    // the claim table FIRST — an idempotent replay / conflict for an
    // already-seen decision must succeed even after the run later went terminal
    // (the consumed-snapshot replay is the idempotency guarantee). Only a
    // decisionId that is neither a known claim NOR the current pending suspend
    // falls through to the terminal / not-found guards.
    const existing = run.claims.get(decisionId);
    if (existing !== undefined) {
      if (existing.phase === "consumed") {
        if (existing.bodyKey === key && existing.ack !== undefined) {
          // Idempotent replay of the SAME body → return the stored ack (NOT a
          // second Mastra resume; that would throw "not suspended").
          return existing.ack.body;
        }
        // consumed with a DIFFERENT body → 409 decision_conflict.
        throw new FormDecisionError(
          "decision_conflict",
          409,
          `decision ${decisionId} already consumed with a different body`,
        );
      }
      // phase === "processing" → a concurrent claim is mid-flight.
      throw new FormDecisionError("decision_in_flight", 409, "decision in flight", {
        extra: { retry_after_ms: 250 },
      });
    }

    // A NEW decisionId: it must reference the CURRENTLY pending suspend. A run
    // with no pending suspend that is terminal → 410; otherwise → 404.
    if (run.pending === null || run.pending.decisionId !== decisionId) {
      if (run.terminal) {
        throw new FormDecisionError("run_terminal", 410, `run ${runId} is terminal`);
      }
      throw new FormDecisionError(
        "decision_not_found",
        404,
        `decision ${decisionId} not found for run ${runId}`,
      );
    }

    // ----- Phase 1 (lock): claim pending → processing -----------------------
    // Crash semantics (in-memory claim + Mastra snapshot as durable truth): a
    // crash mid-`processing` drops this Map entry; on reboot `reattach` mints a
    // FRESH decisionId off the snapshot's pending suspend, so a post-crash
    // resubmit can never collide with the lost claim.
    run.claims.set(decisionId, { phase: "processing", bodyKey: key });

    // ----- Phase 2 (no lock): dispatch the descriptor's resume + Mastra resume
    const descriptor = this.descriptorOf(run);
    let resumeData: unknown;
    let ackBody: Record<string, unknown>;
    try {
      if (descriptor.resume === undefined) {
        // A skill with no HITL suspend cannot accept a form-decision.
        throw new FormDecisionError(
          "unsupported_action",
          400,
          `skill '${run.skill}' accepts no form-decision`,
        );
      }
      const dispatched = descriptor.resume(run.pending.step, body.decision);
      resumeData = dispatched.resumeData;
      ackBody = dispatched.ackBody;
    } catch (err) {
      // content_invalid / unsupported_action → rollback processing → pending.
      run.claims.delete(decisionId);
      throw err;
    }

    const step = run.pending.step;
    let result: unknown;
    try {
      const workflow = this.mastra.getWorkflow(descriptor.workflowId);
      const handle = await workflow.createRun({ runId });
      result = await handle.resume({ step, resumeData });
    } catch (err) {
      // A resume failure (e.g. the run was concurrently driven terminal) →
      // rollback the claim and surface as run_terminal (defensive; the single
      // process topology makes this rare).
      run.claims.delete(decisionId);
      throw new FormDecisionError(
        "run_terminal",
        410,
        `resume failed for run ${runId}: ${(err as Error).message}`,
      );
    }

    // The pending suspend is consumed; clear it before translating the next state
    // (translate sets a fresh pending if the run suspended again).
    run.pending = null;
    this.translate(runId, result);

    // ----- Phase 3 (lock): consume + store the ack snapshot -----------------
    run.claims.set(decisionId, {
      phase: "consumed",
      bodyKey: key,
      ack: { body: ackBody },
    });
    return ackBody;
  }

  /**
   * Translate a WorkflowResult into SSE frames + run state. A discriminated
   * result on status (live-probed 1.41: suspended | success | failed | ...).
   */
  private translate(runId: string, result: unknown): void {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    const r = result as {
      status: string;
      result?: { outcome?: string } | undefined;
      steps?: Record<string, { status?: string; suspendPayload?: Record<string, unknown> }>;
      error?: unknown;
    };

    if (r.status === "suspended") {
      // Find the suspended step + its payload (steps[id].status === 'suspended').
      const entry = Object.entries(r.steps ?? {}).find(
        ([, s]) => s.status === "suspended" && s.suspendPayload !== undefined,
      );
      const step = entry?.[0] ?? "collect";
      const payload = entry?.[1]?.suspendPayload ?? {};
      const decisionId = randomUUID();
      run.pending = { step, decisionId };
      // awaiting_user{form_kind, spec_inline, decision_id, ...}.
      this.pubsub.append(runId, {
        kind: "awaiting_user",
        payload: {
          form_kind: formKindFor(payload),
          spec_inline: payload,
          decision_id: decisionId,
          step,
        },
      });
      return;
    }

    if (r.status === "success") {
      const outcome = r.result?.outcome;
      if (outcome === "declined") {
        // A decline is terminal: wire kind aborted → status projects declined
        // (the app metadata is the decline outcome).
        run.terminal = true;
        this.pubsub.append(runId, {
          kind: "aborted",
          payload: { reason: "user_declined" },
        });
        return;
      }
      // Completed: the skill's plain-speak summary then done. When the
      // workflow output carries a `resolution` provenance (pinned vs
      // inferred_newest, the profile-resolution branch the run took), it rides
      // the terminal TEXT frame payload — skill-agnostic copy, the done frame
      // stays {}.
      run.terminal = true;
      const textPayload: Record<string, unknown> = {
        text: this.descriptorOf(run).summaryText(r.result),
      };
      const resolution = (r.result as { resolution?: unknown } | undefined)?.resolution;
      if (typeof resolution === "string") textPayload["resolution"] = resolution;
      this.pubsub.append(runId, { kind: "text", payload: textPayload });
      this.pubsub.append(runId, { kind: "done", payload: {} });
      return;
    }

    // failed | tripwire | bailed → error (the #1244 hard-abort path).
    if (r.status === "failed" || r.status === "tripwire" || r.status === "bailed") {
      run.terminal = true;
      this.pubsub.append(runId, {
        kind: "error",
        payload: this.errorFramePayload(r.error),
      });
      return;
    }

    if (r.status === "canceled") {
      run.terminal = true;
      this.pubsub.append(runId, { kind: "aborted", payload: { reason: "canceled" } });
      return;
    }

    // running/waiting/pending/paused: no terminal frame; the run is still live.
    // (The drive loop is event-driven via form-decision; nothing to emit here.)
  }

  /**
   * Build the error frame payload from a run error. Accepted shapes, in
   * priority order:
   *   1. any object carrying a string `message` — the Mastra default engine
   *      delivers step errors as FLAT toJSON()'d objects {message, name, code}
   *      (NOT Error instances; identical live and after snapshot rehydration,
   *      stack stripped). A live in-process Error instance matches the same
   *      defensive reads (message/name/code).
   *   2. a bare string → the reason verbatim.
   *   3. anything else → the generic "workflow_failed".
   * `message` goes on the wire as the user-facing reason (typed STOP wording
   * stays verbatim); `name` + `code` ride alongside so the UI can dispatch a
   * STOP card on name PLUS a code allowlist — code alone is NOT discriminating
   * (native errors like SqliteError also carry a `code`).
   */
  private errorFramePayload(error: unknown): Record<string, unknown> {
    if (error !== null && typeof error === "object") {
      const e = error as { message?: unknown; name?: unknown; code?: unknown };
      if (typeof e.message === "string") {
        return {
          reason: e.message,
          ...(typeof e.name === "string" ? { name: e.name } : {}),
          ...(typeof e.code === "string" ? { code: e.code } : {}),
        };
      }
    }
    if (typeof error === "string") return { reason: error };
    return { reason: "workflow_failed" };
  }

  /** The current pending suspend (step + decisionId), for GET /skill-runs/:id. */
  pendingOf(runId: string): { step: string; decisionId: string } | null {
    return this.runs.get(runId)?.pending ?? null;
  }

  /** The session (Mastra thread) this run is linked to, or null (run↔session
   *  association; skill_runs.session_id ↔ thread metadata). */
  sessionOf(runId: string): string | null {
    return this.runs.get(runId)?.sessionId ?? null;
  }

  /**
   * The status summary for GET /api/skill-runs/:id: the product-projected status,
   * the current pending suspend (if any), and the full SSE event backlog. Reads
   * the live Mastra run status via getWorkflowRunById and applies the status
   * projection. A run this service does not track but that lives in storage still
   * resolves (re-attached after a boot) by scanning the registered workflows;
   * null only when storage has no such run.
   */
  async statusSummary(runId: string): Promise<{
    run_id: string;
    skill: string;
    status: string;
    session_id: string | null;
    pending: { step: string; decision_id: string } | null;
    events: unknown[];
  } | null> {
    const tracked = this.runs.get(runId);
    let skill: string;
    let state: { status?: string } | null = null;

    if (tracked !== undefined) {
      skill = tracked.skill;
      const workflow = this.mastra.getWorkflow(this.descriptorOf(tracked).workflowId);
      state = (await workflow.getWorkflowRunById(runId)) as { status?: string } | null;
    } else {
      const found = await this.findInStorage(runId);
      if (found === null) return null;
      skill = found.skill;
      state = found.state;
    }

    const mastraStatus = (state?.status ?? "running") as MastraRunStatus;
    // The decline hint: this service emitted an aborted-for-decline frame, or the
    // workflow result was {outcome:'declined'}. We track terminal + read the
    // pubsub's last terminal kind to distinguish declined from aborted/done.
    const declined = this.lastTerminalWasDecline(runId);
    const status = projectStatus(mastraStatus, declined ? { declined: true } : {});
    const pending = tracked?.pending ?? null;
    return {
      run_id: runId,
      skill,
      status,
      session_id: tracked?.sessionId ?? null,
      pending: pending ? { step: pending.step, decision_id: pending.decisionId } : null,
      events: this.pubsub.snapshot(runId),
    };
  }

  /** Find an untracked run in storage by asking each descriptor's REGISTERED
   *  workflow (a descriptor whose workflow has not landed is skipped). */
  private async findInStorage(
    runId: string,
  ): Promise<{ skill: string; state: { status?: string } } | null> {
    for (const d of RUN_DESCRIPTORS) {
      if (!REGISTERED_WORKFLOW_ID_SET.has(d.workflowId)) continue;
      const state = (await this.mastra
        .getWorkflow(d.workflowId)
        .getWorkflowRunById(runId)) as { status?: string } | null;
      if (state !== null) return { skill: d.skillId, state };
    }
    return null;
  }

  /** True when the run's terminal frame was an aborted-for-decline (vs done/error
   *  /abort). Read off the pubsub backlog: a decline lands as aborted{reason:
   *  'user_declined'}. Used to project declined vs aborted. */
  private lastTerminalWasDecline(runId: string): boolean {
    const log = this.pubsub.snapshot(runId);
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const ev = log[i] as { kind: string; payload?: { reason?: string } };
      if (ev.kind === "aborted") return ev.payload?.reason === "user_declined";
      if (ev.kind === "done" || ev.kind === "error") return false;
    }
    return false;
  }

  /** True once a terminal frame was emitted for the run. */
  isTerminal(runId: string): boolean {
    return this.runs.get(runId)?.terminal ?? false;
  }

  /** Test-only: drop all run state between isolated cases. */
  resetForTests(): void {
    this.runs.clear();
  }
}
