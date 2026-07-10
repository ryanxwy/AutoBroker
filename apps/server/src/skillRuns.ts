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
 * gate, ambiguous-location ask-pick). Each start()/resume()
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
 * The form-decision claim map remains process-local: synchronous map ops are the
 * lock inside the server instance that owns/reattached the run. Run START
 * ownership is different and is cross-process through the durable SQLite claim;
 * runtimeGlue's dup-runId guard remains defense in depth inside one process.
 *
 * Dependency wall: app layer. Imports core (schemas/status), skills (ids),
 * workflows (the run drive + glue) — NEVER @mastra, NEVER the DB.
 */

import { randomUUID } from "node:crypto";

import {
  SearchProfileIntakeInputSchema,
  providerDriverKind,
  selectionDriverKind,
  type AgentSelection,
  type HarnessDriverKind,
  type SearchProfileIntakeInput,
} from "@autobroker/core";
import { policy } from "@autobroker/model";
import {
  GEOSEARCH_SKILL_ID,
  HYGIENE_SKILL_ID,
  INBOX_CHECK_SKILL_ID,
  INCENTIVE_SCRAPE_SKILL_ID,
  INTAKE_SKILL_ID,
  INVENTORY_AGGREGATOR_SCAN_SKILL_ID,
  INVENTORY_COMPARE_SKILL_ID,
  INVENTORY_LINK_SCAN_SKILL_ID,
  INVENTORY_SITE_SCAN_SKILL_ID,
  QUOTE_AUDIT_SKILL_ID,
  QUOTE_COMPARE_SKILL_ID,
  QUOTE_PIPELINE_SKILL_ID,
  REPLY_EXTRACT_SKILL_ID,
} from "@autobroker/skills";
import {
  beginRunGuarded,
  releaseRunOwnership,
  clearContactFlipForRun,
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
  DAILY_DIGEST_WORKFLOW_ID,
  DEALER_GEOSEARCH_WORKFLOW_ID,
  DEALER_HYGIENE_WORKFLOW_ID,
  DEALER_INBOX_CHECK_WORKFLOW_ID,
  DEALER_REPLY_EXTRACT_WORKFLOW_ID,
  DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID,
  NEGOTIATION_FOLLOWUP_WORKFLOW_ID,
  DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID,
  INCENTIVE_SCRAPE_WORKFLOW_ID,
  INVENTORY_AGGREGATOR_SCAN_WORKFLOW_ID,
  INVENTORY_COMPARE_WORKFLOW_ID,
  INVENTORY_LINK_SCAN_WORKFLOW_ID,
  INVENTORY_SITE_SCAN_WORKFLOW_ID,
  PIPELINE_RESET_WORKFLOW_ID,
  QUOTE_AUDIT_WORKFLOW_ID,
  QUOTE_COMPARE_WORKFLOW_ID,
  QUOTE_PIPELINE_WORKFLOW_ID,
  REGISTERED_WORKFLOW_IDS,
  CollectResumeSchema,
  AmbiguousLocationResumeSchema,
  TrimSuggestionResumeSchema,
  BatchReviewResumeSchema,
  HygieneResumeSchema,
  LeadApprovalResumeSchema,
  PipelineResetResumeSchema,
  ContactFlipApprovalResumeSchema,
  QuotePipelineSendResumeSchema,
  requestContactFlipForRun,
  resolveSelectionForRun,
  type createMastraInstance,
} from "@autobroker/workflows";
import {
  getDb,
  validateResetToken,
  tryClaimActivation,
  clearActivationByRunId,
  writeLastProgressAt,
} from "@autobroker/tools";
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

/** A different live run already owns the requested search profile. The claim
 * is acquired before Mastra run creation, so this conflict has zero workflow,
 * channel, or session side effects. */
export class ProfileRunConflictError extends Error {
  constructor(
    readonly profileId: string,
    readonly attemptedRunId: string,
    readonly liveRunId: string | null,
  ) {
    super(
      `profile '${profileId}' already has live run '${liveRunId ?? "unknown"}'; ` +
        `refusing concurrent run '${attemptedRunId}'`,
    );
    this.name = "ProfileRunConflictError";
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
   *  FormDecisionError (content_invalid / unsupported_action).
   *  `suspendPayload` is the RETAINED payload of the suspend being answered
   *  (the exact spec_inline the user saw) — a descriptor that must validate
   *  the answer against what was shown (e.g. the batch_review approved-ids ⊆
   *  shown-targets check) reads it; descriptors that don't need it simply
   *  declare two parameters (wire-identical behavior). */
  resume?(
    step: string,
    decision: FormDecisionBody["decision"],
    suspendPayload: Record<string, unknown>,
  ): { resumeData: unknown; ackBody: Record<string, unknown> };
  /** The plain-speak summary for the terminal `text` frame on success. */
  summaryText(result: unknown): string;
}

/**
 * The wire `driver_kind` for a run's init frame. A run with a resolved
 * AgentSelection (an explicit bar pick registered for this runId, or the
 * `AUTOBROKER_AGENT_PROVIDER` env default — e.g. `/e2e-loop --provider claude`)
 * takes that selection's provider; otherwise the descriptor's policy-default
 * label. This keeps the rail's run footer honest: the descriptor default always
 * reads `deepseek_apikey`, so without this a Claude run would mislabel as DeepSeek.
 *
 * The label is METHOD-AWARE: a Claude OAuth-subscription run (anthropic+oauth,
 * lane B) reads `anthropic_oauth`, NOT `anthropic_apikey` — same provider, the
 * subscription method, not the api key. Without this an OAuth run mislabels as an
 * api-key run even though the ledger records `pricing_source=subscription`.
 */
function runDriverKind(descriptor: RunDescriptor, runId: string): HarnessDriverKind {
  const sel = resolveSelectionForRun(runId);
  return sel !== null ? selectionDriverKind(sel.provider, sel.method) : descriptor.driverKind();
}

/**
 * Validate a start-request body against a per-skill schema, or throw the
 * standard 400 content_invalid with a JSON-pointer field on the first issue.
 * Every descriptor's buildInput funnels through this — the error-envelope shape
 * is defined once here (the multi-field descriptors keep their own schema + return
 * mapping but parse through this; the one-field ones use profileScopedBuildInput).
 */
function parseStartBody<S extends z.ZodTypeAny>(
  schema: S,
  body: Record<string, unknown>,
): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FormDecisionError("content_invalid", 400, "request body invalid", {
      ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
      extra: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/** The shared one-field start body for every profile-scoped skill (only
 *  `search_profile_id` matters; the start-route envelope fields ride the same
 *  body and are accepted + ignored — non-strict object). */
const ProfileScopedStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
});

/** The shared buildInput for the profile-scoped descriptors (geosearch,
 *  link_scan, incentive_scrape, inbox_check, hygiene, closeout, pipeline_reset,
 *  inventory_compare, quote_compare, reply_extract): validate the one-field body
 *  and return {search_profile_id}. */
function profileScopedBuildInput(
  body: Record<string, unknown>,
): { search_profile_id: string | null } {
  return {
    search_profile_id: parseStartBody(ProfileScopedStartBodySchema, body).search_profile_id ?? null,
  };
}

/** The identical summaryText passthrough shared by every descriptor whose
 *  workflow templates its own plain-speak summary: return result.summary, else
 *  the skill's fallback (declined / short-circuit runs never reach summaryText). */
function passthroughSummary(fallback: string): RunDescriptor["summaryText"] {
  return (result: unknown): string => {
    const r = result as { summary?: string } | undefined;
    return r?.summary ?? fallback;
  };
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
    case "resolveLocation":
      return AmbiguousLocationResumeSchema;
    case "trimSuggestion":
      return TrimSuggestionResumeSchema;
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

/** Validate a form-content blob against the strict 18-field intake schema or
 *  throw a 400 content_invalid. Shared by the collect form and the confirmVehicle
 *  edit form (both render the SAME data_collection form). */
function parseIntakeFormContent(content: unknown): SearchProfileIntakeInput {
  const parsed = SearchProfileIntakeInputSchema.safeParse(content ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FormDecisionError("content_invalid", 400, "form content invalid", {
      ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
      extra: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/**
 * The intake resume shaping (the data_collection form handler). accept →
 * validate content against SearchProfileIntakeInputSchema.strict and map to the
 * collect step's submit resumeData; decline/cancel → the step's decline
 * resumeData + a {action, content:null} ack (terminal-non-write).
 *
 * The non-collect suspends (ambiguous-location, trim-suggestion,
 * confirmVehicle) resume with their own typed resume schemas. The confirmVehicle
 * step renders TWO cards (intake_confirm | the re-rendered data_collection edit
 * form), disambiguated by the retained suspend payload's `kind`: an edit-form
 * accept validates the form like collect; the confirmation card maps the
 * accept/edit verbs straight through.
 */
function intakeResume(
  step: string,
  decision: FormDecisionBody["decision"],
  suspendPayload: Record<string, unknown>,
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
    const fields = parseIntakeFormContent(content);
    const resume = CollectResumeSchema.parse({ action: "submit", fields });
    return { resumeData: resume, ackBody: { action: "accept", content: fields } };
  }

  if (step === "confirmVehicle") {
    // The edit form re-render (data_collection) carries a full form submit; the
    // confirmation card (intake_confirm) carries the accept/edit verb.
    if (suspendPayload["kind"] === "data_collection") {
      const fields = parseIntakeFormContent(content);
      return { resumeData: { action: "submit", fields }, ackBody: { action: "accept", content: fields } };
    }
    const inner =
      content !== null && typeof content === "object" && (content as Record<string, unknown>)["action"] === "edit"
        ? "edit"
        : "accept";
    return { resumeData: { action: inner }, ackBody: { action: "accept", content: { action: inner } } };
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
  // (intake_freeform_prefill is the representative — both intake useCases share
  // one alias), so the wire label flips in lock-step with a registry-string swap.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("intake_freeform_prefill").provider);
  },

  buildInput(body: Record<string, unknown>): IntakeStartInput {
    const parsed = parseStartBody(IntakeStartBodySchema, body);
    return {
      input_mode: parsed.input_mode,
      freeform_text: parsed.freeform_text ?? null,
      seed_fields: parsed.seed_fields ?? null,
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

  buildInput: profileScopedBuildInput,

  // The workflow's confirm step already templates the full plain-speak summary
  // (counts + nearest dealers + the no-auto-chain ending) — pass it through.
  summaryText: passthroughSummary("Dealer geosearch complete."),
};

// ===========================================================================
// inventory_site_scan — the third registered descriptor (READ-ONLY browser
// skill). It auto-scans every in-radius target (owner directive) — no
// batch_review suspend, so NO `resume` member: a form-decision against a
// site-scan run 400s as unsupported_action. The multi-field start body carries
// the optional hand-picked dealer_ids / audit-metadata / truncation valve.
// ===========================================================================

/** The inventory-scan start body fields. `dealer_ids` is a csv of dealer ids
 *  (a hand-picked set that bypasses all truncation); `approved_by` is audit
 *  metadata passthrough; `max_targets` is the optional truncation valve. */
const InventoryScanStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
  dealer_ids: z.string().nullable().optional(),
  approved_by: z.string().nullable().optional(),
  max_targets: z.number().int().positive().nullable().optional(),
});

/** The inventory-scan workflow inputData shape. */
interface InventoryScanStartInput {
  search_profile_id: string | null;
  dealer_ids: string[] | null;
  approved_by: string | null;
  max_targets: number | null;
}

/** csv → trimmed non-empty id list, or null when nothing usable was supplied. */
function parseDealerIdsCsv(csv: string | null | undefined): string[] | null {
  if (csv === null || csv === undefined) return null;
  const ids = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return ids.length > 0 ? ids : null;
}

/** The accept-content shape for the batch_review form (the wire is ALWAYS an
 *  explicit id list — there is no approve-all member). */
const BatchReviewAcceptContentSchema = z.object({
  approved_dealer_ids: z.array(z.string()).min(1),
});

/**
 * The batch_review resume shaping, shared by every batch-approve suspend (one
 * wire contract over several suspended-step names: inventory_link_scan's
 * "reviewGate", dealer_inbox_check / dealer_web_lead_submit / negotiation_followup
 * / dealer_closeout_email's "batchReview"). decline/cancel → the step's decline
 * resumeData (cancel normalizes to decline — the step schema has no 'cancel'
 * member); accept → validate {approved_dealer_ids} and require EVERY id to be
 * one of the targets the suspend actually showed (read off the retained
 * suspend payload — on link_scan the generic dealer_id key carries SOURCE
 * ids) — anything else is 400 content_invalid and the suspend stays
 * answerable.
 */
function batchReviewResumeFor(
  expectedStep: string,
): NonNullable<RunDescriptor["resume"]> {
  return (step, decision, suspendPayload) =>
    batchReviewResume(expectedStep, step, decision, suspendPayload);
}

function batchReviewResume(
  expectedStep: string,
  step: string,
  decision: FormDecisionBody["decision"],
  suspendPayload: Record<string, unknown>,
): { resumeData: unknown; ackBody: Record<string, unknown> } {
  if (step !== expectedStep) {
    throw new FormDecisionError(
      "unsupported_action",
      400,
      `no resume schema for suspended step '${step}'`,
    );
  }
  const { action, content } = decision;

  if (action === "decline" || action === "cancel") {
    return {
      resumeData: BatchReviewResumeSchema.parse({ action: "decline" }),
      ackBody: { action, content: null },
    };
  }

  const parsed = BatchReviewAcceptContentSchema.safeParse(content ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FormDecisionError("content_invalid", 400, "form content invalid", {
      ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
      extra: { issues: parsed.error.issues },
    });
  }

  // ids ⊆ the targets the card actually showed (the retained suspend payload
  // is the authority on what was reviewable).
  const targetsRaw = suspendPayload["targets"];
  const shownIds = new Set(
    Array.isArray(targetsRaw)
      ? targetsRaw
          .map((t) => (t as { dealer_id?: unknown }).dealer_id)
          .filter((id): id is string => typeof id === "string")
      : [],
  );
  const unknown = parsed.data.approved_dealer_ids.filter((id) => !shownIds.has(id));
  if (unknown.length > 0) {
    throw new FormDecisionError(
      "content_invalid",
      400,
      `approved_dealer_ids contains id(s) not in the reviewed targets: ${unknown.join(", ")}`,
      { field: "/approved_dealer_ids" },
    );
  }

  const resume = BatchReviewResumeSchema.parse({
    action: "approve",
    approved_dealer_ids: parsed.data.approved_dealer_ids,
  });
  return {
    resumeData: resume,
    ackBody: {
      action: "accept",
      content: { approved_dealer_ids: parsed.data.approved_dealer_ids },
    },
  };
}

/** The inventory_site_scan descriptor. */
export const inventorySiteScanDescriptor: RunDescriptor = {
  skillId: INVENTORY_SITE_SCAN_SKILL_ID,
  workflowId: INVENTORY_SITE_SCAN_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the skill's LLM useCase
  // (inventory_extract, the per-dealer snapshot extraction) to — flipping in
  // lock-step with a registry-string provider swap.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("inventory_extract").provider);
  },

  buildInput(body: Record<string, unknown>): InventoryScanStartInput {
    const parsed = parseStartBody(InventoryScanStartBodySchema, body);
    return {
      search_profile_id: parsed.search_profile_id ?? null,
      dealer_ids: parseDealerIdsCsv(parsed.dealer_ids),
      // approved_by is AUDIT METADATA ONLY — it rides into the workflow state
      // for the trail; nothing branches on it (here or in the workflow).
      approved_by: parsed.approved_by ?? null,
      max_targets: parsed.max_targets ?? null,
    };
  },

  // No `resume` member — the scan is READ-ONLY and auto-scans every in-radius
  // target (owner directive), so the workflow has no batch_review suspend; a
  // form-decision against a site-scan run 400s as unsupported_action.

  // The workflow's confirm step templates the full deterministic summary —
  // pass it through (declined runs never reach summaryText).
  summaryText: passthroughSummary("Inventory site scan complete."),
};

// ===========================================================================
// inventory_link_scan — the fourth registered descriptor (browser skill with
// ONE batch_review suspend over pending inventory LINKS). Same wire contract
// as inventory_site_scan's card; the suspended step is "reviewGate" and the
// approved ids are SOURCE ids (validated ⊆ the retained suspend payload's
// shown rows through the shared batchReviewResume seam).
// ===========================================================================

/** The inventory_link_scan descriptor. */
export const inventoryLinkScanDescriptor: RunDescriptor = {
  skillId: INVENTORY_LINK_SCAN_SKILL_ID,
  workflowId: INVENTORY_LINK_SCAN_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the skill's LLM useCase
  // (inventory_extract, shared with the site scan) to — flipping in lock-step
  // with a registry-string provider swap.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("inventory_extract").provider);
  },

  buildInput: profileScopedBuildInput,

  resume: batchReviewResumeFor("reviewGate"),

  // The workflow's confirm step templates the full deterministic summary —
  // pass it through (declined runs never reach summaryText).
  summaryText: passthroughSummary("Inventory link scan complete."),
};

// ===========================================================================
// inventory_aggregator_scan — the read-only sibling of inventory_site_scan
// (scans new-car shopping sites). Auto-scans its static site set with NO
// approval gate, so the descriptor declares NO `resume` member: a form-decision
// against an aggregator-scan run 400s as unsupported_action (like geosearch).
// driver_kind DERIVES from the policy() route the skill's LLM useCase
// (inventory_extract, shared with the site/link scans) takes — it flips in
// lock-step with a registry-string provider swap.
// ===========================================================================

/** The aggregator-scan start body fields. Only `search_profile_id` matters to
 *  the workflow — the target sites come from a static adapter registry, never
 *  from the start body; envelope fields ride the same body and are ignored. */
const AggregatorScanStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
});

/** The aggregator-scan workflow inputData shape. */
interface AggregatorScanStartInput {
  search_profile_id: string | null;
}

/** The inventory_aggregator_scan descriptor. */
export const inventoryAggregatorScanDescriptor: RunDescriptor = {
  skillId: INVENTORY_AGGREGATOR_SCAN_SKILL_ID,
  workflowId: INVENTORY_AGGREGATOR_SCAN_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the skill's LLM useCase
  // (inventory_extract, the per-site snapshot extraction) to — flipping in
  // lock-step with a registry-string provider swap.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("inventory_extract").provider);
  },

  buildInput(body: Record<string, unknown>): AggregatorScanStartInput {
    const parsed = AggregatorScanStartBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "request body invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    return { search_profile_id: parsed.data.search_profile_id ?? null };
  },

  // The workflow's persistConfirm step templates the full deterministic summary —
  // pass it through.
  summaryText(result: unknown): string {
    const r = result as { summary?: string } | undefined;
    return r?.summary ?? "Inventory aggregator scan complete.";
  },
};

// ===========================================================================
// incentive_scrape — the fifth registered descriptor (READ-ONLY browser skill).
// It auto-approves every new OEM source (owner directive) — no first-encounter
// approval suspend, so NO `resume` member: a form-decision against an
// incentive-scrape run 400s as unsupported_action. Targets derive from the
// active profiles; the one-field start body carries only the profile pin.
// ===========================================================================

/** The incentive_scrape descriptor. */
export const incentiveScrapeDescriptor: RunDescriptor = {
  skillId: INCENTIVE_SCRAPE_SKILL_ID,
  workflowId: INCENTIVE_SCRAPE_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the skill's LLM useCase
  // (incentive_extract, the offers-page extraction) to — flipping in
  // lock-step with a registry-string provider swap.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("incentive_extract").provider);
  },

  buildInput: profileScopedBuildInput,

  // The workflow's confirm step templates the full deterministic summary —
  // pass it through (declined runs never reach summaryText).
  summaryText: passthroughSummary("Incentive scrape complete."),
};

// ===========================================================================
// dealer_inbox_check — the sixth registered descriptor (email-pull skill with
// ONE batch_review suspend over discovered dealer-reply groups BEFORE any
// write). zero-LLM (the whole sweep is deterministic), so driver_kind is the
// constant api-key label. The suspended step is "batchReview" and the approved
// ids are DEALER ids — reuses the shared batchReviewResume seam (approve an
// explicit dealer-id list ⊆ the retained suspend payload's shown targets, or
// decline = terminal/zero writes). REJECT is deferred (the workflow passes
// reject:[]), so the accept content stays the plain {approved_dealer_ids} shape.
// ===========================================================================

/** The dealer_inbox_check descriptor. */
export const dealerInboxCheckDescriptor: RunDescriptor = {
  skillId: INBOX_CHECK_SKILL_ID,
  workflowId: DEALER_INBOX_CHECK_WORKFLOW_ID,

  // Zero-LLM: the sweep (discovery/routing/classify/ingest) is fully
  // deterministic, so the wire label is the constant api-key lane (no useCase
  // routes through policy()).
  driverKind(): HarnessDriverKind {
    return "deepseek_apikey";
  },

  buildInput: profileScopedBuildInput,

  resume: batchReviewResumeFor("batchReview"),

  // The workflow's confirm step templates the full deterministic summary — pass
  // it through (declined/no_replies runs never reach summaryText).
  summaryText: passthroughSummary("Dealer inbox check complete."),
};

// ===========================================================================
// dealer_hygiene — the seventh registered descriptor (DESTRUCTIVE mailbox
// cleanup with THREE strictly-ordered batch_review suspends 5a orphans → 5b
// CRM threads → 5c CRM contacts). zero-LLM (detect/classify/commit are
// deterministic), so driver_kind is the constant api-key label. ONE resume
// vocabulary reused per stage (approve an explicit id list min 1 ⊆ the retained
// stage payload's shown ids, or decline = terminal/zero writes for the WHOLE
// run). The three suspended step ids are the only ones the resume answers.
// ===========================================================================

/** The accept-content shape for a hygiene stage review (the wire is ALWAYS an
 *  explicit id list — there is no approve-all member). */
const HygieneAcceptContentSchema = z.object({
  approved_ids: z.array(z.string()).min(1),
});

/** The three suspended step ids the hygiene resume answers (5a/5b/5c). */
const HYGIENE_SUSPEND_STEPS = new Set(["suspend5a", "suspend5b", "suspend5c"]);

/**
 * The hygiene per-stage resume shaping. Parameterized like batchReviewResume
 * but dispatching on the three suspended step ids and validating the approved
 * ids against the RETAINED stage payload's `targets[].id`: a step outside
 * {suspend5a, suspend5b, suspend5c} → 400 unsupported_action; decline/cancel →
 * the stage's decline resume; accept → {approved_ids min 1} with EVERY id ⊆ the
 * shown stage ids → else 400 content_invalid (claim rolls back, the suspend
 * stays answerable). The same vocabulary is reused for all three stages.
 */
function hygieneResume(
  step: string,
  decision: FormDecisionBody["decision"],
  suspendPayload: Record<string, unknown>,
): { resumeData: unknown; ackBody: Record<string, unknown> } {
  if (!HYGIENE_SUSPEND_STEPS.has(step)) {
    throw new FormDecisionError(
      "unsupported_action",
      400,
      `no resume schema for suspended step '${step}'`,
    );
  }
  const { action, content } = decision;

  if (action === "decline" || action === "cancel") {
    return {
      resumeData: HygieneResumeSchema.parse({ action: "decline" }),
      ackBody: { action, content: null },
    };
  }

  const parsed = HygieneAcceptContentSchema.safeParse(content ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FormDecisionError("content_invalid", 400, "form content invalid", {
      ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
      extra: { issues: parsed.error.issues },
    });
  }

  // ids ⊆ the targets the stage card actually showed (the retained suspend
  // payload is the authority on what was reviewable in THIS stage).
  const targetsRaw = suspendPayload["targets"];
  const shownIds = new Set(
    Array.isArray(targetsRaw)
      ? targetsRaw
          .map((t) => (t as { id?: unknown }).id)
          .filter((id): id is string => typeof id === "string")
      : [],
  );
  const unknown = parsed.data.approved_ids.filter((id) => !shownIds.has(id));
  if (unknown.length > 0) {
    throw new FormDecisionError(
      "content_invalid",
      400,
      `approved_ids contains id(s) not in the reviewed targets: ${unknown.join(", ")}`,
      { field: "/approved_ids" },
    );
  }

  const resume = HygieneResumeSchema.parse({
    action: "approve",
    approved_ids: parsed.data.approved_ids,
  });
  return {
    resumeData: resume,
    ackBody: { action: "accept", content: { approved_ids: parsed.data.approved_ids } },
  };
}

/** The dealer_hygiene descriptor. */
export const dealerHygieneDescriptor: RunDescriptor = {
  skillId: HYGIENE_SKILL_ID,
  workflowId: DEALER_HYGIENE_WORKFLOW_ID,

  // Zero-LLM: detect/classify/commit are fully deterministic, so the wire label
  // is the constant api-key lane (no useCase routes through policy()).
  driverKind(): HarnessDriverKind {
    return "deepseek_apikey";
  },

  buildInput: profileScopedBuildInput,

  resume: hygieneResume,

  // The workflow's verify step templates the full deterministic summary — pass
  // it through (declined runs never reach summaryText).
  summaryText: passthroughSummary("Dealer hygiene complete."),
};

// ===========================================================================
// dealer_web_lead_submit — the IRREVERSIBLE-SEND keystone descriptor (real send
// in buyer mode, fake in test mode). The skill's LLM useCase is lead_form_map (the ONE Custom-platform
// field map), so driver_kind DERIVES from policy("lead_form_map") and flips with a
// registry-string provider swap. TWO suspend kinds, so the resume dispatches on
// the suspended STEP id:
//   - "batchReview" → suspend ① — a FULL-BATCH input shows the batch_review card
//     (reuse the shared batchReviewResume seam); a SINGLE-STORE input collapses ①
//     to a kind:"approval" single_store_confirm card (the approve/decline seam).
//     The retained suspend payload's `kind` selects which (the card the user saw).
//   - "emailFallback" → suspend ② — the INDEPENDENT email_fallback re-confirm
//     (the browser.submit → gmail.send scope switch); approve/decline only.
// decline/cancel everywhere = skip THAT scope: ① decline is terminal/zero writes,
// ② decline skips that dealer's fallback only (the run continues).
// ===========================================================================

/** The dealer-web-lead-submit start body fields. All optional with null defaults:
 *  a pin-less full-batch input STOPs in the workflow (pin_required), and the
 *  single-store / force_retry fields default off; envelope fields ride the same
 *  body and are ignored. */
const DealerWebLeadSubmitStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
  target_listing_id: z.string().nullable().optional(),
  force_retry: z.boolean().optional(),
});

/** The dealer-web-lead-submit workflow inputData shape. */
interface DealerWebLeadSubmitStartInput {
  search_profile_id: string | null;
  target_listing_id: string | null;
  force_retry: boolean;
}

/**
 * The suspend ② (and single-store ①) resume shaping: the approval card carries no
 * content — accept → {action:"approve"}, decline/cancel → {action:"decline"}
 * (skip THAT scope, never a global terminal). Mirrors the OEM first-encounter
 * approve button (no content member). The workflow re-validates with
 * LeadApprovalResumeSchema, so this is the wire→typed translation only.
 */
function leadApprovalResume(
  decision: FormDecisionBody["decision"],
): { resumeData: unknown; ackBody: Record<string, unknown> } {
  const { action } = decision;
  const inner = action === "accept" ? "approve" : "decline";
  return {
    resumeData: LeadApprovalResumeSchema.parse({ action: inner }),
    ackBody: { action, content: null },
  };
}

/** The dealer_web_lead_submit descriptor. */
export const dealerWebLeadSubmitDescriptor: RunDescriptor = {
  skillId: "dealer_web_lead_submit",
  workflowId: DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the skill's single LLM useCase
  // (lead_form_map, the Custom-platform field map) to — flipping in lock-step
  // with a registry-string provider swap.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("lead_form_map").provider);
  },

  buildInput(body: Record<string, unknown>): DealerWebLeadSubmitStartInput {
    const parsed = parseStartBody(DealerWebLeadSubmitStartBodySchema, body);
    return {
      search_profile_id: parsed.search_profile_id ?? null,
      target_listing_id: parsed.target_listing_id ?? null,
      force_retry: parsed.force_retry ?? false,
    };
  },

  resume(
    step: string,
    decision: FormDecisionBody["decision"],
    suspendPayload: Record<string, unknown>,
  ): { resumeData: unknown; ackBody: Record<string, unknown> } {
    // suspend ① (batchReview): a single-store input collapses the batch card to a
    // kind:"approval" single_store_confirm card — the retained payload's `kind`
    // selects the resume vocabulary the user's card actually used.
    if (step === "batchReview") {
      return suspendPayload["kind"] === "approval"
        ? leadApprovalResume(decision)
        : batchReviewResume("batchReview", step, decision, suspendPayload);
    }
    // suspend ② (emailFallback): the INDEPENDENT email_fallback re-confirm.
    if (step === "emailFallback") {
      return leadApprovalResume(decision);
    }
    throw new FormDecisionError(
      "unsupported_action",
      400,
      `no resume schema for suspended step '${step}'`,
    );
  },

  // The workflow's recordConfirm step templates the full deterministic summary —
  // pass it through (declined runs never reach summaryText).
  summaryText: passthroughSummary("Lead submission complete."),
};

// ===========================================================================
// daily_digest — the eighth registered descriptor (Phase 4 / Wave O windowed
// read-only aggregation). zero-LLM + zero-suspend, so driver_kind is the
// constant api-key label and there is NO resume (a form-decision 400s as
// unsupported_action). `search_profile_id:null` → the workflow enumerates all
// active profiles; `since_hours` is the optional "new since" window.
// ===========================================================================

/** The daily_digest start body fields. */
const DailyDigestStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
  since_hours: z.number().nullable().optional(),
});

/** The daily_digest workflow inputData shape. */
interface DailyDigestStartInput {
  search_profile_id: string | null;
  since_hours: number | null;
}

export const dailyDigestDescriptor: RunDescriptor = {
  skillId: "daily_digest",
  workflowId: DAILY_DIGEST_WORKFLOW_ID,

  // Zero-LLM: the aggregation/render is fully deterministic, so the wire label
  // is the constant api-key lane (no useCase routes through policy()).
  driverKind(): HarnessDriverKind {
    return "deepseek_apikey";
  },

  buildInput(body: Record<string, unknown>): DailyDigestStartInput {
    const parsed = parseStartBody(DailyDigestStartBodySchema, body);
    return {
      search_profile_id: parsed.search_profile_id ?? null,
      since_hours: parsed.since_hours ?? null,
    };
  },

  // The workflow's confirm step templates the deterministic summary; a graceful
  // zero-active "skipped" run carries its own summary too.
  summaryText: passthroughSummary("Daily digest ready."),
};

// ===========================================================================
// negotiation_followup (X2) — the irreversible-send email follow-up (real in buyer mode, fake in test mode).
//
// ONE LLM useCase (negotiation_followup, the prose draft), so driver_kind DERIVES
// from policy("negotiation_followup") and flips with a registry-string provider
// swap (mirror X1's lead_form_map derivation). TWO suspend kinds ride the one
// "batchReview" step (exactly like X1's batchReview raises batch_review OR a
// single_store approval): suspend ① is the batch_review SEND-n card; suspend ②
// is the sensitive contact-flip re-confirm (approve/decline only). The retained
// payload's `kind` selects the resume vocabulary the user's card actually used.
//
// The contact-flip ② is an EXPLICIT, opt-in override: it fires ONLY when the ①
// batch-approve decision carried a flip request. The shared BatchReviewResume
// schema has no address-change field, so the request rides the batch-approve
// content out-of-band (flip_primary_contact_id + the dealer/thread it applies to)
// and is registered into the workflow's per-run carry via requestContactFlipForRun
// BEFORE the Mastra resume runs (see formDecision's pre-resume hook). The carry is
// per-run in-process; a crash re-asks (fail-closed), never fail-open.
// ===========================================================================

/** The negotiation_followup start body. Both ids optional+nullable: a pin-less
 *  full-batch input STOPs in the workflow (pin_required); a named thread runs the
 *  single-thread path. */
const NegotiationFollowupStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
  thread_id: z.string().nullable().optional(),
});

/** The negotiation_followup workflow inputData shape. */
interface NegotiationFollowupStartInput {
  search_profile_id: string | null;
  thread_id: string | null;
}

/**
 * The contact-flip ② re-confirm resume shaping: the sensitive approval card
 * carries no content — accept → {action:"approve"}, decline/cancel → {action:
 * "decline"} (no flip; the run continues, the send is independent). The workflow
 * re-validates with ContactFlipApprovalResumeSchema, so this is the wire→typed
 * translation only.
 */
function contactFlipApprovalResume(
  decision: FormDecisionBody["decision"],
): { resumeData: unknown; ackBody: Record<string, unknown> } {
  const inner = decision.action === "accept" ? "approve" : "decline";
  return {
    resumeData: ContactFlipApprovalResumeSchema.parse({ action: inner }),
    ackBody: { action: decision.action, content: null },
  };
}

/** The optional flip-override fields the ① batch-approve content may carry (an
 *  EXPLICIT user address-change request; absent in the happy path). All three are
 *  required together — a partial request is a 400. */
const ContactFlipOverrideContentSchema = z.object({
  flip_primary_contact_id: z.string().min(1),
  flip_dealer_id: z.string().min(1),
  flip_thread_id: z.string().min(1),
});

/** Parse a flip override off a ① batch-approve decision content, or null when
 *  none was requested. A content that carries SOME but not all flip fields is a
 *  400 content_invalid (a partial override is a contract breach, not a silent
 *  no-flip). */
function contactFlipOverrideFrom(
  decision: FormDecisionBody["decision"],
): { threadId: string; dealerId: string; contactId: string } | null {
  const content = decision.content ?? {};
  const anyFlip =
    "flip_primary_contact_id" in content ||
    "flip_dealer_id" in content ||
    "flip_thread_id" in content;
  if (!anyFlip) return null;
  const parsed = ContactFlipOverrideContentSchema.safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FormDecisionError("content_invalid", 400, "contact-flip override incomplete", {
      ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
      extra: { issues: parsed.error.issues },
    });
  }
  return {
    threadId: parsed.data.flip_thread_id,
    dealerId: parsed.data.flip_dealer_id,
    contactId: parsed.data.flip_primary_contact_id,
  };
}

/** The negotiation_followup descriptor. */
export const negotiationFollowupDescriptor: RunDescriptor = {
  skillId: "negotiation_followup",
  workflowId: NEGOTIATION_FOLLOWUP_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the prose-draft useCase to.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("negotiation_followup").provider);
  },

  buildInput(body: Record<string, unknown>): NegotiationFollowupStartInput {
    const parsed = parseStartBody(NegotiationFollowupStartBodySchema, body);
    return {
      search_profile_id: parsed.search_profile_id ?? null,
      thread_id: parsed.thread_id ?? null,
    };
  },

  resume(
    step: string,
    decision: FormDecisionBody["decision"],
    suspendPayload: Record<string, unknown>,
  ): { resumeData: unknown; ackBody: Record<string, unknown> } {
    // Both suspends ride the "batchReview" step; the retained payload's `kind`
    // selects which the user answered. The ① batch-approve may ALSO carry a flip
    // override in its content — that override is registered out-of-band in
    // formDecision's pre-resume hook (the descriptor.resume signature has no runId).
    if (step === "batchReview") {
      // suspend ② — the sensitive contact-flip re-confirm.
      if (suspendPayload["kind"] === "approval") {
        return contactFlipApprovalResume(decision);
      }
      // suspend ① — the batch_review SEND-n list. Validate the flip override (if
      // present) so a malformed override 400s here, before resume; the registration
      // itself is the formDecision hook's job (it owns runId).
      contactFlipOverrideFrom(decision);
      return batchReviewResume("batchReview", step, decision, suspendPayload);
    }
    throw new FormDecisionError(
      "unsupported_action",
      400,
      `no resume schema for suspended step '${step}'`,
    );
  },

  summaryText: passthroughSummary("Negotiation follow-up complete."),
};

// ===========================================================================
// dealer_closeout_email (X3) — the EXIT skill (irreversible-send: real in buyer mode, fake in test mode; state-only).
//
// NEAR-ZERO-LLM (the default body is deterministic) → driver_kind is the constant
// api-key lane, NOT a policy() derivation (there is no LLM useCase to route). ONE
// suspend: the batch_review card. decline → terminal zero writes; "SKIP ALL" → the
// typed `skip_all_reset` outcome (the Phase-4 pipeline_reset hand-off). The
// workflow recognizes SKIP ALL as an approve whose approved_dealer_ids intersect
// ZERO reviewed targets, so the descriptor emits an approve carrying a SENTINEL
// non-target id (a non-empty list satisfying the schema's .min(1), but matching no
// shown dealer) when the decision content sets `skip_all`. The shared
// batchReviewResume helper would 400 an unknown id, so X3 needs its OWN batch
// resume shaper (closeoutBatchResume) that allows the skip-all sentinel.
// ===========================================================================

/** The sentinel approved id the SKIP-ALL approve carries: a non-empty list (the
 *  schema requires .min(1)) that intersects no reviewed target → the workflow's
 *  `approved ∩ targets === ∅` branch produces the typed skip_all_reset outcome. */
const SKIP_ALL_SENTINEL_ID = "__closeout_skip_all__";

/** The closeout batch_review resume shaping. Like batchReviewResume, BUT the
 *  accept content may set `skip_all:true` → emit an approve carrying the skip-all
 *  sentinel id (the workflow turns an empty target-intersection into the
 *  skip_all_reset outcome). A normal accept validates approved_dealer_ids ⊆ the
 *  shown targets (the shared invariant). decline/cancel → the decline resumeData. */
function closeoutBatchResume(
  step: string,
  decision: FormDecisionBody["decision"],
  suspendPayload: Record<string, unknown>,
): { resumeData: unknown; ackBody: Record<string, unknown> } {
  if (step !== "batchReview") {
    throw new FormDecisionError(
      "unsupported_action",
      400,
      `no resume schema for suspended step '${step}'`,
    );
  }
  const { action, content } = decision;
  if (action === "decline" || action === "cancel") {
    return {
      resumeData: BatchReviewResumeSchema.parse({ action: "decline" }),
      ackBody: { action, content: null },
    };
  }
  // SKIP ALL — an explicit "send none, reset the pipeline" accept. The wire is an
  // approve carrying the sentinel id; the workflow reads the empty intersection as
  // the skip_all_reset hand-off. This is NOT a decline (a decline is a plain stop).
  if (content !== undefined && content["skip_all"] === true) {
    return {
      resumeData: BatchReviewResumeSchema.parse({
        action: "approve",
        approved_dealer_ids: [SKIP_ALL_SENTINEL_ID],
      }),
      ackBody: { action: "accept", content: { skip_all: true } },
    };
  }
  // Normal accept — the explicit dealer-id list ⊆ the shown targets (reuse the
  // shared validator so the ⊆-targets check and the content schema match X1).
  return batchReviewResume("batchReview", step, decision, suspendPayload);
}

/** The dealer_closeout_email descriptor. */
export const dealerCloseoutEmailDescriptor: RunDescriptor = {
  skillId: "dealer_closeout_email",
  workflowId: DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID,

  // ZERO-LLM — the default closeout body is deterministic, so there is no useCase
  // to route. The api-key lane is the constant driver_kind (mirror the zero-LLM
  // dealer_inbox_check / dealer_hygiene descriptors).
  driverKind(): HarnessDriverKind {
    return "deepseek_apikey";
  },

  buildInput: profileScopedBuildInput,

  resume: closeoutBatchResume,

  summaryText: passthroughSummary("Dealer closeout complete."),
};

// ===========================================================================
// pipeline_reset — the ninth registered descriptor (DESTRUCTIVE full-DB wipe).
// zero-LLM; ONE typed-YES confirmation_gate suspend on the step "confirmGate".
// The token is RE-VALIDATED SERVER-SIDE here (verbatim YES, case-insensitive) —
// the client/LLM is never trusted; a non-YES token is rejected and the gate
// stays answerable. decline/cancel = terminal, ZERO destruction. The wipe
// itself ignores search_profile_id (a global op — see the registry exception).
// ===========================================================================

/** Re-validate the typed-YES token IN CODE and shape the resume. A confirm with
 *  a non-YES token is rejected (content_invalid) — never trusted from the wire;
 *  decline/cancel resolves to a zero-destruction decline. */
function pipelineResetResume(
  step: string,
  decision: FormDecisionBody["decision"],
  _suspendPayload: Record<string, unknown>,
): { resumeData: unknown; ackBody: Record<string, unknown> } {
  if (step !== "confirmGate") {
    throw new FormDecisionError(
      "unsupported_action",
      400,
      `no resume schema for suspended step '${step}'`,
    );
  }
  const { action, content } = decision;
  if (action === "decline" || action === "cancel") {
    return {
      resumeData: PipelineResetResumeSchema.parse({ action: "decline" }),
      ackBody: { action, content: null },
    };
  }
  // accept → the load-bearing server-side typed-YES re-validation.
  const token = content?.confirm_token;
  if (!validateResetToken(token)) {
    throw new FormDecisionError("content_invalid", 400, "confirmation token must be YES", {
      field: "/confirm_token",
    });
  }
  return {
    resumeData: PipelineResetResumeSchema.parse({ action: "confirm", confirm_token: "YES" }),
    ackBody: { action: "accept", content: { confirm_token: "YES" } },
  };
}

export const pipelineResetDescriptor: RunDescriptor = {
  skillId: "pipeline_reset",
  workflowId: PIPELINE_RESET_WORKFLOW_ID,

  // Zero-LLM (backup/migrate/verify are deterministic) → the constant api-key label.
  driverKind(): HarnessDriverKind {
    return "deepseek_apikey";
  },

  buildInput: profileScopedBuildInput,

  resume: pipelineResetResume,

  summaryText: passthroughSummary("Pipeline reset complete."),
};

// ===========================================================================
// inventory_compare — the tenth registered descriptor (deterministic inventory
// ranker; read-only, zero-LLM, NO suspend). No `resume` member: the workflow
// has no HITL suspend, so a form-decision against an inventory_compare run 400s
// as unsupported_action. driver_kind is the constant api-key label (no useCase
// routes through policy()).
// ===========================================================================

/** The inventory_compare descriptor. */
export const inventoryCompareDescriptor: RunDescriptor = {
  skillId: INVENTORY_COMPARE_SKILL_ID,
  workflowId: INVENTORY_COMPARE_WORKFLOW_ID,

  // Zero-LLM: resolve/rank/render are fully deterministic, so the wire label is
  // the constant api-key lane (no useCase routes through policy()).
  driverKind(): HarnessDriverKind {
    return "deepseek_apikey";
  },

  buildInput: profileScopedBuildInput,

  // The workflow's render step templates the full deterministic summary — pass
  // it through.
  summaryText: passthroughSummary("Inventory compare complete."),
};

// ===========================================================================
// quote_audit — the ninth registered descriptor (deterministic 10-check audit;
// read-only plus an idempotent quote_audits upsert, zero-LLM, NO suspend). No
// `resume` member: the workflow has no HITL suspend, so a form-decision against a
// quote_audit run 400s as unsupported_action. driver_kind is the constant api-key
// label (no useCase routes through policy()).
// ===========================================================================

/** The quote-audit start body fields. `search_profile_id` is the profile pin;
 *  `quote_id` selects single-quote mode (null → the recent batch). The
 *  start-route envelope fields ride the same body and are accepted + ignored
 *  (non-strict object). */
const QuoteAuditStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
  quote_id: z.string().nullable().optional(),
});

/** The quote-audit workflow inputData shape. */
interface QuoteAuditStartInput {
  search_profile_id: string | null;
  quote_id: string | null;
}

/** The quote_audit descriptor. */
export const quoteAuditDescriptor: RunDescriptor = {
  skillId: QUOTE_AUDIT_SKILL_ID,
  workflowId: QUOTE_AUDIT_WORKFLOW_ID,

  // Zero-LLM: resolve/load/audit/persist are fully deterministic, so the wire
  // label is the constant api-key lane (no useCase routes through policy()).
  driverKind(): HarnessDriverKind {
    return "deepseek_apikey";
  },

  buildInput(body: Record<string, unknown>): QuoteAuditStartInput {
    const parsed = parseStartBody(QuoteAuditStartBodySchema, body);
    return {
      search_profile_id: parsed.search_profile_id ?? null,
      quote_id: parsed.quote_id ?? null,
    };
  },

  // The workflow's confirm step templates the full deterministic summary — pass
  // it through.
  summaryText: passthroughSummary("Quote audit complete."),
};

// ===========================================================================
// quote_compare — the tenth registered descriptor (deterministic compare ranker;
// read-only, zero-LLM, NO suspend). No `resume` member: the workflow has no HITL
// suspend, so a form-decision against a quote_compare run 400s as
// unsupported_action. driver_kind is the constant api-key label (no useCase
// routes through policy()).
// ===========================================================================

/** The quote_compare descriptor. */
export const quoteCompareDescriptor: RunDescriptor = {
  skillId: QUOTE_COMPARE_SKILL_ID,
  workflowId: QUOTE_COMPARE_WORKFLOW_ID,

  // Zero-LLM: resolve/rank/confirm are fully deterministic, so the wire label is
  // the constant api-key lane (no useCase routes through policy()).
  driverKind(): HarnessDriverKind {
    return "deepseek_apikey";
  },

  buildInput: profileScopedBuildInput,

  // The workflow's confirm step templates the full deterministic summary — pass
  // it through.
  summaryText: passthroughSummary("Quote compare complete."),
};

// ===========================================================================
// dealer_reply_extract — the eleventh registered descriptor (the SOLE live-LLM
// skill: per-message single emit_result extraction). AUTONOMOUS — NO `resume`
// member: the workflow has no HITL suspend, so a form-decision against a
// reply-extract run 400s as unsupported_action (like geosearch). driver_kind is
// DERIVED from the policy() route the skill's LLM useCase (dealer_reply_extract)
// takes — it IS a live-LLM skill, so the label flips in lock-step with a
// registry-string provider swap (NOT the zero-LLM constant).
// ===========================================================================

/** The dealer_reply_extract descriptor. */
export const dealerReplyExtractDescriptor: RunDescriptor = {
  skillId: REPLY_EXTRACT_SKILL_ID,
  workflowId: DEALER_REPLY_EXTRACT_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the skill's single LLM useCase
  // (dealer_reply_extract, the per-message structured extraction) to —
  // deepseek_apikey under the default registry strings, flipping in lock-step
  // with a provider swap. NOT the zero-LLM constant: this IS a live-LLM skill.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("dealer_reply_extract").provider);
  },

  buildInput: profileScopedBuildInput,

  // No `resume` member — autonomous, no HITL suspend; a form-decision 400s as
  // unsupported_action through the service's resume===undefined branch.

  // The workflow's confirm step templates the full deterministic summary —
  // pass it through.
  summaryText: passthroughSummary("Dealer reply extract complete."),
};

// ===========================================================================
// quote_pipeline (O1) — the Phase-4 ORCHESTRATOR descriptor (local_write; the
// FINAL skill). It composes the child skill workflows over existing DB state, or
// — when target_listing_id is supplied — runs the targeted-VIN OTD sub-path (one
// send through the L2 gate — real in buyer mode, fake in test mode). The skill's only LLM touch is delegated to the
// child reply_extract (the orchestrator runs no LLM step of its own), so
// driver_kind DERIVES from policy("dealer_reply_extract") and flips in lock-step
// with a registry-string provider swap (NOT the zero-LLM constant — a pipeline
// run that extracts replies IS a live-LLM run through its child).
//
// ONE suspend kind: the targeted-VIN SEND approval ("targeted") — approve fires
// the gated send (real in buyer mode, fake in test mode) + records the quote; decline → terminal `declined` (zero
// outbound, zero record write). The fan-out lane never suspends here (the
// incentive_scrape OEM first-encounter ask is handled autonomously by the
// orchestrator — see the SCRAPE-SUSPEND NOTE in quotePipeline.ts).
// ===========================================================================

/** The quote_pipeline start body fields. All optional with null defaults: a
 *  pin-less input STOPs in the workflow (pin_required); dry_run + the single-store
 *  target_listing_id default off; envelope fields ride the same body and are
 *  ignored (non-strict object). */
const QuotePipelineStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
  target_listing_id: z.string().nullable().optional(),
  // slash key=value args arrive as strings; accept "true"/"false"/"1"/"0" too.
  dry_run: z.union([z.boolean(), z.string()]).optional(),
});

/** The quote_pipeline workflow inputData shape. */
interface QuotePipelineStartInput {
  search_profile_id: string | null;
  dry_run: boolean;
  target_listing_id: string | null;
}

/** Coerce a slash-string / boolean dry_run into a boolean (default false). */
function coerceDryRun(raw: boolean | string | undefined): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "true" || raw === "1";
  return false;
}

/** The quote_pipeline descriptor. */
export const quotePipelineDescriptor: RunDescriptor = {
  skillId: QUOTE_PIPELINE_SKILL_ID,
  workflowId: QUOTE_PIPELINE_WORKFLOW_ID,

  // DERIVED from the provider policy() routes the child reply_extract useCase to —
  // a pipeline run extracts dealer replies through that live-LLM child, so the
  // label flips in lock-step with a registry-string provider swap.
  driverKind(): HarnessDriverKind {
    return providerDriverKind(policy("dealer_reply_extract").provider);
  },

  buildInput(body: Record<string, unknown>): QuotePipelineStartInput {
    const parsed = parseStartBody(QuotePipelineStartBodySchema, body);
    return {
      search_profile_id: parsed.search_profile_id ?? null,
      dry_run: coerceDryRun(parsed.dry_run),
      target_listing_id: parsed.target_listing_id ?? null,
    };
  },

  // The ONE suspend is the targeted-VIN SEND approval on the "targeted" step: the
  // approval card carries no content — accept → {action:"approve"} (fire the
  // gated send [real in buyer mode, fake in test mode] + record), decline/cancel → {action:"decline"} (terminal,
  // zero outbound/zero record). The workflow re-validates with
  // QuotePipelineSendResumeSchema, so this is the wire→typed translation only.
  resume(
    step: string,
    decision: FormDecisionBody["decision"],
    _suspendPayload: Record<string, unknown>,
  ): { resumeData: unknown; ackBody: Record<string, unknown> } {
    if (step !== "targeted") {
      throw new FormDecisionError(
        "unsupported_action",
        400,
        `no resume schema for suspended step '${step}'`,
      );
    }
    const inner = decision.action === "accept" ? "approve" : "decline";
    return {
      resumeData: QuotePipelineSendResumeSchema.parse({ action: inner }),
      ackBody: { action: decision.action, content: null },
    };
  },

  // The workflow's logCompletion step templates the full deterministic summary —
  // pass it through (declined runs never reach summaryText).
  summaryText: passthroughSummary("Quote pipeline complete."),
};

// ===========================================================================
// The descriptor registry + the skill-agnostic run service.
// ===========================================================================

/** Every skill the server can start runs for, in registration order. */
export const RUN_DESCRIPTORS: readonly RunDescriptor[] = [
  intakeRunDescriptor,
  dealerGeosearchDescriptor,
  inventorySiteScanDescriptor,
  inventoryAggregatorScanDescriptor,
  inventoryLinkScanDescriptor,
  incentiveScrapeDescriptor,
  dealerInboxCheckDescriptor,
  dealerReplyExtractDescriptor,
  dealerHygieneDescriptor,
  dailyDigestDescriptor,
  pipelineResetDescriptor,
  inventoryCompareDescriptor,
  quoteAuditDescriptor,
  quoteCompareDescriptor,
  quotePipelineDescriptor,
  dealerWebLeadSubmitDescriptor,
  negotiationFollowupDescriptor,
  dealerCloseoutEmailDescriptor,
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
  /** The search_profile this run acts on (extracted from the start input), or
   *  null for a profile-less/intake run. The ApprovalInbox keys parked gates by
   *  (profileId, runId, decisionId) and the scheduler routes lifecycle events by
   *  it; a reattached run (recovered at boot) carries null until the durable
   *  activation registry rebinds it. */
  searchProfileId: string | null;
  /** The step id + decisionId + RETAINED suspend payload of the CURRENTLY
   *  pending suspend, or null when the run is running/terminal. The
   *  form-decision must reference this decisionId; the payload is what the
   *  descriptor's resume validates the answer against (the exact spec_inline
   *  the user saw — e.g. the batch_review ids ⊆ targets check). */
  pending: { step: string; decisionId: string; payload: Record<string, unknown> } | null;
  /** Whether a terminal frame has been emitted (the run is over). */
  terminal: boolean;
  /** Whether the once-only terminal hook (carry-map GC, ownership release,
   *  listener fan-out) has already run — guards against a double-fire. */
  terminalHandled: boolean;
  claims: Map<string, Claim>;
}

/** A parked gate, as surfaced cross-run by {@link SkillRunService.listPendingGates}
 *  — the raw backbone the ApprovalInbox ranks + tags. */
export interface PendingGate {
  runId: string;
  profileId: string | null;
  skill: string;
  sessionId: string | null;
  step: string;
  decisionId: string;
  payload: Record<string, unknown>;
}

/** A run reaching a gate or a terminal — the events the PortfolioScheduler (slot
 *  management) subscribes to. */
export interface RunLifecycleEvent {
  runId: string;
  profileId: string | null;
  skill: string;
}
export type RunTerminalKind = "declined" | "completed" | "error" | "canceled";
export interface RunTerminalEvent extends RunLifecycleEvent {
  terminalKind: RunTerminalKind;
}
export interface RunLifecycleListener {
  onRunSuspended?(event: RunLifecycleEvent): void;
  /** A parked run was resumed (a human answered its gate) — it is executing again,
   *  so the scheduler re-occupies its slot. */
  onRunResumed?(event: RunLifecycleEvent): void;
  onRunTerminal?(event: RunTerminalEvent): void;
}

/** Extract the search_profile_id baked into a start input by the descriptor's
 *  buildInput (every profile-scoped skill carries it). Null for intake / a
 *  profile-less body. */
function extractSearchProfileId(input: unknown): string | null {
  if (input !== null && typeof input === "object" && "search_profile_id" in input) {
    const v = (input as Record<string, unknown>)["search_profile_id"];
    return typeof v === "string" ? v : null;
  }
  return null;
}

/** Map a suspended step's payload → the awaiting_user form_kind. The gate/
 *  location suspends are approval-style forms but all resume through
 *  this same channel. */
function formKindFor(payload: Record<string, unknown>): string {
  const kind = payload["kind"];
  return typeof kind === "string" ? kind : "data_collection";
}

/**
 * The data families a completed skill's run touched, keyed by workflowId — the
 * `kinds` carried on the data.changed pulse the UI reads to refetch exactly the
 * views that render those families (intake writes profiles+sessions; geosearch
 * writes dealers; the inventory scans write listings; incentive_scrape writes
 * incentives). An UNKNOWN workflowId (a future email/quote skill not yet mapped)
 * defaults to the broad safe set so its writes never go unseen — a future skill
 * may then narrow itself. Threads/messages/quotes are listed for the skills that
 * will write them as those surfaces land. This is the ONLY place the skill→data
 * mapping lives (the workflow/tools layers have no pubsub access).
 */
function affectedKinds(workflowId: string): string[] {
  switch (workflowId) {
    case SEARCH_PROFILE_INTAKE_WORKFLOW_ID:
      return ["profiles", "sessions"];
    case DEALER_GEOSEARCH_WORKFLOW_ID:
      return ["dealers"];
    case INVENTORY_SITE_SCAN_WORKFLOW_ID:
    case INVENTORY_AGGREGATOR_SCAN_WORKFLOW_ID:
    case INVENTORY_LINK_SCAN_WORKFLOW_ID:
      return ["listings"];
    case INCENTIVE_SCRAPE_WORKFLOW_ID:
      return ["incentives"];
    case DAILY_DIGEST_WORKFLOW_ID:
      return ["digest"];
    case DEALER_INBOX_CHECK_WORKFLOW_ID:
      return ["threads", "messages", "contacts"];
    case DEALER_REPLY_EXTRACT_WORKFLOW_ID:
      // +digest: reply-extract writes dealer_quotes, which the digest headline
      // ("N quote(s), lowest $X") re-aggregates. Without pulsing digest the
      // headline count stays stale until the next daily_digest run while best-OTD
      // self-heals from the live quotes fetch — a jarring "0 quote(s)" beside a
      // real best price. GET /api/digest recomputes fresh, so this is a harmless refetch.
      return ["quotes", "messages", "digest"];
    case DEALER_HYGIENE_WORKFLOW_ID:
      return ["threads", "contacts"];
    case PIPELINE_RESET_WORKFLOW_ID:
      // A full wipe — every search is gone. Pulse profiles/sessions (+digest):
      // the active-profile list refetches to empty and the Canvas unmounts every
      // per-profile section on its own. We deliberately DROP the per-profile data
      // families (dealers/listings/quotes/incentives) that 404 on a deleted
      // profile — pulsing them would make those sections refetch the now-DELETED
      // id (a burst of 404s) before the profile-list refetch unmounts them.
      // `digest` stays: GET /api/digest returns an EMPTY view (not 404) for a
      // gone profile, so the standalone /digest page still refreshes harmlessly.
      return ["profiles", "sessions", "digest"];
    case INVENTORY_COMPARE_WORKFLOW_ID:
      // Pure read: the ranker writes NOTHING (no match_score column, no row
      // mutation). The success pulse fires with kinds:[] — the UI treats it as
      // nothing-to-refetch.
      return [];
    case QUOTE_AUDIT_WORKFLOW_ID:
      // Writes quote_audits rows (the only mutation) — name the "quotes" data
      // family so the quote-compare surface refetches the freshly-audited
      // findings. (quote_audits rides under the quotes kind; D3's compare panel
      // invalidates on it.)
      return ["quotes"];
    case QUOTE_COMPARE_WORKFLOW_ID:
      // Pure read: the compare ranker writes NOTHING (it reads dealer_quotes +
      // the latest audit per quote and ranks in memory). The success pulse fires
      // with kinds:[] — the UI treats it as nothing-to-refetch.
      return [];
    case QUOTE_PIPELINE_WORKFLOW_ID:
      // The orchestrator's children write quote_audits (audit), dealer_quotes
      // (reply-extract + the targeted-VIN record), manufacturer_incentives
      // (scrape), inventory_listings (the targeted listing is re-touched), and
      // messages (the targeted send draft). Name the data families those
      // surfaces refetch on. +digest for the same reason as reply-extract: the
      // dealer_quotes write must refresh the stale digest headline count.
      return ["quotes", "incentives", "listings", "messages", "digest"];
    case DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID:
      // A submitted lead writes a lead_submissions row, may update a dealer's
      // contact_email, and an email fallback writes a messages row (fake in test mode).
      return ["lead_submissions", "dealers", "messages"];
    case NEGOTIATION_FOLLOWUP_WORKFLOW_ID:
      // A follow-up sends a reply (fake in test mode) on an existing thread and updates that
      // thread's state (the contact-flip is a dealer-contact write, but the visible
      // surfaces that refetch are the thread list + its messages).
      return ["threads", "messages"];
    case DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID:
      // A closeout closes threads + writes a thread_suppression row and flips the
      // profile to 'closed' on completion (the "profiles" kind, NOT the table name —
      // the profile card refetches on it).
      return ["threads", "messages", "profiles"];
    default:
      // A skill whose data family is not mapped yet — refetch broadly rather
      // than leave a view silently stale.
      return ["profiles", "sessions", "dealers", "listings", "incentives"];
  }
}

/** The profile id a completed run's output carries, read defensively across the
 *  three skill output shapes (intake → profileId; geosearch → searchProfileId;
 *  the scans/incentive → search_profile_id). Null when none is present (a
 *  headless/profile-less terminal) — a null-scoped pulse refetches the lists
 *  unscoped, which is still correct (just broader). */
function resultProfileId(result: unknown): string | null {
  const r = (result ?? {}) as {
    profileId?: unknown;
    searchProfileId?: unknown;
    search_profile_id?: unknown;
  };
  for (const v of [r.profileId, r.searchProfileId, r.search_profile_id]) {
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
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
  private readonly lifecycleListeners: RunLifecycleListener[] = [];

  constructor(
    private readonly mastra: MastraInstance,
    private readonly pubsub: RunPubSub,
  ) {}

  /** Register a run-lifecycle listener (the PortfolioScheduler for slot
   *  management). Listeners are fired in registration order; a throwing listener
   *  is isolated so it never breaks the run lifecycle or a sibling listener. */
  addLifecycleListener(listener: RunLifecycleListener): void {
    this.lifecycleListeners.push(listener);
  }

  /** Every currently parked gate across ALL runs — the ApprovalInbox backbone.
   *  The per-run state map is otherwise read only by single runId; this is the
   *  one cross-run enumeration. */
  listPendingGates(): PendingGate[] {
    const gates: PendingGate[] = [];
    for (const [runId, run] of this.runs) {
      if (run.pending === null) continue;
      gates.push({
        runId,
        profileId: run.searchProfileId,
        skill: run.skill,
        sessionId: run.sessionId,
        step: run.pending.step,
        decisionId: run.pending.decisionId,
        payload: run.pending.payload,
      });
    }
    return gates;
  }

  /** Notify listeners a parked run is being resumed (it re-occupies its slot for the
   *  duration of its resumed execution; a subsequent suspend/terminal frees it again). */
  private fireResumed(run: RunState, runId: string): void {
    const event: RunLifecycleEvent = { runId, profileId: run.searchProfileId, skill: run.skill };
    for (const l of this.lifecycleListeners) {
      try {
        l.onRunResumed?.(event);
      } catch {
        // listener isolation.
      }
    }
  }

  /** Notify listeners a run parked at a gate (a slot is freed — a suspended run
   *  holds zero slots). Edge-triggered: fires each time the run suspends. */
  private fireSuspended(run: RunState, runId: string): void {
    const event: RunLifecycleEvent = { runId, profileId: run.searchProfileId, skill: run.skill };
    for (const l of this.lifecycleListeners) {
      try {
        l.onRunSuspended?.(event);
      } catch {
        // listener isolation — a listener error never breaks the run lifecycle.
      }
    }
  }

  /** The once-only terminal hook: GC the negotiation contact-flip carry, release
   *  the run-ownership reservation (bounds ownedRunIds), then fan out onRunTerminal
   *  so the scheduler frees the slot + the activation registry reacts. Idempotent
   *  via terminalHandled (a run hits exactly one terminal branch,
   *  but the guard makes a double-call safe). */
  private fireTerminal(run: RunState, runId: string, terminalKind: RunTerminalKind): void {
    if (run.terminalHandled) return;
    run.terminalHandled = true;
    // Cheap no-op for non-negotiation runs (the carry Maps are keyed by runId).
    clearContactFlipForRun(runId);
    releaseRunOwnership(runId);
    const event: RunTerminalEvent = {
      runId,
      profileId: run.searchProfileId,
      skill: run.skill,
      terminalKind,
    };
    for (const l of this.lifecycleListeners) {
      try {
        l.onRunTerminal?.(event);
      } catch {
        // listener isolation.
      }
    }
  }

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

    this.pubsub.attachInit(runId, descriptor.skillId, runDriverKind(descriptor, runId));
    const decisionId = randomUUID();
    this.runs.set(runId, {
      skill: descriptor.skillId,
      sessionId: null,
      // A reattached run's profile binding is rebuilt by the durable activation
      // registry (PROMPT-phase0-rest); null until then. The gate still surfaces in
      // listPendingGates regardless.
      searchProfileId: null,
      pending: { step, decisionId, payload },
      terminal: false,
      terminalHandled: false,
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
   * (init frame, driver_kind injected), then begins the run: the GUARD half is
   * awaited (DuplicateRunIdError propagates so the route can 409; ownership +
   * Mastra run creation are durable before the ack), the DRIVE half is NOT —
   * the start returns while the workflow runs, so the rail subscribes the SSE
   * stream DURING the run (a no-suspend browser skill streams its activity to
   * a connected client instead of blocking the POST for its whole wall-clock).
   * The first WorkflowResult is translated when the drive settles (at the
   * first suspend, or at the terminal); a drive REJECTION (Mastra resolves
   * failed-status results — a rejection is plumbing-level) lands as an error
   * frame so the stream always terminates.
   */
  async start(args: {
    skill: string;
    runId?: string;
    input: unknown;
    sessionId?: string | null;
    /** Per-run provider selection (lane A). Registered run-scoped by
     *  beginRunGuarded in lock-step with ownership; absent → no run-scoped
     *  override, so resolveSelectionForRun falls through to the env default
     *  (`AUTOBROKER_AGENT_PROVIDER`, which may itself be claude) or, unset, the
     *  policy() default. */
    agentSelection?: AgentSelection;
  }): Promise<{ runId: string }> {
    const descriptor = DESCRIPTORS_BY_SKILL.get(args.skill);
    if (descriptor === undefined) {
      throw new UnknownSkillError(args.skill);
    }
    const runId = args.runId ?? randomUUID();

    // Acquire the durable per-profile owner BEFORE touching Mastra. Across two
    // server processes only one SQLite INSERT wins; a loser returns a typed 409
    // with zero workflow/channel state. Profile-less runs need no claim.
    const profileId = extractSearchProfileId(args.input);
    const activationClaim =
      profileId === null
        ? null
        : tryClaimActivation({ profileId, runId, db: getDb() });
    if (activationClaim !== null && !activationClaim.acquired) {
      throw new ProfileRunConflictError(profileId!, runId, activationClaim.liveRunId);
    }

    // The dup-id guard + run creation come next. If Mastra refuses the run, roll
    // back only a claim THIS call inserted; an idempotent pre-existing same-run
    // claim belongs to the already-live run and must survive.
    const workflow = this.mastra.getWorkflow(descriptor.workflowId);
    let started: Promise<unknown>;
    try {
      ({ started } = await beginRunGuarded(workflow, {
        runId,
        inputData: args.input,
        ...(args.agentSelection !== undefined ? { agentSelection: args.agentSelection } : {}),
      }));
    } catch (err) {
      if (activationClaim?.inserted === true) {
        clearActivationByRunId({ runId, db: getDb() });
      }
      throw err;
    }

    // First frame: init {run_id, skill, driver_kind} (the pubsub injects
    // driver_kind).
    this.pubsub.attachInit(runId, descriptor.skillId, runDriverKind(descriptor, runId));

    this.runs.set(runId, {
      skill: descriptor.skillId,
      sessionId: args.sessionId ?? null,
      searchProfileId: profileId,
      pending: null,
      terminal: false,
      terminalHandled: false,
      claims: new Map(),
    });

    void started
      .then((result) => {
        this.translate(runId, result);
      })
      .catch((err: unknown) => {
        const run = this.runs.get(runId);
        if (run !== undefined && !run.terminal) {
          run.terminal = true;
          this.finalizeActivation(runId);
          this.pubsub.append(runId, { kind: "error", payload: this.errorFramePayload(err) });
          this.fireTerminal(run, runId, "error");
        }
      });

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
      const dispatched = descriptor.resume(run.pending.step, body.decision, run.pending.payload);
      resumeData = dispatched.resumeData;
      ackBody = dispatched.ackBody;
    } catch (err) {
      // content_invalid / unsupported_action → rollback processing → pending.
      run.claims.delete(decisionId);
      throw err;
    }

    // negotiation_followup contact-flip ② pre-resume hook: an EXPLICIT flip
    // override on the ① batch_review approve is registered into the workflow's
    // per-run carry BEFORE the Mastra resume, so its batchReview step raises the
    // sensitive ② re-confirm for the approved thread. Scoped to the X2 workflow +
    // the ① batch_review card (NOT the ② approval re-confirm itself). The override
    // content was already validated in descriptor.resume; here we register it.
    // (The descriptor.resume signature has no runId, so this is the right seam.)
    if (
      descriptor.workflowId === NEGOTIATION_FOLLOWUP_WORKFLOW_ID &&
      run.pending.step === "batchReview" &&
      run.pending.payload["kind"] !== "approval" &&
      body.decision.action === "accept"
    ) {
      const override = contactFlipOverrideFrom(body.decision);
      if (override !== null) {
        requestContactFlipForRun(runId, override);
      }
    }

    const step = run.pending.step;
    // The parked run is about to execute again — re-occupy its scheduler slot
    // before the resume drives it (a re-suspend / terminal below frees it again).
    this.fireResumed(run, runId);
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
   * Tear down this run's durable activation entry at its terminal. Idempotent
   * (delete-by-runId no-ops when a newer run already overwrote the profile's
   * entry); profile-less runs that recorded nothing also no-op.
   */
  private finalizeActivation(runId: string): void {
    clearActivationByRunId({ runId, db: getDb() });
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
      run.pending = { step, decisionId, payload };
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
      // A parked run holds ZERO scheduler slots — notify so the slot frees.
      this.fireSuspended(run, runId);
      return;
    }

    if (r.status === "success") {
      const outcome = r.result?.outcome;
      if (outcome === "declined") {
        // A decline is terminal: wire kind aborted → status projects declined
        // (the app metadata is the decline outcome).
        run.terminal = true;
        this.finalizeActivation(runId);
        this.pubsub.append(runId, {
          kind: "aborted",
          payload: { reason: "user_declined" },
        });
        this.fireTerminal(run, runId, "declined");
        return;
      }
      // Completed: the skill's plain-speak summary then done. When the
      // workflow output carries a `resolution` provenance (pinned vs
      // inferred_newest, the profile-resolution branch the run took), it rides
      // the terminal TEXT frame payload — skill-agnostic copy, the done frame
      // stays {}.
      run.terminal = true;
      this.finalizeActivation(runId);
      const descriptor = this.descriptorOf(run);
      const textPayload: Record<string, unknown> = {
        text: descriptor.summaryText(r.result),
      };
      const resolution = (r.result as { resolution?: unknown } | undefined)?.resolution;
      if (typeof resolution === "string") textPayload["resolution"] = resolution;
      // inventory_aggregator_scan's per-site tally (F9 site_contribution anchor)
      // rides the SAME skill-agnostic channel — copy it through when present.
      const perSite = (r.result as { per_site?: unknown } | undefined)?.per_site;
      if (Array.isArray(perSite)) textPayload["per_site"] = perSite;
      this.pubsub.append(runId, { kind: "text", payload: textPayload });
      // A successful skill run = forward progress for its profile: advance the
      // durable progress watermark (the dormancy marker the profileHealth /
      // orphan-sweep reconcile reads). Declined/failed/canceled runs skip this.
      const completedProfileId = resultProfileId(r.result);
      if (completedProfileId !== null) {
        writeLastProgressAt(getDb(), completedProfileId, new Date().toISOString());
      }
      // The fresh-by-default pulse: a completed skill wrote rows, so name the
      // touched data families (off the workflowId) + the profile they belong to
      // (off r.result.profileId) so the dashboard refetches exactly the stale
      // views WITHOUT a manual reload. CRITICAL ORDERING: this is appended
      // BEFORE the terminal `done` — appended after `done` the single-terminal
      // invariant ("wire wins") would DISCARD it. A declined/failed run never
      // reaches here, so it emits no pulse.
      this.pubsub.append(runId, {
        kind: "data.changed",
        payload: {
          profile_id: completedProfileId,
          kinds: affectedKinds(descriptor.workflowId),
        },
      });
      // Backfill the run's profile from the RESULT before the terminal fan-out.
      // An unpinned launch starts with a null input profile (the workflow
      // resolves inferred-newest internally), so RunState.searchProfileId is
      // null at start — but the lifecycle listeners key on event.profileId
      // (the scan-chain would silently never fire for an unpinned site_scan).
      // The completed result names the profile the run ACTUALLY acted on.
      if (run.searchProfileId === null && completedProfileId !== null) {
        run.searchProfileId = completedProfileId;
      }
      // Fire the terminal fan-out BEFORE the `done` frame. A lifecycle listener
      // (the app-layer scan-chain) may SYNCHRONOUSLY append an announce frame
      // onto THIS channel, and post-`done` appends are discarded (the
      // single-terminal "wire wins" rule). Every listener throw is isolated in
      // fireTerminal, so a listener error can never swallow the `done` below.
      // Only the success branch reorders — the declined/error/canceled branches
      // append their terminal frame first (no listener appends for those).
      this.fireTerminal(run, runId, "completed");
      this.pubsub.append(runId, { kind: "done", payload: {} });
      return;
    }

    // failed | tripwire | bailed → error (the fail-closed hard-abort path).
    if (r.status === "failed" || r.status === "tripwire" || r.status === "bailed") {
      run.terminal = true;
      this.finalizeActivation(runId);
      this.pubsub.append(runId, {
        kind: "error",
        payload: this.errorFramePayload(r.error),
      });
      this.fireTerminal(run, runId, "error");
      return;
    }

    if (r.status === "canceled") {
      run.terminal = true;
      this.finalizeActivation(runId);
      this.pubsub.append(runId, { kind: "aborted", payload: { reason: "canceled" } });
      this.fireTerminal(run, runId, "canceled");
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

  /** The current pending suspend (step + decisionId), for GET /skill-runs/:id.
   *  Projected WITHOUT the retained payload — the wire shape is unchanged. */
  pendingOf(runId: string): { step: string; decisionId: string } | null {
    const pending = this.runs.get(runId)?.pending ?? null;
    return pending === null ? null : { step: pending.step, decisionId: pending.decisionId };
  }

  /** The session (Mastra thread) this run is linked to, or null (run↔session
   *  association; skill_runs.session_id ↔ thread metadata). */
  sessionOf(runId: string): string | null {
    return this.runs.get(runId)?.sessionId ?? null;
  }

  /**
   * Append a sibling-run announce onto a PARENT run's channel: a voiced text
   * line plus the machine-readable `chained_run` metadata ({run_id, skill}) the
   * client reads to stream the sibling as its own live assistant turn. The
   * metadata rides a `text` frame's payload (the same channel the terminal
   * text-frame metadata uses), so it needs no new wire kind.
   *
   * MUST be appended BEFORE the parent's terminal `done` (post-terminal appends
   * are discarded — "wire wins"); the app-layer scan-chain listener calls this
   * from inside the terminal fan-out, which now runs before the `done` append.
   * No-op when the parent channel is gone (a headless/GC'd run).
   */
  appendChainedRunAnnounce(
    parentRunId: string,
    args: { text: string; chainRunId: string; chainSkill: string },
  ): void {
    if (!this.pubsub.has(parentRunId)) return;
    this.pubsub.append(parentRunId, {
      kind: "text",
      payload: {
        text: args.text,
        chained_run: { run_id: args.chainRunId, skill: args.chainSkill },
      },
    });
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
