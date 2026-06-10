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

// Outbound-URL SSRF validator (9 ordered rules, fail-closed).
export {
  validateSourceUrl,
  isPrivateIp,
  SourceUrlValidationError,
  type ValidateSourceUrlOptions,
} from "./ssrf.js";

// Dealer-platform inventory scout (fingerprint table + fresh-200 SRP probe).
export {
  likelySrpPath,
  resolveSrp,
  type ScoutOptions,
} from "./inventoryScout.js";

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
  parseLocation,
  synthProfileId,
  readProfileRow,
  listProfileRows,
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
