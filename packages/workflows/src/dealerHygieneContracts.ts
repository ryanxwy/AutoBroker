/**
 * dealer_hygiene contracts — the typed input/output, the ONE batch_review
 * suspend payload (discriminated by stage), and the ONE resume vocabulary the
 * three suspend stages reuse. Skill-local, single-use (the workflow file + the
 * server descriptor + their tests import them), kept out of the shared core
 * layer like the other skills' contracts.
 *
 * DESTRUCTIVE skill. Three strictly-ordered per-item batch-review suspends
 * (5a orphans → 5b CRM threads → 5c CRM contacts). Decline at ANY stage = ZERO
 * writes for the whole run. The resume is always an EXPLICIT id list (approve
 * {approved_ids min 1} | decline) — never an approve-all wire member; rows
 * default undecided on the card.
 *
 * SOFT profile scope: the workflow records the resolution provenance
 * (pinned | inferred_newest) but runs GLOBAL detection regardless — there is no
 * three-branch STOP here.
 *
 * ZERO-LLM: the whole pipeline (detect, classify, commit) is deterministic;
 * there is no emit schema, no #1244 surface.
 *
 * Dependency wall: imports zod only.
 */

import { z } from "zod";

/** The stable workflow id (registration + the server descriptor). */
export const DEALER_HYGIENE_WORKFLOW_ID = "dealer_hygiene" as const;

/** The three strictly-ordered cleanup stages (5a → 5b → 5c). */
export const HYGIENE_STAGES = ["orphans", "crm_threads", "crm_contacts"] as const;
export type HygieneStage = (typeof HYGIENE_STAGES)[number];

// ---------------------------------------------------------------------------
// workflow input / output
// ---------------------------------------------------------------------------

/** The workflow input (the server descriptor builds this from the start body).
 *  The profile pin is recorded as provenance but never filters detection. */
export const DealerHygieneInputSchema = z.object({
  /** An explicit profile pin, or null → soft resolution (no STOP). */
  search_profile_id: z.string().nullable(),
});
export type DealerHygieneInput = z.infer<typeof DealerHygieneInputSchema>;

/**
 * The workflow output — cleaned | declined union. `cleaned` carries the per-stage
 * counts (every count is a number, no budget, no hex run id); `nothing_to_clean`
 * (all three detection sets empty) is a VALID success, never an error.
 * `declined` (a decline at ANY stage) means zero writes for the whole run.
 */
export const DealerHygieneOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("cleaned"),
    resolution: z.enum(["pinned", "inferred_newest"]),
    orphans_deleted: z.number().int(),
    crm_threads_suppressed: z.number().int(),
    crm_contacts_suppressed: z.number().int(),
    /** All three detection sets were empty — a clean mailbox, valid success. */
    nothing_to_clean: z.boolean(),
    summary: z.string(),
  }),
  z.object({ outcome: z.literal("declined") }),
]);
export type DealerHygieneOutput = z.infer<typeof DealerHygieneOutputSchema>;

// ---------------------------------------------------------------------------
// the ONE suspend payload (discriminated by stage)
// ---------------------------------------------------------------------------

/**
 * The suspend payload (the spec_inline each stage's batch_review card renders).
 * ONE shape, discriminated by `stage`: the targets carry a generic `id`
 * (thread_id for 5a/5b, contact_id for 5c), a display `name`, and a plain-speak
 * `reason`. IDs + short labels only — no full bodies in the payload.
 */
export const HygieneStageReviewSchema = z
  .object({
    kind: z.literal("batch_review"),
    stage: z.enum(HYGIENE_STAGES),
    question: z.string(),
    targets: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        reason: z.string(),
      }),
    ),
    total: z.number().int(),
  })
  .strict();
export type HygieneStageReview = z.infer<typeof HygieneStageReviewSchema>;

// ---------------------------------------------------------------------------
// the ONE resume vocabulary (reused per stage)
// ---------------------------------------------------------------------------

/**
 * The resume — an EXPLICIT id list to approve (min 1), or a decline. The same
 * vocabulary is reused for all three stages. There is NO approve-all member: the
 * card's "Select all" is a UI affordance that still emits the full explicit id
 * list. A decline at any stage is terminal (zero writes for the whole run).
 */
export const HygieneResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), approved_ids: z.array(z.string()).min(1) }),
  z.object({ action: z.literal("decline") }),
]);
export type HygieneResume = z.infer<typeof HygieneResumeSchema>;
