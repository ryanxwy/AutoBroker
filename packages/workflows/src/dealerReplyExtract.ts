/**
 * dealer_reply_extract — skill #7, the SOLE live-LLM keystone of the email
 * wave. ONE flat linear Mastra `createWorkflow`: 4 named steps chained with
 * `.then()`, no nested workflow, and — like geosearch — ZERO suspend steps:
 * the run is read-only Gmail + local DB writes, autonomous, no human gate.
 *
 * STEP MAP:
 *   0 resolveProfile    — the standard three-branch profile-ASK (infer_ok,
 *                         read-only, re-runnable): exactly-1 active → run; 0 →
 *                         typed STOP at intake; 2+ → typed STOP, ask by
 *                         vehicle. `resolution` provenance: pinned |
 *                         inferred_newest. NOT a pin_required boundary STOP.
 *   1 loadCandidates    — the read-only candidate SELECT: inbound messages
 *                         WHERE quote_extraction_status IN ('pending','failed')
 *                         AND search_profile_id = ?, with the
 *                         dealer_id resolved via thread_id → threads.dealer_id
 *                         and the source_gmail_message_id = the message's
 *                         gmail_message_id (the UNIQUE upsert key). A succeeded
 *                         message is NEVER in this set (idempotent re-extract).
 *   2 extractAndPersist — the per-message pipeline, looped INSIDE this one step
 *                         (Mastra steps are workflow-level, not per-item). For
 *                         EACH candidate, in a per-message try/catch:
 *                           a. classify (pure) — a no_quote message still
 *                              proceeds to a zero-row succeed (intent set, 0
 *                              rows);
 *                           b. prepareAttachments (pure fallback tree over the
 *                              gmail adapter + the attachment-text seam; PDFs
 *                              never OCR'd; an OCR-unavailable image degrades to
 *                              a typed failure, the body can still extract);
 *                           c. extract — the ONE LLM step: a single emit_result
 *                              tool bound to the Zod emit schema,
 *                              hitlAvailable=false, WITH an automatic ONE-hop
 *                              recovery: the first hop is deepseek-v4-flash
 *                              (forced emit, thinking OFF); on the malformed
 *                              class (#1244) it retries ONCE on deepseek-v4-pro
 *                              WITH thinking (tool_choice:"auto"), SAME provider
 *                              (privacy-clean). A retry that ALSO fails malformed
 *                              hard-aborts as a typed MalformedToolCallAbort
 *                              (NEVER a prose fallthrough, NEVER a regexed-out
 *                              tool name);
 *                           d. validatePersist — reclassifyRule2Failures →
 *                              build the full row + provenance →
 *                              DealerQuoteSchema.parse (Rule1/Rule2 belt) BEFORE
 *                              the SQL txn → persistMessageQuotes (all-or-
 *                              nothing; one row failing rolls the WHOLE message
 *                              back + marks it failed, re-queued);
 *                           e. mark-processed — success → succeeded (intent =
 *                              the LLM message_intent, processed_at stamped,
 *                              terminal even with 0 rows). The persist layer
 *                              owns the mark-processed state machine.
 *                         ONE bad message NEVER fails the whole run: the
 *                         per-message catch marks it failed (processed_at NULL,
 *                         re-queued) and continues the loop.
 *   3 confirm           — deterministic ZERO-LLM template over the three counts
 *                         (quotes upserted / messages processed / messages
 *                         failed). Refers to the car, never the budget, never a
 *                         run id.
 *
 * KEYSTONE: #1244 fail-closed. The extract step binds a SINGLE emit_result tool
 * with the flat Zod schema; it NEVER mixes structured-object output + tools,
 * NEVER injects response_format/json_schema per-step. On a malformed tool call
 * the run fails CLOSED (the typed MalformedToolCallAbort), caught per-message →
 * that message is marked `failed`. Communication never includes budget (the
 * confirm copy is structurally budget-free). Gmail is read-only — no send.
 *
 * FALLBACK GATING MAP:
 *   - image vision → OCR        → AUTO-allowed transient/equivalent read, voiced
 *                                 by the attachment seam's fallback span +
 *                                 stamped extraction_method='ocr'.
 *   - PDF no text layer / OCR    → an HONEST per-attachment failure (PDFs are
 *     unavailable                  NEVER OCR'd); the message can still extract
 *                                 from its body, else it fails honestly.
 *   - malformed structured call  → AUTOMATIC bounded recovery: one same-provider
 *                                 retry on deepseek-v4-pro WITH thinking
 *                                 (tool_choice:"auto"). Still malformed after the
 *                                 retry → hitlAvailable=false: typed
 *                                 MalformedToolCallAbort, caught per-message →
 *                                 that message marked failed (re-queued), the
 *                                 run continues.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/core (the
 * DealerQuote row schemas + reclassify), @autobroker/model (typed abort +
 * suspend type), @autobroker/tools (resolver + candidate reader + classifier +
 * attachment tree + gmail adapter + persist + getDb — the ONLY DB/side-effect
 * paths), the skill contracts module, and this layer's harness facade.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";

import { reclassifyRule2Failures, type DealerReplyQuoteRow } from "@autobroker/core";
import { MalformedToolCallAbort, policy } from "@autobroker/model";
import {
  classifyMessageQuoteClass,
  createGmailAdapter,
  getDb,
  loadReplyExtractCandidates as loadReplyExtractCandidatesImpl,
  markMessageFailed as markMessageFailedImpl,
  persistMessageQuotes as persistMessageQuotesImpl,
  prepareAttachments as prepareAttachmentsImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
  type AttachmentRef,
  type GmailAdapter,
  type ReplyExtractCandidate,
} from "@autobroker/tools";

import {
  buildDealerReplyExtractPrompt,
  capReplySnapshot,
  DealerReplyExtractEmitSchema,
  DealerReplyExtractInputSchema,
  DealerReplyExtractOutputSchema,
  DealerReplyExtractStateSchema,
  DealerReplyExtractStopError,
  type DealerReplyExtractState,
  type MessageIntent,
  type ReplyCandidateState,
} from "./dealerReplyExtractContracts.js";
import { harness, isHarnessSuspend, type HarnessLedgerContext } from "./harness.js";
import { isMalformedToolCallError } from "./recoverEmitWithRetry.js";

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL step closures against
 * deterministic stubs + an isolated tmp DB, WITHOUT module mocks.
 */
export interface DealerReplyExtractWorkflowDeps {
  harnessGenerate: typeof harness.generate;
  /** The typed three-branch profile resolver (tools layer). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** The read-only candidate SELECT (tools layer). */
  loadCandidates: typeof loadReplyExtractCandidatesImpl;
  /** The gmail adapter factory (default fake; the bytes source for attachments
   *  + the per-message attachment-ref read). */
  createGmailAdapter: typeof createGmailAdapter;
  /** The deterministic attachment fallback tree (tools layer). */
  prepareAttachments: typeof prepareAttachmentsImpl;
  /** The all-or-nothing per-message upsert + mark-processed state machine
   *  (tools layer, the ONLY dealer_quotes/messages write). */
  persistMessageQuotes: typeof persistMessageQuotesImpl;
  /** The persist layer's mark-failed path (the per-message catch routes a
   *  thrown #1244/extract error here so the state machine has one owner). */
  markMessageFailed: typeof markMessageFailedImpl;
  /** The DB accessor the read/write closures run through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: DealerReplyExtractWorkflowDeps = {
  harnessGenerate: harness.generate,
  resolveProfile: resolveActiveProfileImpl,
  loadCandidates: loadReplyExtractCandidatesImpl,
  createGmailAdapter,
  prepareAttachments: prepareAttachmentsImpl,
  persistMessageQuotes: persistMessageQuotesImpl,
  markMessageFailed: markMessageFailedImpl,
  getDb,
};

let injectedDeps: DealerReplyExtractWorkflowDeps | undefined;

function deps(): DealerReplyExtractWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner (a production caller must
 *  never redirect the harness, the gmail adapter, or the DB write path). */
export function __setDealerReplyExtractDepsForTests(
  partial: Partial<DealerReplyExtractWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setDealerReplyExtractDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetDealerReplyExtractDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// ledger identity for the per-message extraction LLM calls
// ---------------------------------------------------------------------------

function dealerReplyExtractLedger(runId: string): HarnessLedgerContext {
  return {
    runId,
    skill: "dealer_reply_extract",
    layer: "L2",
    promptVersion: "p3-e2-v1",
    schemaVersion: "p3-e2-v1",
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): DealerReplyExtractState {
  return DealerReplyExtractStateSchema.parse(inputData);
}

/** A human label for the ask-by-vehicle STOP. */
function vehicleLabel(p: { year: number | null; make: string; model: string; trim: string | null }): string {
  return [p.year, p.make, p.model, p.trim].filter((x) => x != null && `${x}`.trim() !== "").join(" ");
}

/** The default first-hop extraction useCase (deepseek-v4-flash, forced emit,
 *  thinking OFF) and the automatic recovery-hop useCase (deepseek-v4-pro WITH
 *  thinking, tool_choice:"auto"). Same provider on both — privacy-clean. */
const EXTRACT_USE_CASE = "dealer_reply_extract" as const;
const EXTRACT_RETRY_USE_CASE = "dealer_reply_extract_retry" as const;

/** Run ONE single-emit_result extraction over one message's snapshot through the
 *  given useCase. A malformed tool call hard-aborts (fail-closed) — never a prose
 *  fallthrough, never a regexed-out tool call.
 *
 *  `useCase` picks the provider route and NOTHING else: `dealer_reply_extract`
 *  (deepseek-v4-flash, forced emit_result, thinking OFF — the first hop) or
 *  `dealer_reply_extract_retry` (deepseek-v4-pro WITH thinking, tool_choice
 *  "auto" — the automatic recovery hop). The emit schema, prompt, single-tool
 *  discipline and #1244 fail-closed handling are IDENTICAL on both routes. */
async function extractOneMessage(args: {
  runId: string;
  useCase: typeof EXTRACT_USE_CASE | typeof EXTRACT_RETRY_USE_CASE;
  messageBody: string;
  attachmentText: string;
}): Promise<{
  quotes: DealerReplyQuoteRow[];
  messageIntent: MessageIntent;
  contactRole: string | null;
}> {
  const result = await deps().harnessGenerate(
    {
      useCase: args.useCase,
      schema: DealerReplyExtractEmitSchema,
      prompt: buildDealerReplyExtractPrompt(args.messageBody, args.attachmentText),
      hitlAvailable: false,
    },
    dealerReplyExtractLedger(args.runId),
  );
  if (isHarnessSuspend(result)) {
    // Defensive: with hitlAvailable=false the harness throws rather than
    // suspends; a suspend-shaped return still fail-closes identically.
    throw new MalformedToolCallAbort(result.signals);
  }
  return {
    quotes: result.object.quotes,
    messageIntent: result.object.message_intent,
    contactRole: result.object.contact_role,
  };
}

/**
 * Extract one message with the AUTOMATIC one-hop recovery (owner-directed F1):
 * the first hop runs the default DeepSeek useCase (v4-flash, forced emit_result,
 * thinking OFF). If THAT hop fails the MALFORMED class (#1244 — the deterministic
 * serialization defect a thinking-OFF retry can't fix), retry EXACTLY ONCE on
 * the same provider's v4-pro WITH thinking (tool_choice:"auto"). The retry is
 * bounded to ONE hop — its own throw (malformed again, ZodError, transport)
 * propagates to the per-message catch and the message stays `failed` (fail-
 * closed, exactly as the v4-flash path). Any NON-malformed first-hop failure
 * (ZodError / transport) skips the retry and propagates immediately.
 *
 * Returns the extracted rows + the useCase whose route actually served the
 * persisted result, so provenance stamps the real model hop.
 */
async function extractWithRecovery(args: {
  runId: string;
  messageBody: string;
  attachmentText: string;
}): Promise<{
  quotes: DealerReplyQuoteRow[];
  messageIntent: MessageIntent;
  contactRole: string | null;
  servedUseCase: typeof EXTRACT_USE_CASE | typeof EXTRACT_RETRY_USE_CASE;
}> {
  try {
    const first = await extractOneMessage({ ...args, useCase: EXTRACT_USE_CASE });
    return { ...first, servedUseCase: EXTRACT_USE_CASE };
  } catch (err) {
    // ONLY the malformed class triggers the bounded recovery hop. A ZodError or a
    // transport throw is not recoverable by re-running on v4-pro+thinking.
    if (!isMalformedToolCallError(err)) throw err;
    // Bounded ONE-hop retry: v4-pro WITH thinking. Its throw is NOT re-caught —
    // a second malformed (or any) failure propagates and the message stays
    // failed (fail-closed).
    const retried = await extractOneMessage({ ...args, useCase: EXTRACT_RETRY_USE_CASE });
    return { ...retried, servedUseCase: EXTRACT_RETRY_USE_CASE };
  }
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (standard three-branch ASK; infer_ok, no suspend)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: DealerReplyExtractInputSchema,
  outputSchema: DealerReplyExtractStateSchema,
  execute: async ({ inputData }) => {
    const resolved = deps().resolveProfile(
      deps().getDb(),
      inputData.search_profile_id !== null ? { threadPin: inputData.search_profile_id } : {},
    );

    if (resolved.kind === "none") {
      throw new DealerReplyExtractStopError(
        "no_active_profile",
        "No active search profile found — dealer_reply_extract needs one to know " +
          "which dealer replies to read quotes from. Run /search_profile_intake " +
          "to create a profile, then re-run /dealer_reply_extract.",
      );
    }
    if (resolved.kind === "ambiguous") {
      const labels = resolved.candidates.map((p) => vehicleLabel(p)).join(" | ");
      throw new DealerReplyExtractStopError(
        "multiple_active_profiles",
        `Multiple active search profiles found (${labels}). Tell me which vehicle ` +
          "to extract dealer quotes for by re-running /dealer_reply_extract with " +
          "that profile's search_profile_id.",
      );
    }

    // pinned | inferred_newest — the run proceeds, provenance recorded in state.
    return {
      resolution: resolved.kind,
      search_profile_id: resolved.profile.id,
      candidates: [],
      quotes_upserted: 0,
      messages_processed: 0,
      messages_failed: 0,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — loadCandidates (read-only SELECT of pending/failed inbound messages)
// ---------------------------------------------------------------------------

const loadCandidatesStep = createStep({
  id: "loadCandidates",
  inputSchema: DealerReplyExtractStateSchema,
  outputSchema: DealerReplyExtractStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    // The candidate set is always the profile's pending+failed inbound messages
    // (a `failed` row is re-attempted on a re-run; a `succeeded` row is terminal).
    // The malformed-class recovery is an in-message hop, NOT a candidate-set
    // change — there is no separate "failed-only" route any more.
    const rows: ReplyExtractCandidate[] = deps().loadCandidates(
      state.search_profile_id,
      deps().getDb(),
    );
    const candidates: ReplyCandidateState[] = rows.map((r) => ({
      message_id: r.messageId,
      dealer_id: r.dealerId,
      source_gmail_message_id: r.sourceGmailMessageId,
      search_profile_id: r.searchProfileId,
      body: r.body,
      status: null,
      rows_upserted: 0,
    }));
    return { ...state, candidates };
  },
});

// ---------------------------------------------------------------------------
// step 2 — extractAndPersist (the per-message pipeline, looped IN this step)
// ---------------------------------------------------------------------------

const extractAndPersistStep = createStep({
  id: "extractAndPersist",
  inputSchema: DealerReplyExtractStateSchema,
  outputSchema: DealerReplyExtractStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    const adapter: GmailAdapter = deps().createGmailAdapter();

    let quotesUpserted = 0;
    let messagesProcessed = 0;
    let messagesFailed = 0;
    const processed: ReplyCandidateState[] = [];

    // Mastra steps are workflow-level, not per-item: the per-message pipeline is
    // an IN-STEP loop. One bad message never aborts the loop (per-message catch).
    for (const c of state.candidates) {
      try {
        // a. fetch the per-message attachment refs from the adapter (read-only;
        //    the body already rode the state from loadCandidates).
        let attachmentRefs: readonly AttachmentRef[] = [];
        try {
          const msg = await adapter.getMessage(c.source_gmail_message_id);
          attachmentRefs = msg.attachments;
        } catch {
          // No fetchable message content (e.g. a legacy row) — proceed with the
          // body alone; a body-less message will simply classify no_quote.
          attachmentRefs = [];
        }

        // a'. classify (pure). A no_quote message still proceeds to a zero-row
        //     succeed (intent set, 0 rows) — it is not a failure.
        const messageClass = classifyMessageQuoteClass({ body: c.body, attachments: attachmentRefs });

        // b. prepareAttachments (pure fallback tree). PDFs are never OCR'd; an
        //    OCR-unavailable image degrades to a typed failure — the body can
        //    still extract. The extraction method is derived from whether any
        //    successful attachment used OCR.
        const prep = await deps().prepareAttachments(
          c.source_gmail_message_id,
          attachmentRefs,
          adapter,
        );
        // deepseek.chat has no native vision; images go through on-device OCR
        // (extraction_method='ocr'), PDFs/body through text (='text'). The
        // 'vision' enum member is forward-compat for a vision-capable provider.
        const extractionMethod: "ocr" | "text" = prep.usedOcr ? "ocr" : "text";

        // c. extract — the ONE LLM step (single emit_result tool, fail-closed),
        //    WITH the automatic owner-directed recovery: the first hop runs
        //    deepseek-v4-flash (forced emit, thinking OFF); on the MALFORMED
        //    class (#1244) it retries ONCE on deepseek-v4-pro WITH thinking
        //    (tool_choice:"auto"), same provider (privacy-clean). A retry that
        //    ALSO fails malformed (or any other error) propagates to the catch
        //    below → the message stays `failed`, exactly as the v4-flash path.
        const extracted = await extractWithRecovery({
          runId,
          messageBody: c.body,
          attachmentText: capReplySnapshot(prep.text),
        });

        // Provenance stamps the provider the served route actually used (DeepSeek
        // on BOTH hops — the recovery is same-provider). Derived from policy so a
        // registry-string provider swap flips the stamped provenance in lock-step.
        const extractorProvider = policy(extracted.servedUseCase).provider;

        // d. validatePersist — reclass Rule2 failures, then persist all-or-
        //    nothing. The persist layer re-validates every row through
        //    DealerQuoteSchema (.strict + Rule1/Rule2) BEFORE the SQL txn; one
        //    row failing rolls the WHOLE message back + marks it failed.
        //
        // Backfill quote_format from the message-level class when the LLM
        // left it null. The LLM's own non-null value always wins; this only
        // fills the gap when the LLM omitted it.
        const formatFromClass = (
          { pdf_quote: "pdf", image_quote: "image", text_quote: "text", no_quote: null } as const
        )[messageClass];
        const rows: DealerReplyQuoteRow[] = extracted.quotes.map((row) =>
          reclassifyRule2Failures(
            row.quote_format == null && formatFromClass != null
              ? { ...row, quote_format: formatFromClass }
              : row,
          ),
        );
        const persistResult = deps().persistMessageQuotes({
          provenance: {
            messageId: c.message_id,
            sourceGmailMessageId: c.source_gmail_message_id,
            searchProfileId: c.search_profile_id,
            dealerId: c.dealer_id,
            extractorProvider,
            extractionMethod,
            intent: extracted.messageIntent,
            contactRole: extracted.contactRole,
          },
          rows,
          db: deps().getDb(),
        });

        if (persistResult.ok) {
          quotesUpserted += persistResult.rowsUpserted;
          messagesProcessed += 1;
          processed.push({ ...c, status: "succeeded", rows_upserted: persistResult.rowsUpserted });
        } else {
          // A validation/SQL failure inside persist already marked the message
          // `failed` (processed_at NULL, re-queued) in its own statement.
          messagesFailed += 1;
          processed.push({ ...c, status: "failed", rows_upserted: 0 });
        }
      } catch {
        // A thrown MalformedToolCallAbort (#1244) or any other per-message error
        // (adapter/extract throw) → mark the message failed (intent NULL,
        // processed_at NULL → re-queued) via the persist layer's mark-failed
        // path, write ZERO quotes, then continue. ONE bad message never fails
        // the whole run.
        deps().markMessageFailed({ messageId: c.message_id, db: deps().getDb() });
        messagesFailed += 1;
        processed.push({ ...c, status: "failed", rows_upserted: 0 });
      }
    }

    return {
      ...state,
      candidates: processed,
      quotes_upserted: state.quotes_upserted + quotesUpserted,
      messages_processed: state.messages_processed + messagesProcessed,
      messages_failed: state.messages_failed + messagesFailed,
    };
  },
});

// ---------------------------------------------------------------------------
// step 3 — confirm (deterministic ZERO-LLM template; the car, never the budget)
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: DealerReplyExtractStateSchema,
  outputSchema: DealerReplyExtractOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const total = state.candidates.length;

    let summary: string;
    if (total === 0) {
      summary =
        "No unread dealer replies to read quotes from — nothing new was " +
        "extracted.";
    } else {
      summary =
        `Read ${total} dealer repl${total === 1 ? "y" : "ies"}: ` +
        `${state.messages_processed} processed` +
        (state.messages_failed > 0
          ? `, ${state.messages_failed} could not be read and will be retried`
          : "") +
        `. ${state.quotes_upserted} quote(s) saved` +
        (state.quotes_upserted === 0 && state.messages_processed > 0
          ? " (no real numbers in these replies yet)."
          : ".");
    }

    return {
      outcome: "extracted" as const,
      resolution: state.resolution,
      quotes_upserted: state.quotes_upserted,
      messages_processed: state.messages_processed,
      messages_failed: state.messages_failed,
      search_profile_id: state.search_profile_id,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (4 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const dealerReplyExtractWorkflow = createWorkflow({
  id: "dealer_reply_extract",
  inputSchema: DealerReplyExtractInputSchema,
  outputSchema: DealerReplyExtractOutputSchema,
})
  .then(resolveProfileStep)
  .then(loadCandidatesStep)
  .then(extractAndPersistStep)
  .then(confirmStep)
  .commit();

/** The workflow id, exported for registration + the server descriptor. */
export const DEALER_REPLY_EXTRACT_WORKFLOW_ID = "dealer_reply_extract" as const;
