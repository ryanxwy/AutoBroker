/**
 * Provider registry (Layer 2).
 *
 * Wires the three first-class api-key providers behind a single
 * `createProviderRegistry`, exposing capability aliases so callers resolve a
 * model by a provider-neutral `{provider}.{tier}` ModelAlias string. Swapping
 * the concrete model behind an alias is a one-string edit here.
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
 *   - alias = `{provider}.{tier}`, tier in { chat, cheap, strong }.
 *     These are model-capability aliases, not the forbidden per-provider L1-L5
 *     harness tiering.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { openai } from "@ai-sdk/openai";
import { createProviderRegistry, customProvider } from "ai";
import type { LanguageModel, ProviderRegistryProvider } from "ai";
import type { ProviderV3 } from "@ai-sdk/provider";
import type { ModelAlias } from "@autobroker/core";

/**
 * The registry separator. We use "." so the public alias string is exactly the
 * core `ModelAlias` shape: `deepseek.cheap`, `anthropic.strong`, ...
 */
const SEPARATOR = "." as const;

const deepseek = createDeepSeek();

/**
 * Tier -> concrete model bindings per provider.
 *
 * DeepSeek ids are pinned (revised 2026-06-04): the
 * deepseek-chat/deepseek-reasoner aliases deprecate 2026-07-24. V4 thinking
 * is a REQUEST PARAMETER on a shared model id, not a separate "-thinking" model.
 * This registry binds model ids only; call sites set thinking per step:
 * chat/rail defaults to thinking ON + reasoning_effort:"high", while structured
 * emit_result steps force thinking OFF + temperature:0 because named/forced
 * tool_choice is rejected in thinking mode.
 *
 * Cross-provider aliases are intentionally present for the first-class lanes.
 * Their exact ids/capability rows were confirmed against the official Anthropic
 * + OpenAI model docs (fetched 2026-06-05) for the cross-provider smoke; the
 * live calls themselves still gate on an explicit go.
 */
export const registry: ProviderRegistryProvider<Record<string, ProviderV3>, typeof SEPARATOR> =
  createProviderRegistry(
  {
    // DEFAULT provider — cheap-model-first; also the live-harness test agent.
    deepseek: customProvider({
      languageModels: {
        cheap: deepseek("deepseek-v4-flash"), // thinking-off (explicit), temperature:0
        chat: deepseek("deepseek-v4-flash"),
        strong: deepseek("deepseek-v4-pro"), // thinking-off; evaluate per useCase
      },
      fallbackProvider: deepseek,
    }),

    // Anthropic ids confirmed against the official model overview (fetched
    // 2026-06-05, platform.claude.com/docs/.../models/overview). The prior
    // strings were STALE: claude-sonnet-4-5 → superseded by claude-sonnet-4-6,
    // claude-opus-4-1 → superseded by claude-opus-4-8 (and 4-1 is now a $15/MTok
    // legacy model). claude-haiku-4-5 is still current (alias of the dated
    // -20251001 snapshot). All three support tools + structured outputs + vision.
    anthropic: customProvider({
      languageModels: {
        cheap: anthropic("claude-haiku-4-5"),
        chat: anthropic("claude-sonnet-4-6"),
        strong: anthropic("claude-opus-4-8"),
      },
      fallbackProvider: anthropic,
    }),

    // OpenAI ids confirmed against the official model docs (fetched 2026-06-05,
    // developers.openai.com/api/docs/models). The prior strings were STALE: the
    // gpt-4.1 family and o3 are superseded by the GPT-5.x line. gpt-5.4 is the
    // default reasoning workhorse (effort none/low/medium/high/xhigh),
    // gpt-5.4-mini the cheapest capable tier, gpt-5.5 the strongest. All support
    // tools + structured outputs + vision.
    openai: customProvider({
      languageModels: {
        cheap: openai("gpt-5.4-mini"),
        chat: openai("gpt-5.4"),
        strong: openai("gpt-5.5"),
      },
      fallbackProvider: openai,
    }),
  },
  { separator: SEPARATOR },
);

/**
 * Resolve a `{provider}.{tier}` ModelAlias to a concrete LanguageModel.
 *
 * NOTE: `ModelAlias` is structurally identical to the registry's
 * `providerId{SEPARATOR}modelId` key, which is why SEPARATOR is ".".
 */
export function resolveModel(alias: ModelAlias): LanguageModel {
  const real = registry.languageModel(alias);
  const result =
    _harnessGenerateFault === "none" ? real : wrapWithGenerateFault(real, _harnessGenerateFault);
  // The harness model-wrapper (record/replay) applies on TOP of the fault wrap.
  // When unset (production default) this is byte-identical to returning `result`.
  return _harnessModelWrapper ? _harnessModelWrapper(result, alias) : result;
  // TODO: surface a typed "alias not registered" error instead of letting the
  // SDK throw, so policy() down-routing can react. Fail-LOUD, never silent.
}

// --- TEST-ONLY generate-fault seam (T4-U2) ---------------------------------
// Makes the NEXT resolved model's doGenerate/doStream fail like a provider 5xx
// ("llm_500", throw now) or a hung request ("llm_timeout", reject after a short
// delay). NEVER armed in production: the arm() refuses outside a test runner,
// the same guard rule as the workflows __setIntakeDepsForTests seam. The throw
// propagates through the Agent.generate() .catch() in @autobroker/workflows
// (harness.ts) which records ONE NULL-not-$0 ledger row and re-throws — so an
// armed llm_* fault fails the run CLOSED, never a fabricated "success" (inv #4/#12).
export type HarnessGenerateFault = "none" | "llm_500" | "llm_timeout";

let _harnessGenerateFault: HarnessGenerateFault = "none";

export function __setHarnessGenerateFaultForTests(fault: HarnessGenerateFault): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setHarnessGenerateFaultForTests is a test-only seam (refused outside a test runner)",
    );
  }
  _harnessGenerateFault = fault;
}

export function __resetHarnessGenerateFaultForTests(): void {
  _harnessGenerateFault = "none";
}

/** Wrap a resolved v3 model so doGenerate/doStream reject. Preserves identity
 *  fields (modelId for pricing, specificationVersion) so the ledger row still
 *  records the real route — the throw, not a fabricated success, is what we test. */
function wrapWithGenerateFault(
  model: LanguageModel,
  fault: Exclude<HarnessGenerateFault, "none">,
): LanguageModel {
  if (typeof model === "string") return model; // a bare-string id has no doGenerate to fault.
  const reject = async (): Promise<never> => {
    if (fault === "llm_timeout") {
      await new Promise((r) => setTimeout(r, 50)); // reject-after-delay, not a real hang.
    }
    throw new Error(`injected LLM fault: ${fault}`);
  };
  // A Proxy intercepts ONLY doGenerate/doStream and delegates everything else to the
  // REAL model — preserving its prototype, getters, and identity fields (modelId,
  // provider, specificationVersion, supportedUrls) that Mastra's agent/schema-compat
  // layer reads before any call. (A spread/clone would drop the prototype + getters
  // and crash Mastra's tool builder.) Reads use the default receiver (this=target) and
  // methods are bound to target so private-field access never trips on the proxy.
  return new Proxy(model, {
    get(target, prop) {
      if (prop === "doGenerate" || prop === "doStream") return reject;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// --- TEST-ONLY model-wrapper seam (Phase-4 record/replay) ------------------
// Lets the harness swap a wrapped model in through resolveModel WITHOUT touching
// @autobroker/workflows: the wrapper (e.g. recordingModel / replayModel) is
// applied on TOP of the fault wrap. NEVER armed in production — the set() refuses
// outside a test runner, the same guard rule as __setHarnessGenerateFaultForTests.
// When unset (null default) resolveModel is byte-identical to today.
let _harnessModelWrapper: ((model: LanguageModel, alias: string) => LanguageModel) | null = null;

export function __setHarnessModelWrapper(
  fn: (model: LanguageModel, alias: string) => LanguageModel,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setHarnessModelWrapper is a test-only seam (refused outside a test runner)",
    );
  }
  _harnessModelWrapper = fn;
}

export function __resetHarnessModelWrapper(): void {
  _harnessModelWrapper = null;
}
