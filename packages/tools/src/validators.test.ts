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

import {
  assertPaymentMethodConsistent,
  assertUnicodeSafe,
  PaymentMethodMismatchError,
  UnicodeUnsafeError,
} from "./validators.js";

describe("assertPaymentMethodConsistent", () => {
  it("throws when a FINANCE buyer's draft asserts cash (the PIC-20260629r2-3 defect)", () => {
    expect(() =>
      assertPaymentMethodConsistent(
        "Thanks for the number. I'm ready to move — this would be a cash purchase, no trade-in.",
        "finance",
      ),
    ).toThrow(PaymentMethodMismatchError);
  });

  it("throws when a CASH buyer's draft asserts financing or leasing", () => {
    expect(() =>
      assertPaymentMethodConsistent("I'll finance through your dealership.", "cash"),
    ).toThrow(PaymentMethodMismatchError);
    expect(() =>
      assertPaymentMethodConsistent("We're planning to lease this one.", "cash"),
    ).toThrow(PaymentMethodMismatchError);
  });

  it("passes when the draft is consistent with the chosen method", () => {
    expect(
      assertPaymentMethodConsistent(
        "I plan to finance — can you send your best APR and term?",
        "finance",
      ),
    ).toEqual({ ok: true, errors: [] });
    expect(
      assertPaymentMethodConsistent("I plan to pay cash; what's your best out-the-door?", "cash"),
    ).toEqual({ ok: true, errors: [] });
  });

  it("passes when the draft is silent on payment method", () => {
    expect(
      assertPaymentMethodConsistent("Can you beat 31200 out-the-door on the same trim?", "finance"),
    ).toEqual({ ok: true, errors: [] });
  });

  it("does not flag a neutral QUESTION about financing for a cash buyer", () => {
    // A question is not a self-claim; only an affirmative intent counts.
    expect(
      assertPaymentMethodConsistent("Do you offer in-house financing options?", "cash"),
    ).toEqual({ ok: true, errors: [] });
  });

  it("does not flag a NEGATED or CONTRASTED mention of the other method", () => {
    // Cash buyer negating financing is consistent, not a contradiction.
    expect(
      assertPaymentMethodConsistent("No, I'm not financing it — I'll be paying cash.", "cash"),
    ).toEqual({ ok: true, errors: [] });
    // Finance buyer contrasting against cash is consistent.
    expect(
      assertPaymentMethodConsistent("Rather than paying cash, I'll finance with you.", "finance"),
    ).toEqual({ ok: true, errors: [] });
  });

  it("does not flag a competing dealer's 'cash deal/offer' cited by a finance buyer", () => {
    // The prompt encourages citing a competing number; 'cash deal'/'cash offer'
    // describe a competitor, not the buyer — they are not self-claims.
    expect(
      assertPaymentMethodConsistent("Another dealer has a better cash deal at 31,200.", "finance"),
    ).toEqual({ ok: true, errors: [] });
  });

  it("never throws when the preference is undecided / empty / unknown", () => {
    for (const pref of ["undecided", "", null, "whatever"]) {
      expect(
        assertPaymentMethodConsistent("This would be a cash purchase.", pref),
      ).toEqual({ ok: true, errors: [] });
    }
  });
});

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
