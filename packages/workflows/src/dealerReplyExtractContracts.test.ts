/**
 * Unit tests — the dealer_reply_extract emit contract. Freezes the #1244-safe
 * shape of DealerReplyExtractEmitSchema: a single flat, all-required, .strict()
 * tool schema. T7 added the LLM title-fallback fields (contact_name /
 * contact_role) — these tests pin that the schema accepts both a null and a
 * value, the prompt asks for them, and the strict shape stays closed.
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

describe("DealerReplyExtractEmitSchema — contact_name / contact_role", () => {
  it("accepts both fields null (no signature)", () => {
    const parsed = DealerReplyExtractEmitSchema.parse({
      ...BASE,
      contact_name: null,
      contact_role: null,
    });
    expect(parsed.contact_name).toBeNull();
    expect(parsed.contact_role).toBeNull();
  });

  it("accepts a name + title value", () => {
    const parsed = DealerReplyExtractEmitSchema.parse({
      ...BASE,
      contact_name: "Jane Doe",
      contact_role: "Sales Manager",
    });
    expect(parsed.contact_name).toBe("Jane Doe");
    expect(parsed.contact_role).toBe("Sales Manager");
  });

  it("rejects a missing contact field (all-required)", () => {
    expect(() =>
      DealerReplyExtractEmitSchema.parse({ ...BASE, contact_name: null }),
    ).toThrow();
  });

  it("stays .strict() — an unknown key is rejected", () => {
    expect(() =>
      DealerReplyExtractEmitSchema.parse({
        ...BASE,
        contact_name: null,
        contact_role: null,
        contact_email: "x@y.z",
      }),
    ).toThrow();
  });
});

describe("buildDealerReplyExtractPrompt — title-fallback instruction", () => {
  it("asks for the signature name + title and keeps the emit_result discipline", () => {
    const prompt = buildDealerReplyExtractPrompt("Here is your quote.", "");
    expect(prompt).toContain("contact_name / contact_role");
    expect(prompt).toContain("Return via the emit_result tool.");
    // The replaced clause is gone.
    expect(prompt).not.toContain("Extract numeric facts only.");
  });
});
