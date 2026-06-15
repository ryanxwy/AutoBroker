/**
 * @autobroker/tools — Layer 4 public surface.
 *
 * The ONLY layer that touches SQLite or external APIs. In-process
 * tool({execute}) closures for Gmail, browser, DB, plus pure calc/validators,
 * fronted by the L2 in-process gate (the single side-effect path).
 *
 * Dependency wall: tools may import core and db — never workflows or app.
 */

// L2 gate bridge + L1 env fuse — the single side-effect path.
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
  BrowserTool,
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
  ZIP_SUBMIT_TEXT_RE,
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
  type ResponseMatch,
  type PageLike,
  type DealerLeadForm,
} from "./browser.js";

// Anti-bot block-page signature classifier (first 8 KB scan; blocked captures
// are discarded and surfaced, never escalated).
export { classifyBlockSignature } from "./blockSignature.js";

// US-dealer gate — hard filter lives in code, not in any prompt.
export { isUsDealer, type IsUsDealerOptions } from "./geo.js";

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
  annotateDistance,
  rankByDistance,
  type Viewport,
  type CandidateFilterResult,
  type RankedDealerCandidate,
} from "./geosearch/pure.js";
export {
  mapsExtractor,
  parseMapsHref,
  parseRatingLabel,
  isServiceCenterTypeLine,
  needsFallback,
  MAPS_EXTRACT_REQUIRED_FIELDS,
  type MapsDomDocument,
  type MapsDomElement,
} from "./geosearch/mapsExtractor.js";
export { upsertDealers, type UpsertDealersResult } from "./geosearch/upsertDealers.js";

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
  likelySrpPath,
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
  type ProfileMatchCtx,
  type RankedRow,
} from "./inventory/inventory_rank.js";
export {
  listListingsForProfile,
  type ProfileListingsRead,
} from "./inventory/read.js";
export {
  rankInventoryForProfile,
  type RankedCandidate,
  type RankInventoryResult,
} from "./inventory/compute.js";

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
  listProfileMessageRows,
  listProfileContactEmails,
  listProfileDealerDomains,
  readFirstLeadSubmitAtMs,
  listSuppressedGmailThreadIds,
  listIngestedGmailMessageIds,
} from "./inbox/reads.js";

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

// Scheduler watermark — the per-job last-success store in pipeline_state (the
// durable catch-up watermark; the only product-DB access the background
// scheduler is permitted, funnelled down here per the SQLite invariant).
export { watermarkKey, readLastSuccess, writeLastSuccess } from "./scheduler/watermark.js";

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
export { flagCodesFromJson } from "./quotes/flags.js";
export {
  rankQuotesForProfile,
  type QuoteRanking,
  type CompareResult,
} from "./quotes/compare.js";

// Pure validators (post-validation + safety rules).
export {
  postValidate,
  assertNoBudget,
  assertPhonePolicy,
  BudgetLeakError,
  PhonePolicyViolationError,
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

// Settings/env — the curated NON-SECRET operational env vars (the editable
// GMAIL_BACKEND / CHROME_HEADLESS toggles + read-only fuse/path/status rows).
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

// Profile service — the ONLY write path for search_profiles + audit_log,
// the typed three-branch resolver, fake-phone, and the core↔db adapter.
export {
  rowToProfile,
  profileToRow,
  validate,
  create,
  resolveActive,
  update,
  replace,
  close,
  restore,
  parseLocation,
  synthProfileId,
  readProfileRow,
  listProfileRows,
  listProfileDealerRows,
  resolveActiveProfile,
  requireActiveProfile,
  makeFakePhone,
  resolveStoredPhone,
  writeAuditLog,
  AUDIT_ACTIONS,
  ActiveSlotConflict,
  IdentityLockedError,
  IDENTITY_FIELDS,
  CoordinatesNotResolvedError,
  MissingRequiredFieldError,
  NoActiveProfileError,
  MultipleActiveProfilesError,
  type SearchProfileRow,
  type ValidateResult,
  type ParsedLocation,
  type ResolvedCoordinates,
  type CreateOpts,
  type CreateResult,
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
// generic audit_log completion row. No child workflow / LLM here.
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
} from "./pipeline/index.js";
