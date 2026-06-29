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

import { ModelAliasSchema } from "@autobroker/core";
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
  /**
   * AUTOMATIC same-provider RETRY of a malformed dealer_reply_extract (the F1
   * recovery). Fired ONCE, in-process, by the per-message catch on the
   * malformed-tool-call failure class (#1244) — NEVER by the user, never cross-
   * provider. The auto-path's first hop runs deepseek-v4-flash on the forced
   * emit_result lane (thinking OFF); on the malformed class this useCase retries
   * the SAME message ONCE on deepseek-v4-pro WITH thinking, same provider
   * (privacy-clean, no egress to a Western provider). The thinking lane CANNOT
   * use a forced/named tool_choice (DeepSeek thinking mode rejects it — "Thinking
   * mode does not support this tool_choice"), so the harness runs this useCase on
   * the emit_result tool with tool_choice:"auto" + thinking ON (the model reasons,
   * then voluntarily calls the single emit_result tool). #1244 fail-closed + Zod
   * post-validation are IDENTICAL on this lane: if the v4-pro+thinking retry ALSO
   * comes back malformed, the message stays `failed`, exactly as the v4-flash hop.
   */
  "dealer_reply_extract_retry",
  /** Render a Telegram headline from already-computed audit flags (Phase 1). */
  "quote_audit_headline",
  /**
   * Intake freeform prefill: an EXTRACTION pass over a user's one-liner that
   * pre-seeds the intake form. All-nullable subset; never extracts PII/budget.
   * Prefill only seeds the form — it never persists.
   */
  "intake_freeform_prefill",
  /**
   * Intake trim-suggestion: a STRUCTURED EXTRACTION over web-fetched trim pages
   * (the fetch lives in packages/tools; this useCase only structures the gathered
   * text into a grounded trim list the buyer picks from). Single emit_result tool,
   * never mixed with other tools (#1244). Routes to deepseek.chat.
   */
  "intake_trim_lookup",
  /**
   * Geosearch snapshot-fallback parsing ONLY — the dealer_geosearch happy
   * path is zero-LLM (the in-page evaluate extractor returns typed rows
   * directly). This useCase fires only when extraction degrades to the
   * rendered-text snapshot: a single emit_result tool carrying the flat
   * 12-field DealerCandidate schema; never Output.object + tools on DeepSeek.
   */
  "geosearch_extract",
  /**
   * Inventory-listing extraction for the site/link scan skills: the SECOND
   * phase of a two-phase pipeline (tools-only capture first, then this
   * separate no-tools structured call over the fenced page snapshot) emitting
   * the flat 11-field InventoryListing rows. On DeepSeek that means a single
   * emit_result tool; never Output.object + tools.
   */
  "inventory_extract",
  /**
   * Manufacturer-incentive extraction for the incentive_scrape skill: the
   * SECOND phase of a two-phase pipeline (tools-only OEM/rooftop page capture
   * first, then this separate no-tools structured call over the fenced offers
   * snapshot) emitting the flat 4-field Incentive rows. On DeepSeek that
   * means a single emit_result tool; never Output.object + tools.
   */
  "incentive_extract",
  /**
   * Custom-platform lead-form field map for the dealer_web_lead_submit skill:
   * over a fenced (UNTRUSTED) contact-form DOM snapshot, a single no-tools
   * structured call emitting the flat {fields[], submit_selector} map. On
   * DeepSeek that means a single emit_result tool; never Output.object + tools.
   */
  "lead_form_map",
  /**
   * AUTOMATIC same-provider malformed-class recovery hop for geosearch_extract —
   * v4-pro WITH thinking + tool_choice auto; emit_result single-tool + #1244
   * fail-closed + Zod identical; reasoningEffort medium (the failure is a
   * serialization defect, not a reasoning-difficulty one). Same provider →
   * privacy-clean, no cross-provider egress.
   */
  "geosearch_extract_retry",
  /**
   * AUTOMATIC same-provider malformed-class recovery hop for inventory_extract —
   * v4-pro WITH thinking + tool_choice auto; emit_result single-tool + #1244
   * fail-closed + Zod identical; reasoningEffort medium (the failure is a
   * serialization defect, not a reasoning-difficulty one). Same provider →
   * privacy-clean, no cross-provider egress.
   */
  "inventory_extract_retry",
  /**
   * AUTOMATIC same-provider malformed-class recovery hop for incentive_extract —
   * v4-pro WITH thinking + tool_choice auto; emit_result single-tool + #1244
   * fail-closed + Zod identical; reasoningEffort medium (the failure is a
   * serialization defect, not a reasoning-difficulty one). Same provider →
   * privacy-clean, no cross-provider egress.
   */
  "incentive_extract_retry",
  /**
   * AUTOMATIC same-provider malformed-class recovery hop for lead_form_map —
   * v4-pro WITH thinking + tool_choice auto; emit_result single-tool + #1244
   * fail-closed + Zod identical; reasoningEffort medium (the failure is a
   * serialization defect, not a reasoning-difficulty one). Same provider →
   * privacy-clean, no cross-provider egress.
   */
  "lead_form_map_retry",
  /**
   * Negotiation follow-up PROSE drafting for the negotiation_followup skill: a
   * plain text generation (NO tools, NO structured output) — the tone is chosen
   * in CODE and the model only writes the chosen register's prose. Because there
   * are no tools and no per-step json_schema, the #1244 mixing failure is
   * structurally inapplicable. Routes to deepseek.chat.
   */
  "negotiation_followup",
  /**
   * Negotiation-state SUMMARY for the dealer-negotiation detail modal: a single
   * emit_result structured generation over the dealer's already-stored
   * substantive reply bodies (flat .strict() {summary}). An advisory,
   * read-only projection — ANY failure degrades to null. Routes to deepseek.chat,
   * mirroring intake_freeform_prefill (emit_result discipline; never Output.object
   * + tools on DeepSeek).
   */
  "negotiation_summary",
  /**
   * NL skill-router: classify a free-form chat message into ONE of the 17
   * skills / intake / none. A single emit_result tool carrying the flat
   * ChatRouteEmitSchema (temp 0, thinking OFF) — never Output.object + tools on
   * DeepSeek. The router only CHOOSES + LAUNCHES; every downstream gate stays
   * load-bearing. Routes to deepseek.chat.
   */
  "chat_route",
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
  // AUTOMATIC same-provider retry on the malformed class (owner-directed): the
  // v4-flash forced-emit hop failed, so retry ONCE on deepseek-v4-pro WITH
  // thinking. Same provider — privacy-clean, no cross-provider egress. v4-pro is
  // the `strong` tier; thinking is a per-request parameter (NOT a separate model
  // id), bound by the harness for this useCase. The harness runs this useCase on
  // the emit_result tool with tool_choice:"auto" + thinking ON (a forced/named
  // tool_choice is rejected in DeepSeek thinking mode), which is structurally the
  // chat/rail thinking-ON + auto lane that runs clean.
  dealer_reply_extract_retry: "deepseek.strong",
  quote_audit_headline: "deepseek.cheap",
  // Both intake LLM passes (prefill + trim lookup) route to deepseek.chat
  // (deepseek-v4-flash, temp 0, per-step thinking:disabled + named tool_choice —
  // emit_result hard constraint: DeepSeek thinking mode rejects a named/forced
  // tool_choice). emit_result strategy (supportsOutputObjectWithTools false) is
  // shared with every DeepSeek alias — no Output.object + tools mix.
  intake_freeform_prefill: "deepseek.chat",
  intake_trim_lookup: "deepseek.chat",
  // Snapshot-fallback parsing only; single emit_result tool; never
  // Output.object + tools on DeepSeek (supportsOutputObjectWithTools false).
  geosearch_extract: "deepseek.chat",
  // Snapshot row extraction (two-phase: capture is zero-LLM); single
  // emit_result tool on DeepSeek, same discipline as geosearch_extract.
  inventory_extract: "deepseek.chat",
  // Offer-card row extraction (two-phase: capture is zero-LLM); single
  // emit_result tool on DeepSeek, same discipline as inventory_extract.
  incentive_extract: "deepseek.chat",
  // Custom lead-form field map (single emit_result tool over the fenced form
  // DOM); same DeepSeek discipline as inventory_extract / incentive_extract.
  lead_form_map: "deepseek.chat",
  // The four AUTOMATIC malformed-class recovery hops (shared recoverEmitWithRetry
  // helper). Each retries its primary emit_result useCase ONCE on deepseek-v4-pro
  // WITH thinking — the `strong` tier, same provider (privacy-clean, no egress).
  // The harness runs these on the emit_result tool with tool_choice:"auto" +
  // thinking ON (a forced/named tool_choice is rejected in DeepSeek thinking
  // mode); the emit schema, #1244 fail-closed and Zod belt are identical.
  geosearch_extract_retry: "deepseek.strong",
  inventory_extract_retry: "deepseek.strong",
  incentive_extract_retry: "deepseek.strong",
  lead_form_map_retry: "deepseek.strong",
  // Negotiation follow-up PROSE draft (NO tools, NO structured output — the
  // draftProse facade). #1244 is structurally inapplicable; deepseek.chat.
  negotiation_followup: "deepseek.chat",
  // Negotiation-state summary (single emit_result tool over the dealer's reply
  // bodies); same DeepSeek emit_result discipline as intake_freeform_prefill.
  negotiation_summary: "deepseek.chat",
  // NL skill-router classify pass (single emit_result tool, temp 0, thinking
  // OFF). Same DeepSeek emit_result discipline as the other classify useCases;
  // a provider swap is a one-string edit here.
  chat_route: "deepseek.chat",
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
  // deepseek-v4-pro — the dealer_reply_extract_retry target (the malformed-class
  // recovery hop). Same #1244 discipline as the other DeepSeek rows:
  // supportsOutputObjectWithTools:false → the harness takes the emit_result lane
  // (NOT native output_object). This useCase runs that lane with thinking ON +
  // tool_choice:"auto" (a forced tool_choice is rejected in thinking mode); the
  // harness decides forced-vs-auto from the useCase, not from this flag.
  "deepseek.strong": {
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

/** Alias-level resolution without a useCase (returned by policyForAlias). */
export interface AliasResolution {
  alias: ModelAlias;
  provider: Provider;
  capabilities: CapabilityFlags;
}

export interface PolicyResolution extends AliasResolution {
  useCase: UseCase;
}

/**
 * Resolve a ModelAlias to its provider + capabilities.
 *
 * Fail-LOUD: a missing capability row throws rather than silently down-routing.
 */
export function policyForAlias(alias: ModelAlias): AliasResolution {
  const capabilities = ALIAS_CAPABILITIES[alias];
  if (capabilities === undefined) {
    throw new Error(
      `policy: no CapabilityFlags registered for alias "${alias}"`,
    );
  }
  const provider = alias.split(".")[0] as Provider;
  return { alias, provider, capabilities };
}

/**
 * Swap the provider prefix of a ModelAlias, keeping the tier segment.
 * withProvider("deepseek.chat", "anthropic") === "anthropic.chat"
 */
export function withProvider(alias: ModelAlias, provider: Provider): ModelAlias {
  const tier = alias.split(".")[1];
  return ModelAliasSchema.parse(`${provider}.${tier}`) as ModelAlias;
}

/**
 * Resolve a useCase to its alias + provider + capabilities.
 *
 * Fail-LOUD: an unmapped useCase or a missing capability row throws rather than
 * silently down-routing to a default. (No silent fallbacks.)
 */
export function policy(useCase: UseCase): PolicyResolution {
  return { useCase, ...policyForAlias(USE_CASE_ALIAS[useCase]) };
}

/**
 * Concrete model id for each alias. Kept in sync with registry.ts by hand.
 * When two aliases share the same concrete id (e.g. deepseek.cheap / deepseek.chat
 * both map to deepseek-v4-flash), the FIRST entry wins in aliasForModelId.
 */
const ALIAS_MODEL_ID: Partial<Record<ModelAlias, string>> = {
  // DeepSeek
  "deepseek.cheap": "deepseek-v4-flash",
  "deepseek.chat": "deepseek-v4-flash",
  "deepseek.strong": "deepseek-v4-pro",
  "deepseek.reasoner": "deepseek-v4-flash",
  // Anthropic — chat before reasoner so claude-sonnet-4-6 → anthropic.chat
  "anthropic.cheap": "claude-haiku-4-5",
  "anthropic.chat": "claude-sonnet-4-6",
  "anthropic.strong": "claude-opus-4-8",
  "anthropic.reasoner": "claude-sonnet-4-6",
  // OpenAI — chat before reasoner so gpt-5.4 → openai.chat
  "openai.cheap": "gpt-5.4-mini",
  "openai.chat": "gpt-5.4",
  "openai.strong": "gpt-5.5",
  "openai.reasoner": "gpt-5.4",
};

/**
 * Reverse-lookup: returns the FIRST ModelAlias whose concrete model id equals
 * `modelId`, or `null` when no alias is bound to that id.
 *
 * Ambiguity: deepseek-v4-flash maps to deepseek.cheap / .chat / .reasoner —
 * the first entry (deepseek.cheap) is returned; all three resolve the same model.
 */
export function aliasForModelId(modelId: string): ModelAlias | null {
  const entry = Object.entries(ALIAS_MODEL_ID).find(([, id]) => id === modelId);
  return entry ? (entry[0] as ModelAlias) : null;
}
