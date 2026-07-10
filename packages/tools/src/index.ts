/**
 * @autobroker/tools — Layer 4 public surface.
 *
 * The ONLY layer that touches SQLite or external APIs. In-process
 * tool({execute}) closures for Gmail, browser, DB, plus pure calc/validators,
 * fronted by the L2 in-process gate (the single side-effect path).
 *
 * Dependency wall: tools may import core and db — never workflows or app.
 */

// L2 in-process approval gate bridge — the single side-effect path.
export {
  requestApproval,
  withGate,
  ExternalMutationsBlockedError,
  MalformedGateRequestError,
  type MutationKind,
  type GateRequest,
  type GateVerdict,
  type Approver,
} from "./gate/index.js";

// App mode (AUTOBROKER_MODE: "buyer"|"test") + the fail-closed harness tripwire.
export {
  resolveMode,
  isBuyerMode,
  isTestMode,
  isHarnessContext,
  forceTestMode,
  assertTestModeSafe,
  ModeViolationError,
  type AppMode,
} from "./realSend.js";

// Gmail (fake/real send seam, default fake).
export {
  GmailTool,
  buildRaw,
  redactBudget,
  createGmailAdapter,
  GmailBackendRefusedError,
  __setGmailAdapterForTests,
  __resetGmailAdapterForTests,
  type SendMode,
  type GmailBackend,
  type OutboundEmail,
  type SendResult,
} from "./gmail.js";

// Gmail adapter contract — the interface + canonical domain types every backend
// and every consumer (send seam, sync, extractor, health probe) speaks.
export type {
  GmailAdapter,
  Message,
  MessageDirection,
  Thread,
  ThreadRef,
  AttachmentRef,
  AttachmentData,
  HistoryRecord,
  HistoryPage,
  HealthResult,
} from "./gmail/types.js";

// Concrete adapters — the factory selects one, but the symbols are exported for
// tests and direct construction. (FakeGmailAdapter's ctor opens the shared DB,
// so construct it only at call time, never at module scope.)
export {
  RealGmailAdapter,
  createRealGmailAdapter,
  type GmailApiClient,
} from "./gmail/adapter.js";
export { FakeGmailAdapter } from "./gmail/fakeAdapter.js";

// Sync engine — the per-mailbox watermark store + window predicate + the
// incremental history sync (the email-pull skill drives syncMailbox).
export {
  syncMailbox,
  computeWindow,
  historyWatermarkKey,
  readHistoryWatermark,
  writeHistoryWatermark,
  type SyncResult,
  type SyncOptions,
  type SyncFallbackSpan,
} from "./gmail/sync.js";

// Authoritative inbox sweep lane — serializes + single-flight coalesces the
// shared mailbox-cursor advance so N concurrent per-profile inbox checks
// advance it ONCE and each sees the full changed set (no leapfrog drop).
// `sweepMailbox` is the lane-wrapped drop-in for the raw `syncMailbox`.
export { authoritativeSweep, sweepMailbox, type SyncFn } from "./inbox/sweepLane.js";

// MIME walk — the inbound payload-tree reader (the parsed-body shape the
// per-message extractor reuses).
export { walkParts, readPartHeader, type ParsedBody } from "./gmail/mime.js";

// Attachment text extraction — the classify + extract path (pdfjs text layer,
// OCR for images) and its injection seams + typed fallback spans.
export {
  extractAttachmentText,
  classifyAttachment,
  type AttachmentClass,
  type AttachmentTextResult,
  type AttachmentFallbackSpan,
  type ExtractOptions,
  type PdfTextExtractor,
  type ImageOcrRunner,
} from "./gmail/attachmentText.js";
export {
  runImageOcr,
  type OcrResult,
  type OcrFallbackSpan,
  type OcrRunner,
  type OcrOptions,
} from "./gmail/ocr.js";

// Gmail OAuth — the loopback consent flow + token/client store helpers (the
// connect route and the reconsent CLI delegate down here; no consumer re-rolls
// the flow).
export {
  runConsentFlow,
  loadAuthorizedClient,
  loadTokenRecord,
  loadClient,
  persistTokenRecord,
  gmailDataDir,
  tokenPath,
  clientPath,
  GMAIL_SCOPES,
  type TokenRecord,
  type InstalledClient,
} from "./gmail/auth.js";

// Browser service (Playwright-native, ephemeral context per run; the ONE
// mutating face routes through the gate, read faces are ungated).
export {
  withBrowserContext,
  assertIsolated,
  computeBackoffMs,
  politenessDelayMs,
  parseRobotsDisallow,
  capSnapshot,
  rowsComplete,
  openedOnce,
  NULL_EMITTER,
  // Browser-acquire (install the Playwright browser on demand before the first
  // launch; present → no-op fast path). Seam exported for test injection.
  ensureBrowserAcquired,
  __setBrowserAcquireDepsForTests,
  __resetBrowserAcquireDepsForTests,
  type BrowserAcquireDeps,
  type AcquireProgress,
  SNAPSHOT_CAP_CHARS,
  POLITENESS_JITTER_MS,
  BrowserIsolationError,
  gatedSubmitForm,
  // Filter face (read-side refinement verbs + their fences; never gated,
  // never holds an Approver).
  FILTER_DENYLIST_RE,
  FILTER_APPLY_TEXT_RE,
  FilterInteractionRefusedError,
  probeFilterTarget,
  assertFilterTargetAllowed,
  runFilterVerb,
  // Location-ZIP face (read-side localizer; never gated, never holds an
  // Approver; ZIP-digits-only value constraint).
  ZIP_VALUE_RE,
  ZIP_FIELD_RE,
  LocationZipRefusedError,
  probeZipTarget,
  assertZipTargetAllowed,
  assertZipValue,
  runLocationZip,
  type ZipTargetProbe,
  type ZipControlPage,
  type ZipFillOptions,
  type FilterVerb,
  type FilterDomElement,
  type FilterDomDocument,
  type FilterTargetProbe,
  type FilterControlPage,
  type FormPage,
  type BrowserEmitter,
  type BrowserContextOptions,
  type BrowserSession,
  type ExtractFallbackResult,
  type DealerLeadForm,
} from "./browser.js";

// Anti-bot block-page signature classifier (first 8 KB scan; blocked captures
// are discarded and surfaced, never escalated).
export { classifyBlockSignature } from "./blockSignature.js";

// US-dealer gate — hard filter lives in code, not in any prompt.
export { isUsDealer, type IsUsDealerOptions } from "./geo.js";

// Pure dealer-contact role parser — canonical job title from a signature tail.
export { parseContactRole } from "./inbox/contactRole.js";

// dealer_geosearch deterministic core — viewport math + candidate filter
// chain (pure), the Maps feed extractor (page-side) with its snapshot-fallback
// decision, and the single dealers/profile_dealers write path (US gate inlined).
export {
  EARTH_RADIUS_MILES,
  haversineMiles,
  zoomForRadius,
  buildMapsSearchUrl,
  tileViewports,
  dealerId,
  dedupByPlaceId,
  rejectNonCandidate,
  isOffBrand,
  normalizeWebsiteHost,
  dedupRooftops,
  annotateDistance,
  rankByDistance,
  type Viewport,
  type CandidateFilterResult,
  type RankedDealerCandidate,
} from "./geosearch/pure.js";
export {
  mapsExtractor,
  needsFallback,
  MAPS_EXTRACT_REQUIRED_FIELDS,
  type MapsDomDocument,
  type MapsDomElement,
} from "./geosearch/mapsExtractor.js";
export {
  upsertDealers,
  upsertDealerContactEmail,
  type UpsertDealersResult,
} from "./geosearch/upsertDealers.js";

// Outbound-URL SSRF validator (9 ordered rules, fail-closed).
export {
  validateSourceUrl,
  isPrivateIp,
  SourceUrlValidationError,
  type ValidateSourceUrlOptions,
} from "./ssrf.js";

// Dealer-platform inventory scout (fingerprint table + fresh-200 SRP probe).
export {
  fingerprintPlatform,
  resolveSrp,
  type DealerPlatform,
  type ScoutOptions,
} from "./inventoryScout.js";

// inventory_site_scan deterministic core — pure helpers (byte-identical id
// hashes + normalizers, match classifier, VIN provenance guard, batched US
// gate), the filter pre-screen data (rung-i URL templates + rung-ii selector
// map), and the capture-then-serial persist writer.
export {
  urlNormalize,
  normalizeListingUrl,
  computeSourceId,
  computeListingId,
  classifyMatchStatus,
  validateVinProvenance,
  isUsDealerBatch,
  truncateRawJson,
  MATCH_STATUSES,
  RAW_LISTING_JSON_CAP_BYTES,
  type MatchStatus,
} from "./inventory/pure.js";
export {
  buildFilteredSrpUrl,
  FILTER_SELECTOR_MAP,
  type FilterProfileSlice,
  type PlatformFilterSelectors,
} from "./inventory/filter.js";
export {
  persistScanResults,
  supersedeStale,
  type ClassifiedListingRow,
  type DealerScanOutcome,
  type PersistRunResult,
  type ScanStatus,
  type SupersedeReason,
} from "./inventory/persist.js";
export {
  resolveOrMintDealer,
  selectExistingVinOwners,
  capTopListings,
  collapseSameVinAcrossDealers,
  type ResolveOrMintDealerArgs,
  type ResolveOrMintDealerResult,
  type CapListingCandidate,
  type VinCollapseCandidate,
} from "./inventory/aggregatorPersist.js";
export {
  AGGREGATOR_ADAPTERS,
  buildCarsComUrl,
  buildEdmundsUrl,
  buildVisorUrl,
  slugifyCarsComModel,
  type AggregatorAdapter,
  type AggregatorCollected,
  type AggregatorCollectedCards,
  type AggregatorCollectedRows,
  type AggregatorFilterSlice,
} from "./inventory/aggregatorAdapters.js";
export {
  VisorRowSchema,
  mapVisorStructuredRows,
  type VisorMapResult,
  type VisorProfileCoords,
} from "./inventory/visorMap.js";
export {
  readInventoryChangesSince,
  emitInventoryPriceChange,
  INVENTORY_PRICE_CHANGE_ACTION,
  type InventoryPriceChange,
} from "./inventory/auditWriter.js";
export {
  classifyTrimAvailability,
  normalizeTrim,
  trimSubsetMatch,
  resegmentModelTrim,
  type TrimAvailability,
} from "./inventory/trimMatch.js";
export {
  classifyColorAvailability,
  normalizeColor,
  colorTokenMatch,
  type ColorAvailability,
} from "./inventory/colorMatch.js";
export {
  harvestBreakdownFromSnapshot,
  type HarvestedBreakdown,
} from "./inventory/inventoryBreakdownHarvest.js";

// inventory_link_scan deterministic core — the junk-link pre-filter (5 closed
// rules, single source of truth), the profile accept/reject policy, and the
// pending-source loader + seeder (frozen parity ids).
export {
  classifySkipUrl,
  filterForProfile,
  SKIP_URL_REASONS,
  PROFILE_FILTER_REJECT_REASONS,
  type SkipUrlReason,
  type ProfileFilterRejectReason,
  type ProfileFilterResult,
} from "./inventory/linkScanPure.js";
export {
  listPendingSources,
  seedInventorySource,
  type PendingSourceRow,
  type SeedInventorySourceOptions,
} from "./inventory/sources.js";

// inventory_compare deterministic core — the pure weighted ranker (four axes,
// hard pre-filters), the live-listings read helper (joined to dealers for the
// distance axis), and the profile-scoped ranking glue that maps ranked rows to
// the flat candidate the read panel + workflow surface. Zero-LLM, read-only:
// match_status / score are transient (no match_score column is ever written).
export {
  TRIM_WEIGHT,
  PRICE_WEIGHT,
  COLOR_WEIGHT,
  DISTANCE_WEIGHT,
  scoreListing,
  applyFilters,
  rankListings,
  selectTopListingsForDealer,
  type ProfileMatchCtx,
  type RankedRow,
} from "./inventory/inventory_rank.js";
export {
  listListingsForProfile,
  readListingRowById,
  type ProfileListingsRead,
} from "./inventory/read.js";
export {
  rankInventoryForProfile,
  type RankedCandidate,
  type RankInventoryResult,
} from "./inventory/compute.js";
export {
  PER_DEALER_RECORD_CAP_DEFAULT,
  PER_DEALER_RECORD_CAP_MIN,
  PER_DEALER_RECORD_CAP_MAX,
  resolvePerDealerRecordCap,
} from "./inventory/recordCap.js";

// Fake-mailbox corpus seeder — the inbound deterministic row builder (the
// adapter only writes outbound, so this stages the dealer-reply corpus the read
// paths + sync consume). Tools owns the DB write; the harness fixture calls down.
export {
  seedFakeMailbox,
  type FakeMailboxSeedThread,
  type FakeMailboxSeedMessage,
  type FakeMailboxSeedAttachment,
  type SeedFakeMailboxResult,
} from "./gmail/fakeSeed.js";

// Fake-mailbox-send-only preflight — the fail-CLOSED 2-AND matrix the
// irreversible-send skills run before any send (fake adapter instance + backend
// self-declares 'fake'); ANY false aborts the send.
export {
  assertFakeMailboxSendOnly,
  FakeMailboxPreflightError,
  type FakeMailboxPreflightDeps,
} from "./gmail/sendPreflight.js";

// Read-probe helpers — the structurally send-blocked facade + the fail-closed
// pre-flight envelope guard for buyer-mode read-only diagnostics. The facade's
// send() always throws; the envelope guard refuses harness/test/CI contexts and
// the production data dir before any read proceeds.
export {
  assertReadProbeEnvelope,
  ReadOnlyGmailAdapter,
} from "./gmail/readProbe.js";

// Outbound send+record writer — the single skill-facing draft-then-promote
// send path (test-mode brake → draft row → send [real in buyer mode, fake in
// test mode] → promote, all inside one
// gated commit). Three discriminated outcomes (sent/declined/partial).
export {
  sendAndRecord,
  promoteOutbound,
  ThreadFlagMismatchError,
  type SendRecordTarget,
  type SendRecordDeps,
  type SendRecordOutcome,
  type PartialSendResult,
} from "./gmail/sendRecord.js";

// Lead-submission XOR writer — the INSERT-only typed-union writer over the three
// legal `ck_lead_submissions_xor` shapes (web_form | email+fallback | failed) +
// the duplicate-skip / force-retry precondition guard.
export {
  recordSubmission,
  checkSubmissionPrecondition,
  ForceRetryRefusedError,
  type SubmissionOutcome,
  type SubmissionPrecondition,
  type EmailFallbackReason,
  type FailReason,
} from "./leadSubmissions/recordSubmission.js";

// Dealership-exclusivity claim seam — bind a dealer to AT MOST one profile
// (partial-unique index uq_profile_dealers_bound_dealer WHERE status='bound'),
// returning a typed claimed|conflict verdict (NEVER budget in the holder label,
// inv #9), plus the bound→closed_out release path (closeout/purge/reset).
export {
  claimDealer,
  releaseDealerClaims,
  type ClaimResult,
} from "./leadSubmissions/claimDealer.js";

// dealer_web_lead_submit deterministic scout — the lead-form platform
// fingerprint + contact-path probe set, the dealer-facing payload assembler
// (fake phone LOCKED, budget redacted, consent CHECKED, SMS opt-in OMITTED),
// and the US-only HARD GATE partition (non-US filtered before the banner). Pure:
// the gated submit / email fallback / record writes all live downstream.
export {
  platformOf,
  contactPathFor,
  buildLeadPayload,
  partitionUsDealers,
  CONTACT_PATHS,
  type LeadPlatform,
  type LeadFieldRole,
  type FormFieldRole,
  type LeadPayloadProfile,
  type ScoutDealerRow,
} from "./leadSubmit/scout.js";

// dealerComm — shared dealer-facing message builders + deterministic
// classification helpers (pure: constants/templates, submit-outcome state
// machine, closeout draft, reply-target ladder, quote-situation tone).
export {
  FAKE_PHONE_DEFAULT,
  MAX_RETRIES,
  ASSERTIVE_OTD_DELTA_USD,
  BATCH_SILENCE_WINDOW_DAYS,
  SUBJECT_PREFIX_FIRST_TOUCH,
  SUBJECT_PREFIX_FOLLOWUP,
  FOOTER_DISCLAIMER,
  wrapUntrustedDealerInput,
} from "./dealerComm/constants.js";
export {
  safeBodyTemplate,
  safeSubjectLine,
  subjectForFollowup,
  type MessageProfile,
} from "./dealerComm/messageTemplates.js";
export {
  classifySubmitOutcome,
  hasCaptcha,
  retryStrategy,
  normalizeFormFieldName,
  requiredFieldSet,
  type SubmitOutcome,
  type RetryAction,
  type FormFieldSpec,
} from "./dealerComm/submitOutcome.js";
export {
  buildCloseoutDraft,
  closeoutGreetingName,
  type CloseoutProfile,
  type CloseoutDealer,
} from "./dealerComm/closeoutDraft.js";
export {
  selectNextReplyTargets,
  gateDecisionForTarget,
  followupCapDecision,
  MAX_UNANSWERED_FOLLOWUPS,
  MAX_TOTAL_FOLLOWUPS,
  resolveReplyTarget,
  buildDraftContext,
  reuseThreadIdForReply,
  type ReplyCandidateThread,
  type GateDecision,
  type FollowupCapDecision,
  type ReplyTargetSource,
  type ReplyTarget,
  type ContactRow,
  type InboundMessageRow,
  type LeadSubmissionRow,
  type DealerRow,
  type ReplyTargetInputs,
  type ThreadMessageRow,
  type ThreadSnapshotInput,
  type DraftContextMessage,
  type DraftContext,
} from "./dealerComm/replyTargets.js";
export {
  classifyQuoteSituation,
  type QuoteTone,
  type QuoteSituation,
} from "./dealerComm/quoteSituation.js";
export {
  dealerGiveUpDecision,
  type DealerVerdict,
  type GiveUpReason,
  type GiveUpInput,
  type GiveUpDecision,
} from "./dealerComm/giveUp.js";
export {
  deriveNegotiationStatus,
  type NegotiationStatus,
  type NegotiationStatusInput,
} from "./dealerComm/negotiationStatus.js";
export {
  composeStatusLine,
  composeNegotiationStrategy,
  composeNextSteps,
  type StatusLineInput,
  type NegotiationStrategyInput,
  type NextStepsInput,
} from "./dealerComm/negotiationAdvice.js";

// negotiation_followup (X2) — the single-transaction contact-flip writer + the
// per-profile follow-up reads (open-quote OTD situation, needs-response thread
// candidates, the reply-thread snapshot, and the 4-level reply-target inputs).
export { setPrimaryReplyTarget } from "./dealerComm/contactFlip.js";
export {
  readDealerGiveUpInputs,
  readDealerContacts,
  listFollowupCandidateThreads,
  readThreadSnapshotForDraft,
  readReplyTargetInputs,
  type DealerGiveUpInputsRead,
  type DealerContactRead,
  type FollowupCandidateThread,
  type ThreadSnapshotRead,
  type ReplyTargetInputsRead,
} from "./inbox/followupReads.js";
export { setThreadState } from "./inbox/threadWrites.js";
export {
  listProfileDealerVerdicts,
  listProfileDealerRowsWithVerdicts,
  type DealerVerdictRow,
} from "./inbox/giveUpProjection.js";
export {
  listProfileThreadStatuses,
  listProfileThreadRowsWithStatus,
  type ThreadStatusRow,
} from "./inbox/negotiationStatusProjection.js";
export {
  listProfileDealerNegotiations,
  readDealerNegotiationDetail,
  readDealerSubstantiveReplyBodies,
  NEGOTIATION_STATUS_RANK,
  type DealerNegotiationRow,
  type DealerNegotiationDetail,
  type NegotiationReplyRow,
  type NegotiationContactRow,
} from "./inbox/negotiationProjection.js";

// dealer_closeout_email (X3) — the closeout target assembler (open threads minus
// closeout-suppressed dealers, 4-level address ladder, idempotent one-per-dealer)
// + the atomic per-dealer send+close+suppress tool (gated send is fake in test
// mode via the AUTOBROKER_MODE=test brake, real in buyer mode; the close +
// thread_suppression commit locally in one transaction).
export {
  assembleCloseoutTargets,
  closeAndSuppressDealer,
  type CloseoutTarget,
  type AssembleResult,
  type CloseoutDealerOutcome,
  type CloseAndSuppressArgs,
} from "./closeout/sendCloseSuppress.js";

// dealer_inbox_check deterministic core — the pure 4-pass discovery query
// builder + dealer-token sweep + first-pass-wins thread dedupe + the
// deterministic quoted/replied classifier, the CRM-relay sender detector, the
// profile-scoped routing ladder, the ONE atomic ingest-or-suppress write
// (search_profile_id NON-NULL — the orphan-row fix), the per-profile sweep
// watermark, and the profile-scoped threads/messages read projections.
export {
  buildInboxQueries,
  dealerTokens,
  dedupeThreadHits,
  classifyThread,
  hostStem,
  CONTACT_BATCH_SIZE,
  DEALER_TOKEN_BATCH_SIZE,
  type BuildInboxQueriesArgs,
  type ThreadHit,
  type ThreadClassification,
  type ClassifyMessage,
} from "./inbox/discovery.js";
export {
  detectCrmPlatformSender,
  CRM_PLATFORM_HOSTS,
} from "./inbox/crm.js";
export {
  isNonSubstantiveReply,
  type ReplyFilterRow,
} from "./inbox/replyFilter.js";
export {
  routeThread,
  lookupDealerBySender,
  type RouteResult,
  type UnroutedReason,
} from "./inbox/routing.js";
export {
  applyInboxBatch,
  type ApplyInboxBatchArgs,
  type ApplyInboxBatchResult,
  type ThreadDecision,
  type InboxMessageInput,
} from "./inbox/applyBatch.js";
export {
  readLastInboxCheckAt,
  writeLastInboxCheckAt,
  lastInboxCheckKey,
} from "./inbox/watermark.js";
export {
  listProfileThreadRows,
  listProfileQuoteRows,
  listProfileIncentiveRows,
  listProfileContactEmails,
  listProfileDealerDomains,
  readFirstLeadSubmitAtMs,
  listSuppressedGmailThreadIds,
  listIngestedGmailMessageIds,
} from "./inbox/reads.js";
export {
  readQuoteSourceDoc,
  type ReadQuoteSourceDocArgs,
  type ReadQuoteSourceDocOpts,
  type QuoteSourceDoc,
} from "./inbox/quoteSourceDoc.js";

// dealer_reply_extract deterministic core — the pure per-message quote-class +
// price/intent/body-parse classifiers, the attachment fallback tree over the
// adapter + the attachment-text seam, and the all-or-nothing per-message upsert
// + mark-processed state machine (quote_id preserved on re-extract).
export {
  classifyMessageQuoteClass,
  normalizeOtdPrice,
  classifyIntent,
  parseQuoteFromBody,
  type MessageQuoteClass,
  type ClassifyMessageInput,
  type BodyIntent,
  type ParsedBodyQuote,
} from "./replyExtract/classify.js";
export {
  prepareAttachments,
  type AttachmentOutcome,
  type AttachmentFailureReason,
  type AttachmentExtractionMethod,
  type PrepareAttachmentsResult,
  type PrepareAttachmentsOptions,
} from "./replyExtract/attachments.js";
export {
  persistMessageQuotes,
  markMessageFailed,
  type MessageProvenance,
  type PersistMessageResult,
} from "./replyExtract/persist.js";
export {
  loadReplyExtractCandidates,
  type ReplyExtractCandidate,
} from "./replyExtract/candidates.js";

// dealer_hygiene deterministic core — the three GLOBAL detection queries +
// idempotent suppression pre-filter, the KEEP-biased intent classifier, the
// staged soft-delete writers with throwing typed guards (the orphan hard-delete
// red-line honored), and the single all-or-nothing commit (a guard throw rolls
// back the whole run). Zero-LLM, zero side effects beyond the local product DB.
export {
  findOrphanThreads,
  findCrmOnlyThreads,
  findCrmPlatformContacts,
  listSuppressions,
  type HygieneScopeTrace,
  type OrphanThreadCandidate,
  type CrmThreadCandidate,
  type CrmContactCandidate,
} from "./hygiene/detect.js";
export {
  SUPPRESSIBLE_INTENTS,
  VALUE_INTENTS,
  isSuppressibleIntent,
  isValueIntent,
} from "./hygiene/classify.js";
export {
  deleteOrphanThread,
  suppressThread,
  suppressContact,
  demoteCrmContact,
  HygieneRejectedError,
} from "./hygiene/writes.js";
export {
  commitHygiene,
  HygieneAssertionError,
  type StagedOrphan,
  type CommitHygieneArgs,
  type CommitHygieneResult,
} from "./hygiene/verify.js";

// incentive_scrape deterministic core — the code-level host rejection table,
// the 7-day cache gate, the cash whitelist, program-identity merge +
// dual-source cross-verify, the {zip}/{model} template fill, the per-brand
// seed candidates, the data-dir file registry (the cross-run first-encounter
// approval memory), and the DELETE-then-INSERT slice writer.
export {
  classifyOemHost,
  cacheGateDecision,
  filterCashTypes,
  mergeScrapeResults,
  crossVerifyIncentives,
  substituteOemUrlTemplate,
  isLikelyUsZip,
  normalizeIncentiveBrand,
  CASH_INCENTIVE_TYPES,
  INCENTIVE_CACHE_TTL_DAYS,
  OEM_SEED_SOURCES,
  type OemHostVerdict,
  type OemHostRejectReason,
  type IncentiveCacheState,
  type ScrapedIncentiveRow,
  type SourceDiscrepancy,
  type CrossVerifyResult,
} from "./incentives/pure.js";
export {
  incentiveRegistryPath,
  readIncentiveRegistry,
  writeIncentiveRegistryEntry,
  parseIncentiveRegistry,
  serializeIncentiveRegistry,
} from "./incentives/registry.js";
export {
  persistIncentives,
  readIncentiveCacheState,
  type PersistIncentivesArgs,
} from "./incentives/persist.js";

// daily_digest deterministic core — the zero-LLM read aggregation + render +
// file-artifact writer + the per-profile digest watermark + the live page
// projection. No LLM, no budget figures, no external mutation.
export {
  bucketFreshness,
  FRESH_WINDOW_MS,
  STALE_WINDOW_MS,
  generateDigest,
  NO_ACTIVE_SEARCHES,
  DEFAULT_OFFERS_LIMIT,
  renderDigestText,
  digestHeadline,
  NO_ACTIVE_SEARCHES_TEXT,
  writeDigestArtifact,
  buildDigestView,
  lastDigestAtKey,
  readLastDigestAt,
  writeLastDigestAt,
  type FreshnessBucket,
  type DigestPayload,
  type DigestProfileGroup,
  type DigestOffer,
  type FreshnessMix,
  type NextAction,
  type GenerateDigestArgs,
  type WriteDigestArtifactArgs,
  type DigestView,
  type DigestViewProfile,
  type DigestViewQuoteRow,
  type BuildDigestViewArgs,
} from "./digest/index.js";

// DB (single connection factory + shared-connection accessor, re-exported
// from @autobroker/db).
export { openDb, getDb, closeDb, resolveDataDir, type Db } from "./db.js";

// LimiterRegistry — process-global resource arbiters (Gmail send / per-host
// politeness / per-provider LLM) that PACE already-approved work, strictly
// BELOW the L2 gate. The singletons (gmailLimiter / hostLimiter / llmLimiter)
// plus the classes + pacing primitives for callers that construct their own.
export * from "./limiter/index.js";

// Scheduler watermark — the per-job last-success store in pipeline_state (the
// durable catch-up watermark; the only product-DB access the background
// scheduler is permitted, funnelled down here per the SQLite invariant).
export {
  watermarkKey,
  scheduledJobClaimKey,
  readLastSuccess,
  writeLastSuccess,
  tryClaimScheduledJob,
  releaseScheduledJobClaim,
  type ScheduledJobClaim,
} from "./scheduler/watermark.js";

// Demo seed — the renderable sample world for the zero-config demo mode
// (idempotent, writes whatever isolated handle it is given).
export { seedDemoData } from "./demo/seedDemo.js";

// test_run_records ledger writer — the ONE write path (NULL-not-$0 enforced).
export {
  writeTestRunRecord,
  SilentZeroCostError,
  type TestRunRecordInsert,
} from "./testRunRecords.js";

// Pure offer math — the deterministic OTD recompute (selling + Σfees + tax vs
// stated, $1 tolerance) + the per-state doc-fee cap table. quote_audit's
// MATH_SANITY / DOC_FEE_CAP checks consume both.
export {
  validateOfferMath,
  OFFER_MATH_TOLERANCE_USD,
  STATE_DOC_FEE_CAP,
  DOC_FEE_HIGH_REFERENCE_USD,
  type OfferMathInput,
  type MathCheck,
  type MathStatus,
  type FeeItem,
} from "./calc.js";

// quote_audit deterministic core — the pure 10-check audit (each firing check
// emits a stable-code AuditFinding; severity derived from the code by the
// surfacing classifier), the float-dollar read helpers feeding it (the recent /
// peer / incentive-slice projections), and the idempotent audit-row writer
// (UPSERT on (dealer_quote_id, audit_pass_version)). Zero-LLM; the only writes
// are quote_audits rows.
export {
  auditQuote,
  classifyAuditSeverity,
  normalizeAddOnCode,
  medianOrNone,
  sumNamedAmounts,
  peerFinanceAprs,
  peerLeaseMfs,
  peerDealerPlusOther,
  profileEligibilityKinds,
  type NamedAmount,
  type AuditQuote,
  type AuditPeer,
  type AuditIncentive,
  type AuditProfile,
} from "./quotes/audit.js";
export {
  listQuotesForProfile,
  getQuote,
  readDealerDisplayName,
  listPeerQuotes,
  listIncentivesSlice,
  DEFAULT_AUDIT_PASS_VERSION,
  type AuditQuoteWithId,
  type ListQuotesOpts,
} from "./quotes/quotesRead.js";
export {
  upsertAudit,
  type UpsertAuditArgs,
  type UpsertAuditOutcome,
} from "./quotes/auditPersist.js";
export { flagCodesFromJson, flagSuggestionsFromJson } from "./quotes/flags.js";
export {
  rankQuotesForProfile,
  type QuoteRanking,
  type OtdAttributionRow,
  type CompareResult,
} from "./quotes/compare.js";
// Pure cross-state OTD math — home-state tax normalization (sales/use tax follows
// the buyer's registration state) + OTD-delta attribution. quote_compare consumes
// both; exported for reuse + direct unit cover.
export {
  STATE_SALES_TAX_RATE,
  homeStateTaxRate,
  normalizeQuoteTax,
  attributeOtdDelta,
  type TaxNormalizationInput,
  type TaxNormalization,
  type OtdComponents,
  type OtdAttribution,
} from "./quotes/crossState.js";

// Pure validators (safety rules).
export {
  assertNoBudget,
  assertPaymentMethodConsistent,
  assertUnicodeSafe,
  BudgetLeakError,
  PaymentMethodMismatchError,
  UnicodeUnsafeError,
  type ValidationResult,
} from "./validators.js";

// Settings — the centralized at-rest store + "test before save" probe for the
// four user-supplied API keys (the only code that reads/writes the keys file or
// mutates a provider env var). Routes delegate down into this surface.
export {
  loadSecretsIntoEnv,
  loadDotEnvKeys,
  getKeyPresence,
  setKey,
  clearKey,
  testKey,
  __setSecretsProbeForTests,
  __resetSecretsProbeForTests,
  UnknownSecretKeyError,
  SECRET_KEY_IDS,
  type SecretKeyId,
  type KeyPresence,
  type KeyPresenceMap,
  type KeyProbeResult,
  type SecretsProbeDeps,
} from "./settings/index.js";

// Settings/env — the curated NON-SECRET operational env vars (the four editable
// app_mode / gmail_account / chrome_headless / per_dealer_record_cap rows +
// read-only path/status rows).
// The boot loader seeds saved overrides into process.env; routes delegate down
// here and never read/write the env file directly.
export {
  getEnvConfig,
  setEnvConfig,
  loadEnvConfigIntoEnv,
  ENV_DESCRIPTORS,
  EDITABLE_IDS,
  UnknownEnvVarError,
  NonEditableEnvVarError,
  InvalidEnvValueError,
  type EnvVarId,
  type EnvVarClass,
  type EnvVarDescriptor,
  type EnvVarState,
} from "./settings/index.js";

// goplaces — the ONLY external API in intake (read-only Google Geocoding).
export {
  resolveLocation,
  MAX_AMBIGUOUS_CANDIDATES,
  type GeoLocation,
  type GoplacesResult,
  type GoplacesFailureReason,
  type GoplacesTraceSpan,
  type GoplacesOptions,
  type FetchLike,
} from "./profile/goplaces.js";

// trimSources — read-only web lookup of a make/model/year's trim lineup, the
// grounding source for the intake trim-suggestion step (allowlisted hosts only).
export {
  fetchTrimSources,
  type TrimSourcesInput,
  type TrimSourcesOptions,
  type TrimSourcesResult,
} from "./trim/trimSources.js";

// Profile service — the ONLY write path for search_profiles + audit_log,
// the typed three-branch resolver, fake-phone, and the core↔db adapter.
export {
  rowToProfile,
  profileToRow,
  validate,
  create,
  update,
  replace,
  close,
  restore,
  purge,
  parseLocation,
  synthProfileId,
  readProfileRow,
  closeProfileStatusPlain,
  listProfileRows,
  listProfileDealerRows,
  resolveActiveProfile,
  makeFakePhone,
  resolveStoredPhone,
  writeAuditLog,
  AUDIT_ACTIONS,
  ActiveSlotConflict,
  IdentityLockedError,
  IDENTITY_FIELDS,
  CoordinatesNotResolvedError,
  MissingRequiredFieldError,
  type SearchProfileRow,
  type ValidateResult,
  type ParsedLocation,
  type ResolvedCoordinates,
  type CreateOpts,
  type CreateResult,
  type PurgeResult,
  type ResolveResult,
  type ResolverTrace,
  type Rng,
  type AuditAction,
  type AuditEntry,
} from "./profile/index.js";

// pipeline_reset (DESTRUCTIVE) — the typed-YES validator, the VACUUM INTO
// backup, the atomic migrate-based recreate (+ accounts re-seed), the mastra.db
// workflow-runtime clear (Memory chat threads preserved), the manifest schema
// verify, the prod-DB-reject guard, and the boot-delegated ensureProductSchema.
// Every destructive path refuses to run outside an isolated AUTOBROKER_DATA_DIR.
export {
  validateResetToken,
  RESET_CONFIRM_TOKEN,
  backupProductDb,
  BACKUPS_TO_KEEP,
  type BackupProductDbArgs,
  pipelineReset,
  DEFAULT_ACCOUNT_EMAIL,
  type PipelineResetArgs,
  type PipelineResetResult,
  verifySchema,
  type VerifySchemaResult,
  type VerifySchemaOptions,
  clearWorkflowRuntimeState,
  WORKFLOW_RUNTIME_TABLE,
  type ClearWorkflowRuntimeResult,
  assertIsolatedDataDir,
  isProductionDataDir,
  PipelineResetRefusedError,
  resolveProductDbPath,
  resolveMastraDbPath,
  ensureProductSchema,
  migrate as migrateProductDb,
  productTableNames,
} from "./pipelineReset/index.js";

// quote_pipeline deterministic core (BUILD-AHEAD) — the child-independent
// orchestrator tools the keystone composes once E2/D2/D3 land: re-derive the 4
// applicable-step flags each run (non-durable, no checkpoint), the read-only
// targeted-VIN validator, the null-VIN-raising OTD ask, the idempotent
// targeted-VIN quote writer, the deterministic LLM-free disposition, and the one
// generic audit_log completion row. No child workflow / LLM here. Also the
// multi-profile orchestration primitives: the ProfileId→live-runId activation
// registry (virtual-actor at-most-one-live-run + reboot-survival reconcile) and
// the boot orphan sweep that frees dealership claims abandoned by a dead run.
export {
  detectPipelineState,
  resolveTargetedListing,
  TargetedListingNotFound,
  NoInboundThread,
  buildOtdInjection,
  MissingVinError,
  recordQuoteFromListing,
  MessageNotFoundError,
  MissingMessageIdError,
  computeFinalState,
  computeNextAction,
  writePipelineCompletion,
  PIPELINE_STEPS,
  FINAL_STATES,
  PIPELINE_COMPLETE_ACTION,
  COLD_DORMANCY_DAYS,
  lastProgressKey,
  readLastProgressAt,
  writeLastProgressAt,
  profileHealth,
  activeRunKey,
  tryClaimActivation,
  recordActivation,
  clearActivationByRunId,
  lookupRunIdForProfile,
  lookupProfileIdForRunId,
  listActiveProfileIds,
  reconcileActivations,
  ActivationClaimConflictError,
  sweepOrphanedBoundClaims,
  type DetectPipelineStateArgs,
  type PipelineStateFlags,
  type ResolveTargetedListingArgs,
  type ResolveTargetedListingResult,
  type TargetedListing,
  type TargetedInboundThread,
  type BuildOtdInjectionArgs,
  type RecordQuoteFromListingArgs,
  type RecordQuoteFromListingResult,
  type PipelineStep,
  type FinalState,
  type WritePipelineCompletionArgs,
  type WritePipelineCompletionResult,
  type ProfileHealth,
  type ProfileHealthLevel,
  type ProfileHealthOpts,
  type ActivationClaimResult,
  type OrphanSweepResult,
} from "./pipeline/index.js";
