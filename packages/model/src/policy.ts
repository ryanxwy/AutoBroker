/**
 * Routing policy (Layer 2).
 *
 * STUB: maps a provider-NEUTRAL `useCase` to a concrete `ModelAlias` and the
 * `CapabilityFlags` of the model behind it. Workflows/skills only ever name a
 * `useCase`; they never hard-code a provider. Changing which model serves a
 * useCase is an edit here, not in any skill.
 *
 * (architectureStack §"Provider 路由 / Agent lane": "workflows 只认 useCase 不
 * 硬编码 provider 名".)
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
  /** Extract a structured DealerQuote from a dealer reply (Phase 2 template). */
  "dealer_reply_extract",
  /** Render a Telegram headline from already-computed audit flags (Phase 1). */
  "quote_audit_headline",
  /** Verify trim at intake; force-override is audited (Phase 2 root dep). */
  "search_profile_intake",
  /** Cheap trivial probe used by the Phase 0 foundation exit criteria. */
  "foundation_probe",
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
  search_profile_intake: "deepseek.chat",
  foundation_probe: "deepseek.cheap",
};

/**
 * Capability map keyed by alias. Drives fail-loud / down-route and the
 * structured-output strategy choice (emit_result vs Output.object).
 *
 * Key fact baked in: DeepSeek MUST NOT mix Output.object with tools
 * (`supportsOutputObjectWithTools: false`) — per-step json_schema injection
 * provokes the #1244 text-dump. (currentTruth §"结构化输出机制")
 *
 * TODO: fill in real per-alias flags for every registered tier; values below are
 * representative stubs for the DeepSeek defaults.
 */
const ALIAS_CAPABILITIES: Partial<Record<ModelAlias, CapabilityFlags>> = {
  "deepseek.cheap": {
    ownsToolLoop: true, // api-key lane: AI SDK owns the loop
    supportsOutputObjectWithTools: false, // #1244 — use emit_result / two-phase
    strictJsonSchema: false,
    supportsVision: false,
    reportsUsageTokens: true,
  },
  "deepseek.chat": {
    ownsToolLoop: true,
    supportsOutputObjectWithTools: false,
    strictJsonSchema: false,
    supportsVision: false,
    reportsUsageTokens: true,
  },
  // TODO: anthropic.* (strictJsonSchema:true, supportsOutputObjectWithTools:true,
  //       supportsVision:true) and openai.* rows.
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
 * silently down-routing to a default. (No silent fallbacks — safetyInvariants.)
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
