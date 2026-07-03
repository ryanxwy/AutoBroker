/**
 * @autobroker/workflows — Layer 3 public surface.
 *
 * The Mastra 1.x backbone (load-bearing). There is NO engine seam: the
 * transitional self-built SkillRun / HarnessWorkflowRuntime scaffold has been
 * DELETED; skills import Mastra primitives directly.
 *
 * What this barrel exposes to the app + harness layers:
 *   - the Mastra instance (library mode — no `mastra dev`, no Hono server, no
 *     Cloud), storage = @mastra/libsql on file:~/.autobroker-ts/mastra.db —
 *     a dedicated DB beside the product autobroker.db, never the same file;
 *   - the registered-workflows map + ids for construction and boot recovery;
 *   - the runtime-glue service (boot recovery + duplicate-runId guard);
 *   - per-run provider selection, the chat-rail Memory store, and the NL router;
 *   - the per-skill workflow ids, resume-schema vocabularies, and test-only DI
 *     seams the server descriptors + the offline in-stack tests build against.
 *
 * This is a PRUNED barrel: it re-exports only the symbols the app/harness layers
 * actually import. In-package modules import each other directly (never through
 * this barrel), so skill-local schemas/helpers/workflow values stay unexported
 * here. Adding an export is warranted only when a cross-package consumer needs it.
 *
 * Dependency wall: workflows may import core, model, and tools — never app.
 * workflows NEVER touches SQLite or external APIs; all side effects go through
 * the @autobroker/tools L2 gate.
 */

// @mastra/core@1.41.0 + @mastra/memory@1.20.2 + @mastra/libsql@1.12.1 are
// installed as an EXACT date-matched trio (pinned, not range) — the published
// peer ranges are looser than reality (libsql@1.12.1 imports
// NotificationsStorage that core@1.38 lacks; mastra#10602-class residue), so
// bump all three together or none. `Mastra` / `Memory` / `LibSQLStore` /
// `createWorkflow` (subpath @mastra/core/workflows) all resolve under NodeNext
// ESM. Do NOT re-introduce a self-built run state machine here.

// The library-mode Mastra instance (storage = mastra.db on disk, the dual-DB
// never-co-write rule keeps it separate from the product DB). No dev server, no Cloud.
export { createMastraInstance, resetMastraForTests } from "./mastra.js";

// The registered-workflows map for createMastraInstance({ workflows }) and the
// ids recoverOnBoot scans (the boot caller owns this list — runtimeGlue).
export {
  REGISTERED_WORKFLOWS,
  REGISTERED_WORKFLOW_IDS,
} from "./registeredWorkflows.js";

// Runtime glue — boot recovery (suspended re-attach + stale 'running'
// restart/cancel) and the duplicate-runId guard. Thin wrappers over the Mastra
// instance/workflow/run API (no engine seam).
export {
  recoverOnBoot,
  restartStaleRun,
  cancelStaleRun,
  startRunGuarded,
  beginRunGuarded,
  releaseRunOwnership,
  resetRuntimeGlueForTests,
  DuplicateRunIdError,
  type BootRecoveryReport,
} from "./runtimeGlue.js";

// Per-run provider-selection registry + alias override (lane A). The server
// registers a run's AgentSelection; the harness reads it at the generate seam
// (resolveSelectionForRun) to re-home a DeepSeek-default route onto the chosen
// provider. With no selection the route is the untouched policy() default.
export {
  setRunSelection,
  clearRunSelection,
  getRunSelection,
  envDefaultSelection,
  resolveSelectionForRun,
} from "./agentSelection.js";

// The chat-rail Memory thread store (sessions = Mastra Memory threads). The
// ONLY construction of @mastra/memory Memory — apps do session CRUD through the
// product-shaped RailSessionStore facade and never import @mastra/* (dep wall).
export {
  createRailMemory,
  RailSessionStore,
  type RailSession,
} from "./railMemory.js";

// The NL skill-router (the core product feature) — the LLM classifier that reads
// a free-form chat message and routes it to ONE of the 17 skills / intake /
// clarify, plus the advisory suggest-next re-rank for the skills popover (never
// launches; #1244 fail-closed → null so the UI keeps its deterministic order).
export {
  classifySkillFromText,
  suggestNextSkills,
  type RouteDecision,
  type RouterContext,
  type SuggestContext,
  type SkillSuggestion,
} from "./router.js";

// The model-layer generate-fault test seam, re-exported so the live e2e host
// (serve-live.mjs depends on @autobroker/workflows but not directly on
// @autobroker/model) can arm an llm_500/llm_timeout fault for the next resolved
// model — the LLM twin of __setIntakeDepsForTests' geocode override.
export { __setHarnessGenerateFaultForTests } from "@autobroker/model";

// ---------------------------------------------------------------------------
// Per-skill surfaces — the workflow id, the resume-schema vocabulary the server
// descriptor imports, the app-set per-run browser-emitter factory, and the
// test-only DI seams the offline in-stack tests drive the real suspend/resume
// chain through. (In-package tests import the skill module files directly.)
// ---------------------------------------------------------------------------

// search_profile_intake (skill #1).
export {
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
  __setIntakeDepsForTests,
  __resetIntakeDepsForTests,
  type IntakeWorkflowDeps,
} from "./searchProfileIntake.js";
export {
  AmbiguousLocationResumeSchema,
  CollectResumeSchema,
  MalformedRetryResumeSchema,
  TrimSuggestionResumeSchema,
} from "./intakeContracts.js";

// dealer_geosearch (skill #2, first browser skill, zero suspends).
export {
  DEALER_GEOSEARCH_WORKFLOW_ID,
  setGeosearchBrowserEmitterFactory,
} from "./dealerGeosearch.js";

// inventory_site_scan (skill #3, browser scan). READ-ONLY auto-approve: no human
// gate, no suspend. The shared batch_review resume vocabulary lives in
// batchReviewContracts.js (below); this skill exposes only its id + emitter setter.
export {
  INVENTORY_SITE_SCAN_WORKFLOW_ID,
  setInventoryScanBrowserEmitterFactory,
} from "./inventorySiteScan.js";

// The shared batch_review resume vocabulary (approve{approved_dealer_ids min 1} |
// decline) — the ONE card the irreversible send skills + inventory_link_scan +
// dealer_inbox_check all suspend against, and the server approval-inbox reshapes.
export { BatchReviewResumeSchema } from "./batchReviewContracts.js";

// inventory_link_scan (skill #4, the link-driven scan sibling).
export {
  INVENTORY_LINK_SCAN_WORKFLOW_ID,
  setLinkScanBrowserEmitterFactory,
} from "./inventoryLinkScan.js";

// incentive_scrape (skill #5). Read-only OEM-source scrape; the first-encounter
// resume vocabulary is exposed for the server descriptor.
export {
  INCENTIVE_SCRAPE_WORKFLOW_ID,
  setIncentiveScrapeBrowserEmitterFactory,
} from "./incentiveScrape.js";
export { OemFirstEncounterResumeSchema } from "./incentiveScrapeContracts.js";

// dealer_inbox_check (skill #6, the email-pull skill; batch_review over
// discovered dealer-reply groups — resume reuses the shared BatchReviewResumeSchema).
export { DEALER_INBOX_CHECK_WORKFLOW_ID } from "./dealerInboxCheck.js";

// dealer_reply_extract (skill #7, the live-LLM keystone; autonomous, zero suspend).
export {
  DEALER_REPLY_EXTRACT_WORKFLOW_ID,
  dealerReplyExtractWorkflow,
  __setDealerReplyExtractDepsForTests,
} from "./dealerReplyExtract.js";

// dealer_hygiene (DESTRUCTIVE — three strictly-ordered batch_review stages; the
// per-stage resume vocabulary is exposed for the server descriptor).
export { DEALER_HYGIENE_WORKFLOW_ID } from "./dealerHygiene.js";
export { HygieneResumeSchema } from "./dealerHygieneContracts.js";

// dealer_web_lead_submit (IRREVERSIBLE-SEND keystone — REAL submit in buyer mode
// via AUTOBROKER_MODE, always behind the L2 gate; test mode fake-submits). TWO
// suspends before any side effect: the batch_review card ① (resume reuses the
// shared BatchReviewResumeSchema) and the INDEPENDENT email_fallback re-confirm ②
// (LeadApprovalResumeSchema). The injectable scout/submit boundary types let the
// functional lane drive the REAL workflow + suspend/resume against a fixture.
export {
  DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID,
  __setDealerWebLeadSubmitDepsForTests,
  __resetDealerWebLeadSubmitDepsForTests,
  type DealerWebLeadSubmitWorkflowDeps,
  type ScoutOutcome,
  type ScoutFormsArgs,
  type SubmitOneArgs,
  type SubmitVerdict,
} from "./dealerWebLeadSubmit.js";
export { LeadApprovalResumeSchema } from "./dealerWebLeadSubmitContracts.js";

// negotiation_followup (IRREVERSIBLE-SEND — REAL email in buyer mode via
// AUTOBROKER_MODE, always behind the L2 gate; test mode fake-sends). Email-only
// (no browser emitter). The contact-flip ② override is registered out-of-band via
// requestContactFlipForRun; the ① batch_review resume reuses BatchReviewResumeSchema.
export {
  NEGOTIATION_FOLLOWUP_WORKFLOW_ID,
  __setNegotiationFollowupDepsForTests,
  __resetNegotiationFollowupDepsForTests,
  requestContactFlipForRun,
  clearContactFlipForRun,
  __negotiationFollowupCarrySizesForTests,
  type NegotiationFollowupWorkflowDeps,
} from "./negotiationFollowup.js";
export { ContactFlipApprovalResumeSchema } from "./negotiationFollowupContracts.js";

// negotiation_summary — the advisory LLM read of a dealer's negotiation state for
// the detail modal (single emit_result, hitlAvailable false; ANY failure degrades
// to {summary:null}). Never surfaces budget.
export {
  getOrGenerateDealerNegotiationSummary,
  __setNegotiationSummaryDepsForTests,
  __resetNegotiationSummaryDepsForTests,
} from "./negotiationSummary.js";

// dealer_closeout_email (the EXIT skill — REAL send in buyer mode via
// AUTOBROKER_MODE, always behind the L2 gate; test mode fake-sends). State-only
// (close + suppress, never delete). The batch_review resume reuses the shared schema.
export {
  DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID,
  __setDealerCloseoutEmailDepsForTests,
  __resetDealerCloseoutEmailDepsForTests,
  type DealerCloseoutEmailWorkflowDeps,
} from "./dealerCloseoutEmail.js";

// daily_digest (zero-LLM, zero-suspend windowed read-only aggregation).
export { DAILY_DIGEST_WORKFLOW_ID } from "./dailyDigest.js";

// pipeline_reset (DESTRUCTIVE — ONE typed-YES confirmation_gate suspend; the
// resume vocabulary is exposed for the server descriptor).
export { PIPELINE_RESET_WORKFLOW_ID } from "./pipelineReset.js";
export { PipelineResetResumeSchema } from "./pipelineResetContracts.js";

// inventory_compare / quote_audit / quote_compare (zero-LLM read skills — only
// their workflow ids cross the package boundary).
export { INVENTORY_COMPARE_WORKFLOW_ID } from "./inventoryCompareContracts.js";
export { QUOTE_AUDIT_WORKFLOW_ID } from "./quoteAuditContracts.js";
export { QUOTE_COMPARE_WORKFLOW_ID } from "./quoteCompareContracts.js";

// quote_pipeline (the ORCHESTRATOR — REAL targeted-VIN send in buyer mode via
// AUTOBROKER_MODE, always behind the L2 gate; test mode fake-sends). The
// targeted-VIN SEND resume vocabulary is exposed for the server descriptor.
export {
  QUOTE_PIPELINE_WORKFLOW_ID,
  QuotePipelineSendResumeSchema,
} from "./quotePipelineContracts.js";
