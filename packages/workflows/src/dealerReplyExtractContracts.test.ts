/**
 * Unit tests — the dealer_reply_extract emit contract. Freezes the #1244-safe
 * shape of DealerReplyExtractEmitSchema: a single flat, all-required, .strict()
 * tool schema. The LLM title-fallback field (contact_role) — these tests pin
 * that the schema accepts both a null and a value, the prompt asks for it, and
 * the strict shape stays closed.
 */

import { describe, expect, it } from "vitest";

import {
  buildDealerReplyExtractPrompt,
  DealerReplyExtractEmitSchema,
} from "./dealerReplyExtractContracts.js";

const BASE = {
  quotes: [],
  message_intent: "stall" as const,
};

describe("DealerReplyExtractEmitSchema — contact_role", () => {
  it("accepts contact_role null (no signature)", () => {
    const parsed = DealerReplyExtractEmitSchema.parse({
      ...BASE,
      contact_role: null,
    });
    expect(parsed.contact_role).toBeNull();
  });

  it("accepts a title value", () => {
    const parsed = DealerReplyExtractEmitSchema.parse({
      ...BASE,
      contact_role: "Sales Manager",
    });
    expect(parsed.contact_role).toBe("Sales Manager");
  });

  it("rejects a missing contact field (all-required)", () => {
    expect(() => DealerReplyExtractEmitSchema.parse({ ...BASE })).toThrow();
  });

  it("stays .strict() — an unknown key is rejected", () => {
    expect(() =>
      DealerReplyExtractEmitSchema.parse({
        ...BASE,
        contact_role: null,
        contact_email: "x@y.z",
      }),
    ).toThrow();
  });
});

describe("buildDealerReplyExtractPrompt — title-fallback instruction", () => {
  it("asks for the signature job title and keeps the emit_result discipline", () => {
    const prompt = buildDealerReplyExtractPrompt("Here is your quote.", "");
    expect(prompt).toContain("contact_role");
    expect(prompt).toContain("Return via the emit_result tool.");
    // The replaced clause is gone.
    expect(prompt).not.toContain("Extract numeric facts only.");
  });
});
