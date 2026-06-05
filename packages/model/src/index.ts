/**
 * @autobroker/model — Layer 2 public surface (the AI SDK layer).
 *
 * Owns provider routing, structured-output helpers, and #1244 detector helpers.
 * Mastra owns orchestration and the agent loop.
 * Imports `ai` / `@ai-sdk/*` (that is this layer's job) and `@autobroker/core`
 * (Layer 1). MUST NOT import workflows / tools / app (one-way deps).
 *
 * See README.md for the layer contract and the 2026-06-02 DeepSeek-default
 * override.
 */

// Provider registry + model resolution.
export { registry, resolveModel, defaultProvider } from "./registry.js";

// useCase -> ModelAlias -> CapabilityFlags routing policy.
export { policy, USE_CASES } from "./policy.js";
export type { UseCase, PolicyResolution } from "./policy.js";

// Provider-neutral harness contract: signature types + the pure structured-output
// strategy selector. The runnable harness.generate facade + Mastra Agent loop
// live in @autobroker/workflows (归属裁定 2026-06-04).
export { chooseStructuredOutputStrategy } from "./harness.js";
export type {
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessSuspend,
  StructuredOutputStrategy,
} from "./harness.js";

// TEST SUPPORT ONLY — fake LanguageModel factories so other layers can unit-test
// agent loops without importing `ai` (the dep wall keeps `ai` types in model).
export { makeStaticToolCallModel, makeProseDumpModel } from "./testSupport.js";

// #1244 fail-closed malformed-tool-call detector (loop-level safety boundary).
export {
  detectMalformedToolCall,
  assertToolTurnOrFailClosed,
  looksLikeToolShapedBlob,
  MalformedToolCallAbort,
  MALFORMED_TOOL_CALL_REASON,
} from "./malformedToolCall.js";
export type { ToolTurnView, MalformedSignal } from "./malformedToolCall.js";

// Self-managed pricing table + usage→cost helper (NULL-not-$0; ledger snapshot).
export { PRICING, PRICING_SOURCE, computeCostUsd } from "./pricing.js";
export type { ModelRate } from "./pricing.js";

// Minimal M0 canonical-message → ModelMessage translator (flat text, fail-LOUD).
export {
  CANONICAL_ROLES,
  toModelMessages,
  UnsupportedCanonicalMessageError,
} from "./messages.js";
export type { CanonicalMessage, CanonicalRole } from "./messages.js";
