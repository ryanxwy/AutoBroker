/**
 * L1 unit tests — fake LanguageModel factories (TEST SUPPORT structural check).
 *
 * Verifies the factories emit v3-spec-correct shapes (specificationVersion,
 * finishReason object, nested usage, tool-call `input` JSON string) so that a
 * downstream Mastra Agent loop in @autobroker/workflows can drive them. We do
 * not run an agent here (that consumer test lives in workflows); we assert the
 * doGenerate result and the doStream chunk sequence at the shape level.
 */

import { describe, expect, it } from "vitest";
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { makeProseDumpModel, makeStaticToolCallModel } from "./testSupport.js";

/** Drain a v3 stream into an array of parts. */
async function drain(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

describe("makeStaticToolCallModel", () => {
  const model = makeStaticToolCallModel({
    toolName: "emit_result",
    args: { trim: "SR5", ok: true },
    usage: { inputTokens: 42, outputTokens: 7 },
  }) as LanguageModelV3;

  it("is a v3 LanguageModel", () => {
    expect(model.specificationVersion).toBe("v3");
    expect(model.modelId).toBe("static-tool-call");
    expect(model.provider).toBe("autobroker-test");
  });

  it("doGenerate returns one well-formed tool-call part with finishReason tool-calls", async () => {
    const result = await model.doGenerate(
      {} as Parameters<LanguageModelV3["doGenerate"]>[0],
    );
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "tool_calls" });
    expect(result.content).toHaveLength(1);
    const part = result.content[0];
    expect(part?.type).toBe("tool-call");
    if (part?.type === "tool-call") {
      expect(part.toolName).toBe("emit_result");
      // args are serialized as the v3 `input` JSON string.
      expect(JSON.parse(part.input)).toEqual({ trim: "SR5", ok: true });
    }
  });

  it("reports usage in the nested v3 shape", async () => {
    const result = await model.doGenerate(
      {} as Parameters<LanguageModelV3["doGenerate"]>[0],
    );
    expect(result.usage.inputTokens.total).toBe(42);
    expect(result.usage.outputTokens.total).toBe(7);
  });

  it("doStream emits the tool call then a terminal finish chunk", async () => {
    const { stream } = await model.doStream(
      {} as Parameters<LanguageModelV3["doStream"]>[0],
    );
    const parts = await drain(stream);
    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    expect(parts.some((p) => p.type === "tool-call")).toBe(true);
    const finish = parts.at(-1);
    expect(finish?.type).toBe("finish");
    if (finish?.type === "finish") {
      expect(finish.finishReason).toEqual({ unified: "tool-calls", raw: "tool_calls" });
    }
  });
});

describe("makeProseDumpModel", () => {
  const blob = '{"name": "gmail_send", "arguments": {"to": "x@y.com"}}';
  const model = makeProseDumpModel({ text: blob }) as LanguageModelV3;

  it("doGenerate returns plain text, finishReason stop, NO tool calls (prose dump)", async () => {
    const result = await model.doGenerate(
      {} as Parameters<LanguageModelV3["doGenerate"]>[0],
    );
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.content).toHaveLength(1);
    const part = result.content[0];
    expect(part?.type).toBe("text");
    if (part?.type === "text") {
      expect(part.text).toBe(blob);
    }
    expect(result.content.some((p) => p.type === "tool-call")).toBe(false);
  });

  it("doStream emits text chunks then a finish chunk with finishReason stop", async () => {
    const { stream } = await model.doStream(
      {} as Parameters<LanguageModelV3["doStream"]>[0],
    );
    const parts = await drain(stream);
    expect(parts.some((p) => p.type === "text-delta")).toBe(true);
    expect(parts.some((p) => p.type === "tool-call")).toBe(false);
    const finish = parts.at(-1);
    expect(finish?.type).toBe("finish");
    if (finish?.type === "finish") {
      expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" });
    }
  });
});
