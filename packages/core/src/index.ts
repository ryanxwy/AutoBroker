/**
 * @autobroker/core — Layer 1 public surface.
 *
 * Pure TYPES + Zod contracts shared by every higher layer
 * (model -> workflows -> tools -> app). This package MUST NOT import any
 * framework: `ai`, `drizzle-orm`, `playwright`, any HTTP server, etc. are all
 * invisible here. See README.md for the full layer contract.
 */

// Shared type aliases + enums.
export {
  PROVIDERS,
  ProviderSchema,
  MODEL_TIERS,
  ModelTierSchema,
  ModelAliasSchema,
  DEFAULT_PROVIDER,
  CapabilityFlagsSchema,
  SKILL_RUN_STATUSES,
  SkillRunStatusSchema,
  DRIVER_KINDS,
  DriverKindSchema,
  HARNESS_DRIVER_KINDS,
  HarnessDriverKindSchema,
  providerDriverKind,
  selectionDriverKind,
} from "./types.js";
export type {
  Provider,
  ModelTier,
  ModelAlias,
  CapabilityFlags,
  SkillRunStatus,
  DriverKind,
  HarnessDriverKind,
} from "./types.js";

// Zod schemas (flat, required, explicit-null structured-output convention).
export {
  DealerQuoteSchema,
  DealerReplyQuoteRowSchema,
  MoneyLineSchema,
  FinancingModeSchema,
  QuoteFormatSchema,
  IntentSchema,
  ExtractorProviderSchema,
  ExtractionMethodSchema,
  reclassifyRule2Failures,
} from "./schema/dealerQuote.js";
export type {
  DealerQuote,
  DealerReplyQuoteRow,
  MoneyLine,
  FinancingMode,
  QuoteFormat,
  Intent,
  ExtractorProvider,
  ExtractionMethod,
} from "./schema/dealerQuote.js";

export { AuditFindingSchema } from "./schema/auditFlag.js";
export type { AuditFinding } from "./schema/auditFlag.js";

export { DealerCandidateSchema } from "./schema/dealerCandidate.js";
export type { DealerCandidate } from "./schema/dealerCandidate.js";

export {
  InventoryListingSchema,
  InventoryStatusSchema,
  INVENTORY_STATUSES,
} from "./schema/inventoryListing.js";
export type { InventoryListing, InventoryStatus } from "./schema/inventoryListing.js";

export { AggregatorListingSchema } from "./schema/aggregatorListing.js";
export type { AggregatorListing } from "./schema/aggregatorListing.js";

export {
  IncentiveSchema,
  IncentiveTypeSchema,
  IncentiveEligibilitySchema,
  IncentiveSourceRegistryEntrySchema,
  INCENTIVE_TYPES,
  INCENTIVE_ELIGIBILITIES,
} from "./schema/incentive.js";
export type {
  Incentive,
  IncentiveType,
  IncentiveEligibility,
  IncentiveSourceRegistryEntry,
} from "./schema/incentive.js";

export {
  SearchProfileSchema,
  SearchProfileStatusSchema,
  PhonePolicySchema,
  FinancingPreferenceSchema,
  IntBoolSchema,
} from "./schema/searchProfile.js";
export type {
  SearchProfile,
  SearchProfileStatus,
  PhonePolicy,
  FinancingPreference,
  IntBool,
} from "./schema/searchProfile.js";

export {
  SearchProfileIntakeInputSchema,
  INTAKE_FIELD_META,
  INTAKE_REQUIRED_FIELDS,
  INTAKE_INTERNAL_ONLY_FIELDS,
} from "./schema/intake.js";
export type {
  SearchProfileIntakeInput,
  IntakeFieldName,
  IntakeFieldMeta,
  IntakeSection,
  IntakeFieldSensitivity,
} from "./schema/intake.js";

export { SessionThreadSchema } from "./schema/sessionThread.js";
export type { SessionThread } from "./schema/sessionThread.js";

export { AgentSelectionSchema, parseAgentSelection } from "./agentSelection.js";
export type { AgentSelection } from "./agentSelection.js";
