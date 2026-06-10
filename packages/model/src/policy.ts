/**
 * Routing policy (Layer 2).
 *
 * STUB: maps a provider-NEUTRAL `useCase` to a concrete `ModelAlias` and the
 * `CapabilityFlags` of the model behind it. Workflows/skills only ever name a
 * `useCase`; they never hard-code a provider. Changing which model serves a
 * useCase is an edit here, not in any skill.
 *
 * Override (2026-06-02): default routing targets DeepSeek tiers; Anthropic and
 * OpenAI are switchable by changing the alias string. No privacy gate.
 */

import type { CapabilityFlags, ModelAlias, Provider } from "@autobroker/core";

/**
 * The closed set of model use-cases skills can request. One per LLM-touching
 * concern, kept coarse so routing stays legible.
 *
 * TODO: expand as skills land — e.g. "incentive_scrape", "negotiation_followup",
 * "closeout_email". Each new useCase needs a policy entry + (if a new model)
 * a registry tier binding + a CapabilityFlags row.
 */
export const USE_CASES = [
  /** Extract a structured DealerQuote from a dealer reply (Phase 3 template). */
  "dealer_reply_extract",
  /** Render a Telegram headline from already-computed audit flags (Phase 1). */
  "quote_audit_headline",
  /**
   * Intake trim-verify: LLM checks whether `trim` truly exists for the
   * make/model/year and, when not, suggests real alternatives. Its {valid,...}
   * output drives the force-override audit branch. Both intake useCases route to
   * deepseek.chat (they replaced an earlier single intake stub useCase).
   */
  "intake_trim_verify",
  /**
   * Intake freeform prefill: an EXTRACTION pass over a user's one-liner that
   * pre-seeds the intake form. All-nullable subset; never extracts PII/budget.
   * Prefill only seeds the form — it never persists.
   */
  "intake_freeform_prefill",
  /**
   * Geosearch snapshot-fallback parsing ONLY — the dealer_geosearch happy
   * path is zero-LLM (the in-page evaluate extractor returns typed rows
   * directly). This useCase fires only when extraction degrades to the
   * rendered-text snapshot: a single emit_result tool carrying the flat
   * 12-field DealerCandidate schema; never Output.object + tools on DeepSeek.
   */
  "geosearch_extract",
  /** Cheap trivial probe used by the Phase 0 foundation exit criteria. */
  "foundation_probe",
  /**
   * Cross-provider smoke probe. Routes to a structured-output-with-tools
   * provider (Anthropic) so the harness exercises the NATIVE `output_object`
   * strategy end-to-end — the counterpart to foundation_probe's emit_result
   * (DeepSeek) lane. The live calls themselves gate on an explicit go.
   */
  "cross_provider_smoke",
] as const;
export type UseCase = (typeof USE_CASES)[number];

/**
 * useCase -> ModelAlias. Defaults to DeepSeek tiers (override 2026-06-02).
 *
 * TODO: make this overridable per-account/per-run (user switches provider) by
 * threading the chosen `Provider` through and swapping the prefix while keeping
 * the tier. The mapping below is the cheap-model-first default.
 */
const USE_CASE_ALIAS: Record<UseCase, ModelAlias> = {
  dealer_reply_extract: "deepseek.chat",
  quote_audit_headline: "deepseek.cheap",
  // Both intake LLM passes route to deepseek.chat (deepseek-v4-flash, temp 0,
  // per-step thinking:disabled + named tool_choice — emit_result hard constraint:
  // DeepSeek thinking mode rejects a named/forced tool_choice). emit_result
  // strategy (supportsOutputObjectWithTools false) is shared with every DeepSeek
  // alias — no Output.object + tools mix.
  intake_trim_verify: "deepseek.chat",
  intake_freeform_prefill: "deepseek.chat",
  // Snapshot-fallback parsing only; single emit_result tool; never
  // Output.object + tools on DeepSeek (supportsOutputObjectWithTools false).
  geosearch_extract: "deepseek.chat",
  foundation_probe: "deepseek.cheap",
  // Routes to anthropic.chat (supportsOutputObjectWithTools:true) so the harness
  // takes the NATIVE output_object strategy. Swapping to "openai.chat" is a
  // one-string change that keeps the same strategy (both rows are true).
  cross_provider_smoke: "anthropic.chat",
};

/**
 * Capability map keyed by alias. Drives fail-loud / down-route and the
 * structured-output strategy choice (emit_result vs structured object output).
 *
 * Key fact baked in: DeepSeek MUST NOT mix Output.object with tools
 * (`supportsOutputObjectWithTools: false`) — per-step json_schema injection
 * provokes the #1244 text-dump (mixing structured output with tools is the
 * trigger; pure tool loops are clean).
 *
 * TODO: fill in real per-alias flags for every registered tier; values below are
 * representative stubs for the DeepSeek defaults.
 */
const ALIAS_CAPABILITIES: Partial<Record<ModelAlias, CapabilityFlags>> = {
  "deepseek.cheap": {
    supportsToolCalls: true, // Mastra owns the loop; DeepSeek supports tool calls.
    supportsOutputObjectWithTools: false, // #1244 — use emit_result / two-phase
    strictJsonSchema: false,
    supportsVision: false,
    reportsUsageTokens: true,
  },
  "deepseek.chat": {
    supportsToolCalls: true,
    supportsOutputObjectWithTools: false,
    strictJsonSchema: false,
    supportsVision: false,
    reportsUsageTokens: true,
  },

  // Anthropic rows (cross-provider smoke). Verified 2026-06-05 against the
  // official structured-outputs doc (platform.claude.com/.../structured-outputs):
  // Claude supports structured JSON output (output_config.format json_schema) AND
  // tool use in the SAME request ("call tools with guaranteed-valid parameters
  // AND return structured JSON responses"), via constrained decoding / strict
  // schema. GA on Haiku 4.5 / Sonnet 4.6 / Opus 4.8 (the ids the registry binds).
  // All current Claude models support vision (model overview: "text and image
  // input … and vision") and report usage tokens. So:
  // supportsOutputObjectWithTools:true (→ output_object strategy), strictJsonSchema:true.
  "anthropic.cheap": {
    supportsToolCalls: true,
    supportsOutputObjectWithTools: true,
    strictJsonSchema: true,
    supportsVision: true,
    reportsUsageTokens: true,
  },
  "anthropic.chat": {
    supportsToolCalls: true,
    supportsOutputObjectWithTools: true,
    strictJsonSchema: true,
    supportsVision: true,
    reportsUsageTokens: true,
  },
  "anthropic.strong": {
    supportsToolCalls: true,
    supportsOutputObjectWithTools: true,
    strictJsonSchema: true,
    supportsVision: true,
    reportsUsageTokens: true,
  },
  "anthropic.reasoner": {
    supportsToolCalls: true,
    supportsOutputObjectWithTools: true,
    strictJsonSchema: true,
    supportsVision: true,
    reportsUsageTokens: true,
  },

  // OpenAI rows (cross-provider smoke). Verified 2026-06-05 against the
  // official model docs (developers.openai.com/api/docs/models) + the
  // structured-outputs/function-calling guides: the GPT-5.x family supports
  // Structured Outputs (response_format json_schema, strict) together with
  // function/tool calling, plus vision (text+image input) and usage reporting.
  // So supportsOutputObjectWithTools:true, strictJsonSchema:true.
  "openai.cheap": {
    supportsToolCalls: true,
    supportsOutputObjectWithTools: true,
    strictJsonSchema: true,
    supportsVision: true,
    reportsUsageTokens: true,
  },
  "openai.chat": {
    supportsToolCalls: true,
    supportsOutputObjectWithTools: true,
    strictJsonSchema: true,
    supportsVision: true,
    reportsUsageTokens: true,
  },
  "openai.strong": {
    supportsToolCalls: true,
    supportsOutputObjectWithTools: true,
    strictJsonSchema: true,
    supportsVision: true,
    reportsUsageTokens: true,
  },
  "openai.reasoner": {
    supportsToolCalls: true,
    supportsOutputObjectWithTools: true,
    strictJsonSchema: true,
    supportsVision: true,
    reportsUsageTokens: true,
  },
};

export interface PolicyResolution {
  useCase: UseCase;
  alias: ModelAlias;
  provider: Provider;
  capabilities: CapabilityFlags;
}

/**
 * Resolve a useCase to its alias + provider + capabilities.
 *
 * Fail-LOUD: an unmapped useCase or a missing capability row throws rather than
 * silently down-routing to a default. (No silent fallbacks.)
 */
export function policy(useCase: UseCase): PolicyResolution {
  const alias = USE_CASE_ALIAS[useCase];
  const capabilities = ALIAS_CAPABILITIES[alias];
  if (capabilities === undefined) {
    // TODO: replace with a typed PolicyError once the error taxonomy exists.
    throw new Error(
      `policy: no CapabilityFlags registered for alias "${alias}" (useCase "${useCase}")`,
    );
  }
  const provider = alias.split(".")[0] as Provider;
  return { useCase, alias, provider, capabilities };
}
