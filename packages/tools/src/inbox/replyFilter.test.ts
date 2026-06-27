/**
 * L1 unit tests — the non-substantive reply filter. Freezes what the detail
 * read hides (no-reply / auto-reply / CRM-noise / marketing-advertising) and
 * the positive override that ALWAYS shows a priced/substantive reply. Pure.
 */

import { describe, expect, it } from "vitest";

import { isNonSubstantiveReply, type ReplyFilterRow } from "./replyFilter.js";

/** A baseline substantive-but-plain row; tests override one field at a time. */
function row(over: Partial<ReplyFilterRow> = {}): ReplyFilterRow {
  return {
    senderEmail: "sales@bobsmithhyundai.com",
    subject: "Re: your inquiry",
    bodyText: "Thanks for reaching out, happy to help.",
    quoteExtractionIntent: null,
    hasExtractedQuote: false,
    ...over,
  };
}

describe("isNonSubstantiveReply — HIDE cases", () => {
  it("hides a no-reply local-part sender", () => {
    expect(isNonSubstantiveReply(row({ senderEmail: "no-reply@bobsmithhyundai.com" }))).toBe(true);
    expect(isNonSubstantiveReply(row({ senderEmail: "noreply@dealer.com" }))).toBe(true);
    expect(isNonSubstantiveReply(row({ senderEmail: "donotreply@dealer.com" }))).toBe(true);
    expect(isNonSubstantiveReply(row({ senderEmail: "do.not.reply@dealer.com" }))).toBe(true);
  });

  it("hides an out-of-office / automatic-reply subject", () => {
    expect(isNonSubstantiveReply(row({ subject: "Out of Office: away until Monday" }))).toBe(true);
    expect(isNonSubstantiveReply(row({ subject: "Automatic reply: Re: your inquiry" }))).toBe(true);
  });

  it("hides an undeliverable / delivery-failure bounce", () => {
    expect(isNonSubstantiveReply(row({ subject: "Undeliverable: your message" }))).toBe(true);
    expect(
      isNonSubstantiveReply(row({ subject: "Delivery has failed to these recipients" })),
    ).toBe(true);
  });

  it("hides a row classified auto_reply by the extractor", () => {
    expect(isNonSubstantiveReply(row({ quoteExtractionIntent: "auto_reply" }))).toBe(true);
  });

  it("hides a CRM-platform sender with no extracted quote", () => {
    expect(isNonSubstantiveReply(row({ senderEmail: "lead@podium.email" }))).toBe(true);
  });

  it("hides marketing from a real sales address (no quote, no quote-signal)", () => {
    expect(
      isNonSubstantiveReply(
        row({
          subject: "Year-End Sales Event — this weekend only!",
          bodyText: "Come see our clearance. Click here to unsubscribe.",
        }),
      ),
    ).toBe(true);
  });
});

describe("isNonSubstantiveReply — SHOW cases (override wins)", () => {
  it("shows a plain substantive reply", () => {
    expect(isNonSubstantiveReply(row())).toBe(false);
  });

  it("shows a CRM-platform sender that DID produce a quote", () => {
    expect(
      isNonSubstantiveReply(row({ senderEmail: "lead@podium.email", hasExtractedQuote: true })),
    ).toBe(false);
  });

  it("shows a reply carrying a quote-signal token even without an extracted quote", () => {
    expect(
      isNonSubstantiveReply(row({ bodyText: "Your out-the-door price is ready." })),
    ).toBe(false);
  });

  it("shows a 'sales event' email that contains a real $ price (override wins)", () => {
    expect(
      isNonSubstantiveReply(
        row({
          subject: "Year-End Sales Event — this weekend only!",
          bodyText: "And on your trim the OTD is $32,500. Unsubscribe anytime.",
        }),
      ),
    ).toBe(false);
  });

  it("shows even a no-reply sender if it carries an extracted quote (override is absolute)", () => {
    expect(
      isNonSubstantiveReply(row({ senderEmail: "no-reply@dealer.com", hasExtractedQuote: true })),
    ).toBe(false);
  });
});
