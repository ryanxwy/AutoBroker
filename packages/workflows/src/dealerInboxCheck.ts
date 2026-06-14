/**
 * dealer_inbox_check — the email-pull skill. ONE flat linear Mastra
 * `createWorkflow`: 6 named steps chained with `.then()`, no nested workflow,
 * NO LLM call anywhere (the sweep — discovery, routing, classify, ingest — is
 * fully deterministic). The single suspend is the batch_review card BEFORE any
 * write: decline = terminal, ZERO DB writes, the watermark NOT advanced.
 *
 * STEP MAP:
 *   0 resolveProfile   — the typed three-branch resolver (pinned → run;
 *                        exactly-1 active → inferred-newest, LOGGED, run; 0 →
 *                        typed STOP at intake; 2+ → typed STOP ask-by-vehicle).
 *   1 syncDiscover     — READ-ONLY. read the per-profile last-check timestamp →
 *                        computeWindow (first run "2d") → syncMailbox over the
 *                        injected adapter (the GLOBAL historyId advances inside
 *                        sync) → voice a history-expired full resync on the
 *                        emitter (a transient, auto-allowed fallback) → build the
 *                        4 discovery passes → search each → first-pass-wins
 *                        dedupe → route each thread → CRM-detect → classify →
 *                        suppression read BEFORE the gate → dedup vs
 *                        already-ingested gmail_message_ids. State carries
 *                        matched dealer groups + the unrouted list (ids + short
 *                        strings only).
 *   2 batchReview      — suspend ① (the only one). decline → declined; approve →
 *                        the approved_dealer_ids ∩ shown is the apply set.
 *   3 applyBatch       — gated !declined. ONE applyInboxBatch (search_profile_id
 *                        NON-NULL): ingest the approved groups, write the
 *                        watermark only after this.
 *   4 advanceWatermark — gated !declined, AFTER the write. write the per-profile
 *                        last-check timestamp. decline → untouched (the
 *                        historyId already advanced inside sync, but the
 *                        per-profile window stays so a re-run re-discovers).
 *   5 confirm          — deterministic ZERO-LLM templated summary → output. Zero
 *                        discovered threads = no_replies success (never an
 *                        error). The summary names the car, NEVER budget, NEVER
 *                        a hex run id.
 *
 * Budget red line: only make/model/year + the discovered dealer prose reach this
 * file — the profile's budget is structurally absent.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/model (the
 * suspend type), @autobroker/tools (the resolver + the inbox tools + the gmail
 * sync engine + the adapter factory — the ONLY DB/side-effect paths), and the
 * skill-local contracts.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  applyInboxBatch as applyInboxBatchImpl,
  buildInboxQueries,
  classifyThread,
  computeWindow as computeWindowImpl,
  createGmailAdapter,
  dealerTokens,
  dedupeThreadHits,
  detectCrmPlatformSender,
  getDb,
  listIngestedGmailMessageIds as listIngestedGmailMessageIdsImpl,
  listProfileContactEmails as listProfileContactEmailsImpl,
  listProfileDealerRows as listProfileDealerRowsImpl,
  listSuppressedGmailThreadIds as listSuppressedGmailThreadIdsImpl,
  readLastInboxCheckAt as readLastInboxCheckAtImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
  routeThread as routeThreadImpl,
  syncMailbox as syncMailboxImpl,
  writeLastInboxCheckAt as writeLastInboxCheckAtImpl,
  type GmailAdapter,
  type ThreadDecision,
  type ThreadHit,
} from "@autobroker/tools";

import {
  BatchReviewResumeSchema,
  DEALER_INBOX_CHECK_WORKFLOW_ID,
  DealerInboxCheckStopError,
  InboxReviewSuspendSchema,
} from "./dealerInboxCheckContracts.js";

// ---------------------------------------------------------------------------
// the mailbox key (one mailbox → one global historyId; the per-profile window
// is the per-search watermark, kept separately)
// ---------------------------------------------------------------------------

/** The single mailbox key the global historyId watermark is stored under. One
 *  inbox, one server cursor — the per-profile window is the separate per-search
 *  watermark (advanced only on a successful apply). */
const MAILBOX_KEY = "primary";

/** How many threads the discovery sweep hydrates per pass (a bound so a noisy
 *  query can never balloon the suspend payload). */
const MAX_THREADS_PER_SWEEP = 50;

/** A short prose snippet for the review card (no full bodies in the payload). */
const SNIPPET_MAX = 140;

function snippetOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_MAX ? `${collapsed.slice(0, SNIPPET_MAX - 1)}…` : collapsed;
}

// ---------------------------------------------------------------------------
// the in-process emitter (the voiced sync fallback; SSE in prod, NULL otherwise)
// ---------------------------------------------------------------------------

/** The narrow voiced-trace face the sync fallback is reported on. */
export interface InboxEmitter {
  action(kind: string, detail: string): void;
}

const NULL_INBOX_EMITTER: InboxEmitter = { action: () => undefined };

let inboxEmitterFactory: (runId: string) => InboxEmitter = () => NULL_INBOX_EMITTER;

/** Install the app-layer per-run emitter factory (idempotent; last call wins —
 *  one server per process). */
export function setDealerInboxCheckEmitterFactory(
  factory: (runId: string) => InboxEmitter,
): void {
  inboxEmitterFactory = factory;
}

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL suspend/resume chain against
 * a deterministic Gmail adapter stub + an isolated tmp DB, WITHOUT module mocks.
 */
export interface DealerInboxCheckWorkflowDeps {
  resolveProfile: typeof resolveActiveProfileImpl;
  /** Mint the Gmail adapter the sweep reads (default fake; tests inject a stub). */
  createAdapter: () => GmailAdapter;
  syncMailbox: typeof syncMailboxImpl;
  computeWindow: typeof computeWindowImpl;
  listProfileDealers: typeof listProfileDealerRowsImpl;
  listProfileContactEmails: typeof listProfileContactEmailsImpl;
  listSuppressedGmailThreadIds: typeof listSuppressedGmailThreadIdsImpl;
  listIngestedGmailMessageIds: typeof listIngestedGmailMessageIdsImpl;
  readLastInboxCheckAt: typeof readLastInboxCheckAtImpl;
  writeLastInboxCheckAt: typeof writeLastInboxCheckAtImpl;
  applyInboxBatch: typeof applyInboxBatchImpl;
  getDb: typeof getDb;
}

const realDeps: DealerInboxCheckWorkflowDeps = {
  resolveProfile: resolveActiveProfileImpl,
  createAdapter: () => createGmailAdapter(),
  syncMailbox: syncMailboxImpl,
  computeWindow: computeWindowImpl,
  listProfileDealers: listProfileDealerRowsImpl,
  listProfileContactEmails: listProfileContactEmailsImpl,
  listSuppressedGmailThreadIds: listSuppressedGmailThreadIdsImpl,
  listIngestedGmailMessageIds: listIngestedGmailMessageIdsImpl,
  readLastInboxCheckAt: readLastInboxCheckAtImpl,
  writeLastInboxCheckAt: writeLastInboxCheckAtImpl,
  applyInboxBatch: applyInboxBatchImpl,
  getDb,
};

let injectedDeps: DealerInboxCheckWorkflowDeps | undefined;

function deps(): DealerInboxCheckWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner. */
export function __setDealerInboxCheckDepsForTests(
  partial: Partial<DealerInboxCheckWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setDealerInboxCheckDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetDealerInboxCheckDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  return fn(deps().getDb());
}

function vehicleLabel(p: { year: number; make: string; model: string; trim: string | null }): string {
  return [p.year, p.make, p.model, p.trim].filter((x) => x !== null && x !== "").join(" ");
}

// ---------------------------------------------------------------------------
// the threaded workflow state (flat plain-JSON; LEAN — ids + counts + snippets)
// ---------------------------------------------------------------------------

const InboxMessageStateSchema = z.object({
  message_id: z.string(),
  gmail_message_id: z.string(),
  sender: z.string(),
  sender_email: z.string(),
  sender_name: z.string().nullable(),
  recipient: z.string().nullable(),
  subject: z.string().nullable(),
  body_text: z.string().nullable(),
  received_at: z.string().nullable(),
});

const MatchedDealerGroupSchema = z.object({
  dealer_id: z.string(),
  dealer_name: z.string(),
  contact_id: z.string(),
  normalized_sender_email: z.string(),
  is_crm_platform_sender: z.boolean(),
  threads: z.array(
    z.object({
      thread_id: z.string(),
      gmail_thread_id: z.string().nullable(),
      subject: z.string().nullable(),
      classification: z.enum(["quoted", "replied"]),
      snippet: z.string(),
      messages: z.array(InboxMessageStateSchema),
    }),
  ),
});

const UnroutedThreadSchema = z.object({ thread_id: z.string(), snippet: z.string() });

const InboxCheckStateSchema = z.object({
  searchProfileId: z.string(),
  resolution: z.enum(["pinned", "inferred_newest"]),
  make: z.string(),
  model: z.string(),
  year: z.number().int(),
  trim: z.string().nullable(),
  declined: z.boolean(),
  window: z.string(),
  fullResync: z.boolean(),
  queriesRun: z.number().int(),
  rawHitCount: z.number().int(),
  uniqueThreadCount: z.number().int(),
  matchedGroups: z.array(MatchedDealerGroupSchema),
  unrouted: z.array(UnroutedThreadSchema),
  approvedDealerIds: z.array(z.string()).nullable(),
  newMessagesCount: z.number().int(),
  newThreadsCount: z.number().int(),
  rejectedCount: z.number().int(),
});
type InboxCheckState = z.infer<typeof InboxCheckStateSchema>;

const InboxCheckInputSchema = z.object({
  search_profile_id: z.string().nullable(),
});

const InboxCheckOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("checked"),
    resolution: z.enum(["pinned", "inferred_newest"]),
    window: z.string(),
    queries_run: z.number().int(),
    raw_hit_count: z.number().int(),
    unique_thread_count: z.number().int(),
    new_messages_count: z.number().int(),
    new_threads_count: z.number().int(),
    unique_dealers_replied: z.number().int(),
    unrouted_count: z.number().int(),
    rejected_count: z.number().int(),
    full_resync: z.boolean(),
    summary: z.string(),
  }),
  z.object({ outcome: z.literal("declined") }),
  z.object({ outcome: z.literal("no_replies") }),
]);

function asState(inputData: unknown): InboxCheckState {
  return InboxCheckStateSchema.parse(inputData);
}

/** A loosely-typed dealer-row slice (the read closure returns snake_case). */
function dealerRowInfo(row: Record<string, unknown>): {
  dealerId: string;
  name: string;
  website: string | null;
} {
  return {
    dealerId: String(row["dealer_id"] ?? ""),
    name: typeof row["name"] === "string" ? row["name"] : "(unnamed)",
    website:
      typeof row["website"] === "string" && row["website"] !== "" ? row["website"] : null,
  };
}

/** Deterministic product ids from the backend ids (double-fire safe). */
function productThreadId(gmailThreadId: string): string {
  return `inbox-thread-${gmailThreadId}`;
}
function productMessageId(gmailMessageId: string): string {
  return `inbox-msg-${gmailMessageId}`;
}
function contactIdFor(dealerId: string, normalizedEmail: string): string {
  return `contact-${dealerId}-${normalizedEmail}`;
}

/** The local-part name guess for a sender address (display fallback). */
function senderNameOf(from: string, email: string): string | null {
  // "Sam Sales <sam@x.com>" → "Sam Sales"; bare "sam@x.com" → null.
  const lt = from.indexOf("<");
  if (lt > 0) {
    const name = from.slice(0, lt).trim().replace(/^"|"$/g, "");
    if (name !== "" && name !== email) return name;
  }
  return null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Pull the bare email out of a `Name <addr>` or a raw address. */
function emailOf(from: string): string {
  const lt = from.indexOf("<");
  const gt = from.indexOf(">");
  if (lt !== -1 && gt > lt) return from.slice(lt + 1, gt).trim();
  return from.trim();
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (typed three-branch)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: InboxCheckInputSchema,
  outputSchema: InboxCheckStateSchema,
  execute: async ({ inputData }) => {
    const resolved = withDb((db) =>
      deps().resolveProfile(
        db,
        inputData.search_profile_id !== null ? { threadPin: inputData.search_profile_id } : {},
      ),
    );

    if (resolved.kind === "none") {
      throw new DealerInboxCheckStopError(
        "no_active_profile",
        "No active search profile found — dealer_inbox_check needs one to know " +
          "which dealers' replies to look for. Run /search_profile_intake to " +
          "create a profile, then re-run /dealer_inbox_check.",
      );
    }
    if (resolved.kind === "ambiguous") {
      const labels = resolved.candidates.map((p) => vehicleLabel(p)).join(" | ");
      throw new DealerInboxCheckStopError(
        "multiple_active_profiles",
        `Multiple active search profiles found (${labels}). Tell me which search ` +
          "to check replies for by re-running /dealer_inbox_check with that " +
          "profile's search_profile_id.",
      );
    }

    const profile = resolved.profile;
    return {
      searchProfileId: profile.id,
      resolution: resolved.kind,
      make: profile.make,
      model: profile.model,
      year: profile.year,
      trim: profile.trim,
      declined: false,
      window: "",
      fullResync: false,
      queriesRun: 0,
      rawHitCount: 0,
      uniqueThreadCount: 0,
      matchedGroups: [],
      unrouted: [],
      approvedDealerIds: null,
      newMessagesCount: 0,
      newThreadsCount: 0,
      rejectedCount: 0,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — syncDiscover (READ-ONLY: sync + 4-pass discovery + route + classify)
// ---------------------------------------------------------------------------

const syncDiscoverStep = createStep({
  id: "syncDiscover",
  inputSchema: InboxCheckStateSchema,
  outputSchema: InboxCheckStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    const emitter = inboxEmitterFactory(runId);

    // Per-profile window (the per-search watermark feeds computeWindow).
    const lastCheck = withDb((db) => deps().readLastInboxCheckAt(db, state.searchProfileId));
    const lastCheckMs = lastCheck === null ? null : Date.parse(lastCheck);
    const window = deps().computeWindow(Number.isNaN(lastCheckMs) ? null : lastCheckMs, Date.now());

    const adapter = deps().createAdapter();

    // Incremental sync advances the GLOBAL historyId inside the engine; a stale
    // historyId triggers a full resync (auto-allowed transient — voiced here).
    const sync = await deps().syncMailbox(adapter, MAILBOX_KEY, {
      resyncWindow: `newer_than:${window}`,
      db: deps().getDb(),
    });
    if (sync.fallback !== null) {
      emitter.action(sync.fallback.kind, sync.fallback.detail);
    }

    // Build the 4 discovery passes off the profile + its known contacts +
    // dealer-name/website tokens.
    const dealerRows = withDb((db) => deps().listProfileDealers(db, state.searchProfileId)).map(
      dealerRowInfo,
    );
    const contactEmails = withDb((db) =>
      deps().listProfileContactEmails(db, state.searchProfileId),
    );
    const tokens = [...new Set(dealerRows.flatMap((d) => dealerTokens(d.name, d.website)))].sort();
    const queries = buildInboxQueries({
      make: state.make,
      model: state.model,
      year: state.year,
      window,
      contactEmails,
      dealerTokens: tokens,
    });

    // Run each pass; first-pass-wins dedupe over the hit lists.
    const hitsByPass: ThreadHit[][] = [];
    let rawHitCount = 0;
    for (const q of queries) {
      const refs = await adapter.search(q, MAX_THREADS_PER_SWEEP);
      rawHitCount += refs.length;
      hitsByPass.push(refs.map((r) => ({ threadId: r.threadId, messageIds: r.messageIds })));
    }
    const uniqueHits = dedupeThreadHits(hitsByPass).slice(0, MAX_THREADS_PER_SWEEP);

    // Pre-gate filter sets (read BEFORE the approval gate, per the hard rule).
    const suppressed = withDb((db) => deps().listSuppressedGmailThreadIds(db));
    const ingested = withDb((db) => deps().listIngestedGmailMessageIds(db));

    const dealerNameById = new Map(dealerRows.map((d) => [d.dealerId, d.name]));

    // Hydrate + route + classify each surviving thread.
    const groupByDealer = new Map<
      string,
      {
        dealer_id: string;
        dealer_name: string;
        contact_id: string;
        normalized_sender_email: string;
        is_crm_platform_sender: boolean;
        threads: InboxCheckState["matchedGroups"][number]["threads"];
      }
    >();
    const unrouted: InboxCheckState["unrouted"] = [];

    for (const hit of uniqueHits) {
      // Already suppressed → skip silently (never re-surface a suppressed thread).
      if (suppressed.has(hit.threadId)) continue;

      const thread = await adapter.getThread(hit.threadId);
      const inbound = thread.messages.filter((m) => m.direction === "inbound");
      if (inbound.length === 0) continue; // no dealer reply in this thread.

      const newMessages = inbound.filter((m) => !ingested.has(m.messageId));
      if (newMessages.length === 0) continue; // every message already ingested.

      // Route by the newest inbound message's sender (profile-scoped ladder).
      const newest = newMessages[newMessages.length - 1]!;
      const senderEmail = normalizeEmail(emailOf(newest.from));
      const dealerHit = withDb((db) =>
        lookupRoute(db, hit.threadId, senderEmail, state.searchProfileId),
      );

      const classification = classifyThread(
        newMessages.map((m) => ({ subject: m.subject, bodyText: m.bodyText })),
      );
      const snippet = snippetOf(newMessages.map((m) => m.bodyText).join(" "));

      if (dealerHit === null) {
        unrouted.push({ thread_id: hit.threadId, snippet });
        continue;
      }

      const dealerId = dealerHit.dealerId;
      const dealerName = dealerNameById.get(dealerId) ?? "(unknown dealer)";
      const normalizedEmail = senderEmail;
      const isCrm = detectCrmPlatformSender(senderEmail);

      let group = groupByDealer.get(dealerId);
      if (group === undefined) {
        group = {
          dealer_id: dealerId,
          dealer_name: dealerName,
          contact_id: contactIdFor(dealerId, normalizedEmail),
          normalized_sender_email: normalizedEmail,
          is_crm_platform_sender: isCrm,
          threads: [],
        };
        groupByDealer.set(dealerId, group);
      }
      group.threads.push({
        thread_id: hit.threadId,
        gmail_thread_id: hit.threadId,
        subject: newest.subject === "" ? null : newest.subject,
        classification,
        snippet,
        messages: newMessages.map((m) => ({
          message_id: productMessageId(m.messageId),
          gmail_message_id: m.messageId,
          sender: m.from,
          sender_email: senderEmail,
          sender_name: senderNameOf(m.from, senderEmail),
          recipient: m.to === "" ? null : m.to,
          subject: m.subject === "" ? null : m.subject,
          body_text: m.bodyText === "" ? null : m.bodyText,
          received_at: new Date(m.internalDateMs).toISOString(),
        })),
      });
    }

    return {
      ...state,
      window,
      fullResync: sync.fullResync,
      queriesRun: queries.length,
      rawHitCount,
      uniqueThreadCount: uniqueHits.length,
      matchedGroups: [...groupByDealer.values()],
      unrouted,
    };
  },
});

/** Profile-scoped sender→dealer lookup used inside the discovery step — a thin
 *  shape adapter over the tools-layer routing ladder (existing binding →
 *  known-contact → unrouted). */
function lookupRoute(
  db: ReturnType<typeof getDb>,
  threadId: string,
  senderEmail: string,
  profileId: string,
): { dealerId: string } | null {
  const route = routeThreadImpl(db, { threadId, senderEmail, profileId });
  return "dealerId" in route ? { dealerId: route.dealerId } : null;
}

// ---------------------------------------------------------------------------
// step 2 — batchReview (suspend ①: the human gate before ANY write)
// ---------------------------------------------------------------------------

const batchReviewStep = createStep({
  id: "batchReview",
  inputSchema: InboxCheckStateSchema,
  outputSchema: InboxCheckStateSchema,
  resumeSchema: BatchReviewResumeSchema,
  suspendSchema: InboxReviewSuspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = asState(inputData);

    // Zero discovered groups AND nothing unrouted → no review needed; the
    // confirm step renders the no_replies success. Pass straight through.
    if (state.matchedGroups.length === 0 && state.unrouted.length === 0) {
      return state;
    }

    if (resumeData === undefined) {
      return (await suspend({
        kind: "batch_review",
        question: "Save these dealer replies to your search?",
        targets: state.matchedGroups.map((g) => ({
          dealer_id: g.dealer_id,
          name: g.dealer_name,
          thread_ids: g.threads.map((t) => t.thread_id),
          classification: g.threads.some((t) => t.classification === "quoted")
            ? ("quoted" as const)
            : ("replied" as const),
          snippet: g.threads[0]?.snippet ?? "",
        })),
        unrouted: state.unrouted,
        total_targets: state.matchedGroups.length,
      })) as never;
    }

    const resume = BatchReviewResumeSchema.parse(resumeData);
    if (resume.action === "decline") {
      return { ...state, declined: true };
    }

    const shown = new Set(state.matchedGroups.map((g) => g.dealer_id));
    const approved = [...new Set(resume.approved_dealer_ids)].filter((id) => shown.has(id));
    return { ...state, approvedDealerIds: approved };
  },
});

// ---------------------------------------------------------------------------
// step 3 — applyBatch (the ONE atomic write; gated on !declined)
// ---------------------------------------------------------------------------

const applyBatchStep = createStep({
  id: "applyBatch",
  inputSchema: InboxCheckStateSchema,
  outputSchema: InboxCheckStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined) return state; // ZERO writes.

    const approvedIds = new Set(state.approvedDealerIds ?? []);
    const approve: ThreadDecision[] = [];
    for (const g of state.matchedGroups) {
      if (!approvedIds.has(g.dealer_id)) continue;
      for (const t of g.threads) {
        approve.push({
          threadId: productThreadId(t.gmail_thread_id ?? t.thread_id),
          gmailThreadId: t.gmail_thread_id,
          dealerId: g.dealer_id,
          contactDisplayName: t.messages[0]?.sender_name ?? null,
          contactId: g.contact_id,
          normalizedSenderEmail: g.normalized_sender_email,
          isCrmPlatformSender: g.is_crm_platform_sender,
          subject: t.subject,
          classification: t.classification,
          messages: t.messages.map((m) => ({
            messageId: m.message_id,
            gmailMessageId: m.gmail_message_id,
            sender: m.sender,
            senderEmail: m.sender_email,
            senderName: m.sender_name,
            recipient: m.recipient,
            subject: m.subject,
            bodyText: m.body_text,
            receivedAt: m.received_at,
          })),
        });
      }
    }

    const res = deps().applyInboxBatch({
      searchProfileId: state.searchProfileId,
      runId,
      approve,
      reject: [],
      db: deps().getDb(),
    });

    return {
      ...state,
      newMessagesCount: res.newMessages,
      newThreadsCount: res.newThreads,
      rejectedCount: res.rejected,
    };
  },
});

// ---------------------------------------------------------------------------
// step 4 — advanceWatermark (gated !declined, AFTER the write)
// ---------------------------------------------------------------------------

const advanceWatermarkStep = createStep({
  id: "advanceWatermark",
  inputSchema: InboxCheckStateSchema,
  outputSchema: InboxCheckStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state; // a decline leaves the window untouched.
    withDb((db) =>
      deps().writeLastInboxCheckAt(db, state.searchProfileId, new Date().toISOString()),
    );
    return state;
  },
});

// ---------------------------------------------------------------------------
// step 5 — confirm (deterministic ZERO-LLM templated summary → output)
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: InboxCheckStateSchema,
  outputSchema: InboxCheckOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) {
      return { outcome: "declined" as const };
    }

    // Zero discovered threads (nothing matched, nothing unrouted) → a VALID
    // no_replies success (the wait-state copy lives on the UI side).
    if (state.matchedGroups.length === 0 && state.unrouted.length === 0) {
      return { outcome: "no_replies" as const };
    }

    const car = vehicleLabel({
      year: state.year,
      make: state.make,
      model: state.model,
      trim: state.trim,
    });
    const dealersReplied = state.matchedGroups.length;
    const summary =
      `Found ${state.newMessagesCount} new repl${state.newMessagesCount === 1 ? "y" : "ies"} ` +
      `from ${dealersReplied} dealer${dealersReplied === 1 ? "" : "s"} for your ${car} search` +
      (state.unrouted.length > 0
        ? `; ${state.unrouted.length} thread(s) could not be matched to a dealer`
        : "") +
      (state.fullResync ? " (full mailbox resync)" : "") +
      ".";

    return {
      outcome: "checked" as const,
      resolution: state.resolution,
      window: state.window,
      queries_run: state.queriesRun,
      raw_hit_count: state.rawHitCount,
      unique_thread_count: state.uniqueThreadCount,
      new_messages_count: state.newMessagesCount,
      new_threads_count: state.newThreadsCount,
      unique_dealers_replied: dealersReplied,
      unrouted_count: state.unrouted.length,
      rejected_count: state.rejectedCount,
      full_resync: state.fullResync,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (6 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const dealerInboxCheckWorkflow = createWorkflow({
  id: DEALER_INBOX_CHECK_WORKFLOW_ID,
  inputSchema: InboxCheckInputSchema,
  outputSchema: InboxCheckOutputSchema,
})
  .then(resolveProfileStep)
  .then(syncDiscoverStep)
  .then(batchReviewStep)
  .then(applyBatchStep)
  .then(advanceWatermarkStep)
  .then(confirmStep)
  .commit();

export { DEALER_INBOX_CHECK_WORKFLOW_ID };
