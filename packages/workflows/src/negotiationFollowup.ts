/**
 * negotiation_followup — the irreversible-send follow-up skill (Phase 5,
 * [fake-send]). ONE flat linear Mastra `createWorkflow`: 7 named steps chained
 * with `.then()`, no nested workflow. The ONLY LLM touch is a NO-TOOL PROSE draft
 * (harness.draftProse) — there is no structured output and no emit_result, so the
 * #1244 mixing failure is structurally inapplicable. TWO human suspends, both
 * BEFORE any side effect: ① a batch_review card over all drafts ("SEND n" = the
 * explicit approve; decline = terminal zero sends / zero writes), and ② an
 * INDEPENDENT sensitive re-confirm for a contact-flip override (promote one dealer
 * contact to the primary reply target) that fires ONLY on an explicit user
 * request — the default happy path never flips.
 *
 * STEP MAP:
 *   0 resolveProfile — EXPLICIT-PIN REQUIRED (this skill never infers, not even
 *                      the single-active case): a pin-less input STOPs by the
 *                      generalized classifier (0 → no_active_profile pointing at
 *                      intake; 1 → pin_required; 2+ → multiple_active_profiles ask
 *                      by vehicle). A supplied pin must resolve `pinned`.
 *   1 selectTargets — listFollowupCandidateThreads → the PURE selectNextReplyTargets
 *                      ranker (latest-inbound recency, exclude agreed/closed,
 *                      tie-break thread_id). The responsive follow-up cap + 7-day silence are
 *                      TOOL PRECONDITIONS: a batch DROPS a capped/cold thread
 *                      BEFORE the draft (the gate never sees it); a single-thread
 *                      request for an impossible target THROWS the typed error. No
 *                      candidates → a graceful `no_candidates` carry (not a STOP).
 *   2 buildContext  — per eligible thread: readThreadSnapshotForDraft →
 *                      buildDraftContext (budget redacted, inbound dealer bodies
 *                      untrusted-fenced) + readQuoteSituationForThread →
 *                      classifyQuoteSituation (THE TONE IS PICKED IN CODE) + the
 *                      reply-target ladder (resolveReplyTarget) resolved ONCE here.
 *                      A thread with no resolvable reply target is dropped.
 *   3 draft         — per target: harness.draftProse writes the CHOSEN-tone PROSE
 *                      (the tone is passed IN; the model does NOT choose it). NO
 *                      structured output. assertNoBudget belt on the output.
 *   4 batchReview   — SUSPEND ① batch_review over ALL drafts. approve names the
 *                      explicit thread-id list ("SEND n"); decline → terminal zero
 *                      sends/writes. A registered contact-flip override → SUSPEND ②
 *                      (sensitive approval) re-confirm → on approve, setPrimaryReplyTarget
 *                      (one txn); decline → no flip. The flip is NEVER inferred.
 *   5 sendRecord    — per approved thread SERIAL via sendAndRecord, replying on the
 *                      EXISTING thread id (reuseThreadIdForReply + the thread
 *                      double-flag: threadId AND inReplyToGmailId both set) with a
 *                      subjectForFollowup subject. Under BLOCK=1 sendAndRecord
 *                      returns {blocked} → ZERO messages rows (the fake send);
 *                      disarmed offline → a promoted row. A mid-batch hard failure
 *                      (partial) stops-and-reconciles (no backfill).
 *   6 confirm       — ZERO-LLM summary + threads.state='negotiating' on each SENT
 *                      thread. `threads.state='agreed'` is NEVER written here
 *                      (agreed requires explicit deal-price confirmation, out of
 *                      scope — it is never inferred from a quote).
 *
 * COMMUNICATION RED LINES: the prose body never reveals a competing dealer's name
 * or contact (numbers only — enforced by the prompt fence + verified offline),
 * never fabricates an offer, never includes a budget (the prompt forbids it AND
 * assertNoBudget belts the output here AND again inside sendAndRecord's buildRaw).
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/tools (the
 * resolver + the follow-up reads + the pure deciders + sendAndRecord +
 * setPrimaryReplyTarget — the ONLY DB/side-effect paths), this layer's harness
 * facade (draftProse), and the skill-local contracts.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  assertNoBudget,
  assertPaymentMethodConsistent,
  buildDraftContext,
  classifyQuoteSituation,
  getDb,
  listFollowupCandidateThreads as listFollowupCandidateThreadsImpl,
  listProfileRows as listProfileRowsImpl,
  readQuoteSituationForThread as readQuoteSituationForThreadImpl,
  readReplyTargetInputs as readReplyTargetInputsImpl,
  readThreadSnapshotForDraft as readThreadSnapshotForDraftImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
  resolveReplyTarget,
  reuseThreadIdForReply,
  selectNextReplyTargets,
  sendAndRecord as sendAndRecordImpl,
  setPrimaryReplyTarget as setPrimaryReplyTargetImpl,
  subjectForFollowup,
  gateDecisionForTarget,
  followupCapDecision,
  BATCH_SILENCE_WINDOW_DAYS,
  type Approver,
  type QuoteTone,
  type SendRecordTarget,
} from "@autobroker/tools";

import {
  BatchReviewResumeSchema,
  BatchReviewSuspendSchema,
  buildFollowupDraftPrompt,
  ContactFlipApprovalResumeSchema,
  ContactFlipApprovalSuspendSchema,
  NEGOTIATION_FOLLOWUP_WORKFLOW_ID,
  NegotiationFollowupInputSchema,
  NegotiationFollowupOutputSchema,
  NegotiationFollowupStopError,
  SevenDaySilenceError,
  FollowupCapError,
  type FollowupTone,
} from "./negotiationFollowupContracts.js";
import { harness, type HarnessLedgerContext } from "./harness.js";
import { resolvePinnedProfileRowOrStop, rowVehicleLabel } from "./profilePinShared.js";

export { NEGOTIATION_FOLLOWUP_WORKFLOW_ID };

// ---------------------------------------------------------------------------
// the internal post-suspend approver (the load-bearing gate call — verbatim X1)
// ---------------------------------------------------------------------------

/**
 * The post-suspend approver. The human ALREADY approved at the batch_review ①
 * suspend; this Approver records that fact for the gate. The L1 fuse (inside
 * sendAndRecord) is the real floor under the harness — under BLOCK=1 it throws
 * BEFORE the send so a fake send can never mint a real receipt. In a disarmed-fuse
 * offline test the approve path runs the real draft-then-promote against the FAKE
 * backend and the row is written. ONE module constant, reused by every send.
 */
const APPROVED: Approver = { async decide() { return true; } };

// ---------------------------------------------------------------------------
// follow-up gating constants (PRECONDITIONS, in code, never in a prompt)
// ---------------------------------------------------------------------------

/** The cold-thread window: a dealer silent past this many days is dropped /
 *  throws. The X0 timing gate defaults the max-gap to 14d; this skill's success
 *  criterion is a 7-day silence window, so we pass maxGapDays explicitly. The
 *  value is shared (tools BATCH_SILENCE_WINDOW_DAYS) so the give-up advisory
 *  projection that mirrors this threshold can never drift from it. */
const SILENCE_WINDOW_DAYS = BATCH_SILENCE_WINDOW_DAYS;

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL suspend/resume chain against a
 * deterministic prose stub + an isolated tmp DB, WITHOUT module mocks. X2 has NO
 * browser step (it is email-only), so there is no scout/submit/withBrowserContext
 * and no browser-emitter factory.
 */
export interface NegotiationFollowupWorkflowDeps {
  /** The NO-TOOL prose draft facade (the only LLM touch; tone is decided in code). */
  draftProse: typeof harness.draftProse;
  /** The typed three-branch profile resolver (tools layer; PIN-required use). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** All active profile rows (the pin-less STOP candidate list). */
  listActiveProfiles: (db: ReturnType<typeof getDb>) => Record<string, unknown>[];
  /** Read one profile row by id (resolved pin → load the row). */
  readProfileById: (db: ReturnType<typeof getDb>, id: string) => Record<string, unknown> | null;
  /** The needs-response candidate threads for the profile (tools layer). */
  listCandidateThreads: typeof listFollowupCandidateThreadsImpl;
  /** One thread's snapshot + the reply double-flag anchor (tools layer). */
  readThreadSnapshot: typeof readThreadSnapshotForDraftImpl;
  /** The current vs best-competing OTD + itemization for the tone (tools layer). */
  readQuoteSituation: typeof readQuoteSituationForThreadImpl;
  /** The 4-rung reply-target ladder inputs (tools layer). */
  readReplyTargetInputs: typeof readReplyTargetInputsImpl;
  /** The gated draft-then-promote send+record (tools layer; the ONLY send path). */
  sendAndRecord: typeof sendAndRecordImpl;
  /** The single-txn contact-flip write (tools layer; behind the sensitive ②). */
  setPrimaryReplyTarget: typeof setPrimaryReplyTargetImpl;
  /** Write threads.state for a sent thread (a LOCAL product write — not gated). */
  updateThreadState: (db: ReturnType<typeof getDb>, threadId: string, state: string) => void;
  /** The DB accessor the read/write closures run through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: NegotiationFollowupWorkflowDeps = {
  draftProse: harness.draftProse,
  resolveProfile: resolveActiveProfileImpl,
  listActiveProfiles: (db) => listProfileRowsImpl(db, "active"),
  readProfileById: (db, id) =>
    (db.$client
      .prepare("SELECT * FROM search_profiles WHERE search_profile_id = ?")
      .get(id) as Record<string, unknown> | undefined) ?? null,
  listCandidateThreads: listFollowupCandidateThreadsImpl,
  readThreadSnapshot: readThreadSnapshotForDraftImpl,
  readQuoteSituation: readQuoteSituationForThreadImpl,
  readReplyTargetInputs: readReplyTargetInputsImpl,
  sendAndRecord: sendAndRecordImpl,
  setPrimaryReplyTarget: setPrimaryReplyTargetImpl,
  updateThreadState: (db, threadId, state) => {
    db.$client.prepare("UPDATE threads SET state = ? WHERE thread_id = ?").run(state, threadId);
  },
  getDb,
};

let injectedDeps: NegotiationFollowupWorkflowDeps | undefined;

function deps(): NegotiationFollowupWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner (a production caller must never
 *  redirect the harness, the send path, or the DB write). */
export function __setNegotiationFollowupDepsForTests(
  partial: Partial<NegotiationFollowupWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setNegotiationFollowupDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring + clear the contact-flip carry between test cases. */
export function __resetNegotiationFollowupDepsForTests(): void {
  injectedDeps = undefined;
  contactFlipRequestsByRun.clear();
  pendingFlipApproveByRun.clear();
}

// ---------------------------------------------------------------------------
// per-run contact-flip override carry
//
// The contact-flip ② fires ONLY on an EXPLICIT user override. The shared
// BatchReviewResume schema has no field for an address-change request, so the
// override is carried OUT-OF-BAND as a per-run map (mirroring X1's per-run
// fallback-decision carry): the server descriptor / a test registers a flip
// request for a (runId, threadId) before resuming, and step 4 raises ② for it
// after the batch approve. In the default happy path the carry is empty, so ②
// never fires. A crash mid-run re-derives the same map on re-execute (fail-closed
// re-ask), never fail-open.
// ---------------------------------------------------------------------------

/** A registered contact-flip request: promote `contactId` to the dealer's primary
 *  reply target, keyed off an approved thread. */
export interface ContactFlipRequest {
  threadId: string;
  dealerId: string;
  contactId: string;
}

const contactFlipRequestsByRun = new Map<string, ContactFlipRequest[]>();

/**
 * Per-run carry of the batch-approved thread ids while suspend ② (the contact-flip
 * re-confirm) is pending. The approve set is recorded on ① approve BEFORE ② is
 * raised, because the SAME step suspends again for ② — its returned state (which
 * would carry approvedThreadIds) is never persisted across the second suspend, so
 * the ② resume's inputData is still the PRE-approve state. This carry holds the
 * "② is pending; here is the approve set" fact so the ② resume rehydrates it and
 * the resume discriminates ① from ② (a {action:decline} is otherwise ambiguous
 * between a batch decline and a flip decline). A crash mid-② re-derives the same
 * set on re-execute (fail-closed re-ask), never fail-open.
 */
const pendingFlipApproveByRun = new Map<string, string[]>();

/** Register a contact-flip override for a run (the explicit user request that
 *  raises the sensitive ② re-confirm). Idempotent per (runId, threadId): the last
 *  request for a thread wins. */
export function requestContactFlipForRun(runId: string, request: ContactFlipRequest): void {
  const existing = contactFlipRequestsByRun.get(runId) ?? [];
  const next = existing.filter((r) => r.threadId !== request.threadId);
  next.push(request);
  contactFlipRequestsByRun.set(runId, next);
}

function contactFlipRequestsFor(runId: string): ContactFlipRequest[] {
  return contactFlipRequestsByRun.get(runId) ?? [];
}

/**
 * The symmetric remover for the per-run contact-flip carry. requestContactFlipForRun
 * registers an entry that no production path ever deletes (contactFlipRequestsByRun
 * leaks one entry per run that registered a flip; pendingFlipApproveByRun leaks on a
 * ②-abandoned run). The app's terminal projection calls this when a run reaches a
 * terminal/declined state — including ②-abandonment, which never reaches confirmStep —
 * so neither Map grows unbounded across the server's lifetime. Idempotent: clearing a
 * run with no carry is a no-op. Safe re fail-closed: the carry is in-process only and a
 * crash re-derives it on re-execute, so clearing strictly at/after terminal cannot lose
 * an in-flight flip (the ② resume's delete at the consume site stays where it is).
 */
export function clearContactFlipForRun(runId: string): void {
  contactFlipRequestsByRun.delete(runId);
  pendingFlipApproveByRun.delete(runId);
}

/** Test-only: the live sizes of the two contact-flip carry Maps, so a test can
 *  assert the GC actually shrinks them (the prod leak is otherwise masked by the
 *  between-case __reset clear). */
export function __negotiationFollowupCarrySizesForTests(): {
  flips: number;
  pendingApprove: number;
} {
  return { flips: contactFlipRequestsByRun.size, pendingApprove: pendingFlipApproveByRun.size };
}

// ---------------------------------------------------------------------------
// ledger identity for the prose-draft LLM calls
// ---------------------------------------------------------------------------

function followupLedger(runId: string): HarnessLedgerContext {
  return {
    runId,
    skill: "negotiation_followup",
    layer: "L2",
    promptVersion: "p5-x2-v1",
    schemaVersion: "p5-x2-v1",
  };
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

/** One eligible follow-up target carried through the steps (the draft + send
 *  inputs). Flat plain-JSON (Mastra snapshots it) and LEAN. */
const FollowupTargetSchema = z.object({
  thread_id: z.string(),
  dealer_id: z.string(),
  dealer_name: z.string(),
  /** The code-chosen tone the draft is written in (the LLM does NOT choose it). */
  tone: z.enum(["conservative", "appreciative", "assertive", "moderate"]),
  /** The leverage numbers passed to the prompt (NUMBERS only, never a name). */
  current_otd: z.number().nullable(),
  best_competing_otd: z.number().nullable(),
  /** The redacted, fenced thread snapshot the prompt embeds. */
  subject: z.string(),
  draft_context: z.object({
    subject: z.string(),
    messages: z.array(
      z.object({
        direction: z.string(),
        senderName: z.string().nullable(),
        body: z.string(),
      }),
    ),
  }),
  /** The resolved reply address (the 4-rung ladder, resolved once in buildContext). */
  reply_email: z.string(),
  /** The latest inbound gmail id — the in_reply_to anchor for the reply double-flag. */
  in_reply_to_gmail_id: z.string().nullable(),
  /** The prose body the draft step fills (null until drafted). */
  draft_body: z.string().nullable(),
});
type FollowupTarget = z.infer<typeof FollowupTargetSchema>;

/** The accumulating state threaded through the 7 steps. */
const FollowupStateSchema = z.object({
  searchProfileId: z.string(),
  vehicle: z.string(),
  /** The BUYER's reply address (search_profiles.follow_up_email; nullable). The
   *  follow-up reply is sent FROM the buyer TO the dealer — so this, not the
   *  dealer's reply_email, is the send `from`. Null falls back to the in-thread
   *  reply_email so a missing buyer address never blocks the reply. */
  followUpEmail: z.string().nullable(),
  /** The buyer's chosen payment method (search_profiles.financing_preference;
   *  nullable). Grounds the draft prompt + belts the output so a draft never
   *  fabricates a payment method the buyer did not choose (CLAUDE.md §9). */
  financingPreference: z.string().nullable(),
  /** Single-thread mode: follow up just this thread, or null for the full batch. */
  threadIdMode: z.string().nullable(),
  /** Terminal-declined flag (batch_review decline): every later step passes. */
  declined: z.boolean(),
  /** No eligible candidate threads → a graceful no_candidates summary. */
  noCandidates: z.boolean(),
  /** The eligible follow-up targets (the card rows + draft + send inputs). */
  targets: z.array(FollowupTargetSchema),
  /** The approved thread ids from suspend ① (the "SEND n" set). */
  approvedThreadIds: z.array(z.string()).nullable(),
  /** How many contact flips were committed (0 or 1; suspend-② gated). */
  contactFlips: z.number().int(),
  /** How many fake sends fired (fuse-blocked under BLOCK=1, promoted offline). */
  emailsSent: z.number().int(),
});
type FollowupState = z.infer<typeof FollowupStateSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): FollowupState {
  return FollowupStateSchema.parse(inputData);
}

/** Run `fn` against the SHARED tools-layer DB connection. */
function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  return fn(deps().getDb());
}

/** The TRUNCATED first-line preview of a draft (≤120 chars) — small payload only;
 *  the full body is asserted from the DB on send, never carried in the suspend. */
function firstLinePreview(body: string): string {
  const firstLine = body.replace(/\s+/g, " ").trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (EXPLICIT-PIN REQUIRED; never infers newest)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: NegotiationFollowupInputSchema,
  outputSchema: FollowupStateSchema,
  execute: async ({ inputData }) => {
    // EXPLICIT-PIN REQUIRED (this skill never infers, not even the single-active
    // case). A pin-less input STOPs by the generalized classifier. thread_id mode
    // still requires a pinned profile — the named thread must live under the pin.
    const d = deps();
    const { row: profileRow, profileId } = resolvePinnedProfileRowOrStop({
      withDb,
      resolvers: {
        listActiveProfiles: d.listActiveProfiles,
        resolveProfile: d.resolveProfile,
        readProfileById: d.readProfileById,
      },
      pin: inputData.search_profile_id,
      skillSlash: "/negotiation_followup",
      purposeClause: "dealer threads to follow up",
      pinClause: "follows up threads for a search you have explicitly pinned",
      makeError: (code, message) => new NegotiationFollowupStopError(code, message),
    });

    const row = profileRow ?? {};
    return {
      searchProfileId: String(row["search_profile_id"] ?? profileId),
      vehicle: rowVehicleLabel(row) || "vehicle",
      // The buyer's reply address — the follow-up is sent FROM the buyer (nullable).
      followUpEmail:
        typeof row["follow_up_email"] === "string" ? (row["follow_up_email"] as string) : null,
      // The buyer's chosen payment method — grounds the draft (never fabricate one).
      financingPreference:
        typeof row["financing_preference"] === "string"
          ? (row["financing_preference"] as string)
          : null,
      threadIdMode: inputData.thread_id,
      declined: false,
      noCandidates: false,
      targets: [],
      approvedThreadIds: null,
      contactFlips: 0,
      emailsSent: 0,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — selectTargets (PRECONDITIONS, not prose) [deterministic]
// ---------------------------------------------------------------------------

const selectTargetsStep = createStep({
  id: "selectTargets",
  inputSchema: FollowupStateSchema,
  outputSchema: FollowupStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const nowMs = Date.now();

    const candidates = withDb((db) => deps().listCandidateThreads(db, state.searchProfileId));
    const byThreadId = new Map(candidates.map((c) => [c.threadId, c]));

    // The PURE ranker: exclude agreed/closed, rank latest-inbound recency, tie-break
    // thread_id. selectNextReplyTargets reads only {threadId, lastInboundAtMs, state}.
    const ranked = selectNextReplyTargets(
      candidates.map((c) => ({
        threadId: c.threadId,
        lastInboundAtMs: c.lastInboundAtMs,
        state: c.state,
      })),
    );

    // SINGLE-THREAD MODE: resolve just the named thread. A precondition violation
    // (cap / silence) is a typed THROW here (the user named an impossible target);
    // a thread the ranker excluded (agreed/closed) or that does not exist is a STOP.
    if (state.threadIdMode !== null) {
      const cand = byThreadId.get(state.threadIdMode);
      if (cand === undefined) {
        throw new NegotiationFollowupStopError(
          "no_active_profile",
          `Thread ${state.threadIdMode} is not a follow-up candidate for this search.`,
        );
      }
      const cap = followupCapDecision(cand.unansweredFollowups, cand.roundsSent);
      if (cap !== "ok") {
        throw new FollowupCapError(cand.threadId, cap === "total_cap" ? "total" : "unanswered");
      }
      const gate = gateDecisionForTarget(cand.lastInboundAtMs, cand.lastOutboundAtMs, {
        maxGapDays: SILENCE_WINDOW_DAYS,
        nowMs,
      });
      if (gate === "skip") {
        throw new SevenDaySilenceError(cand.threadId);
      }
      // A still-open agreed/closed thread named explicitly is a no-op (never
      // re-contacted) → no_candidates rather than a draft.
      const survivesRank = ranked.some((r) => r.threadId === cand.threadId);
      if (gate === "wait" || !survivesRank) {
        return { ...state, noCandidates: true };
      }
      return { ...state, targets: targetStubsFor([cand]) };
    }

    // BATCH MODE: the cap + silence are SILENT pre-filters (drop, never throw). Keep
    // only ranked threads under the responsive follow-up cap and `ready` (not
    // wait/skip). The cap drops a silent dealer's over-nudged thread but keeps an
    // actively-countering thread eligible no matter how deep the negotiation runs.
    const eligible = ranked
      .map((r) => byThreadId.get(r.threadId)!)
      .filter((c) => followupCapDecision(c.unansweredFollowups, c.roundsSent) === "ok")
      .filter(
        (c) =>
          gateDecisionForTarget(c.lastInboundAtMs, c.lastOutboundAtMs, {
            maxGapDays: SILENCE_WINDOW_DAYS,
            nowMs,
          }) === "ready",
      );

    if (eligible.length === 0) {
      return { ...state, noCandidates: true };
    }
    return { ...state, targets: targetStubsFor(eligible) };
  },
});

/** Turn candidate rows into target stubs (context + draft filled by later steps).
 *  Only the routing fields are set here; tone/context/reply target/body are null
 *  placeholders rebuilt in buildContext + draft. */
function targetStubsFor(
  candidates: ReadonlyArray<{ threadId: string; dealerId: string; dealerName: string | null }>,
): FollowupTarget[] {
  return candidates.map((c) => ({
    thread_id: c.threadId,
    dealer_id: c.dealerId,
    dealer_name: c.dealerName ?? "(dealer)",
    tone: "appreciative" as const, // placeholder; buildContext overwrites in code.
    current_otd: null,
    best_competing_otd: null,
    subject: "",
    draft_context: { subject: "", messages: [] },
    reply_email: "",
    in_reply_to_gmail_id: null,
    draft_body: null,
  }));
}

// ---------------------------------------------------------------------------
// step 2 — buildContext (THE TONE IS PICKED IN CODE) [deterministic]
// ---------------------------------------------------------------------------

const buildContextStep = createStep({
  id: "buildContext",
  inputSchema: FollowupStateSchema,
  outputSchema: FollowupStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined || state.noCandidates) return state;

    const built: FollowupTarget[] = [];
    for (const t of state.targets) {
      const snapshot = withDb((db) => deps().readThreadSnapshot(db, t.thread_id));
      const draftContext = buildDraftContext({
        threadId: snapshot.threadId,
        subject: snapshot.subject,
        messages: snapshot.messages.map((m) => ({
          direction: m.direction,
          senderName: m.senderName,
          bodyText: m.bodyText,
          receivedAtMs: m.receivedAtMs,
        })),
      });

      const situation = withDb((db) =>
        deps().readQuoteSituation(db, { profileId: state.searchProfileId, dealerId: t.dealer_id }),
      );
      // THE TONE IS PICKED IN CODE (the classifier owns the register from the
      // numbers; the LLM only writes the chosen tone's prose).
      const tone: QuoteTone = classifyQuoteSituation({
        isItemized: situation.isItemized,
        bestCompetingOtd: situation.bestCompetingOtd,
        currentOtd: situation.currentOtd,
      });

      // The 4-rung reply-target ladder, resolved ONCE here. A thread with no
      // resolvable reply address cannot be reached → dropped (counted by absence).
      const replyTarget = withDb((db) =>
        resolveReplyTarget(
          deps().readReplyTargetInputs(db, {
            profileId: state.searchProfileId,
            dealerId: t.dealer_id,
            threadId: t.thread_id,
          }),
        ),
      );
      if (replyTarget === null) continue;

      built.push({
        ...t,
        tone,
        current_otd: situation.currentOtd,
        best_competing_otd: situation.bestCompetingOtd,
        subject: snapshot.subject ?? "",
        draft_context: {
          subject: draftContext.subject,
          messages: draftContext.messages.map((m) => ({
            direction: m.direction,
            senderName: m.senderName,
            body: m.body,
          })),
        },
        reply_email: replyTarget.email,
        in_reply_to_gmail_id: snapshot.latestInboundGmailMessageId,
      });
    }

    if (built.length === 0) {
      return { ...state, targets: [], noCandidates: true };
    }
    return { ...state, targets: built };
  },
});

// ---------------------------------------------------------------------------
// step 3 — draft (the PROSE LLM step; NO structured output) [LLM no-tool]
// ---------------------------------------------------------------------------

const draftStep = createStep({
  id: "draft",
  inputSchema: FollowupStateSchema,
  outputSchema: FollowupStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined || state.noCandidates) return state;

    const drafted: FollowupTarget[] = [];
    for (const t of state.targets) {
      const prompt = buildFollowupDraftPrompt({
        tone: t.tone as FollowupTone,
        draftContext: t.draft_context,
        currentOtd: t.current_otd,
        bestCompetingOtd: t.best_competing_otd,
        vehicle: state.vehicle,
        financingPreference: state.financingPreference,
      });
      // The NO-TOOL prose facade — no emit_result, no schema. #1244 is structurally
      // inapplicable (no tools + no structured output); the detector belt inside
      // draftProse stays clean for a prose stop.
      const result = await deps().draftProse(
        { useCase: "negotiation_followup", prompt },
        followupLedger(runId),
      );
      const body = result.text;
      // BELT: the budget red line. The prompt forbids a budget; this throws LOUD if
      // one slipped into the output anyway (again belted inside sendAndRecord).
      assertNoBudget(body);
      // BELT: the payment-method red line. The prompt grounds the draft in the
      // buyer's chosen method; this throws LOUD if the draft asserts a method the
      // buyer did not choose (a finance buyer must never "pay cash"). Hard
      // constraint in code, not just prompt (CLAUDE.md §9).
      assertPaymentMethodConsistent(body, state.financingPreference);
      drafted.push({ ...t, draft_body: body });
    }

    return { ...state, targets: drafted };
  },
});

// ---------------------------------------------------------------------------
// step 4 — batchReview (SUSPEND ① batch_review; contact-flip → SUSPEND ②)
// ---------------------------------------------------------------------------

/** The batch_review card question (fixed copy). */
const BATCH_REVIEW_QUESTION = "Send these follow-ups?";

const batchReviewStep = createStep({
  id: "batchReview",
  inputSchema: FollowupStateSchema,
  outputSchema: FollowupStateSchema,
  // Two suspend kinds ride this one step: the batch_review card ① and the
  // sensitive contact-flip approval ②. Mirror X1's batchReview step unioning the
  // two resume/suspend vocabularies — the retained payload kind selects the resume.
  resumeSchema: z.union([BatchReviewResumeSchema, ContactFlipApprovalResumeSchema]),
  suspendSchema: z.union([BatchReviewSuspendSchema, ContactFlipApprovalSuspendSchema]),
  execute: async ({ inputData, resumeData, suspend, runId }) => {
    const state = asState(inputData);
    if (state.declined || state.noCandidates) return state;

    const drafts = state.targets.filter((t) => t.draft_body !== null);

    // FIRST PASS — the batch_review card (gate before prose). Nothing has been
    // written and no send face has been reached. approved_dealer_ids carries the
    // THREAD ids ("SEND n" = the explicit count authorization).
    if (resumeData === undefined) {
      return (await suspend({
        kind: "batch_review",
        question: BATCH_REVIEW_QUESTION,
        targets: drafts.map((d) => ({
          dealer_id: d.thread_id, // the card's id IS the thread id (the SEND-n key).
          name: d.dealer_name,
          // The card renders name + a TRUNCATED draft preview in the existing text
          // slot; the full body never rides the suspend (payload discipline).
          website: firstLinePreview(d.draft_body ?? ""),
        })),
        skipped: [],
        total_targets: drafts.length,
        total_in_radius: drafts.length,
        submit_label: "Send approved follow-ups",
      })) as never;
    }

    // The resume is either the batch_review answer (① first) or the contact-flip
    // re-confirm answer (② second). They discriminate on whether ② is pending: the
    // approve set was stashed in the per-run carry when ② was raised, so a pending
    // entry means THIS resume answers ② (a {action:decline} is otherwise ambiguous
    // between a batch decline and a flip decline). The SAME step suspends twice, so
    // the approve set cannot ride the threaded state across ② — the carry holds it.
    const pendingApprove = pendingFlipApproveByRun.get(runId);

    if (pendingApprove === undefined) {
      // ① BATCH RESUME.
      const resume = BatchReviewResumeSchema.parse(resumeData);
      if (resume.action === "decline") {
        return { ...state, declined: true };
      }
      // approve → the explicit thread-id list intersected with the reviewed drafts.
      const shown = new Set(drafts.map((d) => d.thread_id));
      const approved = [...new Set(resume.approved_dealer_ids)].filter((id) => shown.has(id));
      if (approved.length === 0) {
        throw new Error(
          "batchReview: approved_dealer_ids resolved to zero reviewed drafts — refusing to send",
        );
      }

      // CONTACT-FLIP OVERRIDE (②): fires ONLY when a flip was explicitly registered
      // for an approved thread. The flip is NEVER inferred from the ladder. Stash
      // the approve set, then raise the sensitive re-confirm for the first request.
      const flip = contactFlipRequestsFor(runId).find((r) => approved.includes(r.threadId));
      if (flip !== undefined) {
        const target = drafts.find((d) => d.thread_id === flip.threadId);
        pendingFlipApproveByRun.set(runId, approved);
        return (await suspend({
          kind: "approval",
          summary:
            `Change the reply address for ${target?.dealer_name ?? "this dealer"} to ` +
            `${flip.contactId}? Future replies will go to this contact (a different ` +
            "action than sending the follow-up).",
          sensitive: true,
          dealerId: flip.dealerId,
          dealerName: target?.dealer_name ?? "(dealer)",
          contactId: flip.contactId,
          contactEmail: target?.reply_email ?? "",
          reason: "contact_flip",
        })) as never;
      }
      return { ...state, approvedThreadIds: approved };
    }

    // ② CONTACT-FLIP RESUME — the sensitive re-confirm answer. Consume the carry.
    pendingFlipApproveByRun.delete(runId);
    const answer = ContactFlipApprovalResumeSchema.parse(resumeData);
    if (answer.action === "decline") {
      // No flip — the run continues; the send is independent of the flip.
      return { ...state, approvedThreadIds: pendingApprove };
    }
    // RE-CONFIRMED — commit the flip (one txn) for the registered request.
    const flip = contactFlipRequestsFor(runId).find((r) => pendingApprove.includes(r.threadId));
    let contactFlips = state.contactFlips;
    if (flip !== undefined) {
      withDb((db) =>
        deps().setPrimaryReplyTarget(db, { dealerId: flip.dealerId, contactId: flip.contactId }),
      );
      contactFlips += 1;
    }
    return { ...state, approvedThreadIds: pendingApprove, contactFlips };
  },
});

// ---------------------------------------------------------------------------
// step 5 — sendRecord (per-draft serial; reply on the EXISTING thread) [gated]
// ---------------------------------------------------------------------------

const sendRecordStep = createStep({
  id: "sendRecord",
  inputSchema: FollowupStateSchema,
  outputSchema: FollowupStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined || state.noCandidates) return state;

    const approved = new Set(state.approvedThreadIds ?? []);
    const toSend = state.targets.filter((t) => approved.has(t.thread_id) && t.draft_body !== null);

    let emailsSent = 0;
    const sentThreadIds: string[] = [];
    for (const t of toSend) {
      const subject = subjectForFollowup(t.subject);
      const target: SendRecordTarget = {
        email: {
          // TO the dealer (the resolved reply-target rung) — FROM the buyer (the
          // profile's follow_up_email). The reply must come FROM the buyer; falling
          // back to reply_email only when the profile has no buyer address. We do
          // not surface a budget anywhere — the body is the assertNoBudget'd prose,
          // the subject is the redacted prior subject.
          to: t.reply_email,
          from: state.followUpEmail ?? t.reply_email,
          subject,
          body: t.draft_body!,
        },
        threadId: reuseThreadIdForReply(t.thread_id), // reply on the EXISTING thread.
        searchProfileId: state.searchProfileId,
        inReplyToGmailId: t.in_reply_to_gmail_id, // the thread double-flag anchor.
      };

      // THE ONE send face. Under BLOCK=1 sendAndRecord returns {blocked} (the
      // fuse fired BEFORE the draft insert → ZERO messages rows) — the fake send,
      // counted. Disarmed offline → {sent} (one promoted row). A {partial} is a
      // mid-commit failure → STOP-and-reconcile (do not backfill the trailing
      // targets; leave them un-sent so a reconcile pass can finish them).
      const outcome = await deps().sendAndRecord(target, { approver: APPROVED, runId });
      if (outcome.kind === "sent" || outcome.kind === "blocked") {
        emailsSent += 1;
        sentThreadIds.push(t.thread_id);
        continue;
      }
      if (outcome.kind === "partial") {
        // A hard mid-batch failure: stop here. The already-sent threads keep their
        // state write below; the trailing ones are not attempted.
        break;
      }
      // `declined` cannot happen (APPROVED always decides true), but never treat a
      // non-sent outcome as a send — stop-and-reconcile defensively.
      break;
    }

    // Carry the SENT thread ids into the state for the confirm step's state write.
    // (Reuse approvedThreadIds as the carry of what actually sent.)
    return { ...state, approvedThreadIds: sentThreadIds, emailsSent };
  },
});

// ---------------------------------------------------------------------------
// step 6 — confirm (ZERO-LLM summary + threads.state writes) [deterministic]
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: FollowupStateSchema,
  outputSchema: NegotiationFollowupOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return { outcome: "declined" as const };
    if (state.noCandidates) {
      return {
        outcome: "no_candidates" as const,
        summary:
          "No follow-up candidates — every thread is either too recent, past the " +
          "follow-up window, capped, or already agreed/closed.",
      };
    }

    const sentThreadIds = state.approvedThreadIds ?? [];
    // The only thread-state write: a SENT thread moves to 'negotiating'. NEVER
    // 'agreed' (agreed requires an explicit deal-price confirmation, out of scope —
    // it is never inferred from a quote). A LOCAL product write, not gated.
    withDb((db) => {
      for (const threadId of sentThreadIds) {
        deps().updateThreadState(db, threadId, "negotiating");
      }
    });

    const draftsCreated = state.targets.filter((t) => t.draft_body !== null).length;
    const summary =
      `Drafted ${draftsCreated} follow-up(s); sent ${state.emailsSent}` +
      (state.contactFlips > 0 ? `, ${state.contactFlips} reply-address change(s)` : "") +
      ".";

    return {
      outcome: "sent" as const,
      resolution: "pinned" as const,
      drafts_created: draftsCreated,
      emails_sent: state.emailsSent,
      contact_flips: state.contactFlips,
      summary,
      search_profile_id: state.searchProfileId,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (7 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const negotiationFollowupWorkflow = createWorkflow({
  id: "negotiation_followup",
  inputSchema: NegotiationFollowupInputSchema,
  outputSchema: NegotiationFollowupOutputSchema,
})
  .then(resolveProfileStep)
  .then(selectTargetsStep)
  .then(buildContextStep)
  .then(draftStep)
  .then(batchReviewStep)
  .then(sendRecordStep)
  .then(confirmStep)
  .commit();
