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

// Zod schemas (flat, required, explicit-null; per ARCH_STRUCTURED_OUTPUT).
export { DealerQuoteSchema, FinancingModeSchema } from "./schema/dealerQuote.js";
export type { DealerQuote, FinancingMode } from "./schema/dealerQuote.js";

export {
  AuditFlagSchema,
  AuditFlagCodeSchema,
  AuditSeveritySchema,
} from "./schema/auditFlag.js";
export type { AuditFlag, AuditFlagCode, AuditSeverity } from "./schema/auditFlag.js";

export {
  SearchProfileSchema,
  SearchProfileStatusSchema,
} from "./schema/searchProfile.js";
export type { SearchProfile, SearchProfileStatus } from "./schema/searchProfile.js";

export { SessionThreadSchema } from "./schema/sessionThread.js";
export type { SessionThread } from "./schema/sessionThread.js";
