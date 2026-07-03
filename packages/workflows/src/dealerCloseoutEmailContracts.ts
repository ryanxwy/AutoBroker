/**
 * dealer_closeout_email contracts — the typed input/output, the reused
 * batch_review suspend/resume, the typed STOP vocabulary, and the generalized
 * profile-STOP classifier. Skill-local, single-use (only the workflow file and
 * its tests import them).
 *
 * PROFILE RESOLUTION — EXPLICIT-PIN REQUIRED for this skill (it is an
 * irreversible-send skill). A pin-less input STOPs: 0 active → no_active_profile
 * (point at intake), exactly-1 active → pin_required (one active is still not
 * silently run), 2+ active → multiple_active_profiles (ask by vehicle name).
 *
 * ONE suspend point (BEFORE any side effect): batch_review — REUSES the shared
 * BatchReviewSuspendSchema / BatchReviewResumeSchema. The resume is approve{
 * approved_dealer_ids min 1} | decline. "SKIP ALL" is the user approving with
 * every row skipped, which the wire renders as approve with an EMPTY effective
 * id list; the workflow turns that into the typed `skip_all_reset` outcome (the
 * Phase-4 pipeline_reset hand-off) — NOT a throw.
 *
 * NEAR-ZERO-LLM: the closeout body/subject are deterministic templates, so this
 * skill wires NO LLM step and has no emit schema.
 *
 * Dependency wall: imports zod + the sibling skill's batch-review schemas only.
 */

import { z } from "zod";

import { BatchReviewResumeSchema, BatchReviewSuspendSchema } from "./batchReviewContracts.js";
import type { ProfilePinStopCode } from "./profilePinShared.js";

// ---------------------------------------------------------------------------
// workflow input / output
// ---------------------------------------------------------------------------

/** The workflow input (the server descriptor builds this from the start body). */
export const DealerCloseoutEmailInputSchema = z.object({
  /** Explicit profile pin, or null → 0/1/2+ three-branch STOP (pin-required).
   *  The product profile id is a synth-hash string (not a UUID), so this is a
   *  plain z.string() — a `.uuid()` constraint would reject a real start body. */
  search_profile_id: z.string().nullable(),
});
export type DealerCloseoutEmailInput = z.infer<typeof DealerCloseoutEmailInputSchema>;

/**
 * The workflow output — a 3-member discriminated union.
 *   - sent: the closeout ran. `closed_thread_ids` are the threads flipped to
 *     closed; `emails_sent` counts PROMOTED sends (0 under BLOCK=1 — the send is
 *     fuse-blocked even though the local close happened);
 *     `profile_status_transition` is "closed" once any closeout landed.
 *   - declined: the batch_review decline → zero writes, zero sends.
 *   - skip_all_reset: the user skipped every row → the Phase-4 pipeline_reset
 *     hand-off (a typed SUCCESS, not a failure; the reset call site is stubbed).
 */
export const DealerCloseoutEmailOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("sent"),
    resolution: z.enum(["pinned", "inferred_newest"]), // pin_required → always "pinned"
    closed_thread_ids: z.array(z.string()),
    emails_sent: z.number().int(),
    profile_status_transition: z.enum(["closed", "unchanged"]),
    skipped_no_address: z.number().int(),
    summary: z.string(),
    /** For affectedKinds profile scoping. */
    search_profile_id: z.string(),
  }),
  z.object({ outcome: z.literal("declined") }),
  z.object({
    outcome: z.literal("skip_all_reset"),
    search_profile_id: z.string(),
    reset_requested: z.literal(true),
    summary: z.string(),
  }),
]);
export type DealerCloseoutEmailOutput = z.infer<typeof DealerCloseoutEmailOutputSchema>;

// ---------------------------------------------------------------------------
// typed STOP codes (pin-required skill) + the generalized classifier
// ---------------------------------------------------------------------------

/** This skill's STOP vocabulary is exactly the shared pin-required set. */
export type DealerCloseoutEmailStopCode = ProfilePinStopCode;

/** Typed STOP from the resolve step. The message is the user-facing wording —
 *  the server surfaces it verbatim on the run's error frame. */
export class DealerCloseoutEmailStopError extends Error {
  readonly code: DealerCloseoutEmailStopCode;
  constructor(code: DealerCloseoutEmailStopCode, message: string) {
    super(message);
    this.name = "DealerCloseoutEmailStopError";
    this.code = code;
  }
}

/** The generalized profile-STOP classifier (shared across the 3 send skills). */
export { profileStopCode } from "./profilePinShared.js";

// ---------------------------------------------------------------------------
// suspend ① — REUSE the shared batch_review contracts verbatim
// ---------------------------------------------------------------------------

/** The batch_review suspend ① / resume reuse the shared vocabulary. Re-exported
 *  so the workflow + descriptor import them from one place. */
export { BatchReviewResumeSchema, BatchReviewSuspendSchema };
export type { BatchReviewResume, BatchReviewSuspend } from "./batchReviewContracts.js";

/** The stable workflow id (registration + the server descriptor). */
export const DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID = "dealer_closeout_email" as const;
