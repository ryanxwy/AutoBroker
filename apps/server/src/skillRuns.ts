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
import {
  GEOSEARCH_SKILL_ID,
  HYGIENE_SKILL_ID,
  INBOX_CHECK_SKILL_ID,
  INCENTIVE_SCRAPE_SKILL_ID,
  INTAKE_SKILL_ID,
  INVENTORY_COMPARE_SKILL_ID,
  INVENTORY_LINK_SCAN_SKILL_ID,
  INVENTORY_SITE_SCAN_SKILL_ID,
} from "@autobroker/skills";
import {
  beginRunGuarded,
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
  DEALER_GEOSEARCH_WORKFLOW_ID,
  DEALER_HYGIENE_WORKFLOW_ID,
  DEALER_INBOX_CHECK_WORKFLOW_ID,
  INCENTIVE_SCRAPE_WORKFLOW_ID,
  INVENTORY_COMPARE_WORKFLOW_ID,
  INVENTORY_LINK_SCAN_WORKFLOW_ID,
  INVENTORY_SITE_SCAN_WORKFLOW_ID,
  REGISTERED_WORKFLOW_IDS,
  CollectResumeSchema,
  ForceOverrideResumeSchema,
  AmbiguousLocationResumeSchema,
  MalformedRetryResumeSchema,
  BatchReviewResumeSchema,
  HygieneResumeSchema,
  OemFirstEncounterResumeSchema,
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
// inventory_site_scan — the third registered descriptor (browser skill with
// ONE batch_review suspend). The resume validates the approved id list
// against the RETAINED suspend payload: ids outside the reviewed targets are
// a 400 content_invalid (claim rolls back, the suspend stays retryable).
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
 * The batch_review resume shaping, shared by BOTH scan skills (one wire
 * contract, two suspended-step names: inventory_site_scan's "batchReview",
 * inventory_link_scan's "reviewGate"). decline/cancel → the step's decline
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
    const parsed = InventoryScanStartBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "request body invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    return {
      search_profile_id: parsed.data.search_profile_id ?? null,
      dealer_ids: parseDealerIdsCsv(parsed.data.dealer_ids),
      // approved_by is AUDIT METADATA ONLY — it rides into the workflow state
      // for the trail; nothing branches on it (here or in the workflow).
      approved_by: parsed.data.approved_by ?? null,
      max_targets: parsed.data.max_targets ?? null,
    };
  },

  resume: batchReviewResumeFor("batchReview"),

  // The workflow's confirm step templates the full deterministic summary —
  // pass it through (declined runs never reach summaryText).
  summaryText(result: unknown): string {
    const r = result as { summary?: string } | undefined;
    return r?.summary ?? "Inventory site scan complete.";
  },
};

// ===========================================================================
// inventory_link_scan — the fourth registered descriptor (browser skill with
// ONE batch_review suspend over pending inventory LINKS). Same wire contract
// as inventory_site_scan's card; the suspended step is "reviewGate" and the
// approved ids are SOURCE ids (validated ⊆ the retained suspend payload's
// shown rows through the shared batchReviewResume seam).
// ===========================================================================

/** The link-scan start body fields. Only `search_profile_id` matters to the
 *  workflow — links come from pending dealer_inventory_sources rows, never
 *  from the start body; envelope fields ride the same body and are ignored. */
const LinkScanStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
});

/** The link-scan workflow inputData shape. */
interface LinkScanStartInput {
  search_profile_id: string | null;
}

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

  buildInput(body: Record<string, unknown>): LinkScanStartInput {
    const parsed = LinkScanStartBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "request body invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    return { search_profile_id: parsed.data.search_profile_id ?? null };
  },

  resume: batchReviewResumeFor("reviewGate"),

  // The workflow's confirm step templates the full deterministic summary —
  // pass it through (declined runs never reach summaryText).
  summaryText(result: unknown): string {
    const r = result as { summary?: string } | undefined;
    return r?.summary ?? "Inventory link scan complete.";
  },
};

// ===========================================================================
// incentive_scrape — the fifth registered descriptor (browser skill with ONE
// first-encounter approval suspend BEFORE any navigation). The resume
// vocabulary maps the generic form-decision verbs onto the workflow's typed
// save | skip | decline: decline/cancel = the whole run declines (zero nav,
// zero writes); accept defaults to save-the-shown-candidate, with an optional
// content.url correction and an optional content.action="skip" (skip THIS
// brand, run continues) for non-UI callers.
// ===========================================================================

/** The incentive-scrape start body fields. Only `search_profile_id` matters
 *  to the workflow — targets derive from the active profiles; envelope fields
 *  ride the same body and are ignored. */
const IncentiveScrapeStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
});

/** The incentive-scrape workflow inputData shape. */
interface IncentiveScrapeStartInput {
  search_profile_id: string | null;
}

/** The accept-content shape for the first-encounter approval form. Both keys
 *  optional: a bare accept approves the SHOWN candidate (the approval card's
 *  Approve button sends no content). */
const OemFirstEncounterAcceptContentSchema = z
  .object({
    action: z.enum(["save", "skip"]).optional(),
    url: z.string().nullable().optional(),
  })
  .strict();

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

  buildInput(body: Record<string, unknown>): IncentiveScrapeStartInput {
    const parsed = IncentiveScrapeStartBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "request body invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    return { search_profile_id: parsed.data.search_profile_id ?? null };
  },

  resume(
    step: string,
    decision: FormDecisionBody["decision"],
    _suspendPayload: Record<string, unknown>,
  ): { resumeData: unknown; ackBody: Record<string, unknown> } {
    if (step !== "resolveOemSource") {
      throw new FormDecisionError(
        "unsupported_action",
        400,
        `no resume schema for suspended step '${step}'`,
      );
    }
    const { action, content } = decision;

    if (action === "decline" || action === "cancel") {
      return {
        resumeData: OemFirstEncounterResumeSchema.parse({ action: "decline", url: null }),
        ackBody: { action, content: null },
      };
    }

    const parsed = OemFirstEncounterAcceptContentSchema.safeParse(content ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "form content invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    const inner = parsed.data.action ?? "save";
    const url = inner === "save" ? (parsed.data.url ?? null) : null;
    const resume = OemFirstEncounterResumeSchema.parse({ action: inner, url });
    return {
      resumeData: resume,
      ackBody: { action: "accept", content: { action: inner, url } },
    };
  },

  // The workflow's confirm step templates the full deterministic summary —
  // pass it through (declined runs never reach summaryText).
  summaryText(result: unknown): string {
    const r = result as { summary?: string } | undefined;
    return r?.summary ?? "Incentive scrape complete.";
  },
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

/** The inbox-check start body fields. Only `search_profile_id` matters to the
 *  workflow — the sweep window derives from the per-profile watermark, never
 *  from the start body; envelope fields ride the same body and are ignored. */
const InboxCheckStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
});

/** The inbox-check workflow inputData shape. */
interface InboxCheckStartInput {
  search_profile_id: string | null;
}

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

  buildInput(body: Record<string, unknown>): InboxCheckStartInput {
    const parsed = InboxCheckStartBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "request body invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    return { search_profile_id: parsed.data.search_profile_id ?? null };
  },

  resume: batchReviewResumeFor("batchReview"),

  // The workflow's confirm step templates the full deterministic summary — pass
  // it through (declined/no_replies runs never reach summaryText).
  summaryText(result: unknown): string {
    const r = result as { summary?: string } | undefined;
    return r?.summary ?? "Dealer inbox check complete.";
  },
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

/** The hygiene start body fields. Only `search_profile_id` matters — it is
 *  recorded as provenance but never filters the GLOBAL detection; envelope
 *  fields ride the same body and are ignored. */
const HygieneStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
});

/** The hygiene workflow inputData shape. */
interface HygieneStartInput {
  search_profile_id: string | null;
}

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

  buildInput(body: Record<string, unknown>): HygieneStartInput {
    const parsed = HygieneStartBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "request body invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    return { search_profile_id: parsed.data.search_profile_id ?? null };
  },

  resume: hygieneResume,

  // The workflow's verify step templates the full deterministic summary — pass
  // it through (declined runs never reach summaryText).
  summaryText(result: unknown): string {
    const r = result as { summary?: string } | undefined;
    return r?.summary ?? "Dealer hygiene complete.";
  },
};

// ===========================================================================
// inventory_compare — the eighth registered descriptor (deterministic inventory
// ranker; read-only, zero-LLM, NO suspend). No `resume` member: the workflow
// has no HITL suspend, so a form-decision against an inventory_compare run 400s
// as unsupported_action. driver_kind is the constant api-key label (no useCase
// routes through policy()).
// ===========================================================================

/** The inventory-compare start body fields. Only `search_profile_id` matters to
 *  the workflow; the start-route envelope fields ride the same body and are
 *  accepted + ignored (non-strict object). */
const InventoryCompareStartBodySchema = z.object({
  search_profile_id: z.string().nullable().optional(),
});

/** The inventory-compare workflow inputData shape. */
interface InventoryCompareStartInput {
  search_profile_id: string | null;
}

/** The inventory_compare descriptor. */
export const inventoryCompareDescriptor: RunDescriptor = {
  skillId: INVENTORY_COMPARE_SKILL_ID,
  workflowId: INVENTORY_COMPARE_WORKFLOW_ID,

  // Zero-LLM: resolve/rank/render are fully deterministic, so the wire label is
  // the constant api-key lane (no useCase routes through policy()).
  driverKind(): HarnessDriverKind {
    return "deepseek_apikey";
  },

  buildInput(body: Record<string, unknown>): InventoryCompareStartInput {
    const parsed = InventoryCompareStartBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FormDecisionError("content_invalid", 400, "request body invalid", {
        ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
        extra: { issues: parsed.error.issues },
      });
    }
    return { search_profile_id: parsed.data.search_profile_id ?? null };
  },

  // The workflow's render step templates the full deterministic summary — pass
  // it through.
  summaryText(result: unknown): string {
    const r = result as { summary?: string } | undefined;
    return r?.summary ?? "Inventory compare complete.";
  },
};

// ===========================================================================
// The descriptor registry + the skill-agnostic run service.
// ===========================================================================

/** Every skill the server can start runs for, in registration order. */
export const RUN_DESCRIPTORS: readonly RunDescriptor[] = [
  intakeRunDescriptor,
  dealerGeosearchDescriptor,
  inventorySiteScanDescriptor,
  inventoryLinkScanDescriptor,
  incentiveScrapeDescriptor,
  dealerInboxCheckDescriptor,
  dealerHygieneDescriptor,
  inventoryCompareDescriptor,
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
  /** The step id + decisionId + RETAINED suspend payload of the CURRENTLY
   *  pending suspend, or null when the run is running/terminal. The
   *  form-decision must reference this decisionId; the payload is what the
   *  descriptor's resume validates the answer against (the exact spec_inline
   *  the user saw — e.g. the batch_review ids ⊆ targets check). */
  pending: { step: string; decisionId: string; payload: Record<string, unknown> } | null;
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
    case INVENTORY_LINK_SCAN_WORKFLOW_ID:
      return ["listings"];
    case INCENTIVE_SCRAPE_WORKFLOW_ID:
      return ["incentives"];
    case DEALER_INBOX_CHECK_WORKFLOW_ID:
      return ["threads", "messages", "contacts"];
    case DEALER_HYGIENE_WORKFLOW_ID:
      return ["threads", "contacts"];
    case INVENTORY_COMPARE_WORKFLOW_ID:
      // Pure read: the ranker writes NOTHING (no match_score column, no row
      // mutation). The success pulse fires with kinds:[] — the UI treats it as
      // nothing-to-refetch.
      return [];
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
      pending: { step, decisionId, payload },
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
  }): Promise<{ runId: string }> {
    const descriptor = DESCRIPTORS_BY_SKILL.get(args.skill);
    if (descriptor === undefined) {
      throw new UnknownSkillError(args.skill);
    }
    const runId = args.runId ?? randomUUID();

    // The dup-id guard + run creation come FIRST: a 409 must leave no channel
    // or run state behind for the already-existing run id.
    const workflow = this.mastra.getWorkflow(descriptor.workflowId);
    const { started } = await beginRunGuarded(workflow, {
      runId,
      inputData: args.input,
    });

    // First frame: init {run_id, skill, driver_kind} (the pubsub injects
    // driver_kind).
    this.pubsub.attachInit(runId, descriptor.skillId, descriptor.driverKind());

    this.runs.set(runId, {
      skill: descriptor.skillId,
      sessionId: args.sessionId ?? null,
      pending: null,
      terminal: false,
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
          this.pubsub.append(runId, { kind: "error", payload: this.errorFramePayload(err) });
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
      const descriptor = this.descriptorOf(run);
      const textPayload: Record<string, unknown> = {
        text: descriptor.summaryText(r.result),
      };
      const resolution = (r.result as { resolution?: unknown } | undefined)?.resolution;
      if (typeof resolution === "string") textPayload["resolution"] = resolution;
      this.pubsub.append(runId, { kind: "text", payload: textPayload });
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
          profile_id: resultProfileId(r.result),
          kinds: affectedKinds(descriptor.workflowId),
        },
      });
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
