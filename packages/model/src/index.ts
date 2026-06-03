/**
 * @autobroker/model — Layer 2 public surface (the AI SDK layer).
 *
 * Owns provider routing and the provider-neutral structured-generation entry.
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

// Provider-neutral structured-generation entry (api-key lane owns the tool loop).
export { harness, generate } from "./harness.js";
export type {
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessSuspend,
} from "./harness.js";

// #1244 fail-closed malformed-tool-call detector (loop-level safety boundary).
export {
  detectMalformedToolCall,
  assertToolTurnOrFailClosed,
  looksLikeToolShapedBlob,
  MalformedToolCallAbort,
  MALFORMED_TOOL_CALL_REASON,
} from "./malformedToolCall.js";
export type { ToolTurnView, MalformedSignal } from "./malformedToolCall.js";
