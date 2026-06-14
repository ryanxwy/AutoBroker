/**
 * dealer_hygiene — the DESTRUCTIVE mailbox-cleanup skill. ONE flat linear Mastra
 * `createWorkflow`: a soft profile resolve, a read-only detect, THREE strictly-
 * ordered batch_review suspends (5a orphans → 5b CRM threads → 5c CRM contacts),
 * then a single atomic commit. NO LLM call anywhere (detect/classify/commit are
 * fully deterministic).
 *
 * THE KEYSTONE — DECLINE AT ANY STAGE = ZERO WRITES FOR THE WHOLE RUN. The three
 * suspend steps ONLY stage selections into the threaded state; nothing reaches
 * the DB until the single `verify` step, which runs `commitHygiene` (one
 * transaction) ONLY when no stage declined. So a decline at 5a, at 5b (after 5a
 * already staged), or at 5c each leaves ALL tables at Δ=0 — the staged orphans
 * and threads are never committed. This deferred single-transaction shape is what
 * makes the zero-writes guarantee airtight.
 *
 * SAFETY (load-bearing):
 *   - explicit per-item selection (the resume is always an explicit approved_ids
 *     list, never approve-all); a stage stages approved_ids ∩ shown;
 *   - soft-delete: contacts are DEMOTED, CRM threads SUPPRESSED; the only hard
 *     delete is a re-confirmed TRUE orphan (and the orphan path never suppresses
 *     its message-id);
 *   - typed throwing guards inside commitHygiene roll the WHOLE tx back;
 *   - empty stage → its suspend is skipped (no phantom card);
 *   - soft profile scope: the pin is recorded as provenance, detection is GLOBAL,
 *     and none/ambiguous still RUN (no three-branch STOP);
 *   - idempotent re-run: the detect-time suppression pre-filter + the idempotent
 *     writers mean a second run after a clean surfaces nothing → nothing_to_clean.
 *
 * STEP MAP:
 *   0 resolveProfile — soft (no STOP); records resolution provenance.
 *   1 detect         — READ-ONLY: the three detect tools → lean id+label targets,
 *                      pre-filtered against already-suppressed threads.
 *   2 suspend5a      — orphans. empty/declined → pass-through; else suspend; on
 *                      resume decline → declined; approve → stage approved ∩ shown.
 *   3 suspend5b      — crm_threads. same shape; stages stagedThreads.
 *   4 suspend5c      — crm_contacts. same shape; stages stagedContacts.
 *   5 verify         — declined → {outcome:"declined"} (ZERO writes). else the
 *                      single commitHygiene + a deterministic ZERO-LLM summary
 *                      (counts only — NEVER budget, NEVER a hex run id, NEVER the
 *                      car name). all-empty → nothing_to_clean (a valid success).
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/tools (the
 * resolver + the hygiene detect/commit tools — the ONLY DB paths), and the
 * skill-local contracts.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  commitHygiene as commitHygieneImpl,
  findCrmOnlyThreads as findCrmOnlyThreadsImpl,
  findCrmPlatformContacts as findCrmPlatformContactsImpl,
  findOrphanThreads as findOrphanThreadsImpl,
  getDb,
  listSuppressions as listSuppressionsImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
} from "@autobroker/tools";

import {
  DEALER_HYGIENE_WORKFLOW_ID,
  HygieneResumeSchema,
  HygieneStageReviewSchema,
} from "./dealerHygieneContracts.js";

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL suspend/resume chain against
 * an isolated tmp DB, WITHOUT module mocks.
 */
export interface DealerHygieneWorkflowDeps {
  resolveProfile: typeof resolveActiveProfileImpl;
  findOrphanThreads: typeof findOrphanThreadsImpl;
  findCrmOnlyThreads: typeof findCrmOnlyThreadsImpl;
  findCrmPlatformContacts: typeof findCrmPlatformContactsImpl;
  listSuppressions: typeof listSuppressionsImpl;
  commitHygiene: typeof commitHygieneImpl;
  getDb: typeof getDb;
}

const realDeps: DealerHygieneWorkflowDeps = {
  resolveProfile: resolveActiveProfileImpl,
  findOrphanThreads: findOrphanThreadsImpl,
  findCrmOnlyThreads: findCrmOnlyThreadsImpl,
  findCrmPlatformContacts: findCrmPlatformContactsImpl,
  listSuppressions: listSuppressionsImpl,
  commitHygiene: commitHygieneImpl,
  getDb,
};

let injectedDeps: DealerHygieneWorkflowDeps | undefined;

function deps(): DealerHygieneWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner. */
export function __setDealerHygieneDepsForTests(
  partial: Partial<DealerHygieneWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setDealerHygieneDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetDealerHygieneDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  return fn(deps().getDb());
}

// ---------------------------------------------------------------------------
// the threaded workflow state (flat plain-JSON; LEAN — ids + labels only)
// ---------------------------------------------------------------------------

const StagedOrphanSchema = z.object({ thread_id: z.string(), gmail_thread_id: z.string() });

const TargetSchema = z.object({ id: z.string(), name: z.string(), reason: z.string() });

const HygieneStateSchema = z.object({
  resolution: z.enum(["pinned", "inferred_newest"]),
  /** The pinned profile id (for the audit trail), or null when global. */
  pinnedProfileId: z.string().nullable(),
  declined: z.boolean(),
  // the detected candidate targets (id + label only)
  orphanTargets: z.array(TargetSchema),
  crmThreadTargets: z.array(TargetSchema),
  crmContactTargets: z.array(TargetSchema),
  // the {thread_id, gmail_thread_id} detail for the orphan targets — carried so
  // 5a can stage the gmail id (which verify's red-line assertion needs) without
  // surfacing it on the suspend card.
  orphanDetails: z.array(StagedOrphanSchema),
  // the per-stage staged selections (the approved ids; nothing is written until verify)
  stagedOrphans: z.array(StagedOrphanSchema),
  stagedThreads: z.array(z.string()),
  stagedContacts: z.array(z.string()),
  // the verify-step result counts
  orphansDeleted: z.number().int(),
  crmThreadsSuppressed: z.number().int(),
  crmContactsSuppressed: z.number().int(),
});
type HygieneState = z.infer<typeof HygieneStateSchema>;

const HygieneInputSchema = z.object({ search_profile_id: z.string().nullable() });

const HygieneOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("cleaned"),
    resolution: z.enum(["pinned", "inferred_newest"]),
    orphans_deleted: z.number().int(),
    crm_threads_suppressed: z.number().int(),
    crm_contacts_suppressed: z.number().int(),
    nothing_to_clean: z.boolean(),
    summary: z.string(),
  }),
  z.object({ outcome: z.literal("declined") }),
]);

function asState(inputData: unknown): HygieneState {
  return HygieneStateSchema.parse(inputData);
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (SOFT: records provenance, NEVER 3-branch STOPs)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: HygieneInputSchema,
  outputSchema: HygieneStateSchema,
  execute: async ({ inputData }) => {
    const resolved = withDb((db) =>
      deps().resolveProfile(
        db,
        inputData.search_profile_id !== null ? { threadPin: inputData.search_profile_id } : {},
      ),
    );

    // SOFT scope: a pin is recorded as provenance; everything else runs GLOBAL
    // with inferred_newest provenance. No STOP on none/ambiguous.
    let resolution: "pinned" | "inferred_newest";
    let pinnedProfileId: string | null;
    if (resolved.kind === "pinned") {
      resolution = "pinned";
      pinnedProfileId = resolved.profile.id;
    } else {
      resolution = "inferred_newest";
      pinnedProfileId = resolved.kind === "inferred_newest" ? resolved.profile.id : null;
      console.info(
        JSON.stringify({
          trace: "dealer_hygiene",
          event: "global_scope_resolution",
          kind: resolved.kind,
        }),
      );
    }

    return {
      resolution,
      pinnedProfileId,
      declined: false,
      orphanTargets: [],
      crmThreadTargets: [],
      crmContactTargets: [],
      orphanDetails: [],
      stagedOrphans: [],
      stagedThreads: [],
      stagedContacts: [],
      orphansDeleted: 0,
      crmThreadsSuppressed: 0,
      crmContactsSuppressed: 0,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — detect (READ-ONLY: the three detect tools → lean targets)
// ---------------------------------------------------------------------------

const detectStep = createStep({
  id: "detect",
  inputSchema: HygieneStateSchema,
  outputSchema: HygieneStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const pin = state.pinnedProfileId;

    const alreadySuppressed = withDb((db) => deps().listSuppressions(db));

    const orphans = withDb((db) => deps().findOrphanThreads(db, pin)).filter(
      (o) => !alreadySuppressed.has(o.thread_id),
    );
    const crmThreads = withDb((db) => deps().findCrmOnlyThreads(db, pin)).filter(
      (t) => !alreadySuppressed.has(t.thread_id),
    );
    const crmContacts = withDb((db) => deps().findCrmPlatformContacts(db, pin));

    const orphanTargets = orphans.map((o) => ({ id: o.thread_id, name: o.dealer_name, reason: o.reason }));
    // The gmail_thread_id rides a parallel detail field (off the card) so 5a can
    // stage it for verify's red-line assertion.
    const orphanDetails = orphans.map((o) => ({ thread_id: o.thread_id, gmail_thread_id: o.gmail_thread_id }));

    const crmThreadTargets = crmThreads.map((t) => ({
      id: t.thread_id,
      name: t.subject !== null && t.subject !== "" ? `${t.dealer_name} — ${t.subject}` : t.dealer_name,
      reason: t.reason,
    }));

    const crmContactTargets = crmContacts.map((c) => ({
      id: c.contact_id,
      name: `${c.normalized_email} (${c.dealer_name})`,
      reason: c.reason,
    }));

    return {
      ...state,
      orphanTargets,
      crmThreadTargets,
      crmContactTargets,
      orphanDetails,
    };
  },
});

// ---------------------------------------------------------------------------
// the three suspend steps (5a/5b/5c) — STAGE only; never write
// ---------------------------------------------------------------------------

/** Build the suspend payload for one stage. */
function stagePayload(
  stage: "orphans" | "crm_threads" | "crm_contacts",
  question: string,
  targets: HygieneState["orphanTargets"],
): z.infer<typeof HygieneStageReviewSchema> {
  return {
    kind: "batch_review",
    stage,
    question,
    targets: targets.map((t) => ({ id: t.id, name: t.name, reason: t.reason })),
    total: targets.length,
  };
}

const suspend5aStep = createStep({
  id: "suspend5a",
  inputSchema: HygieneStateSchema,
  outputSchema: HygieneStateSchema,
  resumeSchema: HygieneResumeSchema,
  suspendSchema: HygieneStageReviewSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = asState(inputData);
    // declined upstream OR empty stage → pass through (no card).
    if (state.declined || state.orphanTargets.length === 0) return state;

    if (resumeData === undefined) {
      return (await suspend(
        stagePayload("orphans", "Delete these orphan thread records?", state.orphanTargets),
      )) as never;
    }
    const resume = HygieneResumeSchema.parse(resumeData);
    if (resume.action === "decline") return { ...state, declined: true };

    const shown = new Set(state.orphanTargets.map((t) => t.id));
    const approved = [...new Set(resume.approved_ids)].filter((id) => shown.has(id));
    const stagedOrphans = approved
      .map((id) => state.orphanDetails.find((d) => d.thread_id === id))
      .filter((d): d is { thread_id: string; gmail_thread_id: string } => d !== undefined);
    return { ...state, stagedOrphans };
  },
});

const suspend5bStep = createStep({
  id: "suspend5b",
  inputSchema: HygieneStateSchema,
  outputSchema: HygieneStateSchema,
  resumeSchema: HygieneResumeSchema,
  suspendSchema: HygieneStageReviewSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = asState(inputData);
    if (state.declined || state.crmThreadTargets.length === 0) return state;

    if (resumeData === undefined) {
      return (await suspend(
        stagePayload("crm_threads", "Suppress these CRM follow-up threads?", state.crmThreadTargets),
      )) as never;
    }
    const resume = HygieneResumeSchema.parse(resumeData);
    if (resume.action === "decline") return { ...state, declined: true };

    const shown = new Set(state.crmThreadTargets.map((t) => t.id));
    const stagedThreads = [...new Set(resume.approved_ids)].filter((id) => shown.has(id));
    return { ...state, stagedThreads };
  },
});

const suspend5cStep = createStep({
  id: "suspend5c",
  inputSchema: HygieneStateSchema,
  outputSchema: HygieneStateSchema,
  resumeSchema: HygieneResumeSchema,
  suspendSchema: HygieneStageReviewSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = asState(inputData);
    if (state.declined || state.crmContactTargets.length === 0) return state;

    if (resumeData === undefined) {
      return (await suspend(
        stagePayload("crm_contacts", "Demote these CRM platform contacts?", state.crmContactTargets),
      )) as never;
    }
    const resume = HygieneResumeSchema.parse(resumeData);
    if (resume.action === "decline") return { ...state, declined: true };

    const shown = new Set(state.crmContactTargets.map((t) => t.id));
    const stagedContacts = [...new Set(resume.approved_ids)].filter((id) => shown.has(id));
    return { ...state, stagedContacts };
  },
});

// ---------------------------------------------------------------------------
// step 5 — verify (the SINGLE atomic write; ZERO writes when declined)
// ---------------------------------------------------------------------------

const verifyStep = createStep({
  id: "verify",
  inputSchema: HygieneStateSchema,
  outputSchema: HygieneOutputSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);

    // ANY stage decline → terminal, ZERO writes for the whole run.
    if (state.declined) {
      return { outcome: "declined" as const };
    }

    const nothingStaged =
      state.stagedOrphans.length === 0 &&
      state.stagedThreads.length === 0 &&
      state.stagedContacts.length === 0;

    // All three detection sets empty AND nothing staged → nothing_to_clean. (A
    // user could also have skipped every row in a non-empty stage; that too is a
    // clean-zero success.)
    const detectedNothing =
      state.orphanTargets.length === 0 &&
      state.crmThreadTargets.length === 0 &&
      state.crmContactTargets.length === 0;

    let orphansDeleted = 0;
    let crmThreadsSuppressed = 0;
    let crmContactsSuppressed = 0;
    if (!nothingStaged) {
      const res = withDb((db) =>
        deps().commitHygiene(db, {
          runId,
          stagedOrphans: state.stagedOrphans,
          stagedThreads: state.stagedThreads,
          stagedContacts: state.stagedContacts,
        }),
      );
      orphansDeleted = res.orphans_deleted;
      crmThreadsSuppressed = res.crm_threads_suppressed;
      crmContactsSuppressed = res.crm_contacts_suppressed;
    }

    const total = orphansDeleted + crmThreadsSuppressed + crmContactsSuppressed;
    const summary =
      detectedNothing || total === 0
        ? "Mailbox is already clean — nothing to clean up."
        : `Cleaned up ${orphansDeleted} orphan record${orphansDeleted === 1 ? "" : "s"}, ` +
          `suppressed ${crmThreadsSuppressed} CRM follow-up thread${crmThreadsSuppressed === 1 ? "" : "s"}, ` +
          `and demoted ${crmContactsSuppressed} CRM platform contact${crmContactsSuppressed === 1 ? "" : "s"}.`;

    return {
      outcome: "cleaned" as const,
      resolution: state.resolution,
      orphans_deleted: orphansDeleted,
      crm_threads_suppressed: crmThreadsSuppressed,
      crm_contacts_suppressed: crmContactsSuppressed,
      nothing_to_clean: detectedNothing,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (6 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const dealerHygieneWorkflow = createWorkflow({
  id: DEALER_HYGIENE_WORKFLOW_ID,
  inputSchema: HygieneInputSchema,
  outputSchema: HygieneOutputSchema,
})
  .then(resolveProfileStep)
  .then(detectStep)
  .then(suspend5aStep)
  .then(suspend5bStep)
  .then(suspend5cStep)
  .then(verifyStep)
  .commit();

export { DEALER_HYGIENE_WORKFLOW_ID };
