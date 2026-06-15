/**
 * L1 unit tests — pure validators. No SQLite, no network. Freezes:
 *   - assertUnicodeSafe: clean ASCII passes; a valid emoji / surrogate PAIR
 *     passes; a lone HIGH surrogate throws UnicodeUnsafeError; a lone LOW
 *     surrogate throws UnicodeUnsafeError.
 *
 * Lone surrogates are constructed with String.fromCharCode on a single code
 * unit in U+D800–U+DFFF (TS string literals cannot carry an unpaired half).
 */

import { describe, expect, it } from "vitest";

import { assertUnicodeSafe, UnicodeUnsafeError } from "./validators.js";

describe("assertUnicodeSafe", () => {
  it("passes clean ASCII", () => {
    expect(assertUnicodeSafe("Hello, dealer — best out-the-door price?")).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("passes a valid emoji (surrogate pair)", () => {
    // 😀 U+1F600 is the surrogate pair U+D83D U+DE00 — a correctly paired half.
    expect(assertUnicodeSafe("Thanks 😀")).toEqual({ ok: true, errors: [] });
  });

  it("throws on a lone HIGH surrogate", () => {
    const loneHigh = String.fromCharCode(0xd83d); // high half, no low half follows
    expect(() => assertUnicodeSafe(`x${loneHigh}y`)).toThrow(UnicodeUnsafeError);
  });

  it("throws on a lone LOW surrogate", () => {
    const loneLow = String.fromCharCode(0xde00); // low half, no high half precedes
    expect(() => assertUnicodeSafe(`x${loneLow}y`)).toThrow(UnicodeUnsafeError);
  });
});
