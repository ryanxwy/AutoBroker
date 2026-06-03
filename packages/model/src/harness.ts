/**
 * harness.generate — provider-neutral structured-generation entry (Layer 2).
 *
 * STUB: the single chokepoint every skill calls for a schema-valid structured
 * result. It is provider-neutral: the caller passes a `useCase` (NOT a provider)
 * and a Zod `schema`; policy() picks the alias, the registry resolves the model,
 * and this function owns the api-key tool loop end to end.
 *
 * Why "harness" owns the loop: on the api-key lane the AI SDK owns the agentic
 * tool loop, so this is where the #1244 fail-closed detector runs, where the
 * in-process gate handler is reached, and where Zod post-validation belts the
 * structured output. (architectureStack §"运行时 / tool loop owner".)
 *
 * Structured-output rule (currentTruth §"结构化输出机制"): when the routed model
 * cannot mix Output.object with tools (DeepSeek — #1244), use the single
 * `emit_result` tool (Zod-validated in-process) OR a two-phase pipeline
 * (tools-only loop, then a separate no-tools generateText + Output.object).
 * NEVER mix Output.object with tools on such a model. The strategy is chosen
 * from `policy(useCase).capabilities.supportsOutputObjectWithTools`.
 */

import { z } from "zod";
import { policy, type UseCase } from "./policy.js";
import { resolveModel } from "./registry.js";
import {
  assertToolTurnOrFailClosed,
  type MalformedSignal,
} from "./malformedToolCall.js";

export interface HarnessGenerateInput<TSchema extends z.ZodTypeAny> {
  /** Provider-neutral use-case; policy() maps it to a ModelAlias. */
  useCase: UseCase;
  /** The Zod contract the result MUST satisfy (post-validation belt). */
  schema: TSchema;
  /** The prompt / messages payload. TODO: type as canonical-message[] once the
   *  canonical-message <-> ModelMessage translator lands in this layer. */
  prompt: string;
  /** Whether a human is available to suspend to on a fail-closed event. The
   *  in-process loop suspends if true, hard-aborts (typed) if false. */
  hitlAvailable: boolean;
}

export interface HarnessGenerateResult<T> {
  /** Zod-validated structured object. */
  object: T;
  /** Cost + latency, always recorded into test_run_records. usage missing =>
   *  cost_usd null + pricing_source "unavailable", never silently $0.
   *  (currentTruth §"成本/时间度量".) */
  usage: {
    costUsd: number | null;
    durationMs: number;
    pricingSource: "computed" | "unavailable";
    promptTokens: number | null;
    completionTokens: number | null;
  };
}

/** A fail-closed suspend surfaced to the workflow layer (not thrown). */
export interface HarnessSuspend {
  suspended: true;
  reason: "malformed_tool_call";
  signals: MalformedSignal[];
}

/**
 * Provider-neutral structured generation.
 *
 * Skeleton of the intended control flow (each step is TODO):
 *   1. const route = policy(input.useCase); const model = resolveModel(route.alias);
 *   2. choose structured-output strategy from route.capabilities:
 *        supportsOutputObjectWithTools ? Output.object+tools : emit_result tool.
 *   3. run the AI SDK tool loop (stepCountIs default ~20); after EACH
 *      tool-expecting step call assertToolTurnOrFailClosed(turn, hitlAvailable):
 *        - thrown MalformedToolCallAbort propagates (no HITL),
 *        - {suspend:true} returns a HarnessSuspend to the workflow layer.
 *   4. Zod post-validate against input.schema (belt-and-suspenders).
 *   5. compute usage -> cost via the self-managed pricing table; null+flag if
 *      the provider gave no usage.
 *
 * The signature is final; the body is intentionally unimplemented.
 */
export async function generate<TSchema extends z.ZodTypeAny>(
  input: HarnessGenerateInput<TSchema>,
): Promise<HarnessGenerateResult<z.infer<TSchema>> | HarnessSuspend> {
  const route = policy(input.useCase);
  const _model = resolveModel(route.alias);
  void _model; // referenced so the wiring intent is type-checked; loop is TODO.

  // The detector is part of this loop's contract; reference it so the import is
  // load-bearing and the fail-closed seam is visible at the type level.
  void assertToolTurnOrFailClosed;

  // TODO(Phase 0): implement the api-key tool loop + emit_result / two-phase
  // strategy selection + Zod post-validation + cost/time accounting per the
  // control-flow skeleton above. Until then this entry is unimplemented.
  throw new Error("harness.generate: not implemented (Phase 0 foundation stub)");
}

/** Provider-neutral harness facade. Skills call `harness.generate({...})`. */
export const harness = {
  generate,
} as const;
