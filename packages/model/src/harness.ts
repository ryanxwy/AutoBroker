/**
 * harness.generate — provider-neutral structured-generation contract (Layer 2).
 *
 * OWNERSHIP (the layer-ownership decision): the Mastra Agent loop lives in
 * `@autobroker/workflows`; `@autobroker/model` keeps ONLY the pure pieces and
 * the signature types. Concretely:
 *   - model owns: useCase→alias policy, the structured-output STRATEGY choice
 *     (`chooseStructuredOutputStrategy`), the Zod post-validation surface, the
 *     cost/usage table, and the canonical-message ↔ ModelMessage translator.
 *   - workflows owns: the Mastra Agent loop end-to-end AND exports the runnable
 *     `harness.generate` facade. It imports these types + helpers from here.
 *
 * Why the split: only the api-key lane lets the AI SDK own the tool loop, and
 * Mastra is the framework that drives that loop. `@mastra/*` may only be
 * imported in `@autobroker/workflows` (the five-layer wall), so the actual
 * loop — and therefore the facade `const harness` — cannot live in this layer.
 * This file is the typed seam between the two.
 *
 * Structured-output rule: when the routed model cannot mix `Output.object` with
 * tools (DeepSeek — per-step json_schema injection provokes a text-dump), the
 * workflows loop uses the single `emit_result` tool (Zod-validated in-process)
 * instead of structured object output. NEVER mix structured object output with
 * tools on such a model. The strategy is chosen HERE from
 * `policy(useCase).capabilities.supportsOutputObjectWithTools` via
 * `chooseStructuredOutputStrategy`, then honored by the loop.
 */

import { z } from "zod";
import type { CapabilityFlags } from "@autobroker/core";
import type { UseCase } from "./policy.js";

export interface HarnessGenerateInput<TSchema extends z.ZodTypeAny> {
  /** Provider-neutral use-case; policy() maps it to a ModelAlias. */
  useCase: UseCase;
  /** The Zod contract the result MUST satisfy (post-validation belt). */
  schema: TSchema;
  /** The prompt / messages payload. TODO: type as canonical-message[] once the
   *  canonical-message <-> ModelMessage translator lands in this layer. */
  prompt: string;
}

export interface HarnessGenerateResult<T> {
  /** Zod-validated structured object. */
  object: T;
  /** Cost + latency, always recorded into test_run_records. usage missing =>
   *  cost_usd null + pricing_source "unavailable", never silently $0
   *  (NULL-not-$0 cost-metering rule). */
  usage: {
    costUsd: number | null;
    durationMs: number;
    pricingSource: "computed" | "unavailable";
    promptTokens: number | null;
    completionTokens: number | null;
  };
}

/**
 * The two structured-output strategies the workflows loop can run.
 *   - `output_object`: native `Output.object` (+ tools) in one model step.
 *   - `emit_result`:   a single `emit_result` tool carrying a Zod schema; the
 *     ONLY safe path when the model cannot mix object output with tools.
 */
export type StructuredOutputStrategy = "emit_result" | "output_object";

/**
 * Pure strategy selector — the load-bearing #1244 decision, kept in the model
 * layer so the workflows loop never re-derives it.
 *
 * Returns `emit_result` exactly when the routed model CANNOT mix structured
 * object output with tools (`supportsOutputObjectWithTools === false`, e.g.
 * DeepSeek), and `output_object` otherwise. No provider names appear here; the
 * decision is driven purely by the capability flag.
 */
export function chooseStructuredOutputStrategy(
  capabilities: CapabilityFlags,
): StructuredOutputStrategy {
  return capabilities.supportsOutputObjectWithTools
    ? "output_object"
    : "emit_result";
}
