/**
 * quote_pipeline deterministic core — the child-independent tools the
 * orchestrator composes. All are pure-SQL or pure-string; none of them invoke a
 * child workflow or an LLM. The flat Mastra orchestrator (built once the
 * E2/D2/D3 children land) wires these between the child steps.
 *
 *   detectPipelineState     — re-derive the 4 applicable-step flags each run
 *                             (no checkpoint table — non-durable by design).
 *   resolveTargetedListing  — READ-ONLY targeted-VIN validator + empty-thread
 *                             guard (never mutates processed_at).
 *   buildOtdInjection       — the pure VIN-specific OTD ask (raises on null VIN).
 *   recordQuoteFromListing  — idempotent targeted-VIN dealer_quotes writer
 *                             (message_id required + resolved to provenance).
 *   computeFinalState/NextAction — the deterministic LLM-free disposition.
 *   writePipelineCompletion — the one generic audit_log completion row.
 */

export {
  detectPipelineState,
  type DetectPipelineStateArgs,
  type PipelineStateFlags,
} from "./detectPipelineState.js";

export {
  resolveTargetedListing,
  TargetedListingNotFound,
  NoInboundThread,
  type ResolveTargetedListingArgs,
  type ResolveTargetedListingResult,
  type TargetedListing,
  type TargetedInboundThread,
} from "./resolveTargetedListing.js";

export {
  buildOtdInjection,
  MissingVinError,
  type BuildOtdInjectionArgs,
} from "./buildOtdInjection.js";

export {
  recordQuoteFromListing,
  MessageNotFoundError,
  MissingMessageIdError,
  type RecordQuoteFromListingArgs,
  type RecordQuoteFromListingResult,
} from "./recordQuoteFromListing.js";

export {
  computeFinalState,
  computeNextAction,
  PIPELINE_STEPS,
  FINAL_STATES,
  type PipelineStep,
  type FinalState,
} from "./finalState.js";

export {
  writePipelineCompletion,
  PIPELINE_COMPLETE_ACTION,
  type WritePipelineCompletionArgs,
  type WritePipelineCompletionResult,
} from "./auditLogWriter.js";

export {
  COLD_DORMANCY_DAYS,
  lastProgressKey,
  readLastProgressAt,
  writeLastProgressAt,
} from "./progressWatermark.js";

export {
  profileHealth,
  type ProfileHealth,
  type ProfileHealthLevel,
  type ProfileHealthOpts,
} from "./profileHealth.js";

export {
  activeRunKey,
  tryClaimActivation,
  recordActivation,
  clearActivationByRunId,
  lookupRunIdForProfile,
  lookupProfileIdForRunId,
  listActiveProfileIds,
  reconcileActivations,
  ActivationClaimConflictError,
  type ActivationClaimResult,
} from "./activationRegistry.js";

export {
  sweepOrphanedBoundClaims,
  type OrphanSweepResult,
} from "./orphanSweep.js";
