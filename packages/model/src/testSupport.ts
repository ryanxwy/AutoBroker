/**
 * TEST SUPPORT ONLY — fake `LanguageModel` factories (Layer 2).
 *
 * NEVER imported by a production code path. Exists solely because the
 * five-layer wall keeps `ai` / `@ai-sdk/*` types inside `@autobroker/model`:
 * other layers (notably `@autobroker/workflows`) need to unit-test their Mastra
 * Agent loops against a deterministic model WITHOUT importing `ai` themselves.
 * These factories hand back a real `LanguageModelV3` so they drive a genuine
 * `new Agent({ model })` loop, not a hand-rolled fake of one.
 *
 * Two failure-mode shapes are provided:
 *   - makeStaticToolCallModel — one well-formed tool call (the happy path the
 *     #1244 detector must pass clean).
 *   - makeProseDumpModel      — plain text, finishReason 'stop', no tool calls:
 *     the #1244 text-dump the fail-closed detector must catch.
 *
 * API surface verified against @ai-sdk/provider@3.0.10 (the version `ai@6.0.195`
 * resolves) `LanguageModelV3`: specificationVersion 'v3'; finishReason is the
 * object `{ unified, raw }` (NOT a bare string); usage is nested
 * `{ inputTokens: { total, ... }, outputTokens: { total, ... } }`; a tool-call
 * content part is `{ type: 'tool-call', toolCallId, toolName, input }` where
 * `input` is STRINGIFIED JSON (NOT `args`). doGenerate AND doStream are both
 * implemented because Mastra streams internally on some lanes.
 */

import type {
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

/** Token counts in the simple shape callers think in; widened to the nested
 *  v3 `LanguageModelV3Usage` internally. */
interface SimpleUsage {
  inputTokens: number;
  outputTokens: number;
}

const DEFAULT_USAGE: SimpleUsage = { inputTokens: 10, outputTokens: 5 };

/** Lift a flat `{inputTokens, outputTokens}` into the nested v3 usage object. */
function toV3Usage(usage: SimpleUsage): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: usage.inputTokens,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: usage.outputTokens,
      reasoning: 0,
    },
  };
}

/** Assemble a complete `doGenerate` result around the given content + reason. */
function makeGenerateResult(
  content: LanguageModelV3Content[],
  finishReason: LanguageModelV3FinishReason,
  usage: SimpleUsage,
): LanguageModelV3GenerateResult {
  return {
    content,
    finishReason,
    usage: toV3Usage(usage),
    warnings: [],
  };
}

/**
 * Build the matching `doStream` from the resolved content parts: emit each
 * content part as the appropriate stream chunk, then a terminal `finish` chunk
 * carrying the same usage + finishReason. This mirrors what a real provider
 * stream produces, so a Mastra loop that streams internally sees a coherent
 * sequence.
 */
function makeStreamResult(
  content: LanguageModelV3Content[],
  finishReason: LanguageModelV3FinishReason,
  usage: SimpleUsage,
): { stream: ReadableStream<LanguageModelV3StreamPart> } {
  const v3Usage = toV3Usage(usage);
  const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];

  for (const part of content) {
    if (part.type === "text") {
      const id = "text-0";
      parts.push({ type: "text-start", id });
      parts.push({ type: "text-delta", id, delta: part.text });
      parts.push({ type: "text-end", id });
    } else {
      // tool-call (and any other resolved part) is emitted as-is; the v3 stream
      // union admits a full LanguageModelV3ToolCall chunk verbatim.
      parts.push(part as LanguageModelV3StreamPart);
    }
  }

  parts.push({ type: "finish", usage: v3Usage, finishReason });

  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    }),
  };
}

/** Common scaffolding for a v3 model around fixed resolved content. */
function makeStaticModel(opts: {
  modelId: string;
  content: LanguageModelV3Content[];
  finishReason: LanguageModelV3FinishReason;
  usage: SimpleUsage;
}): LanguageModelV3 {
  const { modelId, content, finishReason, usage } = opts;
  return {
    specificationVersion: "v3",
    provider: "autobroker-test",
    modelId,
    supportedUrls: {},
    doGenerate: () =>
      Promise.resolve(makeGenerateResult(content, finishReason, usage)),
    doStream: () =>
      Promise.resolve(makeStreamResult(content, finishReason, usage)),
  };
}

/**
 * A model whose single turn is one WELL-FORMED tool call for `opts.toolName`
 * with `opts.args` serialized as the v3 `input` JSON string, finishReason
 * `tool-calls`. This is the clean path the #1244 detector must pass through.
 */
export function makeStaticToolCallModel(opts: {
  toolName: string;
  args: unknown;
  modelId?: string;
  usage?: SimpleUsage;
}): LanguageModel {
  const content: LanguageModelV3Content[] = [
    {
      type: "tool-call",
      toolCallId: "call_0",
      toolName: opts.toolName,
      input: JSON.stringify(opts.args),
    },
  ];
  return makeStaticModel({
    modelId: opts.modelId ?? "static-tool-call",
    content,
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: opts.usage ?? DEFAULT_USAGE,
  });
}

/**
 * A model that dumps plain TEXT (the caller supplies a tool-shaped blob string
 * when simulating the #1244 failure), finishReason `stop`, NO tool calls. The
 * fail-closed detector must catch this on a tool-expecting step.
 */
export function makeProseDumpModel(opts: {
  text: string;
  modelId?: string;
  usage?: SimpleUsage;
}): LanguageModel {
  const content: LanguageModelV3Content[] = [{ type: "text", text: opts.text }];
  return makeStaticModel({
    modelId: opts.modelId ?? "prose-dump",
    content,
    finishReason: { unified: "stop", raw: "stop" },
    usage: opts.usage ?? DEFAULT_USAGE,
  });
}

/**
 * A model for the NATIVE structured-output (`output_object`) lane — the
 * Anthropic/OpenAI path Mastra drives with `structuredOutput: { schema }`.
 *
 * Live-probed against @mastra/core@1.41.0 (offline fake-model probe, 2026-06-05):
 * `agent.generate(prompt, { structuredOutput: { schema } })` injects a NATIVE
 * `responseFormat: { type: 'json', schema }` into the model call (NOT prompt
 * injection, NOT a second structuring agent), registers NO tools, and the model
 * is expected to return the result as a plain JSON TEXT response with
 * finishReason `stop`. Mastra then parses that text into `result.object`. So this
 * fake mirrors a clean provider on that path: ONE text part carrying `opts.object`
 * serialized as JSON, finishReason `stop`, no tool calls. (Drives the real
 * agent → real structured-output parse → real `.object`, same as a clean
 * Anthropic/OpenAI turn — not a hand-rolled fake of the result.)
 */
export function makeStructuredObjectModel(opts: {
  object: unknown;
  modelId?: string;
  usage?: SimpleUsage;
}): LanguageModel {
  const content: LanguageModelV3Content[] = [
    { type: "text", text: JSON.stringify(opts.object) },
  ];
  return makeStaticModel({
    modelId: opts.modelId ?? "structured-object",
    content,
    finishReason: { unified: "stop", raw: "stop" },
    usage: opts.usage ?? DEFAULT_USAGE,
  });
}
