/**
 * L1 unit tests — #1244 malformed-tool-call detector (safety boundary).
 *
 * Freezes the fail-closed contract (INVARIANTS / safetyInvariants §2):
 *   finish_reason != tool_calls OR empty tool_calls OR tool-shaped blob in
 *   content ⇒ suspend under HITL, typed MalformedToolCallAbort without HITL.
 *   NEVER regex-extract-and-execute. Pure functions — no LLM, no I/O.
 */

import { describe, expect, it } from "vitest";
import {
  MalformedToolCallAbort,
  assertToolTurnOrFailClosed,
  detectMalformedToolCall,
  looksLikeToolShapedBlob,
  type ToolTurnView,
} from "./malformedToolCall.js";

const cleanToolTurn: ToolTurnView = {
  finishReason: "tool_calls",
  expectsToolCall: true,
  toolCallCount: 1,
  content: "",
};

describe("detectMalformedToolCall", () => {
  it("returns no signals on a clean structured tool turn", () => {
    expect(detectMalformedToolCall(cleanToolTurn)).toEqual([]);
  });

  it("flags finish_reason != tool_calls on a tool-expecting step", () => {
    expect(
      detectMalformedToolCall({ ...cleanToolTurn, finishReason: "stop" }),
    ).toContain("finish_reason_not_tool_calls");
  });

  it("flags an empty tool_calls array on a tool-expecting step", () => {
    expect(
      detectMalformedToolCall({ ...cleanToolTurn, toolCallCount: 0 }),
    ).toContain("empty_tool_calls");
  });

  it("flags a JSON tool-shaped blob dumped into content (#1244)", () => {
    const turn: ToolTurnView = {
      finishReason: "stop",
      expectsToolCall: false,
      toolCallCount: 0,
      content: '{"name": "gmail_send", "arguments": {"to": "dealer@x.com"}}',
    };
    expect(detectMalformedToolCall(turn)).toContain(
      "tool_shaped_blob_in_content",
    );
  });

  it("flags an XML-ish tool-shaped blob in content", () => {
    expect(looksLikeToolShapedBlob("<tool_call>submit_form</tool_call>")).toBe(
      true,
    );
  });

  it("does not flag ordinary prose (precision-first heuristic)", () => {
    expect(
      looksLikeToolShapedBlob("Here are the three quotes I found for you."),
    ).toBe(false);
  });
});

describe("assertToolTurnOrFailClosed", () => {
  it("passes a clean turn through", () => {
    expect(assertToolTurnOrFailClosed(cleanToolTurn, false)).toEqual({
      ok: true,
    });
  });

  it("signals SUSPEND (not throw) when HITL is available", () => {
    const result = assertToolTurnOrFailClosed(
      { ...cleanToolTurn, toolCallCount: 0 },
      true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.suspend).toBe(true);
      expect(result.reason).toBe("malformed_tool_call");
      expect(result.signals).toContain("empty_tool_calls");
    }
  });

  it("throws a typed MalformedToolCallAbort when there is no HITL", () => {
    expect(() =>
      assertToolTurnOrFailClosed({ ...cleanToolTurn, finishReason: "stop" }, false),
    ).toThrowError(MalformedToolCallAbort);
  });
});
