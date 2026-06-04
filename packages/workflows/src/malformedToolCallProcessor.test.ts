/**
 * L1 unit tests — #1244 Mastra output-Processor shell (safety boundary).
 *
 * Freezes the spike-3 contract: detection runs on processOutputStep (before
 * tool execution), any signal aborts CLOSED via the processor abort()
 * (TripWire), the abort NEVER asks for a retry (retry:true == auto-repair ==
 * forbidden), and the AI SDK finishReason spelling (`tool-calls`) is
 * normalized for the provider-raw detector. Pure — no LLM, no Mastra runtime.
 */

import { describe, expect, it } from "vitest";
import type { ProcessOutputStepArgs } from "@mastra/core/processors";
import {
  malformedToolCallProcessor,
  type MalformedToolCallTripMetadata,
} from "./malformedToolCallProcessor.js";

/** Sentinel thrown by the fake abort so tests can observe the trip. */
class FakeTrip extends Error {
  constructor(
    readonly reason: string | undefined,
    readonly options: { retry?: boolean; metadata?: MalformedToolCallTripMetadata } | undefined,
  ) {
    super(reason ?? "trip");
  }
}

/** Minimal fake of the Mastra step args — only the fields the shell reads,
 *  plus an abort() that records its inputs and throws like the real one. */
function fakeStepArgs(over: {
  finishReason?: string;
  toolCalls?: Array<{ toolName: string; toolCallId: string; args: unknown }>;
  text?: string;
}): ProcessOutputStepArgs<MalformedToolCallTripMetadata> {
  const args = {
    stepNumber: 0,
    finishReason: over.finishReason,
    toolCalls: over.toolCalls,
    text: over.text,
    messages: [] as unknown[],
    state: {},
    abort: (reason?: string, options?: { retry?: boolean; metadata?: MalformedToolCallTripMetadata }) => {
      throw new FakeTrip(reason, options);
    },
  };
  // Structural fake: the shell only touches the fields above.
  return args as unknown as ProcessOutputStepArgs<MalformedToolCallTripMetadata>;
}

const run = (
  processor: ReturnType<typeof malformedToolCallProcessor>,
  args: ProcessOutputStepArgs<MalformedToolCallTripMetadata>,
) => processor.processOutputStep!(args);

describe("malformedToolCallProcessor — clean turns pass", () => {
  it("accepts a structured tool-call step (AI SDK hyphenated finishReason)", () => {
    const p = malformedToolCallProcessor({ hitlAvailable: false });
    const args = fakeStepArgs({
      finishReason: "tool-calls",
      toolCalls: [{ toolName: "emit_result", toolCallId: "t1", args: {} }],
      text: "",
    });
    expect(() => run(p, args)).not.toThrow();
  });
});

describe("malformedToolCallProcessor — #1244 signals abort closed", () => {
  it("trips on finishReason stop with zero tool calls (text-dump shape)", () => {
    const p = malformedToolCallProcessor({ hitlAvailable: false });
    const args = fakeStepArgs({
      finishReason: "stop",
      toolCalls: [],
      text: '{"name": "gmail_send", "arguments": {"to": "dealer@x.com"}}',
    });
    expect(() => run(p, args)).toThrow(FakeTrip);
  });

  it("carries reason + signals + hitlAvailable in the trip metadata", () => {
    const p = malformedToolCallProcessor({ hitlAvailable: true });
    const args = fakeStepArgs({ finishReason: "stop", toolCalls: [], text: "" });
    try {
      run(p, args);
      expect.unreachable("should have tripped");
    } catch (e) {
      const trip = e as FakeTrip;
      expect(trip.options?.metadata?.reason).toBe("malformed_tool_call");
      expect(trip.options?.metadata?.hitlAvailable).toBe(true);
      expect(trip.options?.metadata?.signals).toContain("empty_tool_calls");
    }
  });

  it("NEVER requests a retry — retry:true would be framework auto-repair", () => {
    const p = malformedToolCallProcessor({ hitlAvailable: true });
    const args = fakeStepArgs({ finishReason: "stop", toolCalls: [], text: "" });
    try {
      run(p, args);
      expect.unreachable("should have tripped");
    } catch (e) {
      expect((e as FakeTrip).options?.retry).not.toBe(true);
    }
  });

  it("trips on a tool-shaped blob even on a non-tool-expecting step", () => {
    const p = malformedToolCallProcessor({
      hitlAvailable: false,
      expectsToolCall: () => false, // prose lane — blob heuristic still armed
    });
    const args = fakeStepArgs({
      finishReason: "stop",
      toolCalls: [],
      text: "<tool_call>submit_form</tool_call>",
    });
    expect(() => run(p, args)).toThrow(FakeTrip);
  });

  it("does not trip prose on a non-tool-expecting step", () => {
    const p = malformedToolCallProcessor({
      hitlAvailable: false,
      expectsToolCall: () => false,
    });
    const args = fakeStepArgs({
      finishReason: "stop",
      toolCalls: [],
      text: "Here are the three quotes I found.",
    });
    expect(() => run(p, args)).not.toThrow();
  });
});
