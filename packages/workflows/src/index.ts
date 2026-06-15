/**
 * @autobroker/workflows — Layer 3 public surface.
 *
 * The Mastra 1.x backbone (load-bearing). There is NO engine seam: the
 * transitional self-built SkillRun / HarnessWorkflowRuntime scaffold has been
 * DELETED; skills import Mastra primitives directly.
 *
 * What lands here (foundation first, then one skill at a time):
 *   - the Mastra instance (library mode — no `mastra dev`, no Hono server, no
 *     Cloud), storage = @mastra/libsql on file:~/.autobroker-ts/mastra.db —
 *     a dedicated DB beside the product autobroker.db, never the same file;
 *   - one flat linear `createWorkflow` per skill;
 *   - Memory threads/resources + OM auto-compact on the chat rail ONLY (OM is
 *     never enabled inside skill workflow runs — mastra#14598);
 *   - the runtime-glue service: boot recovery (MASTRA_TELEMETRY_DISABLED=1
 *     before construction → deterministic tool re-registration by toolName →
 *     listWorkflowRuns({status:'suspended'}) re-attach approval UI →
 *     restart()/cancel() per age policy), duplicate-runId idempotency guard,
 *     SSE pubsub discipline, and the Mastra→product status projection onto
 *     core's `SkillRunStatus` (single source — no core↔workflows enum drift).
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

// #1244 fail-closed detector as a Mastra output Processor (detection logic
// stays pure in @autobroker/model).
export {
  malformedToolCallProcessor,
  type MalformedToolCallProcessorOptions,
  type MalformedToolCallTripMetadata,
} from "./malformedToolCallProcessor.js";

// The library-mode Mastra instance (storage = mastra.db on disk, the dual-DB
// never-co-write rule keeps it separate from the product DB). No dev server, no Cloud.
export {
  createMastraInstance,
  getMastra,
  resetMastraForTests,
  type CreateMastraInstanceOptions,
} from "./mastra.js";

// The runnable harness.generate facade: the Mastra Agent
// loop end-to-end. Types + pure helpers live in @autobroker/model; the loop is
// owned here (only the api-key lane lets the AI SDK own the tool loop).
// emit_result discipline + #1244 fail-closed.
export {
  harness,
  type HarnessLedgerContext,
} from "./harness.js";

// Runtime glue — boot recovery (suspended re-attach + stale
// 'running' restart/cancel) and the duplicate-runId guard. Thin wrappers over
// the Mastra instance/workflow/run API (no engine seam).
export {
  recoverOnBoot,
  restartStaleRun,
  cancelStaleRun,
  startRunGuarded,
  beginRunGuarded,
  resetRuntimeGlueForTests,
  DuplicateRunIdError,
  type BegunRun,
  type BootRecoveryReport,
  type UnclassifiedRun,
  type ReattachableSuspendedRun,
  type StaleRunningRun,
  type RecoverOnBootOptions,
  type StartRunGuardedArgs,
} from "./runtimeGlue.js";

// The search_profile_intake skill workflow (the first skill) — one flat
// linear createWorkflow, 8 steps, no nested workflow. The test-only deps seam is
// exported so the offline in-stack tests drive the real suspend/resume chain.
export {
  searchProfileIntakeWorkflow,
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
  __setIntakeDepsForTests,
  __resetIntakeDepsForTests,
  type IntakeWorkflowDeps,
} from "./searchProfileIntake.js";

// The intake skill contracts (emit schemas + resume schemas + prompt builders),
// co-located with the skill (skill-local, single-use; see header rationale).
export {
  IntakePrefillSchema,
  TrimVerifyResultSchema,
  CollectResumeSchema,
  ForceOverrideResumeSchema,
  AmbiguousLocationResumeSchema,
  MalformedRetryResumeSchema,
  buildPrefillPrompt,
  buildTrimVerifyPrompt,
  type IntakePrefill,
  type TrimVerifyResult,
} from "./intakeContracts.js";

// The dealer_geosearch skill workflow (skill #2, first browser skill) — one
// flat linear createWorkflow, 6 steps, zero suspends. Test-only deps seam +
// the app-set per-run browser-emitter factory are exported alongside.
export {
  dealerGeosearchWorkflow,
  DEALER_GEOSEARCH_WORKFLOW_ID,
  setGeosearchBrowserEmitterFactory,
  __setGeosearchDepsForTests,
  __resetGeosearchDepsForTests,
  DealerGeosearchStopError,
  GeosearchAllViewportsFailedError,
  GeosearchExtractSchema,
  buildGeosearchExtractPrompt,
  type GeosearchWorkflowDeps,
  type GeosearchStopCode,
  type GeosearchExtract,
  type ViewportScanArgs,
  type ViewportScanOutcome,
} from "./dealerGeosearch.js";

// The inventory_site_scan skill workflow (skill #3, first browser skill with a
// human suspend) — one flat linear createWorkflow, 6 steps, one batch_review
// suspend. Test-only deps seam + the app-set per-run browser-emitter factory
// are exported alongside, plus the batch_review suspend/resume contracts the
// server descriptor and the UI build against.
export {
  inventorySiteScanWorkflow,
  INVENTORY_SITE_SCAN_WORKFLOW_ID,
  setInventoryScanBrowserEmitterFactory,
  __setInventoryScanDepsForTests,
  __resetInventoryScanDepsForTests,
  InventorySiteScanStopError,
  InventoryScanCaptureLostError,
  BatchReviewSuspendSchema,
  BatchReviewResumeSchema,
  BATCH_REVIEW_QUESTION,
  InventoryExtractSchema,
  buildInventoryExtractPrompt,
  computeScanTargets,
  bucketTargetsByHost,
  scanHostnameOf,
  isDeniedScanHost,
  walkFilterLadder,
  browserWalkSrp,
  collectInventoryCards,
  weaveCardsForExtraction,
  selectVdpCandidates,
  harvestVinFromSnapshot,
  scanDealersParallelImpl,
  SCAN_CONCURRENCY,
  SCAN_SKIP_REASONS,
  FILTERED_RENDER_MIN_CHARS,
  type InventoryScanWorkflowDeps,
  type InventoryScanStopCode,
  type InventoryExtract,
  type BatchReviewSuspend,
  type BatchReviewResume,
  type ScanSkipReason,
  type ProfileDealerRowSlice,
  type ScanTargetRow,
  type SkippedTargetRow,
  type ScanBucket,
  type ScanDealersArgs,
  type DealerCaptureOutcome,
  type BucketRunner,
  type FilterLadderIo,
  type FilterLadderOutcome,
  type FilterRungExit,
  type CollectedCard,
  type SrpWalkIo,
  type SrpWalkResult,
} from "./inventorySiteScan.js";

// The inventory_link_scan skill workflow (skill #4 — the link-driven sibling
// of inventory_site_scan: 8 flat steps, one batch_review suspend on the SAME
// card + resume wire). Test-only deps seam + the app-set per-run
// browser-emitter factory are exported alongside the contracts.
export {
  inventoryLinkScanWorkflow,
  INVENTORY_LINK_SCAN_WORKFLOW_ID,
  setLinkScanBrowserEmitterFactory,
  __setInventoryLinkScanDepsForTests,
  __resetInventoryLinkScanDepsForTests,
  InventoryLinkScanStopError,
  InventoryLinkScanCaptureLostError,
  LINK_SCAN_REVIEW_QUESTION,
  LINK_SCAN_SKIP_REASONS,
  LinkScanReviewSuspendSchema,
  LinkScanReviewResumeSchema,
  LinkScanInputSchema,
  LinkScanOutputSchema,
  bucketLinksByHost,
  captureOneLink,
  captureLinksParallelImpl,
  runLinkBucket,
  type InventoryLinkScanWorkflowDeps,
  type InventoryLinkScanStopCode,
  type LinkScanSkipReason,
  type LinkScanReviewSuspend,
  type LinkScanReviewResume,
  type LinkScanInput,
  type LinkScanOutput,
  type LinkCaptureTarget,
  type LinkScanCaptureArgs,
  type SourceCaptureOutcome,
  type LinkBucket,
  type LinkBucketRunner,
} from "./inventoryLinkScan.js";

// The incentive_scrape skill contracts (skill #5 — typed input/output, the
// OEM first-encounter suspend/resume vocabulary, the incentive_extract emit
// shape + fenced prompt, and the typed STOP / skip / fail vocabularies). The
// workflow itself lands beside them; skill-local, single-use (see header
// rationale in the contracts file).
export {
  IncentiveScrapeInputSchema,
  IncentiveScrapeOutputSchema,
  IncentiveScrapeStopError,
  INCENTIVE_SKIP_REASONS,
  INCENTIVE_FAIL_REASONS,
  OemFirstEncounterSuspendSchema,
  OemFirstEncounterResumeSchema,
  IncentiveExtractSchema,
  buildIncentiveExtractPrompt,
  type IncentiveScrapeInput,
  type IncentiveScrapeOutput,
  type IncentiveScrapeStopCode,
  type IncentiveSkipReason,
  type IncentiveFailReason,
  type OemFirstEncounterSuspend,
  type OemFirstEncounterResume,
  type IncentiveExtract,
} from "./incentiveScrapeContracts.js";

// The incentive_scrape skill workflow (skill #5 — 7 flat steps, ONE
// first-encounter approval suspend before any navigation). Test-only deps
// seam + the app-set per-run browser-emitter factory are exported alongside
// the capture/collector helpers the offline tests pin.
export {
  incentiveScrapeWorkflow,
  INCENTIVE_SCRAPE_WORKFLOW_ID,
  setIncentiveScrapeBrowserEmitterFactory,
  __setIncentiveScrapeDepsForTests,
  __resetIncentiveScrapeDepsForTests,
  collectOfferCards,
  weaveOfferCards,
  rooftopSpecialsUrls,
  runOfferLadder,
  captureOffersImpl,
  OFFER_COLLECT_MAX,
  OFFER_RENDER_MIN_CHARS,
  ROOFTOP_SPECIALS_PATHS,
  type IncentiveScrapeWorkflowDeps,
  type CollectedOfferCard,
  type OfferCaptureArgs,
  type OfferCaptureOutcome,
  type OfferLadderSession,
} from "./incentiveScrape.js";

// The dealer_inbox_check skill workflow (skill #6 — the email-pull skill: 6 flat
// steps, ONE batch_review suspend over discovered dealer-reply groups before any
// write, zero-LLM). Test-only deps seam + the app-set per-run sync emitter
// factory are exported alongside the contracts the server descriptor builds on.
export {
  dealerInboxCheckWorkflow,
  DEALER_INBOX_CHECK_WORKFLOW_ID,
  setDealerInboxCheckEmitterFactory,
  __setDealerInboxCheckDepsForTests,
  __resetDealerInboxCheckDepsForTests,
  type DealerInboxCheckWorkflowDeps,
  type InboxEmitter,
} from "./dealerInboxCheck.js";

// The dealer_inbox_check skill contracts (typed input/output, the batch_review
// suspend payload, the typed STOP vocabulary). Skill-local, single-use (see the
// header rationale in the contracts file). The resume reuses the shared
// BatchReviewResumeSchema already exported above.
export {
  DealerInboxCheckInputSchema,
  DealerInboxCheckOutputSchema,
  DealerInboxCheckStopError,
  InboxReviewSuspendSchema,
  type DealerInboxCheckInput,
  type DealerInboxCheckOutput,
  type DealerInboxCheckStopCode,
  type InboxReviewSuspend,
} from "./dealerInboxCheckContracts.js";

// The dealer_hygiene skill workflow (DESTRUCTIVE — three strictly-ordered
// batch_review suspends 5a/5b/5c with a deferred single-transaction commit;
// decline at any stage = zero writes for the whole run; zero-LLM). Test-only
// deps seam exported alongside the contracts the server descriptor builds on.
export {
  dealerHygieneWorkflow,
  DEALER_HYGIENE_WORKFLOW_ID,
  __setDealerHygieneDepsForTests,
  __resetDealerHygieneDepsForTests,
  type DealerHygieneWorkflowDeps,
} from "./dealerHygiene.js";

// The dealer_hygiene skill contracts (typed input/output, the ONE stage-
// discriminated batch_review suspend payload, the ONE resume vocabulary reused
// per stage). Skill-local, single-use (see the header rationale).
export {
  DealerHygieneInputSchema,
  DealerHygieneOutputSchema,
  HygieneStageReviewSchema,
  HygieneResumeSchema,
  HYGIENE_STAGES,
  type DealerHygieneInput,
  type DealerHygieneOutput,
  type HygieneStage,
  type HygieneStageReview,
  type HygieneResume,
} from "./dealerHygieneContracts.js";

// The dealer_web_lead_submit skill workflow (IRREVERSIBLE-SEND keystone, Phase 5,
// [fake-send] — TWO suspends before any side effect: the batch_review card ① and
// the INDEPENDENT email_fallback re-confirm ②). Test-only deps seam + the per-run
// browser-emitter factory setter exported alongside.
export {
  dealerWebLeadSubmitWorkflow,
  DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID,
  setDealerWebLeadSubmitBrowserEmitterFactory,
  __setDealerWebLeadSubmitDepsForTests,
  __resetDealerWebLeadSubmitDepsForTests,
  type DealerWebLeadSubmitWorkflowDeps,
  // The injectable scout/submit boundary types — the functional-lane host builds
  // deterministic stubs of these (no browser) so the X1 keystone cases drive the
  // REAL workflow + REAL suspend/resume + REAL recordSubmission against a fixture.
  type ScoutOutcome,
  type ScoutFormsArgs,
  type SubmitOneArgs,
  type SubmitVerdict,
} from "./dealerWebLeadSubmit.js";

// The dealer_web_lead_submit contracts (typed input/output + the suspend ②
// approval resume vocabulary the server descriptor imports; the batch_review ①
// resume reuses inventorySiteScan's already-exported BatchReviewResumeSchema).
export {
  DealerWebLeadSubmitInputSchema,
  DealerWebLeadSubmitOutputSchema,
  LeadApprovalResumeSchema,
} from "./dealerWebLeadSubmitContracts.js";

// negotiation_followup (X2) — irreversible-send (fake-send) email follow-up. NO
// browser (email-only), so no browser-emitter setter. The contact-flip ② override
// is registered out-of-band via requestContactFlipForRun (the server descriptor
// threads an approved-thread flip request before the ① batch_review resume).
export {
  negotiationFollowupWorkflow,
  NEGOTIATION_FOLLOWUP_WORKFLOW_ID,
  __setNegotiationFollowupDepsForTests,
  __resetNegotiationFollowupDepsForTests,
  requestContactFlipForRun,
  type NegotiationFollowupWorkflowDeps,
  type ContactFlipRequest,
} from "./negotiationFollowup.js";

// The negotiation_followup contracts (typed input/output + the suspend ②
// contact-flip approval resume vocabulary the server descriptor imports; the
// batch_review ① resume reuses inventorySiteScan's BatchReviewResumeSchema).
export {
  NegotiationFollowupInputSchema,
  NegotiationFollowupOutputSchema,
  ContactFlipApprovalResumeSchema,
} from "./negotiationFollowupContracts.js";

// dealer_closeout_email (X3) — the Phase-5 EXIT skill: near-zero-LLM, state-only
// (close + suppress, never delete). NO browser, NO LLM, so no emitter setter and
// no resume vocabulary beyond the shared BatchReviewResumeSchema.
export {
  dealerCloseoutEmailWorkflow,
  DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID,
  __setDealerCloseoutEmailDepsForTests,
  __resetDealerCloseoutEmailDepsForTests,
  type DealerCloseoutEmailWorkflowDeps,
} from "./dealerCloseoutEmail.js";

// The dealer_closeout_email contracts (typed input/output incl. the
// `skip_all_reset` member; the batch_review resume reuses the shared schema).
export {
  DealerCloseoutEmailInputSchema,
  DealerCloseoutEmailOutputSchema,
} from "./dealerCloseoutEmailContracts.js";

// The registered-workflows map for createMastraInstance({ workflows }) and the
// ids recoverOnBoot scans (the boot caller owns this list — runtimeGlue).
export {
  REGISTERED_WORKFLOWS,
  REGISTERED_WORKFLOW_IDS,
} from "./registeredWorkflows.js";

// The chat-rail Memory thread store (sessions = Mastra Memory threads). The
// ONLY construction of @mastra/memory Memory — apps do session CRUD through the
// product-shaped RailSessionStore facade and never import @mastra/* (dep wall).
// OM is configured rail-only with its model PINNED to DeepSeek via resolveModel
// (never the @mastra default Gemini).
export {
  createRailMemory,
  RailSessionStore,
  RAIL_RESOURCE_ID,
  PIN_METADATA_KEY,
  SCOPE_NOTICE_METADATA_KEY,
  type RailSession,
} from "./railMemory.js";
