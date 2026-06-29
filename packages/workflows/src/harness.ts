/**
 * harness.generate — the runnable structured-generation facade (Layer 3).
 *
 * OWNERSHIP: only the api-key lane lets the AI SDK own the tool loop, and Mastra
 * is the framework that drives that loop. `@mastra/*` may only be imported in
 * `@autobroker/workflows` (the five-layer wall), so the runnable facade — the
 * Mastra Agent loop end-to-end — lives HERE. `@autobroker/model` keeps only the
 * pure pieces and the signature types (HarnessGenerateInput/Result/Suspend,
 * chooseStructuredOutputStrategy, the #1244 detector, pricing, the
 * canonical-message translator); this file imports them and wires the loop.
 *
 * CONTROL FLOW:
 *   1. policy(useCase) → alias + capabilities; resolveModel(alias) → LanguageModel
 *      (fail-LOUD inherited from policy()).
 *   2. chooseStructuredOutputStrategy(capabilities): 'output_object'
 *      (supportsOutputObjectWithTools:true — Anthropic/OpenAI) dispatches to the
 *      NATIVE structured-output path (generateOutputObject); 'emit_result'
 *      (DeepSeek) runs the single-tool discipline. Never cross the two strategies.
 *   3. emit_result path: ONE Mastra `createTool` named 'emit_result' whose
 *      inputSchema is the caller's Zod contract; its execute closure captures the
 *      Mastra-validated args. NO other tools. Per-request the call forces:
 *        - named tool_choice { type:'tool', toolName:'emit_result' }
 *        - DeepSeek thinking DISABLED (providerOptions.deepseek.thinking.type)
 *        - temperature 0 (modelSettings)
 *      Platform constraint (live-verified 2026-06-04): DeepSeek thinking mode
 *      REJECTS a named/forced tool_choice, so an emit_result step MUST disable
 *      thinking per-request. The real provider key is `@ai-sdk/deepseek`'s
 *      `deepseekLanguageModelOptions.thinking.type` = 'disabled' (confirmed in the
 *      .d.ts, not guessed).
 *   4. Construct a Mastra Agent and call agent.generate with
 *      outputProcessors:[malformedToolCallProcessor({hitlAvailable, expectsToolCall:()=>true})].
 *   4b/5. #1244 fail-closed. CRITICAL behavioral fact (live-probed against
 *      @mastra/core@1.41.0, offline fake-model probe 2026-06-04): a tripped
 *      output Processor does NOT reject agent.generate(); the Agent CATCHES the
 *      processor TripWire and RESOLVES the result with `result.tripwire`
 *      populated and `result.finishReason === 'tripwire'`. So we inspect the
 *      RESOLVED field — we do not try/catch a throw on this lane. When
 *      result.tripwire.metadata.reason === 'malformed_tool_call':
 *        hitlAvailable → return HarnessSuspend; no HITL → throw the typed
 *        MalformedToolCallAbort(signals). (The alternate workflow-step path DOES
 *        throw — that is not the path agent.generate takes.)
 *      Belt (stage 4b): if the run did NOT trip yet the emit_result capture is
 *      still empty, run the pure detector over the real finishReason /
 *      toolCallCount / final text — ledger first, then suspend or abort, NEVER
 *      fall through to prose (detect→ledger→act ordering).
 *   6. (Zod authority) the model output is advisory; input.schema is the
 *      law. Mastra validates emit_result's args against that schema at the TOOL
 *      BOUNDARY before execute (live-probed) — a contract violation is recorded
 *      as a typed ValidationError in toolResults with finishReason still
 *      'tool-calls' (so #1244 correctly does NOT trip; a tool WAS called). The
 *      harness detects that rejection (Mastra's isValidationError guard, never a
 *      message string-match) and surfaces it as a ZodError, fail_reason
 *      'zod_validation'. On the success path it additionally re-runs
 *      input.schema.parse(captured) as defense-in-depth (same verdict on drift).
 *   7. (ledger) EVERY call — success AND every failure branch — writes
 *      exactly ONE test_run_records row through @autobroker/tools'
 *      writeTestRunRecord (the single ledger write path; SQLite invariant).
 *      Cost is NULL-not-$0: usage missing → costUsd null + pricingSource
 *      'unavailable'. Wall-clock durationMs is always recorded.
 *
 * Prompt: input.prompt is a flat string; it is routed through the model
 * layer's toModelMessages([{role:'user',...}]) so the canonical-message ↔
 * ModelMessage translator is load-bearing on this lane.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/model (pure
 * helpers + types), @autobroker/tools (the ledger writer — the ONLY DB path),
 * @autobroker/core (types), and zod (post-validation). NEVER opens the product
 * DB or calls a provider directly — Mastra owns the model call, tools owns the DB.
 */

import { Agent } from "@mastra/core/agent";
import { createTool, isValidationError } from "@mastra/core/tools";
import type { OutputProcessorOrWorkflow } from "@mastra/core/processors";
import { z } from "zod";

import {
  chooseStructuredOutputStrategy,
  claudeOAuthQuery,
  computeCostUsd,
  detectMalformedToolCall,
  MalformedToolCallAbort,
  policy,
  redactMalformedSample,
  resolveModel,
  toModelMessages,
  type HarnessGenerateInput,
  type HarnessGenerateResult,
  type HarnessSuspend,
  type PolicyResolution,
  type UseCase,
} from "@autobroker/model";
import { llmLimiter, writeTestRunRecord, type Db } from "@autobroker/tools";

import { applySelection, resolveSelectionForRun } from "./agentSelection.js";
import {
  malformedToolCallProcessor,
  type MalformedToolCallTripMetadata,
} from "./malformedToolCallProcessor.js";

/** The Mastra `model` config slot, narrowed off the Agent constructor so the
 *  `unknown` fake/resolved model can be handed to `new Agent({ model })` without
 *  naming an `ai`-layer type here (the five-layer wall keeps `ai` types in
 *  @autobroker/model; the runtime compatibility is live-probed). */
type AgentModelConfig = ConstructorParameters<typeof Agent>[0]["model"];

/**
 * Caller-supplied ledger identity for the one test_run_records row this run
 * writes. REQUIRED (no invented defaults — fail-loud beats a silent placeholder
 * that fakes provenance): each skill passes its own. Members
 * mirror the table's caller-owned columns (packages/db testRunRecords).
 *
 * provider / model_alias are NOT members: the ledger derives them from
 * policy(input.useCase) at the generate seam itself, so the recorded route is
 * always the route that actually served the call — a caller-supplied string
 * would silently go stale the moment the policy mapping changes.
 */
export interface HarnessLedgerContext {
  /** Run window id (test_run_records.run_id). */
  runId: string;
  /** Skill name (test_run_records.skill). */
  skill: string;
  /** Test layer label, 'L1'..'L5' (test_run_records.layer). */
  layer: string;
  /** Prompt hash / version, or null (test_run_records.prompt_version). */
  promptVersion: string | null;
  /** Zod contract version, or null (test_run_records.schema_version). */
  schemaVersion: string | null;
}

/** The fixed name of the single structured-output tool (emit_result discipline). */
const EMIT_RESULT_TOOL = "emit_result" as const;

/**
 * The useCases that run the emit_result tool on the THINKING lane instead of the
 * default forced-emit lane: thinking ON + tool_choice:"auto" rather than thinking
 * DISABLED + a named/forced tool_choice. The members are the malformed-class
 * recovery hops (the *_retry useCases → deepseek-v4-pro WITH thinking).
 *
 * Why a separate lane: DeepSeek thinking mode REJECTS a named/forced tool_choice
 * ("Thinking mode does not support this tool_choice"), so an emit_result step
 * that wants the model to REASON first cannot force the tool. With tool_choice
 * "auto" the model reasons (thinking) then voluntarily calls the single
 * emit_result tool — structurally the same clean thinking-ON + auto lane the
 * chat/rail runs. The single-tool discipline, the #1244 fail-closed detector and
 * the Zod post-validation belt are IDENTICAL on both lanes; ONLY the toolChoice
 * + thinking switch differ.
 */
export const THINKING_AUTO_EMIT_USE_CASES: ReadonlySet<UseCase> = new Set<UseCase>([
  "dealer_reply_extract_retry",
  "geosearch_extract_retry",
  "inventory_extract_retry",
  "incentive_extract_retry",
  "lead_form_map_retry",
]);

/**
 * Per-useCase reasoning effort on the thinking-emit lane. The original
 * dealer_reply_extract_retry hop stays "high" (its dealer-reply extraction is the
 * heaviest schema). The shared-helper hops recover a SERIALIZATION defect, not a
 * reasoning-difficulty one, so they fall through to "medium" (the `?? "medium"`
 * at the call site). Adding a member here is the only way to raise a hop above
 * "medium".
 */
export const THINKING_EMIT_EFFORT: Partial<Record<UseCase, "high" | "medium">> = {
  dealer_reply_extract_retry: "high",
};

/**
 * Input to the PROSE facade `draftProse` — a strict subset of
 * HarnessGenerateInput with NO schema and NO hitlAvailable: a no-tool plain text
 * generation. The negotiation-follow-up draft step is the only caller; the tone
 * is decided in CODE and the prompt carries the chosen register.
 */
export interface DraftProseInput {
  /** Provider-neutral use-case; policy() maps it to a ModelAlias. */
  useCase: UseCase;
  /** The already-built draft prompt (fenced untrusted dealer text, red lines). */
  prompt: string;
}

/** The result of a PROSE generation: the model's text + the same usage shape the
 *  structured facade returns (minus the parsed object). */
export interface DraftProseResult {
  text: string;
  usage: {
    costUsd: number | null;
    durationMs: number;
    pricingSource: "computed" | "unavailable";
    promptTokens: number | null;
    completionTokens: number | null;
  };
}

/** ISO-ish date bucket for the ledger created_at column (YYYY-MM-DD). */
function createdAtBucket(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Best-effort concrete model id for pricing. `ai`'s LanguageModel is
 * `string | LanguageModelV3 | LanguageModelV2`; the registry returns the V3
 * object for DeepSeek whose `.modelId` ('deepseek-v4-flash' / '-pro') is exactly
 * a PRICING table key. A bare-string model id is returned verbatim. An unknown
 * id simply falls through to 'unavailable' in computeCostUsd (NULL-not-$0).
 */
function concreteModelId(model: unknown): string {
  if (typeof model === "string") return model;
  if (
    model !== null &&
    typeof model === "object" &&
    "modelId" in model &&
    typeof (model as { modelId: unknown }).modelId === "string"
  ) {
    return (model as { modelId: string }).modelId;
  }
  // No concrete id → unpriceable; computeCostUsd renders this as 'unavailable'.
  return "";
}

/**
 * INTERNAL test seam — NEVER pass these from production code. Lets the harness
 * test drive the REAL Agent → REAL processor → REAL ledger chain against a
 * deterministic fake model and an isolated tmp DB, without a vitest module mock
 * (the agent/processor/tripwire/ledger path stays genuinely exercised — that is
 * the in-stack evidence we require): a real chain over a fake model, not a mock.
 */
export interface HarnessTestOverrides {
  /** Inject a fake LanguageModel (use @autobroker/model testSupport factories). */
  model?: unknown;
  /** Inject the isolated tmp-DB handle the ledger row is written through. */
  db?: Db;
  /** Inject a fake lane-B (Claude OAuth) query so the SDK subprocess never spawns
   *  in a unit test. Same guard as `model`/`db`: refused outside a test runner. */
  claudeOAuthQuery?: typeof claudeOAuthQuery;
}

/**
 * Run one structured generation: resolve route → force the emit_result discipline
 * → drive the Mastra Agent through the #1244 fail-closed processor → assert the
 * tool turn (belt) → Zod-validate the captured args → price + write one ledger
 * row. Resolves to a Zod-validated object, or a HarnessSuspend (HITL fail-closed),
 * or throws MalformedToolCallAbort / ZodError (each recorded with its own
 * fail_reason). Dispatches to the native output_object path when the routed model
 * supports structured object output with tools (Anthropic / OpenAI).
 */
async function generate<TSchema extends z.ZodTypeAny>(
  input: HarnessGenerateInput<TSchema>,
  ledger: HarnessLedgerContext,
  _testOverrides?: HarnessTestOverrides,
): Promise<HarnessGenerateResult<z.infer<TSchema>> | HarnessSuspend> {
  const startedAt = Date.now();

  // Test-seam guard (review F3, 2026-06-05): the override param is structurally
  // reachable through the public `typeof generate` type, so refuse it LOUD when
  // no test runner is present — a production caller must never inject a model
  // or redirect the ledger DB through this seam.
  if (
    _testOverrides !== undefined &&
    process.env["VITEST"] === undefined &&
    process.env["NODE_ENV"] !== "test"
  ) {
    throw new Error(
      "harness.generate: _testOverrides is a test-only seam (refused outside a test runner)",
    );
  }

  // Stage 1 — route (fail-LOUD inherited from policy()). Lane-A provider
  // override: a per-run / env selection re-homes a DeepSeek-default route onto
  // the chosen provider (identity when there is no selection, or when the route
  // is already a non-DeepSeek pin like cross_provider_smoke's anthropic.chat).
  // With NO selection this is byte-identical to policy(input.useCase). Every
  // downstream consumer — resolveModel, the strategy gate, generateOutputObject,
  // and the ledger writes — reads `route`, so the override is honored uniformly.
  let route = policy(input.useCase);
  const sel = resolveSelectionForRun(ledger.runId);
  if (sel) route = applySelection(route, sel);

  // Lane B — Claude OAuth via the official Agent SDK (subscription token). When
  // the run's selection is anthropic+oauth the api-key Mastra loop does NOT fire:
  // a single tool-disabled, min-env subprocess query serves the call (native
  // outputFormat:json_schema → structured_output). Structurally exempt from #1244
  // (no api-key tool loop; native structured output), so there is NO
  // detector/recovery here — Zod `.parse` THROWS as the fail-closed belt. The
  // model id is the concrete claude-* id behind the (re-homed) anthropic alias.
  if (sel?.provider === "anthropic" && sel?.method === "oauth") {
    const oauthQuery = _testOverrides?.claudeOAuthQuery ?? claudeOAuthQuery;
    const oauthModelId = concreteModelId(resolveModel(route.alias));
    const r = await oauthQuery({
      prompt: input.prompt,
      jsonSchema: z.toJSONSchema(input.schema),
      model: oauthModelId,
    });
    const object = input.schema.parse(r.structuredOutput) as z.infer<TSchema>;
    const laneBDuration = Date.now() - startedAt;
    // Subscription is flat-rate: cost is NULL + pricing_source 'subscription'
    // (honest — never a fabricated $0; tokens recorded for volume metering).
    writeTestRunRecord(
      {
        runId: ledger.runId,
        skill: ledger.skill,
        createdAt: createdAtBucket(),
        layer: ledger.layer,
        provider: route.provider,
        modelAlias: route.alias,
        costUsd: null,
        latencyMs: laneBDuration,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        pricingSource: "subscription",
        priceInputPerMtok: null,
        priceOutputPerMtok: null,
        promptVersion: ledger.promptVersion,
        schemaVersion: ledger.schemaVersion,
        failReason: null,
        malformedSignals: null,
        malformedSample: null,
      },
      ..._dbArg(_testOverrides),
    );
    return {
      object,
      usage: {
        costUsd: null,
        durationMs: laneBDuration,
        pricingSource: "unavailable",
        promptTokens: r.usage.inputTokens,
        completionTokens: r.usage.outputTokens,
      },
    };
  }

  const model = _testOverrides?.model ?? resolveModel(route.alias);
  const modelId = concreteModelId(model);

  // Per-provider LLM pacing (LimiterRegistry, below the L2 gate): bound the
  // combined call rate to `route.provider` so N concurrent pipelines don't burst
  // one provider. Covers BOTH downstream strategy paths (this entry runs before
  // the output_object branch and the emit_result branch). Skipped when a test
  // injects a model (no real provider call to pace) so the unit suite is never
  // delayed.
  if (_testOverrides?.model === undefined) await llmLimiter.acquireLlm(route.provider);

  // Stage 2 — strategy gate. supportsOutputObjectWithTools:true (Anthropic /
  // OpenAI) routes to the NATIVE structured-output path; DeepSeek's false routes
  // to the emit_result discipline below. The
  // pure selector owns the #1244 decision; this branch only dispatches.
  const strategy = chooseStructuredOutputStrategy(route.capabilities);
  if (strategy === "output_object") {
    return generateOutputObject(input, ledger, route, model, modelId, startedAt, _testOverrides);
  }

  // Stage 3 — the single emit_result tool. Its execute closure captures the
  // Mastra-validated args (Mastra validates against inputSchema before calling
  // execute); we still re-validate with Zod below (Zod is the authority).
  let captured: unknown;
  let capturedSeen = false;
  const emitResult = createTool({
    id: EMIT_RESULT_TOOL,
    description:
      "Emit the final structured result. Call this exactly once with the full result object.",
    inputSchema: input.schema,
    execute: async (inputData) => {
      captured = inputData;
      capturedSeen = true;
      // Terminal ack — the loop ends after this single tool fires.
      return { ok: true };
    },
  });

  // Stage 9 — prompt routed through the canonical-message translator.
  const messages = toModelMessages([{ role: "user", content: input.prompt }]);

  // The thinking lane (the malformed-class recovery hop) reasons first, so the
  // model must be free to think BEFORE the tool fires. The default lane forces
  // the tool and disables thinking (a forced tool_choice is rejected in DeepSeek
  // thinking mode). Both lanes bind the SAME single emit_result tool, run the
  // SAME #1244 processor, and Zod-validate the SAME captured args — only the
  // toolChoice + thinking switch differ.
  const thinkingLane = THINKING_AUTO_EMIT_USE_CASES.has(input.useCase);

  const agent = new Agent({
    id: "harness-emit",
    name: "harness-emit",
    instructions: thinkingLane
      ? "Reason about the input, then produce the final result by calling the emit_result tool exactly once. Do not answer in prose."
      : "You must produce the final result by calling the emit_result tool exactly once. Do not answer in prose.",
    model: model as AgentModelConfig,
    tools: { [EMIT_RESULT_TOOL]: emitResult },
  });

  // Stage 4 — the agent call. Default lane: force the emit_result discipline
  // per-request (named tool_choice + DeepSeek thinking disabled). Thinking lane:
  // tool_choice "auto" + thinking ENABLED (forced tool_choice is rejected in
  // thinking mode); the model reasons then voluntarily calls emit_result. Both
  // lanes keep temperature 0 and run the #1244 processor on every output step
  // (expectsToolCall defaults to () => true) — fail-closed is identical.
  // Review F1 (2026-06-05): a THROW from the model call itself (provider 5xx,
  // transport failure, retry exhaustion) is a run that HAPPENED — record one
  // ledger row (usage unknown ⇒ NULL-not-$0) before propagating the error. If
  // that ledger write itself throws (broken local DB) it wins — both are hard
  // local faults and neither may be swallowed.
  const result = await agent
    .generate(messages, {
      toolChoice: thinkingLane ? "auto" : { type: "tool", toolName: EMIT_RESULT_TOOL },
      // The processor's `processOutputStep` is declared optional on the broad
      // `Processor` interface but the agent's `OutputProcessor` slot wants it
      // present; our processor always defines it (live-probed clean). Cast to the
      // exact expected union — faithful, not an `any` escape.
      outputProcessors: [
        malformedToolCallProcessor({
          hitlAvailable: input.hitlAvailable,
        }) as OutputProcessorOrWorkflow<MalformedToolCallTripMetadata>,
      ],
      // DeepSeek per-request thinking switch — real provider keys from the .d.ts
      // (deepseekLanguageModelOptions: thinking.type + reasoningEffort). Harmless
      // on providers that ignore an unknown providerOptions namespace. The
      // recovery hop turns thinking ON (its whole point is to reason past the
      // serialization defect that failed the thinking-OFF first hop). reasoningEffort
      // is per-useCase via THINKING_EMIT_EFFORT (dealer_reply_extract_retry stays
      // "high"; the other recovery hops fall through to "medium").
      //
      // Cast note: Mastra vendors a NARROWER `@ai-sdk_deepseek-v5` provider-options
      // type (reasoningEffort only "high"|"max") than the RESOLVED runtime provider
      // @ai-sdk/deepseek@2.0.x, whose schema is the full low|medium|high|xhigh|max
      // scale. "medium" is therefore runtime-valid (the resolved provider executes
      // the call) but rejected by Mastra's stale compile-time slot — bridge the
      // effort literal across that single stale union here.
      providerOptions: thinkingLane
        ? {
            deepseek: {
              thinking: { type: "enabled" },
              reasoningEffort: (THINKING_EMIT_EFFORT[input.useCase] ?? "medium") as "high" | "max",
            },
          }
        : { deepseek: { thinking: { type: "disabled" } } },
      modelSettings: { temperature: 0 },
    })
    .catch((err: unknown) => {
      writeTestRunRecord(
        {
          runId: ledger.runId,
          skill: ledger.skill,
          createdAt: createdAtBucket(),
          layer: ledger.layer,
          // Route identity comes from policy(useCase), never a caller string.
          provider: route.provider,
          modelAlias: route.alias,
          costUsd: null,
          latencyMs: Date.now() - startedAt,
          inputTokens: null,
          outputTokens: null,
          pricingSource: "unavailable",
          priceInputPerMtok: null,
          priceOutputPerMtok: null,
          promptVersion: ledger.promptVersion,
          schemaVersion: ledger.schemaVersion,
          failReason: err instanceof Error ? err.name : "model_call_failed",
        },
        ..._dbArg(_testOverrides),
      );
      throw err;
    });

  const durationMs = Date.now() - startedAt;

  // Usage → flat numbers (Mastra normalizes provider usage to LanguageModelV2Usage:
  // inputTokens/outputTokens are `number | undefined`). undefined → null (NULL-not-$0).
  const promptTokens = result.usage?.inputTokens ?? null;
  const completionTokens = result.usage?.outputTokens ?? null;
  const { costUsd, pricingSource } = computeCostUsd(modelId, promptTokens, completionTokens);
  const priceColumns = pricingColumns(modelId, pricingSource);

  /** Write the one ledger row for this run with the given verdict. The route
   *  identity (provider + alias) is the policy() resolution, never a caller
   *  string. */
  const writeLedger = (
    failReason: string | null,
    malformed?: { signals: ReadonlyArray<string>; text: string },
  ): void => {
    writeTestRunRecord(
      {
        runId: ledger.runId,
        skill: ledger.skill,
        createdAt: createdAtBucket(),
        layer: ledger.layer,
        provider: route.provider,
        modelAlias: route.alias,
        costUsd,
        latencyMs: durationMs,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        pricingSource,
        priceInputPerMtok: priceColumns.input,
        priceOutputPerMtok: priceColumns.output,
        promptVersion: ledger.promptVersion,
        schemaVersion: ledger.schemaVersion,
        failReason,
        // #1244 evidence — ONLY the malformed branch passes a payload. The
        // untrusted turn text is truncated + PII/budget-REDACTED (inv #9) by
        // redactMalformedSample BEFORE it is persisted; non-malformed rows leave
        // both columns NULL.
        malformedSignals: malformed ? malformed.signals.join(",") : null,
        malformedSample: malformed ? redactMalformedSample(malformed.text) : null,
      },
      ..._dbArg(_testOverrides),
    );
  };

  // Stage 4b/5 — #1244 fail-closed. A tripped processor RESOLVES with
  // result.tripwire populated (live-probed; NOT a throw on this lane). The
  // metadata IS our MalformedToolCallTripMetadata.
  const trip = readMalformedTrip(result.tripwire);
  if (trip !== null) {
    writeLedger("malformed_tool_call", { signals: trip.signals, text: result.text ?? "" });
    if (input.hitlAvailable) {
      return { suspended: true, reason: "malformed_tool_call", signals: trip.signals };
    }
    throw new MalformedToolCallAbort(trip.signals);
  }

  // Stage 5 — Zod authority (tool-boundary). Mastra validates emit_result's args
  // against input.schema BEFORE calling execute (live-probed). If the model's
  // args violate the contract, execute never captures and Mastra records a typed
  // ValidationError in toolResults while finishReason stays 'tool-calls' (so the
  // #1244 processor correctly does NOT trip — a tool WAS called). That rejection
  // IS the Zod-authority failure ("hallucinated/invalid fields fail loud"); we
  // surface it as a ZodError and ledger it 'zod_validation'. (model output is
  // advisory; the schema is the law.)
  if (!capturedSeen) {
    const validationError = findToolInputValidationError(result.toolResults);
    if (validationError !== null) {
      writeLedger("zod_validation");
      throw toZodError(validationError);
    }
  }

  // Belt (stage 4b): no validation rejection either, yet the terminal tool never
  // fired — refuse to fall through to prose. The belt runs the same pure detector
  // over the REAL turn view (real finishReason + real tool-call count + final
  // text). Review F2 (2026-06-05): ledger BEFORE the fail-closed action — the
  // earlier assertToolTurnOrFailClosed call threw internally on the no-HITL
  // branch, skipping the row; detect-then-ledger-then-act keeps the
  // one-row-per-call contract on every sub-branch.
  if (!capturedSeen) {
    const signals = detectMalformedToolCall({
      finishReason: normalizeFinishReason(result.finishReason),
      expectsToolCall: true,
      toolCallCount: result.toolCalls?.length ?? 0,
      content: result.text ?? "",
    });
    if (signals.length === 0) {
      // Defensive: detector found nothing yet no tool result captured. Fail
      // CLOSED rather than parse an undefined capture (silent prose-fallthrough
      // is forbidden). Unreachable in practice (a captured-less turn always
      // raises a signal), but never let an empty capture reach success.
      writeLedger("empty_tool_call_no_signal");
      throw new MalformedToolCallAbort(["empty_tool_calls"]);
    }
    writeLedger("malformed_tool_call", { signals, text: result.text ?? "" });
    if (input.hitlAvailable) {
      return { suspended: true, reason: "malformed_tool_call", signals };
    }
    throw new MalformedToolCallAbort(signals);
  }

  // Stage 5 belt — re-validate the captured args with Zod. The tool boundary
  // already enforced the same schema, so this is defense-in-depth: it catches a
  // post-capture drift and keeps the Zod-authority guarantee explicit on the
  // success path. A failure here is still a 'zod_validation' verdict.
  let object: z.infer<TSchema>;
  try {
    object = input.schema.parse(captured) as z.infer<TSchema>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      writeLedger("zod_validation");
    } else {
      writeLedger(err instanceof Error ? err.name : "unknown_error");
    }
    throw err;
  }

  // Success — ledger row with no fail reason.
  writeLedger(null);

  return {
    object,
    usage: {
      costUsd,
      durationMs,
      pricingSource: pricingSource === "unavailable" ? "unavailable" : "computed",
      promptTokens,
      completionTokens,
    },
  };
}

/**
 * The NATIVE structured-output (`output_object`) lane — used when the routed
 * model can mix structured object output with tools
 * (`supportsOutputObjectWithTools === true`: Anthropic / OpenAI per their docs,
 * verified 2026-06-05). Instead of the emit_result single-tool discipline, Mastra
 * drives the model with `structuredOutput: { schema }`, which (live-probed against
 * @mastra/core@1.41.0, offline 2026-06-05) injects a NATIVE
 * `responseFormat: { type:'json', schema }` into the model call, registers NO
 * tools, and parses the model's JSON-text response into `result.object`.
 *
 * Same discipline as emit_result on every cross-cutting axis:
 *   - Zod AUTHORITY (stage 5): `result.object` is advisory; we re-run
 *     input.schema.parse over it and fail 'zod_validation' on drift.
 *   - #1244 processor STILL attached, but with `expectsToolCall: () => false`:
 *     this lane legitimately finishes with `stop` + no tool call, so the
 *     finish_reason / empty-tool-calls signals must NOT fire (they would
 *     false-trip every clean structured turn — live-probed C2). Only a
 *     tool-shaped blob in content can still trip, which is harmless on a clean
 *     provider and a real #1244 catch if one ever appears. Fail-closed mapping
 *     (HITL suspend / no-HITL MalformedToolCallAbort) is identical.
 *   - LEDGER: exactly ONE test_run_records row on every branch (success AND every
 *     failure), cost NULL-not-$0, wall-clock always recorded — same writer path.
 *   - NO DeepSeek thinking providerOptions here (this lane is never DeepSeek; the
 *     #1244 emit_result thinking-off constraint is a DeepSeek-only concern).
 */
async function generateOutputObject<TSchema extends z.ZodTypeAny>(
  input: HarnessGenerateInput<TSchema>,
  ledger: HarnessLedgerContext,
  route: PolicyResolution,
  model: unknown,
  modelId: string,
  startedAt: number,
  _testOverrides: HarnessTestOverrides | undefined,
): Promise<HarnessGenerateResult<z.infer<TSchema>> | HarnessSuspend> {
  // Prompt routed through the canonical-message translator, same as the
  // emit_result lane.
  const messages = toModelMessages([{ role: "user", content: input.prompt }]);

  const agent = new Agent({
    id: "harness-output-object",
    name: "harness-output-object",
    instructions:
      "Produce the final result as a structured object that satisfies the provided schema.",
    model: model as AgentModelConfig,
    // No tools: native structured output is the result-delivery mechanism here.
  });

  // Stage 4 — the agent call. structuredOutput drives the native responseFormat.
  // The #1244 processor runs with expectsToolCall:false (this lane's legitimate
  // finish is `stop` + object, not a tool call). Review F1 parity: a THROW from
  // the model call (provider 5xx / transport) is a run that HAPPENED — ledger one
  // row (usage unknown ⇒ NULL-not-$0) before propagating.
  const result = await agent
    .generate(messages, {
      structuredOutput: { schema: input.schema, jsonPromptInjection: false },
      outputProcessors: [
        malformedToolCallProcessor({
          hitlAvailable: input.hitlAvailable,
          expectsToolCall: () => false,
        }) as OutputProcessorOrWorkflow<MalformedToolCallTripMetadata>,
      ],
      modelSettings: { temperature: 0 },
    })
    .catch((err: unknown) => {
      // Zod AUTHORITY on the native lane: Mastra validates result.object against
      // the supplied schema itself and THROWS its own MastraError (id
      // STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED, carrying the real ZodError as
      // `cause`) when the model's object violates the contract — live-probed
      // 2026-06-05 against @mastra/core@1.41.0. That IS the "invalid model output
      // ⇒ ZodError, fail_reason zod_validation" contract the emit_result lane
      // upholds; surface it identically (ledger 'zod_validation', throw the
      // underlying ZodError) instead of leaking the framework error. Any OTHER
      // throw is a real model-call/transport failure (F1 parity): ledger it by
      // its error name and propagate verbatim.
      const zodCause = structuredOutputZodCause(err);
      writeTestRunRecord(
        {
          runId: ledger.runId,
          skill: ledger.skill,
          createdAt: createdAtBucket(),
          layer: ledger.layer,
          // Route identity comes from policy(useCase), never a caller string.
          provider: route.provider,
          modelAlias: route.alias,
          costUsd: null,
          latencyMs: Date.now() - startedAt,
          inputTokens: null,
          outputTokens: null,
          pricingSource: "unavailable",
          priceInputPerMtok: null,
          priceOutputPerMtok: null,
          promptVersion: ledger.promptVersion,
          schemaVersion: ledger.schemaVersion,
          failReason:
            zodCause !== null ? "zod_validation" : err instanceof Error ? err.name : "model_call_failed",
        },
        ..._dbArg(_testOverrides),
      );
      throw zodCause ?? err;
    });

  const durationMs = Date.now() - startedAt;

  const promptTokens = result.usage?.inputTokens ?? null;
  const completionTokens = result.usage?.outputTokens ?? null;
  const { costUsd, pricingSource } = computeCostUsd(modelId, promptTokens, completionTokens);
  const priceColumns = pricingColumns(modelId, pricingSource);

  const writeLedger = (
    failReason: string | null,
    malformed?: { signals: ReadonlyArray<string>; text: string },
  ): void => {
    writeTestRunRecord(
      {
        runId: ledger.runId,
        skill: ledger.skill,
        createdAt: createdAtBucket(),
        layer: ledger.layer,
        provider: route.provider,
        modelAlias: route.alias,
        costUsd,
        latencyMs: durationMs,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        pricingSource,
        priceInputPerMtok: priceColumns.input,
        priceOutputPerMtok: priceColumns.output,
        promptVersion: ledger.promptVersion,
        schemaVersion: ledger.schemaVersion,
        failReason,
        // #1244 evidence — ONLY the malformed branch passes a payload. The
        // untrusted turn text is truncated + PII/budget-REDACTED (inv #9) by
        // redactMalformedSample BEFORE it is persisted; non-malformed rows leave
        // both columns NULL.
        malformedSignals: malformed ? malformed.signals.join(",") : null,
        malformedSample: malformed ? redactMalformedSample(malformed.text) : null,
      },
      ..._dbArg(_testOverrides),
    );
  };

  // Stage 4b/5 — #1244 fail-closed (same mapping as emit_result). A tripped
  // processor RESOLVES with result.tripwire populated (live-probed; not a throw).
  const trip = readMalformedTrip(result.tripwire);
  if (trip !== null) {
    writeLedger("malformed_tool_call", { signals: trip.signals, text: result.text ?? "" });
    if (input.hitlAvailable) {
      return { suspended: true, reason: "malformed_tool_call", signals: trip.signals };
    }
    throw new MalformedToolCallAbort(trip.signals);
  }

  // Stage 5 — Zod AUTHORITY. result.object is advisory; input.schema is the law.
  // A missing object (clean finish but no parsed structure) or a schema violation
  // both fail 'zod_validation' — never fall through to an unvalidated object.
  let object: z.infer<TSchema>;
  try {
    object = input.schema.parse(result.object) as z.infer<TSchema>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      writeLedger("zod_validation");
    } else {
      writeLedger(err instanceof Error ? err.name : "unknown_error");
    }
    throw err;
  }

  // Success — one ledger row, no fail reason.
  writeLedger(null);

  return {
    object,
    usage: {
      costUsd,
      durationMs,
      pricingSource: pricingSource === "unavailable" ? "unavailable" : "computed",
      promptTokens,
      completionTokens,
    },
  };
}

/**
 * Read a malformed-tool-call trip out of the resolved result's `tripwire` field.
 * Returns the typed metadata when this processor fired, else null. We trust the
 * STRUCTURED metadata our own processor set (reason + signals), never string-match
 * the tripwire reason text.
 */
function readMalformedTrip(
  tripwire: { metadata?: unknown } | undefined,
): MalformedToolCallTripMetadata | null {
  if (tripwire === undefined) return null;
  const metadata = tripwire.metadata;
  if (
    metadata !== null &&
    typeof metadata === "object" &&
    "reason" in metadata &&
    (metadata as { reason: unknown }).reason === "malformed_tool_call" &&
    "signals" in metadata &&
    Array.isArray((metadata as { signals: unknown }).signals)
  ) {
    return metadata as MalformedToolCallTripMetadata;
  }
  return null;
}

/**
 * Scan the resolved tool results for an emit_result INPUT-validation failure.
 * Mastra validates the tool args against input.schema before execute and records
 * the rejection as a typed `ValidationError` in the tool result (live-probed).
 * We detect it with Mastra's own `isValidationError` type guard — never by
 * string-matching the error message — and return the first one, or null.
 */
function findToolInputValidationError(
  toolResults: ReadonlyArray<{ payload?: { result?: unknown } }> | undefined,
): { message: string } | null {
  for (const tr of toolResults ?? []) {
    const inner = tr.payload?.result;
    if (isValidationError(inner)) {
      return { message: inner.message };
    }
  }
  return null;
}

/**
 * Wrap a tool-boundary validation rejection as a `ZodError` so callers receive
 * the same typed failure the harness's own `schema.parse` would have thrown.
 * The message carries Mastra's validation detail; this keeps the public contract
 * "invalid model output ⇒ ZodError" honest regardless of which wall (tool input
 * vs post-capture parse) caught it.
 */
function toZodError(validationError: { message: string }): z.ZodError {
  return new z.ZodError([
    {
      code: "custom",
      path: [],
      message: validationError.message,
    },
  ]);
}

/** Mastra error id thrown when native structured output fails schema validation. */
const STRUCTURED_OUTPUT_VALIDATION_ID = "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED" as const;

/**
 * If `err` is Mastra's native structured-output schema-validation failure
 * (id STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED, live-probed 2026-06-05),
 * return the underlying ZodError it carries on `cause` so the harness can surface
 * the Zod-authority failure as a real ZodError (matching the emit_result lane).
 * Returns null for any other error (a true model-call / transport failure).
 *
 * We key on the STRUCTURED, stable Mastra error `id` + a ZodError `cause` — never
 * a message string-match. When the id matches but `cause` is not a ZodError
 * (defensive), we synthesize a ZodError carrying the message so the contract
 * "invalid model output ⇒ ZodError" still holds.
 */
function structuredOutputZodCause(err: unknown): z.ZodError | null {
  if (
    err === null ||
    typeof err !== "object" ||
    (err as { id?: unknown }).id !== STRUCTURED_OUTPUT_VALIDATION_ID
  ) {
    return null;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof z.ZodError) return cause;
  const message = err instanceof Error ? err.message : "structured output schema validation failed";
  return toZodError({ message });
}

/**
 * Mastra/AI-SDK report the hyphenated 'tool-calls'; the pure detector speaks the
 * provider-raw 'tool_calls'. Same normalization the processor applies, so the
 * belt assertion agrees with the inline #1244 path.
 */
function normalizeFinishReason(finishReason: string | undefined): string {
  if (finishReason === undefined) return "";
  return finishReason === "tool-calls" ? "tool_calls" : finishReason;
}

/**
 * Snapshot the per-MTok rate columns for the ledger row. Only populated when the
 * run was actually priced off the table (pricingSource !== 'unavailable'); else
 * null so an unpriced row carries no misleading rate snapshot.
 */
function pricingColumns(
  modelId: string,
  pricingSource: string,
): { input: number | null; output: number | null } {
  if (pricingSource === "unavailable") return { input: null, output: null };
  // Re-derive from a $1M probe through the same table so we never duplicate the
  // PRICING constant here (single source of truth stays in the pricing module).
  const perMTok = computeCostUsd(modelId, 1_000_000, 0);
  const perMTokOut = computeCostUsd(modelId, 0, 1_000_000);
  return {
    input: perMTok.costUsd,
    output: perMTokOut.costUsd,
  };
}

/** Forward an injected test DB to writeTestRunRecord's optional `db` arg, or
 *  nothing (production uses writeTestRunRecord's default getDb()). */
function _dbArg(overrides: HarnessTestOverrides | undefined): [Db] | [] {
  return overrides?.db ? [overrides.db] : [];
}

/**
 * Run one PROSE generation: resolve route → drive a no-tool Mastra Agent → return
 * the model's text + usage, after writing exactly ONE ledger row. A strict subset
 * of `generate`: NO emit_result tool, NO structuredOutput, NO toolChoice, NO Zod.
 *
 * #1244 is STRUCTURALLY INAPPLICABLE here — the mixing failure is "structured
 * output (response_format/json_schema) WITH tools"; this call has neither tools
 * nor structured output, so a clean prose turn finishes `stop` with text and
 * never carries a tool call. We still pass the result through the pure detector
 * belt with `expectsToolCall:false` for discipline: that gate only fires on a
 * tool-shaped blob in the content (a real escape), in which case we fail CLOSED
 * with a typed MalformedToolCallAbort — never fall through to the prose. A clean
 * prose stop always returns [] from the detector.
 *
 * Ledger discipline mirrors `generate` verbatim: a THROW from the model call
 * (provider 5xx / transport) still writes one row (usage unknown ⇒ NULL-not-$0)
 * before propagating; the success path writes one row with fail_reason null.
 */
async function draftProse(
  input: DraftProseInput,
  ledger: HarnessLedgerContext,
  _testOverrides?: HarnessTestOverrides,
): Promise<DraftProseResult> {
  const startedAt = Date.now();

  // Test-seam guard (same rule as generate): refuse the override outside a test
  // runner — a production caller must never inject a model or redirect the ledger.
  if (
    _testOverrides !== undefined &&
    process.env["VITEST"] === undefined &&
    process.env["NODE_ENV"] !== "test"
  ) {
    throw new Error(
      "harness.draftProse: _testOverrides is a test-only seam (refused outside a test runner)",
    );
  }

  // Stage 1 — route (fail-LOUD inherited from policy()). Same lane-A provider
  // override as generate(): a per-run / env selection re-homes a DeepSeek-default
  // route onto the chosen provider; identity when none / already non-DeepSeek.
  let route = policy(input.useCase);
  const sel = resolveSelectionForRun(ledger.runId);
  if (sel) route = applySelection(route, sel);

  // Lane B — Claude OAuth prose draft (no schema → r.text). Same subscription
  // ledger shape as generate's lane B; no #1244 detector (no tools, no structured
  // output, and the OAuth lane runs no api-key tool loop).
  if (sel?.provider === "anthropic" && sel?.method === "oauth") {
    const oauthQuery = _testOverrides?.claudeOAuthQuery ?? claudeOAuthQuery;
    const oauthModelId = concreteModelId(resolveModel(route.alias));
    const r = await oauthQuery({ prompt: input.prompt, model: oauthModelId });
    const laneBDuration = Date.now() - startedAt;
    writeTestRunRecord(
      {
        runId: ledger.runId,
        skill: ledger.skill,
        createdAt: createdAtBucket(),
        layer: ledger.layer,
        provider: route.provider,
        modelAlias: route.alias,
        costUsd: null,
        latencyMs: laneBDuration,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        pricingSource: "subscription",
        priceInputPerMtok: null,
        priceOutputPerMtok: null,
        promptVersion: ledger.promptVersion,
        schemaVersion: ledger.schemaVersion,
        failReason: null,
        malformedSignals: null,
        malformedSample: null,
      },
      ..._dbArg(_testOverrides),
    );
    return {
      text: r.text ?? "",
      usage: {
        costUsd: null,
        durationMs: laneBDuration,
        pricingSource: "unavailable",
        promptTokens: r.usage.inputTokens,
        completionTokens: r.usage.outputTokens,
      },
    };
  }

  const model = _testOverrides?.model ?? resolveModel(route.alias);
  const modelId = concreteModelId(model);

  // Stage 9 — prompt routed through the canonical-message translator.
  const messages = toModelMessages([{ role: "user", content: input.prompt }]);

  const agent = new Agent({
    id: "harness-prose",
    name: "harness-prose",
    instructions:
      "Write the reply as plain prose. Do not call any tools and do not return JSON.",
    model: model as AgentModelConfig,
    // No tools, no structured output: prose is the only delivery mechanism.
  });

  // Stage 4 — the agent call. No toolChoice, no structuredOutput. temperature 0;
  // DeepSeek thinking disabled (harmless on providers that ignore the namespace).
  // A throw is a run that HAPPENED — ledger one row (NULL-not-$0) before rethrow.
  const result = await agent
    .generate(messages, {
      providerOptions: { deepseek: { thinking: { type: "disabled" } } },
      modelSettings: { temperature: 0 },
    })
    .catch((err: unknown) => {
      writeTestRunRecord(
        {
          runId: ledger.runId,
          skill: ledger.skill,
          createdAt: createdAtBucket(),
          layer: ledger.layer,
          provider: route.provider,
          modelAlias: route.alias,
          costUsd: null,
          latencyMs: Date.now() - startedAt,
          inputTokens: null,
          outputTokens: null,
          pricingSource: "unavailable",
          priceInputPerMtok: null,
          priceOutputPerMtok: null,
          promptVersion: ledger.promptVersion,
          schemaVersion: ledger.schemaVersion,
          failReason: err instanceof Error ? err.name : "model_call_failed",
        },
        ..._dbArg(_testOverrides),
      );
      throw err;
    });

  const durationMs = Date.now() - startedAt;
  const promptTokens = result.usage?.inputTokens ?? null;
  const completionTokens = result.usage?.outputTokens ?? null;
  const { costUsd, pricingSource } = computeCostUsd(modelId, promptTokens, completionTokens);
  const priceColumns = pricingColumns(modelId, pricingSource);

  const writeLedger = (
    failReason: string | null,
    malformed?: { signals: ReadonlyArray<string>; text: string },
  ): void => {
    writeTestRunRecord(
      {
        runId: ledger.runId,
        skill: ledger.skill,
        createdAt: createdAtBucket(),
        layer: ledger.layer,
        provider: route.provider,
        modelAlias: route.alias,
        costUsd,
        latencyMs: durationMs,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        pricingSource,
        priceInputPerMtok: priceColumns.input,
        priceOutputPerMtok: priceColumns.output,
        promptVersion: ledger.promptVersion,
        schemaVersion: ledger.schemaVersion,
        failReason,
        // #1244 evidence — ONLY the malformed branch passes a payload. The
        // untrusted turn text is truncated + PII/budget-REDACTED (inv #9) by
        // redactMalformedSample BEFORE it is persisted; non-malformed rows leave
        // both columns NULL.
        malformedSignals: malformed ? malformed.signals.join(",") : null,
        malformedSample: malformed ? redactMalformedSample(malformed.text) : null,
      },
      ..._dbArg(_testOverrides),
    );
  };

  const text = result.text ?? "";

  // Detector belt — discipline only. expectsToolCall:false, so the
  // finish_reason / empty-tool-call signals are gated off (a prose stop is the
  // legitimate finish here); only a tool-shaped blob in content can still fire.
  // On any signal we fail CLOSED (typed abort) — never return the blob as prose.
  const signals = detectMalformedToolCall({
    finishReason: normalizeFinishReason(result.finishReason),
    expectsToolCall: false,
    toolCallCount: result.toolCalls?.length ?? 0,
    content: text,
  });
  if (signals.length > 0) {
    writeLedger("malformed_tool_call", { signals, text });
    throw new MalformedToolCallAbort(signals);
  }

  writeLedger(null);

  return {
    text,
    usage: {
      costUsd,
      durationMs,
      pricingSource: pricingSource === "unavailable" ? "unavailable" : "computed",
      promptTokens,
      completionTokens,
    },
  };
}

/**
 * The runnable harness facade re-exported from the layer surface. `as const` so
 * the shape is frozen; skills call `harness.generate(input, ledger)` for a
 * structured result, or `harness.draftProse(input, ledger)` for a no-tool prose
 * draft.
 */
export const harness = { generate, draftProse } as const;
