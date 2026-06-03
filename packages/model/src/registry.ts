/**
 * Provider registry (Layer 2).
 *
 * STUB: wires the three first-class api-key providers behind a single
 * `createProviderRegistry`, exposing tier aliases so callers resolve a model by
 * a provider-neutral `{provider}.{tier}` ModelAlias string. Swapping the
 * concrete model behind a tier is a one-string edit here.
 *
 * Override (2026-06-02): DeepSeek is the DEFAULT api-key provider AND the
 * live-harness test agent. Anthropic + OpenAI are equally first-class,
 * switchable api-key lanes. NO tiering / privacy gate (disclosure is in the
 * README, not enforced in code). See `DEFAULT_PROVIDER` from @autobroker/core.
 *
 * Architecture (architectureStack §"Provider 路由 / Agent lane"):
 *   - api-key lane only: the AI SDK owns the agentic tool loop here, so
 *     needsApproval / stopWhen / Output.* fire natively. Subscription/CLI-spawn
 *     lanes do NOT fire it (T1) and route their gate through the in-process
 *     handler in the tools layer instead.
 *   - alias = `{provider}.{tier}`, tier in { reasoner, chat, cheap, strong }.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { openai } from "@ai-sdk/openai";
import { createProviderRegistry, customProvider } from "ai";
import type { LanguageModel, ProviderRegistryProvider } from "ai";
import type { ProviderV3 } from "@ai-sdk/provider";
import { DEFAULT_PROVIDER, type ModelAlias, type Provider } from "@autobroker/core";

/**
 * The registry separator. We use "." so the public alias string is exactly the
 * core `ModelAlias` shape: `deepseek.cheap`, `anthropic.strong`, ...
 */
const SEPARATOR = "." as const;

const deepseek = createDeepSeek();

/**
 * Tier -> concrete model bindings per provider.
 *
 * TODO: pin exact model ids once verified against each provider's current
 * catalog. DeepSeek test default is `deepseek-v4-flash` (non-thinking,
 * temperature:0) per the harness lane; thinking/reasoner tier is the V4-Pro
 * reasoner. These ids are PLACEHOLDERS — confirm before Phase 1 live runs.
 */
export const registry: ProviderRegistryProvider<Record<string, ProviderV3>, typeof SEPARATOR> =
  createProviderRegistry(
  {
    // DEFAULT provider — cheap-model-first; also the live-harness test agent.
    deepseek: customProvider({
      languageModels: {
        cheap: deepseek("deepseek-chat"), // TODO: pin deepseek-v4-flash id
        chat: deepseek("deepseek-chat"),
        strong: deepseek("deepseek-reasoner"), // TODO: confirm reasoner id
        reasoner: deepseek("deepseek-reasoner"),
      },
      fallbackProvider: deepseek,
    }),

    anthropic: customProvider({
      languageModels: {
        cheap: anthropic("claude-haiku-4-5"), // TODO: confirm ids per catalog
        chat: anthropic("claude-sonnet-4-5"),
        strong: anthropic("claude-opus-4-1"),
        reasoner: anthropic("claude-sonnet-4-5"),
      },
      fallbackProvider: anthropic,
    }),

    openai: customProvider({
      languageModels: {
        cheap: openai("gpt-4.1-mini"), // TODO: confirm ids per catalog
        chat: openai("gpt-4.1"),
        strong: openai("o3"),
        reasoner: openai("o3"),
      },
      fallbackProvider: openai,
    }),
  },
  { separator: SEPARATOR },
);

/** Default provider per the 2026-06-02 override (re-exported for callers). */
export const defaultProvider: Provider = DEFAULT_PROVIDER;

/**
 * Resolve a `{provider}.{tier}` ModelAlias to a concrete LanguageModel.
 *
 * NOTE: `ModelAlias` is structurally identical to the registry's
 * `providerId{SEPARATOR}modelId` key, which is why SEPARATOR is ".".
 */
export function resolveModel(alias: ModelAlias): LanguageModel {
  return registry.languageModel(alias);
  // TODO: surface a typed "alias not registered" error instead of letting the
  // SDK throw, so policy() down-routing can react. Fail-LOUD, never silent.
}
