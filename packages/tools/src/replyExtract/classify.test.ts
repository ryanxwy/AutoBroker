/**
 * L1 unit tests — the dealer_reply_extract pure classifiers. Freezes:
 *   - normalizeOtdPrice: $-strip, comma-strip, k/K ×1000, placeholder → null;
 *   - classifyIntent: unsubscribe ALWAYS wins; quote > ask_for_visit > unrelated;
 *   - parseQuoteFromBody: null when nothing quote-shaped;
 *   - classifyMessageQuoteClass: pdf > image > text > no_quote (attachment class
 *     wins over body; future-promise → no_quote).
 */

import { describe, expect, it } from "vitest";

import type { AttachmentRef } from "../gmail/types.js";
import {
  classifyMessageQuoteClass,
  normalizeOtdPrice,
  classifyIntent,
  parseQuoteFromBody,
} from "./classify.js";

function att(mimeType: string): AttachmentRef {
  return { attachmentId: "a", filename: "f", mimeType, sizeBytes: 0 };
}

// ---------------------------------------------------------------------------
// normalizeOtdPrice
// ---------------------------------------------------------------------------

describe("normalizeOtdPrice", () => {
  it.each([
    ["$12,345", 12345],
    ["12345.00", 12345],
    ["$12k", 12000],
    ["12K", 12000],
    ["$43k", 43000],
    ["$1,234.56", 1234.56],
    ["38120", 38120],
    ["$ 5,000", 5000],
  ] as const)("%s → %d", (raw, expected) => {
    expect(normalizeOtdPrice(raw)).toBe(expected);
  });

  it.each([
    ["free"],
    ["call us"],
    ["TBD"],
    ["please inquire"],
    [""],
    // anchoring: free text containing a number is NOT a price token
    ["2026 Tucson"],
    ["call 555-1234"],
  ] as const)("%s → null", (raw) => {
    expect(normalizeOtdPrice(raw)).toBeNull();
  });

  it("$43k → 43000 (regression: anchored regex still accepts leading $)", () => {
    expect(normalizeOtdPrice("$43k")).toBe(43000);
  });

  it("$12,345 → 12345 (regression: anchored regex still accepts comma-formatted price)", () => {
    expect(normalizeOtdPrice("$12,345")).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// classifyIntent
// ---------------------------------------------------------------------------

describe("classifyIntent", () => {
  it("unsubscribe ALWAYS wins, even with a quote in the same body", () => {
    const body = "Your OTD is $38,120 on the Tucson. To unsubscribe, click here.";
    expect(classifyIntent(body)).toBe("unsubscribe");
  });

  it("a price-bearing body is quote", () => {
    expect(classifyIntent("Sale price 33,995; MSRP 36,000.")).toBe("quote");
  });

  it("a visit nudge (no numbers) is ask_for_visit", () => {
    expect(classifyIntent("Come in for a test drive this weekend!")).toBe("ask_for_visit");
  });

  it("a plain reply is unrelated", () => {
    expect(classifyIntent("Thanks for reaching out, I'll be in touch.")).toBe("unrelated");
  });

  it("quote outranks ask_for_visit when both present", () => {
    expect(classifyIntent("OTD $40,000 — come in to finalize.")).toBe("quote");
  });
});

// ---------------------------------------------------------------------------
// parseQuoteFromBody
// ---------------------------------------------------------------------------

describe("parseQuoteFromBody", () => {
  it("returns null when nothing quote-shaped", () => {
    expect(parseQuoteFromBody("Thanks, talk soon.")).toBeNull();
    expect(parseQuoteFromBody("")).toBeNull();
  });

  it("extracts a VIN", () => {
    const r = parseQuoteFromBody("VIN: KM8J33A2XPU100001 in stock.");
    expect(r?.vin).toBe("KM8J33A2XPU100001");
  });

  it("extracts OTD / MSRP / doc fee as float dollars", () => {
    const r = parseQuoteFromBody("OTD $38,120, MSRP 36,000, doc fee $85.");
    expect(r?.otd).toBe(38120);
    expect(r?.msrp).toBe(36000);
    expect(r?.docFee).toBe(85);
  });

  it("flags an incentive keyword", () => {
    const r = parseQuoteFromBody("$1,000 rebate available.");
    expect(r?.hasIncentive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyMessageQuoteClass
// ---------------------------------------------------------------------------

describe("classifyMessageQuoteClass", () => {
  it("a PDF attachment → pdf_quote (outranks image + body)", () => {
    const cls = classifyMessageQuoteClass({
      body: "See attached. OTD $38,120.",
      attachments: [att("image/png"), att("application/pdf")],
    });
    expect(cls).toBe("pdf_quote");
  });

  it("an image attachment (no PDF) → image_quote", () => {
    const cls = classifyMessageQuoteClass({
      body: "Quote screenshot attached.",
      attachments: [att("image/jpeg")],
    });
    expect(cls).toBe("image_quote");
  });

  it("a price-bearing body with no quote-bearing attachment → text_quote", () => {
    const cls = classifyMessageQuoteClass({
      body: "Sale price 33,995, OTD $38,120.",
      attachments: [],
    });
    expect(cls).toBe("text_quote");
  });

  it("a future-promise body with no real numbers → no_quote", () => {
    const cls = classifyMessageQuoteClass({
      body: "I'll send you numbers tomorrow once I check with my manager.",
      attachments: [],
    });
    expect(cls).toBe("no_quote");
  });

  it("a non-quote attachment (e.g. a calendar invite) falls through to the body", () => {
    const cls = classifyMessageQuoteClass({
      body: "Looking forward to meeting!",
      attachments: [att("text/calendar")],
    });
    expect(cls).toBe("no_quote");
  });
});
