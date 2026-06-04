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
 * Architecture:
 *   - api-key lane: this registry returns AI SDK 6 LanguageModel instances for
 *     Mastra agents. Mastra owns the agentic loop, approval pauses, processors,
 *     stopWhen/maxSteps, and workflow snapshots.
 *   - subscription/CLI-spawn lanes still do not fire an in-process loop over our
 *     tools (T1), so their side-effect gate routes through the same L2 handler.
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
 * TODO(phase-0): pin exact model ids before live runs. The plan's current ids
 * are `deepseek-v4-flash` for cheap/chat and `deepseek-v4-pro` for the
 * reasoner/strong tier, with thinking default-off for structured pipelines.
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
