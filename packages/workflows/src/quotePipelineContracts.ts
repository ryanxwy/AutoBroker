/**
 * quote_pipeline contracts — the typed input/output (+ the workflow id const)
 * the quotePipeline workflow and the server descriptor share. Skill-local,
 * single-use contracts kept out of the shared core layer like the intake /
 * incentive_scrape contracts.
 *
 * This file deliberately carries NO runtime import of any child workflow
 * (dealer_reply_extract / incentive_scrape / quote_audit / quote_compare) — it
 * is zod + the id const only, so it compiles cleanly while three of those four
 * children are still unbuilt. The orchestrator workflow file (built once the
 * children land) is the place those child output↔input schema imports belong.
 *
 * PROFILE RESOLUTION — the STRICT three-branch ASK (this is a per-profile
 * pipeline, NOT the digest/incentive enumerate-all exception): exactly 1 active
 * → run; 0 → typed STOP pointing at intake; 2+ → typed STOP asking by vehicle
 * name. The pipeline NEVER silently picks the newest active. `resolution` is
 * therefore `pinned | inferred_newest`, where `inferred_newest` is only ever
 * reachable via an explicit pin-precedence fact, never an auto-pick.
 *
 * NON-DURABILITY (parity delta, honored in the workflow not here): every run
 * re-derives the four predicates over the live DB via detectPipelineState —
 * there is no checkpoint table. A re-run after a partial pass picks up only the
 * still-applicable steps; child idempotency keys (the dealer_quotes /
 * quote_audits UNIQUE indexes + the 7-day incentive cache) prevent duplicates.
 *
 * final_state / next_action are computed in CODE (the deterministic
 * finalState.ts helpers), never by an LLM — a parity gain over the legacy
 * LLM-narrated completion record.
 *
 * Dependency wall: imports zod only.
 */

import { z } from "zod";

/** The Mastra workflow id + skill id for this orchestrator. */
export const QUOTE_PIPELINE_WORKFLOW_ID = "quote_pipeline" as const;

/** The four child steps, in their canonical fan-out order. */
export const PIPELINE_STEPS = ["extract", "scrape", "audit", "compare"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** The terminal pipeline disposition (computed in code, never by an LLM). */
export const FINAL_STATES = ["ok", "partial", "no_work"] as const;
export type FinalState = (typeof FINAL_STATES)[number];

/** How the profile was resolved. `inferred_newest` is reachable only via an
 *  explicit pin-precedence fact, never a silent auto-pick of the newest. */
export const PIPELINE_RESOLUTIONS = ["pinned", "inferred_newest"] as const;
export type PipelineResolution = (typeof PIPELINE_RESOLUTIONS)[number];

/**
 * Input — `{ search_profile_id, dry_run, target_listing_id }`.
 *   - search_profile_id null → resolve via the strict three-branch ASK.
 *   - dry_run true → short-circuit to a would-run preview (zero writes).
 *   - target_listing_id set → the targeted-VIN OTD sub-path (one outbound send
 *     through the L2 gate — real in buyer mode, fake in test mode), skipping the full fan-out.
 * Flat, all-required-with-explicit-null (the #1244 schema discipline).
 */
export const quotePipelineInputSchema = z.object({
  search_profile_id: z.string().nullable(),
  dry_run: z.boolean(),
  target_listing_id: z.string().nullable(),
});
export type QuotePipelineInput = z.infer<typeof quotePipelineInputSchema>;

/**
 * Output — discriminated by `outcome`.
 *   - completed: the full or partial fan-out ran; the completion record was
 *     appended. `completedSteps` ⊆ PIPELINE_STEPS; `finalState` is the
 *     code-computed disposition; `nextAction` is the deterministic plain-speak
 *     next step.
 *   - declined: the targeted-VIN SEND suspend was declined — zero outbound,
 *     zero record-quote write.
 *
 * The targeted-VIN run reports its disposition through the same `completed`
 * member (it carries `completedSteps: []` and a `finalState` reflecting whether
 * the record-quote landed) so a single discriminant covers both lanes; only an
 * explicit decline produces the `declined` member.
 */
export const quotePipelineCompletedSchema = z.object({
  outcome: z.literal("completed"),
  finalState: z.enum(FINAL_STATES),
  completedSteps: z.array(z.enum(PIPELINE_STEPS)),
  nextAction: z.string(),
  resolution: z.enum(PIPELINE_RESOLUTIONS),
  summary: z.string(),
});
export type QuotePipelineCompleted = z.infer<typeof quotePipelineCompletedSchema>;

export const quotePipelineDeclinedSchema = z.object({
  outcome: z.literal("declined"),
});
export type QuotePipelineDeclined = z.infer<typeof quotePipelineDeclinedSchema>;

export const quotePipelineOutputSchema = z.discriminatedUnion("outcome", [
  quotePipelineCompletedSchema,
  quotePipelineDeclinedSchema,
]);
export type QuotePipelineOutput = z.infer<typeof quotePipelineOutputSchema>;

/**
 * The typed shape serialized into the one `audit_log` completion row's
 * `payload_json` (read back through this schema on the read side — there is no
 * dedicated audit_log column for any of these fields).
 */
export const pipelineCompletionRecordSchema = z.object({
  pipeline_run_id: z.string(),
  completed_steps: z.array(z.enum(PIPELINE_STEPS)),
  final_state: z.enum(FINAL_STATES),
  next_action: z.string(),
});
export type PipelineCompletionRecord = z.infer<typeof pipelineCompletionRecordSchema>;

// ---------------------------------------------------------------------------
// typed STOP (the resolve step — pin_required three-branch + targeted aborts)
// ---------------------------------------------------------------------------

/**
 * The typed STOP codes. The profile branch reuses the pin_required vocabulary
 * (0 active → no_active_profile pointing at intake; exactly 1 → pin_required,
 * never silently run; 2+ → multiple_active_profiles, ask by vehicle name). The
 * targeted-VIN sub-path adds two defensive aborts (the listing/inbound guards
 * resolveTargetedListing throws — surfaced as a STOP, never a crash).
 */
export type QuotePipelineStopCode =
  | "pin_required"
  | "no_active_profile"
  | "multiple_active_profiles"
  | "targeted_listing_not_found"
  | "targeted_no_inbound_thread";

/** Typed STOP from the workflow. The message is the user-facing wording — the
 *  server surfaces it verbatim on the run's error frame. */
export class QuotePipelineStopError extends Error {
  readonly code: QuotePipelineStopCode;
  constructor(code: QuotePipelineStopCode, message: string) {
    super(message);
    this.name = "QuotePipelineStopError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// the targeted-VIN SEND suspend / resume (the single HITL point — real send in buyer mode, fake in test mode)
// ---------------------------------------------------------------------------

/**
 * The targeted-VIN OTD SEND suspend payload (the spec_inline the banner-track
 * approval card renders). kind/summary/sensitive are what the generic approval
 * surface shows; the typed fields are the audit record of WHAT is being sent.
 * The outbound OTD ask on ONE specific listing is a sensitive scope (it sends a
 * real email in buyer mode, fake in test mode), so the card renders the danger frame.
 * IDs + short strings only; the payload stays well under the renderable bound.
 */
export const QuotePipelineSendSuspendSchema = z
  .object({
    kind: z.literal("approval"),
    summary: z.string(),
    sensitive: z.literal(true),
    dealerId: z.string(),
    listingId: z.string(),
    vin: z.string(),
    reason: z.literal("targeted_otd_send"),
  })
  .strict();
export type QuotePipelineSendSuspend = z.infer<typeof QuotePipelineSendSuspendSchema>;

/** The resume vocabulary for the targeted SEND suspend: approve (fire the gated
 *  send — real in buyer mode, fake in test mode — + record the quote) or decline
 *  (zero outbound, zero record write → the `declined` output member). */
export const QuotePipelineSendResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("decline") }),
]);
export type QuotePipelineSendResume = z.infer<typeof QuotePipelineSendResumeSchema>;
