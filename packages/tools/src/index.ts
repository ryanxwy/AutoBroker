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
  type SendMode,
  type OutboundEmail,
  type SendResult,
} from "./gmail.js";

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

// DB (single connection factory + shared-connection accessor, re-exported
// from @autobroker/db).
export { openDb, getDb, closeDb, resolveDataDir, type Db } from "./db.js";

// test_run_records ledger writer — the ONE write path (NULL-not-$0 enforced).
export {
  writeTestRunRecord,
  SilentZeroCostError,
  type TestRunRecordInsert,
} from "./testRunRecords.js";

// Pure offer math.
export {
  validateOfferMath,
  OFFER_MATH_TOLERANCE_USD,
  STATE_DOC_FEE_CAP,
  type OfferLineItems,
  type OfferMathResult,
} from "./calc.js";

// Pure validators (post-validation + safety rules).
export {
  postValidate,
  assertNoBudget,
  assertPhonePolicy,
  BudgetLeakError,
  PhonePolicyViolationError,
  type ValidationResult,
} from "./validators.js";

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
  inFlightRunFor,
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
  ProfileBusyError,
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
