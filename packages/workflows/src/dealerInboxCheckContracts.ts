/**
 * dealer_inbox_check contracts — the typed input/output, the batch_review
 * suspend payload, and the typed STOP vocabulary the dealerInboxCheck workflow
 * and the server descriptor share. Skill-local, single-use (only the workflow
 * file and its tests import them), kept out of the shared core layer like the
 * other skills' contracts; core owns only ROW shapes.
 *
 * PROFILE RESOLUTION — EXPLICIT-PIN REQUIRED for this skill. Unlike the read-only
 * scans, dealer_inbox_check refuses to act on an inferred profile: a pin-less
 * input STOPs and asks the user to pin a search (even with exactly one active
 * profile — picking the single newest active is the thin edge of "silently pick
 * newest" this skill must not do). The only accepted provenance is `pinned`; a
 * supplied pin that is no longer active STOPs too. Zero active → STOP pointing at
 * intake.
 *
 * ONE suspend point: the batch_review card BEFORE any write. It rides the app's
 * banner-track batch_review kind; decline = terminal, ZERO DB writes. Resume
 * REUSES the shared `BatchReviewResumeSchema` (approve{approved_dealer_ids min
 * 1} | decline) — an explicit id list, never approve-all. The per-thread REJECT
 * rides the server descriptor's extended accept content.
 *
 * ZERO-LLM: the whole sweep (discovery, routing, classify, ingest) is
 * deterministic; there is no emit schema, no #1244 surface.
 *
 * Dependency wall: imports zod + the sibling skill's resume schema only.
 */

import { z } from "zod";

import { BatchReviewResumeSchema } from "./batchReviewContracts.js";

/** The stable workflow id (registration + the server descriptor). */
export const DEALER_INBOX_CHECK_WORKFLOW_ID = "dealer_inbox_check" as const;

// ---------------------------------------------------------------------------
// workflow input / output
// ---------------------------------------------------------------------------

/** The workflow input (the server descriptor builds this from the start body).
 *  The profile pin is the ONLY input — the sweep window derives from the
 *  per-profile watermark, never from a start-body `since`. */
export const DealerInboxCheckInputSchema = z.object({
  /** Explicit profile pin, or null → 1/0/2+ three-branch resolution. */
  search_profile_id: z.string().nullable(),
});
export type DealerInboxCheckInput = z.infer<typeof DealerInboxCheckInputSchema>;

/**
 * The workflow output — checked | declined | no_replies union. `checked` carries
 * the audit tallies the confirm template surfaces (every count is a number, no
 * budget, no hex run id). `no_replies` (zero discovered threads) is a VALID
 * success, never an error. `declined` (batch_review decline) means zero writes
 * and the watermark untouched.
 */
export const DealerInboxCheckOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("checked"),
    resolution: z.enum(["pinned"]),
    /** The relative Gmail window the sweep used (e.g. "2d"). */
    window: z.string(),
    queries_run: z.number().int(),
    raw_hit_count: z.number().int(),
    unique_thread_count: z.number().int(),
    new_messages_count: z.number().int(),
    new_threads_count: z.number().int(),
    unique_dealers_replied: z.number().int(),
    unrouted_count: z.number().int(),
    rejected_count: z.number().int(),
    /** The sync had to full-resync (a stale historyId) — a voiced transient. */
    full_resync: z.boolean(),
    summary: z.string(),
  }),
  z.object({ outcome: z.literal("declined") }),
  z.object({ outcome: z.literal("no_replies") }),
]);
export type DealerInboxCheckOutput = z.infer<typeof DealerInboxCheckOutputSchema>;

// ---------------------------------------------------------------------------
// typed STOP codes (pin-required skill: explicit pin, or a lead must exist first)
// ---------------------------------------------------------------------------

export type DealerInboxCheckStopCode =
  | "no_active_profile"
  | "pin_required"
  | "no_lead_submitted";

/** Typed STOP from the resolve step. The message is the user-facing wording —
 *  the server surfaces it verbatim on the run's error frame. */
export class DealerInboxCheckStopError extends Error {
  readonly code: DealerInboxCheckStopCode;
  constructor(code: DealerInboxCheckStopCode, message: string) {
    super(message);
    this.name = "DealerInboxCheckStopError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// the batch_review suspend / resume contracts
// ---------------------------------------------------------------------------

/**
 * The suspend payload (the spec_inline the batch_review card renders). Grouped
 * by dealer; IDs + short labels only (a snippet, not full bodies) so the
 * payload stays small. `unrouted` lists threads with no resolvable dealer (the
 * card surfaces them but they are not an approve/reject target until bound).
 */
export const InboxReviewSuspendSchema = z
  .object({
    kind: z.literal("batch_review"),
    question: z.string(),
    targets: z.array(
      z.object({
        dealer_id: z.string(),
        name: z.string(),
        thread_ids: z.array(z.string()),
        classification: z.enum(["quoted", "replied"]),
        snippet: z.string(),
      }),
    ),
    unrouted: z.array(
      z.object({
        thread_id: z.string(),
        sender_email: z.string(),
        snippet: z.string(),
      }),
    ),
    total_targets: z.number().int(),
  })
  .strict();
export type InboxReviewSuspend = z.infer<typeof InboxReviewSuspendSchema>;

/** Resume reuses the shared batch-review vocabulary (approve an explicit
 *  dealer-id list, or decline). Re-exported so the workflow + descriptor import
 *  it from one place. */
export { BatchReviewResumeSchema };
export type { BatchReviewResume } from "./batchReviewContracts.js";
