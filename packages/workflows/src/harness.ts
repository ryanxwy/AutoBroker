/**
 * harness.generate — the runnable structured-generation facade (Layer 3).
 *
 * OWNERSHIP (归属裁定 2026-06-04, plan-repo DECISIONS.html): only the api-key
 * lane lets the AI SDK own the tool loop, and Mastra is the framework that drives
 * that loop. `@mastra/*` may only be imported in `@autobroker/workflows` (the
 * five-layer wall), so the runnable facade — the Mastra Agent loop end-to-end —
 * lives HERE. `@autobroker/model` keeps only the pure pieces and the signature
 * types (HarnessGenerateInput/Result/Suspend, chooseStructuredOutputStrategy, the
 * #1244 detector, pricing, the canonical-message translator); this file imports
 * them and wires the loop.
 *
 * CONTROL FLOW (AI_ORCH §3.3 — control-flow stages):
 *   1. policy(useCase) → alias + capabilities; resolveModel(alias) → LanguageModel
 *      (fail-LOUD inherited from policy()).
 *   2. chooseStructuredOutputStrategy(capabilities): 'output_object' is not built
 *      until M4 cross-provider smoke → throw a typed HarnessNotImplementedError
 *      (never silently fall back to emit_result).
 *   3. emit_result path: ONE Mastra `createTool` named 'emit_result' whose
 *      inputSchema is the caller's Zod contract; its execute closure captures the
 *      Mastra-validated args. NO other tools. Per-request the call forces:
 *        - named tool_choice { type:'tool', toolName:'emit_result' }
 *        - DeepSeek thinking DISABLED (providerOptions.deepseek.thinking.type)
 *        - temperature 0 (modelSettings)
 *      Platform constraint (裁定⑤ / §11.2, live-verified 2026-06-04): DeepSeek
 *      thinking mode REJECTS a named/forced tool_choice, so an emit_result step
 *      MUST disable thinking per-request. The real provider key is
 *      `@ai-sdk/deepseek`'s `deepseekLanguageModelOptions.thinking.type` =
 *      'disabled' (confirmed in the .d.ts, not guessed).
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
 *        MalformedToolCallAbort(signals). (See api_findings for the alternate
 *        workflow-step path that DOES throw — not the path agent.generate takes.)
 *      Belt (stage 4b): if the run did NOT trip yet the emit_result capture is
 *      still empty, run the pure detector over the real finishReason /
 *      toolCallCount / final text — ledger first, then suspend or abort, NEVER
 *      fall through to prose (review F2 2026-06-05: detect→ledger→act ordering).
 *   6. (stage 5, Zod authority) the model output is advisory; input.schema is the
 *      law. Mastra validates emit_result's args against that schema at the TOOL
 *      BOUNDARY before execute (live-probed) — a contract violation is recorded
 *      as a typed ValidationError in toolResults with finishReason still
 *      'tool-calls' (so #1244 correctly does NOT trip; a tool WAS called). The
 *      harness detects that rejection (Mastra's isValidationError guard, never a
 *      message string-match) and surfaces it as a ZodError, fail_reason
 *      'zod_validation'. On the success path it additionally re-runs
 *      input.schema.parse(captured) as defense-in-depth (same verdict on drift).
 *   7. (stage 6, ledger) EVERY call — success AND every failure branch — writes
 *      exactly ONE test_run_records row through @autobroker/tools'
 *      writeTestRunRecord (the single ledger write path; SQLite invariant).
 *      Cost is NULL-not-$0: usage missing → costUsd null + pricingSource
 *      'unavailable'. Wall-clock durationMs is always recorded.
 *
 * Prompt: input.prompt is a flat string at M0; it is routed through the model
 * layer's toModelMessages([{role:'user',...}]) so the canonical-message ↔
 * ModelMessage translator is load-bearing on this lane (AI_ORCH R7).
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
  computeCostUsd,
  detectMalformedToolCall,
  MalformedToolCallAbort,
  policy,
  resolveModel,
  toModelMessages,
  type HarnessGenerateInput,
  type HarnessGenerateResult,
  type HarnessSuspend,
} from "@autobroker/model";
import { writeTestRunRecord, type Db } from "@autobroker/tools";

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
 * that fakes provenance): the M0 probe / each skill passes its own. Members
 * mirror the table's caller-owned columns (packages/db testRunRecords).
 */
export interface HarnessLedgerContext {
  /** Run window id (test_run_records.run_id). */
  runId: string;
  /** Skill name (test_run_records.skill). */
  skill: string;
  /** Test layer label, 'L1'..'L5' (test_run_records.layer). */
  layer: string;
  /** Provider name (test_run_records.provider). Caller-asserted; the policy
   *  resolution provider is recorded but the ledger label is the caller's. */
  provider: string;
  /** Model alias (test_run_records.model_alias). */
  modelAlias: string;
  /** Prompt hash / version, or null (test_run_records.prompt_version). */
  promptVersion: string | null;
  /** Zod contract version, or null (test_run_records.schema_version). */
  schemaVersion: string | null;
}

/**
 * Thrown when a useCase routes to the `output_object` strategy. That path
 * (native Output.object + tools on Anthropic/OpenAI) lands in M4 cross-provider
 * smoke. We throw LOUD rather than silently emit_result — emitting the wrong
 * strategy would defeat the whole #1244 capability gate.
 */
export class HarnessNotImplementedError extends Error {
  constructor(detail: string) {
    super(`harness.generate not implemented for this route: ${detail}`);
    this.name = "HarnessNotImplementedError";
  }
}

/** The fixed name of the single structured-output tool (emit_result discipline). */
const EMIT_RESULT_TOOL = "emit_result" as const;

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
 * the in-stack evidence M0 requires). See design_notes for why this over a mock.
 */
export interface HarnessTestOverrides {
  /** Inject a fake LanguageModel (use @autobroker/model testSupport factories). */
  model?: unknown;
  /** Inject the isolated tmp-DB handle the ledger row is written through. */
  db?: Db;
}

/**
 * Run one structured generation: resolve route → force the emit_result discipline
 * → drive the Mastra Agent through the #1244 fail-closed processor → assert the
 * tool turn (belt) → Zod-validate the captured args → price + write one ledger
 * row. Resolves to a Zod-validated object, or a HarnessSuspend (HITL fail-closed),
 * or throws MalformedToolCallAbort / ZodError / HarnessNotImplementedError (each
 * recorded with its own fail_reason).
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

  // Stage 1 — route (fail-LOUD inherited from policy()).
  const route = policy(input.useCase);
  const model = _testOverrides?.model ?? resolveModel(route.alias);
  const modelId = concreteModelId(model);

  // Stage 2 — strategy gate. output_object is an M4 deliverable; refuse LOUD.
  const strategy = chooseStructuredOutputStrategy(route.capabilities);
  if (strategy === "output_object") {
    // No ledger row: nothing ran (no model call, no usage). The throw IS the
    // signal; writing a $0/usage-missing row here would fake a run that never
    // happened.
    throw new HarnessNotImplementedError(
      "output_object strategy lands in M4 cross-provider smoke",
    );
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

  // Stage 9 — prompt routed through the canonical-message translator (R7).
  const messages = toModelMessages([{ role: "user", content: input.prompt }]);

  const agent = new Agent({
    id: "harness-emit",
    name: "harness-emit",
    instructions:
      "You must produce the final result by calling the emit_result tool exactly once. Do not answer in prose.",
    model: model as AgentModelConfig,
    tools: { [EMIT_RESULT_TOOL]: emitResult },
  });

  // Stage 4 — the agent call. Force the emit_result discipline per-request:
  // named tool_choice + DeepSeek thinking disabled + temperature 0. The #1244
  // processor runs on every output step (expectsToolCall defaults to () => true).
  // Review F1 (2026-06-05): a THROW from the model call itself (provider 5xx,
  // transport failure, retry exhaustion) is a run that HAPPENED — record one
  // ledger row (usage unknown ⇒ NULL-not-$0) before propagating the error. If
  // that ledger write itself throws (broken local DB) it wins — both are hard
  // local faults and neither may be swallowed.
  const result = await agent
    .generate(messages, {
      toolChoice: { type: "tool", toolName: EMIT_RESULT_TOOL },
      // The processor's `processOutputStep` is declared optional on the broad
      // `Processor` interface but the agent's `OutputProcessor` slot wants it
      // present; our processor always defines it (live-probed clean). Cast to the
      // exact expected union — faithful, not an `any` escape.
      outputProcessors: [
        malformedToolCallProcessor({
          hitlAvailable: input.hitlAvailable,
        }) as OutputProcessorOrWorkflow<MalformedToolCallTripMetadata>,
      ],
      // DeepSeek per-request thinking switch — real provider key from the .d.ts.
      // Harmless on providers that ignore an unknown providerOptions namespace.
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
          provider: ledger.provider,
          modelAlias: ledger.modelAlias,
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

  /** Write the one ledger row for this run with the given verdict. */
  const writeLedger = (failReason: string | null): void => {
    writeTestRunRecord(
      {
        runId: ledger.runId,
        skill: ledger.skill,
        createdAt: createdAtBucket(),
        layer: ledger.layer,
        provider: ledger.provider,
        modelAlias: ledger.modelAlias,
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
      },
      ..._dbArg(_testOverrides),
    );
  };

  // Stage 4b/5 — #1244 fail-closed. A tripped processor RESOLVES with
  // result.tripwire populated (live-probed; NOT a throw on this lane). The
  // metadata IS our MalformedToolCallTripMetadata.
  const trip = readMalformedTrip(result.tripwire);
  if (trip !== null) {
    writeLedger("malformed_tool_call");
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
  // advisory; the schema is the law — AI_ORCH §3.3 stage 5.)
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
    writeLedger("malformed_tool_call");
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
 *  nothing (production uses writeTestRunRecord's default openDb()). */
function _dbArg(overrides: HarnessTestOverrides | undefined): [Db] | [] {
  return overrides?.db ? [overrides.db] : [];
}

/**
 * The runnable harness facade re-exported from the layer surface. `as const` so
 * the shape is frozen; skills call `harness.generate(input, ledger)`.
 */
export const harness = { generate } as const;
