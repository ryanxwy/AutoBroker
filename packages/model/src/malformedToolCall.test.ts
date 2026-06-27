/**
 * L1 unit tests — #1244 malformed-tool-call detector (safety boundary).
 *
 * Freezes the fail-closed contract:
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
  redactMalformedSample,
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

describe("redactMalformedSample", () => {
  it("redacts an email address to <email>", () => {
    const out = redactMalformedSample('contact the buyer at jane.doe@example.com please');
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).toContain("<email>");
  });

  it("redacts a $-prefixed currency/budget amount to <amount>", () => {
    const out = redactMalformedSample("the out-the-door price is $34,250 today");
    expect(out).not.toContain("$34,250");
    expect(out).not.toContain("34,250");
    expect(out).not.toContain("34250");
    expect(out).toContain("<amount>");
  });

  it("redacts a USD-adjacent amount to <amount>", () => {
    const out = redactMalformedSample("budget around 33000 USD for the deal");
    expect(out).not.toContain("33000");
    expect(out).toContain("<amount>");
  });

  it("collapses a bare tool-shaped blob's secret number + email (the #1244 capture)", () => {
    const blob = '{"name":"emit_result","arguments":{"selling_price":34250,"contact":"a@b.com"}}';
    const out = redactMalformedSample(blob);
    expect(out).not.toContain("34250");
    expect(out).not.toContain("a@b.com");
    expect(out).toContain("<email>");
    expect(out).toContain("#");
  });

  it("redacts EVERY digit run including lone single digits (no figure survives)", () => {
    const out = redactMalformedSample("year 2026 trim level 5");
    expect(out).not.toContain("2026");
    expect(out).not.toContain("5"); // a single-digit target must not survive (inv #9).
    expect(out).toContain("#");
  });

  it("closes the k/m magnitude-shorthand budget leak", () => {
    for (const [text, raw] of [
      ["come down 2k", "2k"],
      ["1.5k below invoice", "1.5"],
      ["9k or 8.5k", "8.5"],
      ["2.9k off the sticker", "2.9"],
      ["maybe 2m total", "2m"],
    ] as const) {
      const out = redactMalformedSample(text);
      expect(out).not.toContain(raw);
      expect(out).toContain("<amount>");
    }
    // The lone "9" in "9k or 8.5k" must be gone too (it was the leak before).
    expect(redactMalformedSample("9k or 8.5k")).not.toMatch(/\d/);
  });

  it("redacts grouped/decimal numbers and bare single digits to #", () => {
    expect(redactMalformedSample("1,234")).not.toMatch(/\d/);
    expect(redactMalformedSample("price 30000")).not.toContain("30000");
    expect(redactMalformedSample("price 30000")).toContain("#");
    expect(redactMalformedSample("9")).toBe("#");
  });

  it("catches fullwidth/unicode digits (no figure survives the unicode pass)", () => {
    const out = redactMalformedSample("budget ３０００ here"); // fullwidth 3000.
    expect(out).not.toContain("３０００");
    expect(out).toContain("#");
  });

  it("catches non-decimal numeric glyphs (No superscripts/fractions, Nl numerals)", () => {
    for (const g of ["²", "½", "Ⅻ"]) {
      const out = redactMalformedSample(`a ${g} b`);
      expect(out).not.toContain(g);
      expect(out).toContain("#");
    }
  });

  it("truncates a long input to <=240 chars + a … marker", () => {
    const long = "a".repeat(500);
    const out = redactMalformedSample(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(241); // 240 body chars + the … marker.
    expect(out.slice(0, -1).length).toBeLessThanOrEqual(240);
  });

  it("round-trips clean short prose unchanged (no secrets to redact)", () => {
    const prose = "Here are the three quotes I found for you.";
    expect(redactMalformedSample(prose)).toBe(prose);
  });
});
