/**
 * dealer_closeout_email — the EXIT skill (irreversible-send: real in buyer mode, fake in test mode).
 * ONE flat linear Mastra `createWorkflow`: 7 named steps chained with `.then()`,
 * no nested workflow. NEAR-ZERO-LLM (the closeout body/subject are deterministic
 * templates, so this skill wires NO LLM step and there is no emit_result — the
 * structured-output mixing surface is structurally absent) and STATE-ONLY (it closes a thread
 * + writes a suppression row; it NEVER deletes). ONE human suspend (BEFORE any
 * side effect): the batch_review card. decline → terminal zero sends / zero
 * writes; "SKIP ALL" → the typed `skip_all_reset` outcome (the Phase-4
 * pipeline_reset hand-off, call site STUBBED) — a SUCCESS, never a throw.
 *
 * STEP MAP:
 *   0 resolveProfile — EXPLICIT-PIN REQUIRED (this skill never infers, not even
 *                      the single-active case): a pin-less input STOPs by the
 *                      generalized classifier (0 → no_active_profile pointing at
 *                      intake; 1 → pin_required; 2+ → multiple_active_profiles ask
 *                      by vehicle). A supplied pin must resolve `pinned`.
 *   1 assembleTargets — assembleCloseoutTargets: bound dealers with an OPEN thread
 *                      MINUS dealers already closeout-suppressed (the idempotency
 *                      floor — a 2nd run re-assembles zero targets → no-op), each
 *                      resolved to a reply address by the 4-rung ladder. A dealer
 *                      with no resolvable address is SKIPPED + counted
 *                      (skippedNoAddress, shown BEFORE the gate). Zero candidates →
 *                      a graceful exit (not an error, no suspend).
 *   2 draft         — per target: buildCloseoutDraft default body + subjectForFollowup
 *                      [deterministic, NO LLM]. The default body IS the sent body
 *                      unless the user EDITs (an EDITed body re-asserts in the
 *                      atomic tool before the send).
 *   3 batchReview   — SUSPEND ① batch_review. decline → terminal `declined` (zero
 *                      writes). approve naming the explicit dealer-id list → SEND;
 *                      approve whose ids do NOT intersect the reviewed targets
 *                      ("SKIP ALL") → the typed `skip_all_reset` outcome (NOT a
 *                      throw — the irreversible reset hand-off, call site stubbed).
 *   4 sendCloseClose — per approved dealer SERIAL: closeAndSuppressDealer (the ONE
 *                      atomic tool — the gated send folded around the LOCAL
 *                      threads.state='closed' + thread_suppression INSERT in one
 *                      txn; the close+suppress commit on approve regardless of send
 *                      mode, the send alone is mode-gated). A mid-batch
 *                      short-circuit (a gate-declined send) halts: trailing dealers
 *                      write NOTHING. Collect closed_thread_ids + emails_sent.
 *   5 transition    — search_profiles.status='closed' once any closeout landed (a
 *                      LOCAL state-only product write, not gated). declined /
 *                      skip_all / zero-closed → unchanged.
 *   6 confirm       — ZERO-LLM summary (closed_thread_ids, emails_sent,
 *                      profile_status_transition, skipped_no_address).
 *
 * COMMUNICATION RED LINES: the closeout body never carries a budget (the template
 * has none AND assertNoBudget belts the body/subject inside closeAndSuppressDealer,
 * again inside sendAndRecord's buildRaw). In buyer mode a real email goes out behind
 * the L2 gate; in test mode the send is a fake draft+promote against the
 * FakeGmailAdapter (a fake sandbox `messages` row, NEVER a real outbound).
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/tools (the
 * resolver + profile-dealer reads + assembleCloseoutTargets + closeAndSuppressDealer
 * + the closeout-draft templates — the ONLY DB/side-effect paths), and the
 * skill-local contracts. NO harness facade (zero-LLM), NO browser (email-only).
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  assembleCloseoutTargets as assembleCloseoutTargetsImpl,
  buildCloseoutDraft,
  closeAndSuppressDealer as closeAndSuppressDealerImpl,
  closeProfileStatusPlain,
  getDb,
  listProfileRows as listProfileRowsImpl,
  readProfileRow,
  releaseDealerClaims as releaseDealerClaimsImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
  subjectForFollowup,
  type Approver,
  type CloseoutDealerOutcome,
  type CloseoutTarget,
} from "@autobroker/tools";

import {
  BatchReviewResumeSchema,
  BatchReviewSuspendSchema,
  DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID,
  DealerCloseoutEmailInputSchema,
  DealerCloseoutEmailOutputSchema,
  DealerCloseoutEmailStopError,
} from "./dealerCloseoutEmailContracts.js";
import { resolvePinnedProfileRowOrStop } from "./profilePinShared.js";

export { DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID };

// ---------------------------------------------------------------------------
// the internal post-suspend approver (the load-bearing gate call — verbatim X1)
// ---------------------------------------------------------------------------

/**
 * The post-suspend approver. The human ALREADY approved at the batch_review ①
 * suspend; this Approver records that fact for the gate. The AUTOBROKER_MODE=test
 * brake (inside sendAndRecord, reached through closeAndSuppressDealer) is the
 * test-mode floor — in test mode the send resolves to the FakeGmailAdapter (a fake
 * sandbox `messages` row, never a real outbound) so a fake send can never mint a
 * real receipt. In buyer mode (or an offline fake-backend test) the approve path
 * runs the real draft-then-promote and the row is written. ONE module constant,
 * reused by every closeout.
 */
const APPROVED: Approver = { async decide() { return true; } };

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL suspend/resume chain against a
 * deterministic tmp DB, WITHOUT module mocks. X3 has NO LLM and NO browser, so the
 * only injectable side-effect path is the atomic closeAndSuppressDealer (which in
 * production reaches the real gated send + the local close+suppress txn).
 */
export interface DealerCloseoutEmailWorkflowDeps {
  /** The typed three-branch profile resolver (tools layer; PIN-required use). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** All active profile rows (the pin-less STOP candidate list). */
  listActiveProfiles: (db: ReturnType<typeof getDb>) => Record<string, unknown>[];
  /** Read one profile row by id (resolved pin → load the row). */
  readProfileById: (db: ReturnType<typeof getDb>, id: string) => Record<string, unknown> | null;
  /** Assemble the addressable closeout targets (deterministic, read-only). */
  assembleCloseoutTargets: typeof assembleCloseoutTargetsImpl;
  /** The ONE atomic per-dealer unit: the gated send + the LOCAL close+suppress txn. */
  closeAndSuppressDealer: typeof closeAndSuppressDealerImpl;
  /** Flip the profile status to 'closed' on completion (a LOCAL state-only write,
   *  not gated). */
  closeProfileStatus: (db: ReturnType<typeof getDb>, id: string) => void;
  /** Release THIS profile's 'bound' dealership claims ('bound' → 'closed_out') so
   *  closing the search frees its dealers for another profile (the
   *  dealership-exclusivity release — avoids a permanent fail-closed lock). */
  releaseDealerClaims: typeof releaseDealerClaimsImpl;
  /** The DB accessor the read/write closures run through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: DealerCloseoutEmailWorkflowDeps = {
  resolveProfile: resolveActiveProfileImpl,
  listActiveProfiles: (db) => listProfileRowsImpl(db, "active"),
  readProfileById: readProfileRow,
  assembleCloseoutTargets: assembleCloseoutTargetsImpl,
  closeAndSuppressDealer: closeAndSuppressDealerImpl,
  // State-only: the run's completion flips the profile to 'closed' — a plain
  // status write (no updated_at bump / audit), NOT the soft-delete close
  // lifecycle with its audit/slot/claim machinery.
  closeProfileStatus: closeProfileStatusPlain,
  releaseDealerClaims: releaseDealerClaimsImpl,
  getDb,
};

let injectedDeps: DealerCloseoutEmailWorkflowDeps | undefined;

function deps(): DealerCloseoutEmailWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner (a production caller must never
 *  redirect the resolver, the send path, or the DB write). */
export function __setDealerCloseoutEmailDepsForTests(
  partial: Partial<DealerCloseoutEmailWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setDealerCloseoutEmailDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetDealerCloseoutEmailDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

/** One closeout target carried through the steps (card row + send inputs). Flat
 *  plain-JSON (Mastra snapshots it) and LEAN. */
const CloseoutTargetSchema = z.object({
  dealer_id: z.string(),
  dealer_name: z.string(),
  /** The open thread to close, or null (a new top-level message; no row to flip). */
  thread_id: z.string().nullable(),
  /** The backend thread id the reply rides into (travels with thread_id). */
  gmail_thread_id: z.string().nullable(),
  /** The reply address resolved by the 4-rung ladder. */
  reply_to: z.string(),
  /** The contact display name (for an optional greeting). */
  contact_name: z.string().nullable(),
  /** The open thread's subject — the closeout subject is UNCONDITIONALLY
   *  `subjectForFollowup(thread_subject)` (keeps the conversation's subject). */
  thread_subject: z.string().nullable(),
  /** The open thread's latest inbound gmail_message_id — the reply double-flag
   *  anchor threaded to the send. */
  latest_inbound_gmail_message_id: z.string().nullable(),
  /** The open thread's latest inbound rfc_message_id — the recipient-side
   *  threading header (null → no header). */
  latest_inbound_rfc_message_id: z.string().nullable(),
  /** The deterministic closeout body the draft step fills (null until drafted). */
  body: z.string().nullable(),
  /** The closeout subject the draft step fills (null until drafted). */
  subject: z.string().nullable(),
});
type CloseoutTargetState = z.infer<typeof CloseoutTargetSchema>;

/** The accumulating state threaded through the 7 steps. */
const CloseoutStateSchema = z.object({
  searchProfileId: z.string(),
  /** The minimal message-template profile (drives the deterministic body/subject). */
  messageProfile: z.object({
    year: z.number().nullable(),
    make: z.string().nullable(),
    model: z.string().nullable(),
  }),
  /** The buyer follow-up email the closeout is sent from. */
  followUpEmail: z.string().nullable(),
  /** Terminal-declined flag (batch_review decline): every later step passes. */
  declined: z.boolean(),
  /** "SKIP ALL": the user skipped every row → the Phase-4 reset hand-off. */
  skipAllReset: z.boolean(),
  /** The addressable closeout targets (the card rows + send inputs). */
  targets: z.array(CloseoutTargetSchema),
  /** Dealers dropped for no resolvable reply address (count only, shown pre-gate). */
  skippedNoAddress: z.number().int(),
  /** The approved dealer ids from suspend ① (intersected with the card set). */
  approvedDealerIds: z.array(z.string()).nullable(),
  /** The threads flipped to 'closed' (the closeout receipt). */
  closedThreadIds: z.array(z.string()),
  /** How many sends were PROMOTED (real in buyer mode; a fake sandbox row in test mode). */
  emailsSent: z.number().int(),
});
type CloseoutState = z.infer<typeof CloseoutStateSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): CloseoutState {
  return CloseoutStateSchema.parse(inputData);
}

/** Run `fn` against the SHARED tools-layer DB connection. */
function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  return fn(deps().getDb());
}

/** Map the tool's CloseoutTarget into the threaded state shape (snapshot-safe). */
function targetStateFrom(t: CloseoutTarget): CloseoutTargetState {
  return {
    dealer_id: t.dealerId,
    dealer_name: t.dealerName,
    thread_id: t.threadId,
    gmail_thread_id: t.gmailThreadId,
    reply_to: t.replyTo,
    contact_name: t.contactName,
    thread_subject: t.threadSubject,
    latest_inbound_gmail_message_id: t.latestInboundGmailMessageId,
    latest_inbound_rfc_message_id: t.latestInboundRfcMessageId,
    body: null,
    subject: null,
  };
}

/** Rebuild the tool's CloseoutTarget from a threaded state row (for the send). */
function toCloseoutTarget(t: CloseoutTargetState): CloseoutTarget {
  return {
    dealerId: t.dealer_id,
    dealerName: t.dealer_name,
    threadId: t.thread_id,
    gmailThreadId: t.gmail_thread_id,
    replyTo: t.reply_to,
    contactName: t.contact_name,
    threadSubject: t.thread_subject,
    latestInboundGmailMessageId: t.latest_inbound_gmail_message_id,
    latestInboundRfcMessageId: t.latest_inbound_rfc_message_id,
  };
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (EXPLICIT-PIN REQUIRED; never infers newest)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: DealerCloseoutEmailInputSchema,
  outputSchema: CloseoutStateSchema,
  execute: async ({ inputData }) => {
    // EXPLICIT-PIN REQUIRED (this skill never infers, not even the single-active
    // case — that is the thin edge of "pick newest" an exit skill must not take).
    // A pin-less input STOPs by the generalized classifier.
    const d = deps();
    const { row: profileRow, profileId } = resolvePinnedProfileRowOrStop({
      withDb,
      resolvers: {
        listActiveProfiles: d.listActiveProfiles,
        resolveProfile: d.resolveProfile,
        readProfileById: d.readProfileById,
      },
      pin: inputData.search_profile_id,
      skillSlash: "/dealer_closeout_email",
      purposeClause: "dealers to close out",
      pinClause: "closes out a search you have explicitly pinned",
      makeError: (code, message) => new DealerCloseoutEmailStopError(code, message),
    });

    const row = profileRow ?? {};
    const yearRaw = row["year"];
    return {
      searchProfileId: String(row["search_profile_id"] ?? profileId),
      messageProfile: {
        year: typeof yearRaw === "number" ? yearRaw : null,
        make: typeof row["make"] === "string" ? (row["make"] as string) : null,
        model: typeof row["model"] === "string" ? (row["model"] as string) : null,
      },
      followUpEmail:
        typeof row["follow_up_email"] === "string" ? (row["follow_up_email"] as string) : null,
      declined: false,
      skipAllReset: false,
      targets: [],
      skippedNoAddress: 0,
      approvedDealerIds: null,
      closedThreadIds: [],
      emailsSent: 0,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — assembleTargets (deterministic; idempotency floor + skip-no-address)
// ---------------------------------------------------------------------------

const assembleTargetsStep = createStep({
  id: "assembleTargets",
  inputSchema: CloseoutStateSchema,
  outputSchema: CloseoutStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    // Bound dealers with an OPEN thread MINUS already-closeout-suppressed dealers
    // (the idempotency floor: a 2nd run re-assembles zero already-closed targets).
    // A dealer with no resolvable reply address is dropped + counted here.
    const { targets, skippedNoAddress } = withDb((db) =>
      deps().assembleCloseoutTargets(db, state.searchProfileId),
    );
    return {
      ...state,
      targets: targets.map(targetStateFrom),
      skippedNoAddress,
    };
  },
});

// ---------------------------------------------------------------------------
// step 2 — draft (the deterministic closeout body + subject) [NO LLM]
// ---------------------------------------------------------------------------

const draftStep = createStep({
  id: "draft",
  inputSchema: CloseoutStateSchema,
  outputSchema: CloseoutStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    // The default body IS the sent body. There is no LLM — the template is fully
    // deterministic; an optional EDIT (a future surface) re-asserts inside the
    // atomic tool before the send. The subject is UNCONDITIONALLY the open
    // thread's subject re-cast as a reply (`subjectForFollowup`) so the closeout
    // lands in the existing conversation — every target has an open thread by
    // construction; a null thread subject yields "Re: (no subject)".
    const drafted = state.targets.map((t) => ({
      ...t,
      body: buildCloseoutDraft(state.messageProfile, { contactName: t.contact_name }),
      subject: subjectForFollowup(t.thread_subject),
    }));
    return { ...state, targets: drafted };
  },
});

// ---------------------------------------------------------------------------
// step 3 — batchReview (SUSPEND ①; decline / SKIP ALL / approve branches)
// ---------------------------------------------------------------------------

/** The batch_review card question (fixed copy). */
const BATCH_REVIEW_QUESTION = "Send closeout emails to these dealers?";

const batchReviewStep = createStep({
  id: "batchReview",
  inputSchema: CloseoutStateSchema,
  outputSchema: CloseoutStateSchema,
  resumeSchema: BatchReviewResumeSchema,
  suspendSchema: BatchReviewSuspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    // GRACEFUL EXIT: zero candidates → no card, no suspend, no error. The confirm
    // step renders a `sent`-shape result with empty arrays.
    if (state.targets.length === 0) {
      return { ...state, approvedDealerIds: [] };
    }

    // FIRST PASS — the batch_review card (gate before prose). Nothing has been
    // written and no send face has been reached.
    if (resumeData === undefined) {
      return (await suspend({
        kind: "batch_review",
        question: BATCH_REVIEW_QUESTION,
        targets: state.targets.map((t) => ({
          dealer_id: t.dealer_id,
          name: t.dealer_name,
          website: "",
        })),
        // The skipped-no-address count lives in the confirm summary, never a row.
        skipped: [],
        total_targets: state.targets.length,
        total_in_radius: state.targets.length,
        submit_label: "Send closeout emails",
        // Closeout-only: surface the "Skip all & reset" action on the review card.
        // Empty approve-intersection → the skip_all_reset hand-off (NOT a throw).
        allow_skip_all: true,
      })) as never;
    }

    const resume = BatchReviewResumeSchema.parse(resumeData);
    if (resume.action === "decline") {
      return { ...state, declined: true };
    }
    // approve → the explicit id list intersected with the reviewed targets.
    const targetIds = new Set(state.targets.map((t) => t.dealer_id));
    const approved = [...new Set(resume.approved_dealer_ids)].filter((id) => targetIds.has(id));
    // "SKIP ALL" — the user skipped every row, so the approved set resolves to ZERO
    // reviewed targets. This is NOT a throw (X1 throws here): it is the typed
    // `skip_all_reset` outcome, the Phase-4 pipeline_reset hand-off (call site
    // stubbed — the workflow records the intent and stops cleanly).
    if (approved.length === 0) {
      return { ...state, skipAllReset: true };
    }
    return { ...state, approvedDealerIds: approved };
  },
});

// ---------------------------------------------------------------------------
// step 4 — sendCloseClose (the atomic gated send + the LOCAL close+suppress)
// ---------------------------------------------------------------------------

const sendCloseCloseStep = createStep({
  id: "sendCloseClose",
  inputSchema: CloseoutStateSchema,
  outputSchema: CloseoutStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined || state.skipAllReset) return state; // pass-through (zero writes).

    const approved = new Set(state.approvedDealerIds ?? []);
    const ordered = state.targets.filter((t) => approved.has(t.dealer_id));

    const closed: string[] = [];
    let emailsSent = 0;
    let shortCircuited = false;

    for (const t of ordered) {
      // A mid-batch short-circuit (a gate-declined send) halts the loop: trailing
      // dealers write NOTHING (no send, no close, no suppress).
      if (shortCircuited) continue;

      const outcome: CloseoutDealerOutcome = await withDb((db) =>
        deps().closeAndSuppressDealer({
          db,
          approver: APPROVED,
          runId,
          searchProfileId: state.searchProfileId,
          target: toCloseoutTarget(t),
          body: t.body ?? "",
          subject: t.subject ?? "",
          fromEmail: state.followUpEmail ?? "",
        }),
      );

      if (outcome.kind === "short_circuit") {
        shortCircuited = true;
        continue;
      }
      // `closed`: the local close+suppress committed and the send was approved +
      // attempted (a gate decline takes the short_circuit path above). Count the
      // send whether it was real or fake — in test mode the AUTOBROKER_MODE=test
      // brake resolves a fake send, which we still report as "sent", consistent
      // with negotiation_followup (a buyer reading "0 sent" otherwise thinks no
      // closeout went out). In buyer mode a real email goes out behind the L2 gate;
      // in test mode no real outbound is created.
      if (t.thread_id !== null) closed.push(t.thread_id);
      emailsSent += 1;
    }

    return { ...state, closedThreadIds: closed, emailsSent };
  },
});

// ---------------------------------------------------------------------------
// step 5 — transition (search_profiles.status='closed' on completion) [state-only]
// ---------------------------------------------------------------------------

const transitionStep = createStep({
  id: "transition",
  inputSchema: CloseoutStateSchema,
  outputSchema: CloseoutStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    // The profile flips to 'closed' ONLY when the run completed a real closeout.
    // A decline / SKIP ALL / zero-closed run leaves the profile unchanged.
    if (state.declined || state.skipAllReset || state.closedThreadIds.length === 0) {
      return state;
    }
    withDb((db) => {
      deps().closeProfileStatus(db, state.searchProfileId);
      // Free this search's dealership claims ('bound' → 'closed_out') so another
      // profile can claim those dealers — closing a search must not leave a
      // permanent fail-closed exclusivity lock.
      deps().releaseDealerClaims({ searchProfileId: state.searchProfileId, db });
    });
    return state;
  },
});

// ---------------------------------------------------------------------------
// step 6 — confirm (ZERO-LLM summary) [deterministic]
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: CloseoutStateSchema,
  outputSchema: DealerCloseoutEmailOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) {
      return { outcome: "declined" as const };
    }
    if (state.skipAllReset) {
      return {
        outcome: "skip_all_reset" as const,
        search_profile_id: state.searchProfileId,
        reset_requested: true as const,
        // Terminal prose passed through verbatim by the descriptor's summaryText.
        // CTA points the user at the destructive reset skill — we never auto-invoke
        // it (that would fire a full-DB wipe off a closeout decision; the user runs it).
        summary:
          "Skipped all closeouts; pipeline reset requested. " +
          "Run /pipeline_reset to wipe and recreate this search.",
      };
    }

    const closedCount = state.closedThreadIds.length;
    const profileTransition: "closed" | "unchanged" = closedCount > 0 ? "closed" : "unchanged";
    // emails_sent counts every approved+attempted closeout send (real in buyer
    // mode, fake in test mode), consistent with negotiation_followup's "sent N".
    const summary =
      (closedCount === 0
        ? "No dealers to close out"
        : `Closed out ${closedCount} dealer(s); ${state.emailsSent} email(s) sent`) +
      (state.skippedNoAddress > 0
        ? `; ${state.skippedNoAddress} dealer(s) skipped (no reply address)`
        : "") +
      ".";

    return {
      outcome: "sent" as const,
      resolution: "pinned" as const,
      closed_thread_ids: state.closedThreadIds,
      emails_sent: state.emailsSent,
      profile_status_transition: profileTransition,
      skipped_no_address: state.skippedNoAddress,
      summary,
      search_profile_id: state.searchProfileId,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (7 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const dealerCloseoutEmailWorkflow = createWorkflow({
  id: "dealer_closeout_email",
  inputSchema: DealerCloseoutEmailInputSchema,
  outputSchema: DealerCloseoutEmailOutputSchema,
})
  .then(resolveProfileStep)
  .then(assembleTargetsStep)
  .then(draftStep)
  .then(batchReviewStep)
  .then(sendCloseCloseStep)
  .then(transitionStep)
  .then(confirmStep)
  .commit();
