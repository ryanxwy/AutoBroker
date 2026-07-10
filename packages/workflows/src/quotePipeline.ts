/**
 * quote_pipeline — skill #O1, the Phase-4 ORCHESTRATOR (the final skill). ONE
 * flat linear Mastra `createWorkflow`: named steps chained with `.then()`, no
 * nested-children graph. The orchestrator re-derives the four applicable steps
 * over the live DB each run (no checkpoint table) and composes the EXISTING
 * child skill workflows in canonical fan-out order, or — when a target_listing_id
 * is supplied — runs the targeted-VIN OTD sub-path instead (one gated outbound
 * send through the L2 gate — a real send in buyer mode, the fake mailbox in test
 * mode).
 *
 * STEP MAP:
 *   0 resolveProfile — STRICT pin_required three-branch ASK (this is a
 *                      per-profile orchestration, NOT the digest/incentive
 *                      enumerate-all exception): a supplied still-active pin wins;
 *                      a pin-less input STOPs (0 active → no_active_profile
 *                      pointing at intake; exactly 1 → pin_required, never
 *                      silently run; 2+ → multiple_active_profiles, ask by
 *                      vehicle). resolution is always `pinned`.
 *   1 detect        — detectPipelineState re-derives {extract,scrape,audit,compare}
 *                      over the live DB at the current audit_pass_version.
 *   2 dryRun        — when dry_run, short-circuit to a `completed` preview listing
 *                      the would-run steps: ZERO writes (no completion row, no
 *                      child run), finalState computed from detected-vs-empty.
 *   3 targeted      — when target_listing_id is set, branch to the targeted-VIN
 *                      OTD sub-path (skip the fan-out): resolveTargetedListing →
 *                      buildOtdInjection → SUSPEND the SEND approval (sensitive) →
 *                      decline = zero outbound/zero record (the `declined` member);
 *                      approve = the gated send (the per-seam AUTOBROKER_MODE=test
 *                      brake resolves it to the fake mailbox in test/harness,
 *                      fail-closed; a REAL send in buyer mode — always behind the
 *                      always-on L2 human-approval gate) + recordQuoteFromListing
 *                      on the real inbound message_id, but ONLY when the send
 *                      actually landed (`kind:"sent"`). completedSteps:[];
 *                      finalState reflects the record write (a not-sent send
 *                      records nothing and reports a non-"ok" reconcile state).
 *   4 fanOut        — (NOT targeted, NOT dry_run) compose the child skill
 *                      workflows conditional on their detect predicate, in
 *                      canonical order extract→scrape→audit→compare, by invoking
 *                      each via mastra.getWorkflow(childId).createRun().start({
 *                      inputData }). A child that finishes "success" is a
 *                      completed step; "failed" → not completed (no auto-retry,
 *                      the run continues to `partial`). incentive_scrape's OEM
 *                      first-encounter suspend is handled by the documented
 *                      fallback (see SCRAPE-SUSPEND NOTE below).
 *   5 logCompletion — writePipelineCompletion ONCE (the one audit_log row), with
 *                      completedSteps + finalState=computeFinalState + nextAction=
 *                      computeNextAction + a generated pipelineRunId; return the
 *                      `completed` discriminated-union member.
 *
 * SCRAPE-SUSPEND NOTE (the documented fallback, per the O1 brief): re-raising the
 * incentive_scrape OEM first-encounter suspend through the orchestrator's OWN
 * suspend would require floating the in-flight child run across the
 * orchestrator's suspend/resume boundary (the orchestrator step re-executes from
 * the top on resume, so the child run handle is lost). To keep the gate stack
 * unambiguous, the orchestrator runs incentive_scrape AUTONOMOUSLY: it starts the
 * child run, and if the child returns status "suspended" (it would ask the OEM
 * first-encounter approval) the orchestrator ABANDONS that child run, marks scrape
 * NOT completed, and the deterministic nextAction points the user at
 * /incentive_scrape to approve the source directly. A child that scrapes
 * autonomously (registry hit / cache fresh / honest failure) finishes "success"
 * and counts. The two no-suspend keystone children (reply_extract / audit) and
 * compare nest cleanly with zero HITL concern.
 *
 * KEYSTONE: the ONLY outbound side effect is the targeted-VIN send, and it fires
 * ONLY after the SEND suspend is approved, through sendAndRecord's gated path. The
 * send floor is the per-seam !isBuyerMode() AUTOBROKER_MODE=test brake (resolves
 * every send to the fake mailbox in test/harness, fail-closed) PLUS the always-on
 * L2 human-approval gate; buyer mode sends a real email. The fan-out lane reaches
 * no send at all. recordQuoteFromListing runs ONLY on a `kind:"sent"` outcome (a
 * not-sent send records nothing); it + writePipelineCompletion are LOCAL
 * product-DB writes (not mode-gated). The OTD ask text passes through
 * assertNoBudget before it leaves this file.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/tools (the
 * pipeline tools + the gated send + the resolver + budget validator — the ONLY
 * DB/side-effect paths), and the skill-local contracts + the EXACT child contracts
 * (compile-time, no JSON coercion).
 */

import { createHash, randomUUID } from "node:crypto";

import type { Mastra } from "@mastra/core";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  assertNoBudget,
  buildOtdInjection,
  computeFinalState,
  computeNextAction,
  DEFAULT_AUDIT_PASS_VERSION,
  detectPipelineState,
  getDb,
  listProfileRows as listProfileRowsImpl,
  NoInboundThread,
  recordQuoteFromListing as recordQuoteFromListingImpl,
  readQuoteInputWatermark as readQuoteInputWatermarkImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
  resolveTargetedListing as resolveTargetedListingImpl,
  safeBodyTemplate,
  safeSubjectLine,
  sendAndRecord as sendAndRecordImpl,
  TargetedListingNotFound,
  writePipelineCompletion as writePipelineCompletionImpl,
  writeLastComparedQuoteInput as writeLastComparedQuoteInputImpl,
  type Approver,
  type FinalState,
  type PipelineStateFlags,
  type PipelineStep,
  type ResolveTargetedListingResult,
  type SendRecordTarget,
} from "@autobroker/tools";

import {
  clearRunSelection,
  resolveSelectionForRun,
  setRunSelection,
} from "./agentSelection.js";
import { DealerReplyExtractInputSchema } from "./dealerReplyExtractContracts.js";
import { DEALER_REPLY_EXTRACT_WORKFLOW_ID } from "./dealerReplyExtract.js";
import { IncentiveScrapeInputSchema } from "./incentiveScrapeContracts.js";
import { INCENTIVE_SCRAPE_WORKFLOW_ID } from "./incentiveScrape.js";
import {
  QuoteAuditInputSchema,
  QUOTE_AUDIT_WORKFLOW_ID,
} from "./quoteAuditContracts.js";
import {
  QuoteCompareInputSchema,
  QUOTE_COMPARE_WORKFLOW_ID,
} from "./quoteCompareContracts.js";
import {
  PIPELINE_STEPS,
  QUOTE_PIPELINE_WORKFLOW_ID,
  quotePipelineInputSchema,
  quotePipelineOutputSchema,
  QuotePipelineSendResumeSchema,
  QuotePipelineSendSuspendSchema,
  QuotePipelineStopError,
} from "./quotePipelineContracts.js";

export { QUOTE_PIPELINE_WORKFLOW_ID };

// ---------------------------------------------------------------------------
// the internal post-suspend approver (mirrors X1 — the load-bearing call)
// ---------------------------------------------------------------------------

/**
 * The post-suspend approver for the targeted-VIN send. The human ALREADY
 * approved at the SEND suspend; this Approver records that fact for the gate.
 * The send floor under the harness is the per-seam !isBuyerMode() brake: with
 * AUTOBROKER_MODE=test (force-pinned for every test/CI lane) sendAndRecord
 * resolves the fake mailbox adapter fail-closed, so a targeted ask can never
 * reach a real dealer from a test context. ONE module constant.
 */
const APPROVED: Approver = { async decide() { return true; } };

// ---------------------------------------------------------------------------
// child-run composition (the injectable seam — real impl drives Mastra)
// ---------------------------------------------------------------------------

/** A child workflow run's terminal disposition the orchestrator branches on. */
export type ChildRunOutcome = "success" | "suspended" | "failed";

/** Run ONE child skill workflow to completion via the Mastra instance the step
 *  carries, and report only its terminal disposition (the orchestrator reads
 *  per-row DB state for the actual results, not the child summary). A child that
 *  SUSPENDS (incentive_scrape's OEM first-encounter ask) is reported as
 *  "suspended" — the caller abandons it (see the SCRAPE-SUSPEND NOTE). */
async function runChildImpl(
  mastra: Mastra,
  childId: string,
  inputData: Record<string, unknown>,
  parentRunId: string,
): Promise<ChildRunOutcome> {
  const workflow = mastra.getWorkflow(childId);
  const childRunId = `${childId}-${randomUUID()}`;
  const run = await workflow.createRun({ runId: childRunId });
  // Propagate the parent's per-run provider selection onto the FRESH child runId:
  // the child's harness.generate resolves resolveSelectionForRun(childRunId), so
  // without this re-registration a Claude-selected pipeline would silently extract
  // on the DeepSeek default. Run-scoped + cleared in `finally` (mirrors the
  // runtimeGlue ownership lifecycle) so the registry never leaks child runIds.
  const sel = resolveSelectionForRun(parentRunId);
  if (sel) setRunSelection(childRunId, sel);
  try {
    const result = (await run.start({ inputData })) as { status?: string };
    if (result.status === "success") return "success";
    if (result.status === "suspended") {
      // REAP the abandoned child run (the orchestrator never resumes it — see the
      // SCRAPE-SUSPEND NOTE). Cancelling flips its persisted status to 'canceled'
      // so recoverOnBoot's listWorkflowRuns({status:'suspended'}) scan never
      // resurfaces it as a dangling re-attachable run. A cancel failure must not
      // mask the suspend disposition the orchestrator branches on.
      await run.cancel().catch(() => undefined);
      return "suspended";
    }
    return "failed";
  } finally {
    clearRunSelection(childRunId);
  }
}

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL suspend/resume chain against
 * deterministic stubs and an isolated tmp DB, WITHOUT module mocks (and without
 * registering the four real child workflows on the test Mastra instance).
 */
export interface QuotePipelineWorkflowDeps {
  /** The typed three-branch profile resolver (tools layer; pin_required use). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** All active profile rows (the pin-less STOP candidate list). */
  listActiveProfiles: (db: ReturnType<typeof getDb>) => Record<string, unknown>[];
  /** The 4-predicate re-derivation (tools layer). */
  detectPipelineState: typeof detectPipelineState;
  /** Capture the quote frontier detect evaluates and compare later marks done. */
  readQuoteInputWatermark: typeof readQuoteInputWatermarkImpl;
  /** Advance compare's self-clearing watermark only after child success. */
  writeLastComparedQuoteInput: typeof writeLastComparedQuoteInputImpl;
  /** The READ-ONLY targeted-listing validator (tools layer). */
  resolveTargetedListing: typeof resolveTargetedListingImpl;
  /** Read the latest inbound message on a thread — its id (the recordQuote
   *  provenance), its sender (the reply `to`), AND its gmail_message_id (the
   *  reply `inReplyToGmailId`, so the send's thread flags pair correctly); null
   *  when none (a defensive guard — resolveTargetedListing already proved an
   *  inbound exists). */
  readLatestInbound: (
    db: ReturnType<typeof getDb>,
    threadId: string,
  ) => { messageId: string; sender: string | null; gmailMessageId: string | null } | null;
  /** The idempotent targeted-VIN dealer_quotes writer (tools layer, LOCAL write). */
  recordQuoteFromListing: typeof recordQuoteFromListingImpl;
  /** The gated draft-then-promote send+record (tools layer; the ONLY send path). */
  sendAndRecord: typeof sendAndRecordImpl;
  /** The one-row audit_log completion writer (tools layer, LOCAL write). */
  writePipelineCompletion: typeof writePipelineCompletionImpl;
  /** The child-skill-workflow composer (drives Mastra; injectable for tests).
   *  `parentRunId` is the orchestrator run's id — the source of the per-run
   *  provider selection re-homed onto each child run. */
  runChild: (
    mastra: Mastra,
    childId: string,
    inputData: Record<string, unknown>,
    parentRunId: string,
  ) => Promise<ChildRunOutcome>;
  /** The DB accessor the read/write closures run through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: QuotePipelineWorkflowDeps = {
  resolveProfile: resolveActiveProfileImpl,
  listActiveProfiles: (db) => listProfileRowsImpl(db, "active"),
  detectPipelineState,
  readQuoteInputWatermark: readQuoteInputWatermarkImpl,
  writeLastComparedQuoteInput: writeLastComparedQuoteInputImpl,
  resolveTargetedListing: resolveTargetedListingImpl,
  readLatestInbound: (db, threadId) => {
    const row = db.$client
      .prepare(
        "SELECT message_id, sender, gmail_message_id FROM messages WHERE thread_id = ? AND " +
          "direction = 'inbound' ORDER BY received_at DESC LIMIT 1",
      )
      .get(threadId) as
      | { message_id?: string; sender?: string | null; gmail_message_id?: string | null }
      | undefined;
    if (row?.message_id === undefined) return null;
    return {
      messageId: row.message_id,
      sender: row.sender ?? null,
      gmailMessageId: row.gmail_message_id ?? null,
    };
  },
  recordQuoteFromListing: recordQuoteFromListingImpl,
  sendAndRecord: sendAndRecordImpl,
  writePipelineCompletion: writePipelineCompletionImpl,
  runChild: runChildImpl,
  getDb,
};

let injectedDeps: QuotePipelineWorkflowDeps | undefined;

function deps(): QuotePipelineWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner (a production caller must
 *  never redirect the resolver, the send path, the child composer, or the DB). */
export function __setQuotePipelineDepsForTests(
  partial: Partial<QuotePipelineWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setQuotePipelineDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetQuotePipelineDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// the canonical child-id + input map (compile-time contract per child)
// ---------------------------------------------------------------------------

/** The child workflow id each detected step composes, in canonical fan-out
 *  order. Each input is the EXACT child input contract (no JSON coercion). */
const CHILD_FOR_STEP: Record<PipelineStep, string> = {
  extract: DEALER_REPLY_EXTRACT_WORKFLOW_ID,
  scrape: INCENTIVE_SCRAPE_WORKFLOW_ID,
  audit: QUOTE_AUDIT_WORKFLOW_ID,
  compare: QUOTE_COMPARE_WORKFLOW_ID,
};

/** Build the EXACT child inputData for one step + profile (validated against the
 *  child's own input schema — a compile-time contract). */
function childInputFor(step: PipelineStep, profileId: string): Record<string, unknown> {
  switch (step) {
    case "extract":
      return DealerReplyExtractInputSchema.parse({ search_profile_id: profileId });
    case "scrape":
      return IncentiveScrapeInputSchema.parse({ search_profile_id: profileId });
    case "audit":
      return QuoteAuditInputSchema.parse({ search_profile_id: profileId, quote_id: null });
    case "compare":
      return QuoteCompareInputSchema.parse({ search_profile_id: profileId });
  }
}

// ---------------------------------------------------------------------------
// the threaded workflow state (flat plain-JSON, Mastra-snapshotted)
// ---------------------------------------------------------------------------

const PipelineStateFlagsSchema = z.object({
  extract: z.boolean(),
  scrape: z.boolean(),
  audit: z.boolean(),
  compare: z.boolean(),
});

const QuoteInputWatermarkSchema = z.object({
  quoteCount: z.number().int().nonnegative(),
  maxQuoteRowid: z.number().int().nonnegative(),
  quoteSetHash: z.string().length(64),
});

const QuotePipelineStateSchema = z.object({
  searchProfileId: z.string(),
  dryRun: z.boolean(),
  targetListingId: z.string().nullable(),
  /** The four re-derived predicates (set at detect). */
  detected: PipelineStateFlagsSchema,
  /** Exact quote frontier observed by detect. Persisted only if compare succeeds. */
  compareInputWatermark: QuoteInputWatermarkSchema.nullable(),
  /** The targeted-VIN sub-path is active (skip the fan-out). */
  targeted: z.boolean(),
  /** Terminal-declined flag (the targeted SEND was declined). */
  declined: z.boolean(),
  /** Steps that actually completed this run (the fan-out / targeted record). */
  completedSteps: z.array(z.enum(PIPELINE_STEPS)),
  /** True when the targeted record-quote landed (drives the targeted finalState). */
  recorded: z.boolean(),
  /** The targeted SEND did not complete (a `partial` outcome) — no quote
   *  was recorded and a retained draft awaits reconcile (drives a non-"ok"
   *  finalState distinct from the recorded/no_work paths). */
  sendIncomplete: z.boolean(),
  /** The reconcile hint carried out of a not-sent outcome (surfaced in the
   *  targeted summary/nextAction); null on every send-complete path. */
  sendReconcileHint: z.string().nullable(),
});
type QuotePipelineState = z.infer<typeof QuotePipelineStateSchema>;

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): QuotePipelineState {
  return QuotePipelineStateSchema.parse(inputData);
}

/** Run `fn` against the SHARED tools-layer DB connection. */
function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  return fn(deps().getDb());
}

/** "2026 Hyundai Tucson SEL"-style label for the pin/ask stops. */
function rowVehicleLabel(row: Record<string, unknown>): string {
  return [row["year"], row["make"], row["model"], row["trim"]]
    .filter((x) => x !== null && x !== undefined && x !== "")
    .join(" ");
}

/** The detected predicates as the canonical step list (the finalState input). */
function detectedSteps(flags: PipelineStateFlags): PipelineStep[] {
  return PIPELINE_STEPS.filter((s) => flags[s]);
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (STRICT pin_required three-branch)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: quotePipelineInputSchema,
  outputSchema: QuotePipelineStateSchema,
  execute: async ({ inputData }) => {
    // pin-less full-batch input STOPs by the generalized classifier (this skill
    // never infers, not even the single-active case — pin_required).
    if (inputData.search_profile_id === null) {
      const active = withDb((db) => deps().listActiveProfiles(db));
      if (active.length <= 0) {
        throw new QuotePipelineStopError(
          "no_active_profile",
          "No active search profile found — quote_pipeline needs one to know which " +
            "search to run the post-reply chain over. Run /search_profile_intake to " +
            "create a profile, then re-run /quote_pipeline.",
        );
      }
      const labels = active.map((r) => rowVehicleLabel(r)).join(" | ");
      throw new QuotePipelineStopError(
        active.length === 1 ? "pin_required" : "multiple_active_profiles",
        `Pin a search first: ${labels}. quote_pipeline only runs over a search you have ` +
          "explicitly pinned — pick one from the Searches list, then re-run /quote_pipeline.",
      );
    }

    // A supplied pin must still be active; a stale/closed/missing pin is rejected.
    const resolved = withDb((db) =>
      deps().resolveProfile(db, { threadPin: inputData.search_profile_id! }),
    );
    if (resolved.kind !== "pinned") {
      throw new QuotePipelineStopError(
        "pin_required",
        "That pinned search is no longer active. Pick an active search from the " +
          "Searches list and re-run /quote_pipeline.",
      );
    }

    return {
      searchProfileId: resolved.profile.id,
      dryRun: inputData.dry_run,
      targetListingId: inputData.target_listing_id,
      detected: { extract: false, scrape: false, audit: false, compare: false },
      compareInputWatermark: null,
      targeted: inputData.target_listing_id !== null,
      declined: false,
      completedSteps: [],
      recorded: false,
      sendIncomplete: false,
      sendReconcileHint: null,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — detect (re-derive the four predicates over the live DB)
// ---------------------------------------------------------------------------

const detectStep = createStep({
  id: "detect",
  inputSchema: QuotePipelineStateSchema,
  outputSchema: QuotePipelineStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const db = deps().getDb();
    const compareInputWatermark = deps().readQuoteInputWatermark(db, state.searchProfileId);
    const detected = deps().detectPipelineState({
      searchProfileId: state.searchProfileId,
      auditPassVersion: DEFAULT_AUDIT_PASS_VERSION,
      nowMs: Date.now(),
      quoteInputWatermark: compareInputWatermark,
      db,
    });
    return { ...state, detected, compareInputWatermark };
  },
});

// ---------------------------------------------------------------------------
// step 2 — targeted (the targeted-VIN OTD sub-path: SUSPEND → gated send)
// ---------------------------------------------------------------------------

/** Build the outbound OTD ask body (deterministic template + the VIN-specific
 *  OTD injection), budget-redacted by the template and belt-checked here. */
function buildTargetedBody(
  profile: { year: number | null; make: string | null; model: string | null; trim: string | null; financingPreference: string | null; followUpEmail: string | null },
  otdAsk: string,
): string {
  const body = `${safeBodyTemplate(profile)}\n${otdAsk}\n`;
  assertNoBudget(body); // belt: never an outbound budget figure.
  return body;
}

/** A DETERMINISTIC quote_id for the targeted record, derived from the stable
 *  inputs (listing + the real inbound message id + financing mode). A re-run on
 *  the same listing/financing yields the SAME quote_id, so recordQuoteFromListing's
 *  quote_id idempotency replays cleanly ({recorded:false}) instead of colliding on
 *  the (source_gmail_message_id, financing_mode) UNIQUE index. */
function targetedQuoteId(sourceListingId: string, messageId: string, financingMode: string): string {
  return createHash("sha256")
    .update(`${sourceListingId} ${messageId} ${financingMode}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

const targetedStep = createStep({
  id: "targeted",
  inputSchema: QuotePipelineStateSchema,
  outputSchema: QuotePipelineStateSchema,
  resumeSchema: QuotePipelineSendResumeSchema,
  suspendSchema: QuotePipelineSendSuspendSchema,
  execute: async ({ inputData, resumeData, suspend, runId }) => {
    const state = asState(inputData);
    // Pass through when not the targeted sub-path or after a dry-run short circuit.
    if (!state.targeted || state.targetListingId === null || state.dryRun) return state;

    // Resolve the listing + its inbound thread (READ-ONLY). A throw is a typed
    // STOP, never a crash.
    let resolved: ResolveTargetedListingResult;
    try {
      resolved = withDb((db) =>
        deps().resolveTargetedListing({ targetListingId: state.targetListingId!, db }),
      );
    } catch (err) {
      if (err instanceof TargetedListingNotFound) {
        throw new QuotePipelineStopError(
          "targeted_listing_not_found",
          "That listing was not found — quote_pipeline needs a real listing to send a " +
            "targeted out-the-door ask. Re-run /inventory_site_scan, then re-try.",
        );
      }
      if (err instanceof NoInboundThread) {
        throw new QuotePipelineStopError(
          "targeted_no_inbound_thread",
          "That dealer has no inbound reply for this search yet — quote_pipeline only " +
            "sends a targeted ask into an existing conversation. Run /dealer_inbox_check first.",
        );
      }
      throw err;
    }

    // The VIN-specific OTD ask (throws MissingVinError on a VIN-less listing —
    // surfaced as a hard fail, never a VIN-less "specific" ask).
    const otdAsk = buildOtdInjection({
      stock: resolved.listing.stockNumber,
      vin: resolved.listing.vin,
    });

    // FIRST pass: render the SEND approval card (gate BEFORE prose — nothing has
    // been sent, no record written).
    if (resumeData === undefined) {
      return (await suspend({
        kind: "approval",
        summary:
          `Send a targeted out-the-door ask for VIN ${resolved.listing.vin} to this dealer? ` +
          "(a real outbound email in buyer mode; fake mailbox in test mode)",
        sensitive: true,
        dealerId: resolved.listing.dealerId,
        listingId: resolved.listing.listingId,
        vin: resolved.listing.vin ?? "",
        reason: "targeted_otd_send",
      })) as never;
    }

    const answer = QuotePipelineSendResumeSchema.parse(resumeData);
    if (answer.action === "decline") {
      // DECLINE: zero outbound, zero record write — the terminal `declined`.
      return { ...state, declined: true };
    }

    // APPROVED. The gated send fires now: the per-seam !isBuyerMode() brake
    // resolves the fake mailbox in test/harness (fail-closed) and a REAL send in
    // buyer mode. The OTD ask replies into the dealer's inbound thread (the sender
    // is the reply `to`).
    const inbound = withDb((db) =>
      deps().readLatestInbound(db, resolved.inboundThread.threadId),
    );
    if (inbound === null) {
      // Defensive: resolveTargetedListing already proved an inbound exists, so a
      // null here is a race — STOP rather than fabricate provenance.
      throw new QuotePipelineStopError(
        "targeted_no_inbound_thread",
        "The dealer's inbound reply could not be re-read — re-run /dealer_inbox_check, then re-try.",
      );
    }

    const profileRow = withDb((db) =>
      db.$client
        .prepare("SELECT * FROM search_profiles WHERE search_profile_id = ?")
        .get(state.searchProfileId) as Record<string, unknown> | undefined,
    );
    const row = profileRow ?? {};
    const messageProfile = {
      year: typeof row["year"] === "number" ? (row["year"] as number) : null,
      make: typeof row["make"] === "string" ? (row["make"] as string) : null,
      model: typeof row["model"] === "string" ? (row["model"] as string) : null,
      trim: typeof row["trim"] === "string" ? (row["trim"] as string) : null,
      financingPreference:
        typeof row["financing_preference"] === "string"
          ? (row["financing_preference"] as string)
          : null,
      followUpEmail:
        typeof row["follow_up_email"] === "string" ? (row["follow_up_email"] as string) : null,
    };

    // Reply double-flag invariant: threadId + inReplyToGmailId are set together
    // or neither. A real dealer reply always carries a gmail_message_id, so this
    // is normally a thread reply; if the inbound's gmail id is null (a race / a
    // synthetic row), fall back to a NEW top-level message (both unset) rather
    // than the forbidden exactly-one shape that sendAndRecord refuses.
    const target: SendRecordTarget = {
      email: {
        to: inbound.sender ?? "",
        from: messageProfile.followUpEmail ?? "",
        subject: safeSubjectLine(messageProfile),
        body: buildTargetedBody(messageProfile, otdAsk),
      },
      threadId: inbound.gmailMessageId === null ? null : resolved.inboundThread.threadId,
      searchProfileId: state.searchProfileId,
      inReplyToGmailId: inbound.gmailMessageId,
    };
    const outcome = await deps().sendAndRecord(target, { approver: APPROVED, runId });

    // TRUTHFUL send status: record the quote and report a send ONLY when the send
    // actually landed. A `partial` (the send threw AFTER its draft was inserted —
    // the draft is retained with a NULL gmail id) means the ask did NOT reach the
    // dealer, so we backfill NOTHING and stop-and-reconcile (mirrors
    // negotiationFollowup): skip recordQuoteFromListing and carry a reconcile hint
    // so a later pass can promote or discard the retained draft. `declined` cannot
    // occur here (APPROVED always decides true), but any non-"sent" outcome is
    // treated as not-sent defensively. The gate is unchanged — the send still
    // fired only after the approved suspend above.
    if (outcome.kind !== "sent") {
      const reconcileHint =
        outcome.kind === "partial" ? outcome.partial.reconcile_hint : "send_not_completed";
      return { ...state, sendIncomplete: true, sendReconcileHint: reconcileHint };
    }

    // SENT. Record the targeted quote on the REAL inbound message (idempotent on
    // quote_id; a LOCAL product-DB write — it lands only because the send landed).
    const financingMode = messageProfile.financingPreference ?? "unspecified";
    const result = withDb((db) =>
      deps().recordQuoteFromListing({
        quoteId: targetedQuoteId(resolved.listing.listingId, inbound.messageId, financingMode),
        messageId: inbound.messageId,
        sourceListingId: resolved.listing.listingId,
        dealerId: resolved.listing.dealerId,
        searchProfileId: state.searchProfileId,
        financingMode,
        vin: resolved.listing.vin,
        otdTotal: null,
        db,
      }),
    );

    return { ...state, recorded: result.recorded };
  },
});

// ---------------------------------------------------------------------------
// step 3 — fanOut (compose the child skill workflows in canonical order)
// ---------------------------------------------------------------------------

const fanOutStep = createStep({
  id: "fanOut",
  inputSchema: QuotePipelineStateSchema,
  outputSchema: QuotePipelineStateSchema,
  execute: async ({ inputData, mastra, runId }) => {
    const state = asState(inputData);
    // The targeted sub-path / dry-run / a decline all skip the fan-out.
    if (state.targeted || state.dryRun || state.declined) return state;

    const completed: PipelineStep[] = [];
    for (const step of PIPELINE_STEPS) {
      if (!state.detected[step]) continue; // not applicable this run.
      // Re-capture immediately before compare. Earlier children (especially
      // extract) may have inserted a quote since detect; that quote is part of
      // the set the compare child is about to consume and may be marked done.
      const comparedInput =
        step === "compare"
          ? withDb((db) => deps().readQuoteInputWatermark(db, state.searchProfileId))
          : null;
      const outcome = await deps().runChild(
        mastra,
        CHILD_FOR_STEP[step],
        childInputFor(step, state.searchProfileId),
        runId,
      );
      // A child that SUSPENDED (incentive_scrape OEM first-encounter) or FAILED
      // is NOT completed — no auto-retry; the run continues to `partial` and the
      // deterministic nextAction points the user at the remaining step.
      if (outcome === "success") {
        if (step === "compare") {
          // Persist the PRE-CHILD frontier, never a post-child re-read. A
          // concurrent inbox pass may insert a quote while compare runs; that
          // newer frontier must remain visible to the next admission.
          if (comparedInput === null) {
            throw new Error("quote_pipeline compare succeeded without an input watermark");
          }
          withDb((db) =>
            deps().writeLastComparedQuoteInput(db, state.searchProfileId, comparedInput),
          );
        }
        completed.push(step);
      }
    }

    return { ...state, completedSteps: completed };
  },
});

// ---------------------------------------------------------------------------
// step 4 — logCompletion (the one audit_log row + the typed output)
// ---------------------------------------------------------------------------

const logCompletionStep = createStep({
  id: "logCompletion",
  inputSchema: QuotePipelineStateSchema,
  outputSchema: quotePipelineOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);

    // A declined targeted SEND is the ONLY `declined` member (zero writes).
    if (state.declined) {
      return { outcome: "declined" as const };
    }

    const detected = detectedSteps(state.detected);

    // DRY-RUN: a would-run preview — ZERO writes (no completion row, no child).
    if (state.dryRun) {
      const finalState = computeFinalState(detected, []);
      const wouldRun = detected.length > 0 ? detected.join(", ") : "nothing";
      return {
        outcome: "completed" as const,
        finalState,
        completedSteps: [],
        nextAction: computeNextAction(finalState, detected, []),
        resolution: "pinned" as const,
        summary: `Dry run — would run: ${wouldRun}. No work was performed.`,
      };
    }

    // TARGETED sub-path: completedSteps is always [] (the fan-out is skipped);
    // the finalState reflects whether the record-quote landed. The targeted run
    // writes no audit_log completion row (it is a single-listing ask, not a
    // pipeline pass) — its truth is the recorded dealer_quotes row.
    if (state.targeted) {
      // SEND DID NOT COMPLETE (a `partial` outcome): report a non-"ok"
      // reconcile state, NEVER "sent". No quote was recorded; surface the reconcile
      // hint so a later pass (or the user) resolves the retained draft.
      if (state.sendIncomplete) {
        const hint = state.sendReconcileHint ?? "send_not_completed";
        return {
          outcome: "completed" as const,
          finalState: "partial" as const,
          completedSteps: [],
          nextAction:
            `The targeted out-the-door ask did NOT send (${hint}) — a retained draft is ` +
            "pending reconcile; nothing was recorded. Re-run /quote_pipeline to retry once " +
            "the send path is clear.",
          resolution: "pinned" as const,
          summary:
            "The targeted out-the-door ask did NOT send (send incomplete — a retained draft " +
            "awaits reconcile); no quote was recorded.",
        };
      }
      const finalState: FinalState = state.recorded ? "ok" : "no_work";
      return {
        outcome: "completed" as const,
        finalState,
        completedSteps: [],
        nextAction: state.recorded
          ? "Targeted out-the-door ask sent — watch the inbox for the dealer's reply."
          : "Nothing recorded — the targeted ask was already captured for this listing.",
        resolution: "pinned" as const,
        summary: state.recorded
          ? "Sent a targeted out-the-door ask on the selected listing and recorded the quote."
          : "The targeted ask was already recorded for this listing — nothing new to do.",
      };
    }

    // FAN-OUT: write the ONE completion row, computed in CODE.
    const finalState = computeFinalState(detected, state.completedSteps);
    const nextAction = computeNextAction(finalState, detected, state.completedSteps);
    withDb((db) =>
      deps().writePipelineCompletion({
        searchProfileId: state.searchProfileId,
        pipelineRunId: randomUUID(),
        completedSteps: state.completedSteps,
        finalState,
        nextAction,
        db,
      }),
    );

    const ran = state.completedSteps.length > 0 ? state.completedSteps.join(", ") : "no steps";
    return {
      outcome: "completed" as const,
      finalState,
      completedSteps: state.completedSteps,
      nextAction,
      resolution: "pinned" as const,
      summary:
        finalState === "no_work"
          ? "Pipeline ran — nothing was applicable, so no work was performed."
          : `Pipeline ${finalState === "ok" ? "complete" : "partial"} — ran: ${ran}. ${nextAction}`,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (5 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const quotePipelineWorkflow = createWorkflow({
  id: QUOTE_PIPELINE_WORKFLOW_ID,
  inputSchema: quotePipelineInputSchema,
  outputSchema: quotePipelineOutputSchema,
})
  .then(resolveProfileStep)
  .then(detectStep)
  .then(targetedStep)
  .then(fanOutStep)
  .then(logCompletionStep)
  .commit();
