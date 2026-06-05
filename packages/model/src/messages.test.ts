/**
 * L1 unit tests — M0 canonical-message → ModelMessage translator.
 *
 * Freezes the M0 flat-text subset and the fail-LOUD contract (AI_ORCH R7;
 * safetyInvariants — no silent fallbacks): the three string-content roles map
 * 1:1, and anything outside the subset THROWS rather than being dropped or
 * coerced. Pure functions — no LLM, no I/O.
 */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_ROLES,
  UnsupportedCanonicalMessageError,
  toModelMessages,
  type CanonicalMessage,
} from "./messages.js";

describe("toModelMessages", () => {
  it("maps system/user/assistant flat-text turns 1:1, preserving order", () => {
    const input: CanonicalMessage[] = [
      { role: "system", content: "You are a quote auditor." },
      { role: "user", content: "Here is the dealer reply." },
      { role: "assistant", content: "Found three flags." },
    ];
    expect(toModelMessages(input)).toEqual([
      { role: "system", content: "You are a quote auditor." },
      { role: "user", content: "Here is the dealer reply." },
      { role: "assistant", content: "Found three flags." },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(toModelMessages([])).toEqual([]);
  });

  it("exposes exactly the three M0 roles", () => {
    expect([...CANONICAL_ROLES]).toEqual(["system", "user", "assistant"]);
  });

  it("THROWS (never drops) on a role outside the M0 subset", () => {
    const bad = [
      { role: "tool", content: "result blob" },
    ] as unknown as CanonicalMessage[];
    expect(() => toModelMessages(bad)).toThrowError(
      UnsupportedCanonicalMessageError,
    );
  });

  it("THROWS on non-string content (no silent coercion)", () => {
    const bad = [
      { role: "user", content: { parts: ["image"] } },
    ] as unknown as CanonicalMessage[];
    expect(() => toModelMessages(bad)).toThrowError(
      UnsupportedCanonicalMessageError,
    );
  });

  it("reports the offending index in the thrown error", () => {
    const bad = [
      { role: "user", content: "ok" },
      { role: "system", content: "ok" },
      { role: "nope", content: "bad" },
    ] as unknown as CanonicalMessage[];
    try {
      toModelMessages(bad);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCanonicalMessageError);
      expect((err as UnsupportedCanonicalMessageError).index).toBe(2);
    }
  });
});
