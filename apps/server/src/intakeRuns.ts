/**
 * intakeRuns — the app-side intake run service (BACKEND_SERVICES §5/§7/§12).
 * Starts the search_profile_intake workflow, translates its suspend/resume
 * progress into runPubSub SSE events, and owns the three-phase idempotent
 * form-decision claim. This is the "runtime glue" wiring on the app side: it
 * drives the workflows-layer Mastra run through the EXPORTED glue functions
 * (startRunGuarded) — it never imports @mastra directly (the Mastra/run types
 * flow in by inference from the workflows exports) and never opens the product DB.
 *
 * RUN DRIVE LOOP (§12 swimlane): a run can suspend MULTIPLE times (collect form,
 * force-override gate, ambiguous-location ask-pick, #1244 malformed). Each
 * start()/resume() returns a WorkflowResult discriminated on status:
 *   - suspended → emit awaiting_user{decision_id, form_kind, spec_inline, ...}
 *     from result.steps[suspendedStep].suspendPayload; the run waits for a
 *     form-decision that resumes that step. We DO NOT loop here — the human is
 *     the next event source.
 *   - success → if the workflow's own output is {outcome:'declined'} emit
 *     aborted (status projects to `declined`); else emit text(summary) + done.
 *   - failed/tripwire → emit error{reason}.
 *
 * THE THREE-PHASE IDEMPOTENT CLAIM (§7.2, the 2026-06-04 ruling: in-memory claim
 * map + Mastra snapshot as durable truth). The claim is keyed (runId, decisionId)
 * — the decisionId rides each awaiting_user frame so the form echoes it back.
 *   - Phase 1 (lock): pending → processing. Reject a double-claim of a DIFFERENT
 *     body (409 decision_conflict); REPLAY the stored ack for the SAME body once
 *     consumed (200, idempotent — NOT a second Mastra resume; a second resume of
 *     an already-resolved suspend THROWS "not suspended", live-probed); a
 *     concurrent processing claim → 409 decision_in_flight.
 *   - Phase 2 (no lock): dispatch the data_collection handler (validate content
 *     against SearchProfileIntakeInputSchema.strict for accept; decline/cancel
 *     pass through), then Mastra resume({step, resumeData}). Validation failure →
 *     400 content_invalid + rollback processing→pending.
 *   - Phase 3 (lock): consumed; store the ack snapshot; the resume's terminal/
 *     next-suspend translation already fanned out to SSE.
 *
 * Single-process topology (127.0.0.1:8100, one Node process): the claim map's
 * synchronous map ops ARE the lock (single-threaded JS). The runtimeGlue
 * startRunGuarded dup-runId guard covers the start path; this claim map covers
 * the resume path.
 *
 * Dependency wall: app layer. Imports core (schemas/status), tools (the intake
 * input schema for content validation lives in core; profile reads are the
 * routes' job), workflows (the run drive + glue) — NEVER @mastra, NEVER the DB.
 */

import { randomUUID } from "node:crypto";

import { SearchProfileIntakeInputSchema, providerDriverKind } from "@autobroker/core";
import { policy } from "@autobroker/model";
import {
  startRunGuarded,
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

/** The intake workflow id (must match SEARCH_PROFILE_INTAKE_WORKFLOW_ID). */
const INTAKE_WORKFLOW_ID = "search_profile_intake";
/** The single skill name M1 exposes. */
export const INTAKE_SKILL = "search_profile_intake" as const;

/** The driver_kind for intake runs, DERIVED from the provider policy() actually
 *  routes the skill's LLM useCases to (intake_trim_verify is the representative
 *  — both intake useCases share one alias). A registry-string provider swap
 *  (USE_CASE_ALIAS edit) flips this label in lock-step with the harness
 *  runner's expectDriverKind (D-B4; review HIGH 2026-06-05). */
export function intakeDriverKind(): ReturnType<typeof providerDriverKind> {
  return providerDriverKind(policy("intake_trim_verify").provider);
}

/** The start-intake input (task BUILD §5 / route §3.2 body shape). */
export interface IntakeStartInput {
  input_mode: "slash" | "freeform";
  freeform_text: string | null;
  seed_fields: Record<string, unknown> | null;
}

/** A typed error the route maps to its HTTP code (the error envelope, §13.2). */
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

/** The form-decision request body (§7.1). */
export const FormDecisionBodySchema = z.object({
  decision_id: z.string().min(1),
  decision: z.object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type FormDecisionBody = z.infer<typeof FormDecisionBodySchema>;

/** The stored ack snapshot for a consumed claim (replayed on idempotent retry). */
interface AckSnapshot {
  /** The HTTP body the first successful claim returned (200). */
  body: Record<string, unknown>;
}

/** A claim's lifecycle (§7.2 three-phase). */
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
   *  headless start with no rail. M2-minimal: the run↔session link is recorded
   *  here so status/turn rendering can find it; full turn-model rendering is the
   *  UI's read (BACKEND_SERVICES §6.1 skill_runs.session_id ↔ thread metadata). */
  sessionId: string | null;
  /** The step id + decisionId of the CURRENTLY pending suspend, or null when the
   *  run is running/terminal. The form-decision must reference this decisionId. */
  pending: { step: string; decisionId: string } | null;
  /** Whether a terminal frame has been emitted (the run is over). */
  terminal: boolean;
  claims: Map<string, Claim>;
}

/** Map a suspended step id → the awaiting_user form_kind / suspend payload kind.
 *  collect = the data_collection intake form; the gate/location/malformed
 *  suspends are approval-style forms but all resume through this same channel. */
function formKindFor(payload: Record<string, unknown>): string {
  const kind = payload["kind"];
  return typeof kind === "string" ? kind : "data_collection";
}

/** Stable body key for same-vs-different claim detection (§7.2 Phase 1). */
function bodyKeyOf(body: FormDecisionBody): string {
  // Canonical: action + sorted-key content JSON. decline/cancel have no content.
  const content = body.decision.content ?? null;
  return JSON.stringify({ action: body.decision.action, content });
}

/**
 * The intake run service. One instance per server, holding the Mastra instance
 * (driven via the glue) and the per-run claim/pending state + the pubsub.
 */
export class IntakeRunService {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly mastra: MastraInstance,
    private readonly pubsub: RunPubSub,
  ) {}

  /** True when this service started (and still tracks) the run. */
  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * Re-attach a suspended run recovered by recoverOnBoot after a fresh boot (M1
   * EXIT 2, crash-and-resume). The Mastra snapshot (mastra.db) is the durable
   * truth — the workflow + step closures were re-registered by module import,
   * the run is re-attachable. This re-builds the in-memory run state + a fresh
   * decisionId for the pending suspend, re-emits the init + awaiting_user frames
   * into a fresh pubsub channel, so a form-decision can resume the SAME run in
   * THIS process. The recovered suspend payload is read from
   * getWorkflowRunById(runId).steps[step].suspendPayload (live-probed).
   *
   * Idempotent: a second re-attach of an already-tracked run is a no-op.
   */
  async reattach(runId: string): Promise<void> {
    if (this.runs.has(runId)) return;
    const workflow = this.mastra.getWorkflow(INTAKE_WORKFLOW_ID);
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

    this.pubsub.attachInit(runId, INTAKE_SKILL, intakeDriverKind());
    const decisionId = randomUUID();
    this.runs.set(runId, {
      skill: INTAKE_SKILL,
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
   * Start an intake run. Generates a uuid runId when absent. Opens the pubsub
   * channel (init frame, driver_kind injected), emits a `running`-equivalent
   * (init IS the first frame; no separate running wire kind — status projection
   * reports running), then drives the first start() and translates the result.
   * Returns the runId. A DuplicateRunIdError from startRunGuarded propagates
   * (the route maps it to 409).
   */
  async start(args: {
    runId?: string;
    input: IntakeStartInput;
    sessionId?: string | null;
  }): Promise<{ runId: string }> {
    const runId = args.runId ?? randomUUID();

    // First frame: init {run_id, skill, driver_kind} (the pubsub injects
    // driver_kind). attachInit is idempotent; a re-used runId without a prior run
    // would already have a channel — but startRunGuarded below rejects a dup id.
    this.pubsub.attachInit(runId, INTAKE_SKILL, intakeDriverKind());

    this.runs.set(runId, {
      skill: INTAKE_SKILL,
      sessionId: args.sessionId ?? null,
      pending: null,
      terminal: false,
      claims: new Map(),
    });

    const workflow = this.mastra.getWorkflow(INTAKE_WORKFLOW_ID);
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
   * Submit a form-decision (the three-phase idempotent claim, §7.2). Returns the
   * 200 ack body. Throws FormDecisionError (mapped to the §13.2 codes) on any
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
    // (§7.2: the consumed-snapshot replay is the idempotency guarantee). Only a
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
    // Crash semantics (2026-06-04 ruling: in-memory claim + Mastra snapshot as
    // durable truth): a crash mid-`processing` drops this Map entry; on reboot
    // `reattach` mints a FRESH decisionId off the snapshot's pending suspend,
    // so a post-crash resubmit can never collide with the lost claim.
    run.claims.set(decisionId, { phase: "processing", bodyKey: key });

    // ----- Phase 2 (no lock): dispatch handler + Mastra resume --------------
    let resumeData: unknown;
    let ackBody: Record<string, unknown>;
    try {
      const dispatched = this.dispatchDataCollection(run.pending.step, body.decision);
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
      const workflow = this.mastra.getWorkflow(INTAKE_WORKFLOW_ID);
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
   * The data_collection handler (§7.3, _handle_kind_data_collection equivalent).
   * accept → validate content against SearchProfileIntakeInputSchema.strict and
   * map to the collect step's submit resumeData; decline/cancel → the step's
   * decline resumeData + a {action, content:null} ack (terminal-non-write).
   *
   * The non-collect suspends (force-override gate, ambiguous-location, malformed)
   * resume with their own typed resume schemas; the form action vocabulary maps
   * per §7 / route table: force_override/revise/retry_step (gate), pick/retry
   * (location), retry_step (malformed). The route validates against the EXPORTED
   * resume schemas; here we just thread content through to the right schema by
   * step.
   */
  private dispatchDataCollection(
    step: string,
    decision: FormDecisionBody["decision"],
  ): { resumeData: unknown; ackBody: Record<string, unknown> } {
    const { action, content } = decision;

    // decline/cancel are terminal-non-write on ANY suspend step (§7.3).
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
      // The intake form: validate against the strict 18-field schema (§7.3).
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
    // against the step's exported resume schema. The form maps its action vocab
    // (force_override/revise/retry_step/pick/retry) into content.
    const schema = this.resumeSchemaFor(step);
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

  /** The exported resume schema for a non-collect suspend step. */
  private resumeSchemaFor(step: string): z.ZodTypeAny {
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
      // awaiting_user{form_kind, spec_inline, decision_id, ...} (§4.2/§5.3).
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
        // A decline is terminal: wire kind aborted (§4.4) → status projects
        // declined (the app metadata is the decline outcome).
        run.terminal = true;
        this.pubsub.append(runId, {
          kind: "aborted",
          payload: { reason: "user_declined" },
        });
        return;
      }
      // Created: plain-speak summary then done (§12.1 confirm step).
      run.terminal = true;
      this.pubsub.append(runId, {
        kind: "text",
        payload: { text: this.summaryText(r.result) },
      });
      this.pubsub.append(runId, { kind: "done", payload: {} });
      return;
    }

    // failed | tripwire | bailed → error (§4.2/§5.3, #1244 hard-abort path).
    if (r.status === "failed" || r.status === "tripwire" || r.status === "bailed") {
      run.terminal = true;
      this.pubsub.append(runId, {
        kind: "error",
        payload: { reason: this.errorReason(r.error) },
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

  /** Build the confirm plain-speak summary (budget excluded — §9). */
  private summaryText(result: unknown): string {
    const r = result as { vehicle?: string; location?: string; profileId?: string } | undefined;
    if (r?.vehicle === undefined) return "Search profile created.";
    return `Created search profile for ${r.vehicle}${r.location ? ` near ${r.location}` : ""}.`;
  }

  /** Coerce a run error into a wire reason string. */
  private errorReason(error: unknown): string {
    if (error === undefined || error === null) return "workflow_failed";
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "workflow_failed";
  }

  /** The current pending suspend (step + decisionId), for GET /skill-runs/:id. */
  pendingOf(runId: string): { step: string; decisionId: string } | null {
    return this.runs.get(runId)?.pending ?? null;
  }

  /** The session (Mastra thread) this run is linked to, or null (M2 run↔session
   *  association; BACKEND_SERVICES §6.1 skill_runs.session_id ↔ thread metadata). */
  sessionOf(runId: string): string | null {
    return this.runs.get(runId)?.sessionId ?? null;
  }

  /**
   * The status summary for GET /api/skill-runs/:id: the product-projected status,
   * the current pending suspend (if any), and the full SSE event backlog. Reads
   * the live Mastra run status via getWorkflowRunById and applies the §5/§6
   * projection. A run this service does not track but that lives in storage still
   * resolves (re-attached after a boot); null only when storage has no such run.
   */
  async statusSummary(runId: string): Promise<{
    run_id: string;
    skill: string;
    status: string;
    session_id: string | null;
    pending: { step: string; decision_id: string } | null;
    events: unknown[];
  } | null> {
    const workflow = this.mastra.getWorkflow(INTAKE_WORKFLOW_ID);
    const state = (await workflow.getWorkflowRunById(runId)) as {
      status?: string;
    } | null;
    const tracked = this.runs.get(runId);
    if (state === null && tracked === undefined) {
      return null;
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
      skill: tracked?.skill ?? INTAKE_SKILL,
      status,
      session_id: tracked?.sessionId ?? null,
      pending: pending ? { step: pending.step, decision_id: pending.decisionId } : null,
      events: this.pubsub.snapshot(runId),
    };
  }

  /** True when the run's terminal frame was an aborted-for-decline (vs done/error
   *  /abort). Read off the pubsub backlog: a decline lands as aborted{reason:
   *  'user_declined'}. Used to project declined vs aborted (§5). */
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
