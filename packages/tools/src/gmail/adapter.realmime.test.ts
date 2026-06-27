/**
 * Real-MIME regression suite — RealGmailAdapter against an INJECTED stub client
 * (zero network), driving hand-built `gmail_v1.Schema$Message` fixtures through
 * the wire→canonical `mapMessage` mapping.
 *
 * The keystone case is the HTML-ONLY dealer email: a single text/html part with
 * NO text/plain part. Without the html→text fallback in `mapMessage`, walkParts
 * returns an empty bodyText and the quote text is silently lost. These tests
 * pin that the fallback recovers the readable quote, and that it does NOT fire
 * when a real text/plain part is present.
 *
 * All fixtures are SYNTHETIC: a fake dealer ("Maple Hill Toyota") and a fake
 * buyer; no real names, emails, or PII.
 */

import { describe, expect, it, vi } from "vitest";

import { RealGmailAdapter, type GmailApiClient } from "./adapter.js";
import type { gmail_v1 } from "@googleapis/gmail";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** A minimal stub exposing just the read methods these tests call: a fixed
 *  `messages.get` payload and an `attachments.get` byte blob. */
function stubFor(
  message: gmail_v1.Schema$Message,
  attachmentData = b64url("ATTACHMENT-BYTES"),
): GmailApiClient {
  return {
    users: {
      messages: {
        get: vi.fn(async () => ({ data: message })),
        attachments: {
          get: vi.fn(async () => ({
            data: { data: attachmentData } as gmail_v1.Schema$MessagePartBody,
          })),
        },
      },
    },
  } as unknown as GmailApiClient;
}

const STD_HEADERS = [
  { name: "From", value: "sales@maplehilltoyota.example" },
  { name: "To", value: "buyer@example.com" },
  { name: "Subject", value: "Your quote from Maple Hill Toyota" },
];

describe("RealGmailAdapter — real-MIME body recovery", () => {
  it("(a) text/plain-only message → bodyText is the plain text", async () => {
    const message: gmail_v1.Schema$Message = {
      id: "m-plain",
      threadId: "t1",
      internalDate: "1700000000000",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "text/plain",
        headers: STD_HEADERS,
        body: { data: b64url("Your out-the-door price is $31,250.") },
      },
    };
    const adapter = new RealGmailAdapter({ client: stubFor(message) });

    const msg = await adapter.getMessage("m-plain");

    expect(msg.bodyText).toBe("Your out-the-door price is $31,250.");
  });

  it("(b) HTML-only message → bodyText recovered from the HTML (quote not lost)", async () => {
    const html = "<html><body><p>Your out-the-door price is $31,250.</p></body></html>";
    const message: gmail_v1.Schema$Message = {
      id: "m-html",
      threadId: "t2",
      internalDate: "1700000000000",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "text/html",
        headers: STD_HEADERS,
        body: { data: b64url(html) },
      },
    };
    const adapter = new RealGmailAdapter({ client: stubFor(message) });

    const msg = await adapter.getMessage("m-html");

    // RED without the mapMessage fallback: walkParts yields bodyText "" for an
    // HTML-only message, so these assertions only pass once the html→text
    // recovery runs.
    expect(msg.bodyText).not.toBe("");
    expect(msg.bodyText).toContain("31,250");
    expect(msg.bodyText).toContain("out-the-door");
    // bodyHtml still carries the original markup unchanged.
    expect(msg.bodyHtml).toBe(html);
  });

  it("(c) multipart/alternative (plain + html) → bodyText is the PLAIN part (no fallback)", async () => {
    const message: gmail_v1.Schema$Message = {
      id: "m-alt",
      threadId: "t3",
      internalDate: "1700000000000",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "multipart/alternative",
        headers: STD_HEADERS,
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Plain: OTD $31,250.") } },
          { mimeType: "text/html", body: { data: b64url("<p>HTML: OTD $99,999.</p>") } },
        ],
      },
    };
    const adapter = new RealGmailAdapter({ client: stubFor(message) });

    const msg = await adapter.getMessage("m-alt");

    expect(msg.bodyText).toBe("Plain: OTD $31,250.");
    expect(msg.bodyText).not.toContain("99,999");
  });

  it("(c2) multipart/alternative with whitespace-only plain + rich html → bodyText recovered from html", async () => {
    const message: gmail_v1.Schema$Message = {
      id: "m-alt-blank",
      threadId: "t4",
      internalDate: "1700000000000",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "multipart/alternative",
        headers: STD_HEADERS,
        parts: [
          { mimeType: "text/plain", body: { data: b64url("   \n\t  ") } },
          {
            mimeType: "text/html",
            body: { data: b64url("<p>Your out-the-door price is $31,250.</p>") },
          },
        ],
      },
    };
    const adapter = new RealGmailAdapter({ client: stubFor(message) });

    const msg = await adapter.getMessage("m-alt-blank");

    expect(msg.bodyText).toContain("31,250");
    expect(msg.bodyText).toContain("out-the-door");
  });

  it("(d) multipart/mixed: text part + PDF attachment → attachment mapped + bytes decoded", async () => {
    const message: gmail_v1.Schema$Message = {
      id: "m-pdf",
      threadId: "t5",
      internalDate: "1700000000000",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "multipart/mixed",
        headers: STD_HEADERS,
        parts: [
          { mimeType: "text/plain", body: { data: b64url("See attached quote.") } },
          {
            mimeType: "application/pdf",
            filename: "maple-hill-quote.pdf",
            body: { attachmentId: "att-pdf-1", size: 2048 },
          },
        ],
      },
    };
    const adapter = new RealGmailAdapter({
      client: stubFor(message, b64url("%PDF-FAKE-BYTES")),
    });

    const msg = await adapter.getMessage("m-pdf");

    expect(msg.attachments).toEqual([
      {
        attachmentId: "att-pdf-1",
        filename: "maple-hill-quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    ]);

    const data = await adapter.downloadAttachment("m-pdf", msg.attachments[0]!);
    expect(data.filename).toBe("maple-hill-quote.pdf");
    expect(data.mimeType).toBe("application/pdf");
    expect(Buffer.from(data.bytes).toString("utf8")).toBe("%PDF-FAKE-BYTES");
  });

  it("(e) multipart/mixed: text part + image attachment → attachment mapped", async () => {
    const message: gmail_v1.Schema$Message = {
      id: "m-img",
      threadId: "t6",
      internalDate: "1700000000000",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "multipart/mixed",
        headers: STD_HEADERS,
        parts: [
          { mimeType: "text/plain", body: { data: b64url("See the window sticker image.") } },
          {
            mimeType: "image/png",
            filename: "window-sticker.png",
            body: { attachmentId: "att-img-1", size: 4096 },
          },
        ],
      },
    };
    const adapter = new RealGmailAdapter({ client: stubFor(message) });

    const msg = await adapter.getMessage("m-img");

    expect(msg.attachments).toEqual([
      {
        attachmentId: "att-img-1",
        filename: "window-sticker.png",
        mimeType: "image/png",
        sizeBytes: 4096,
      },
    ]);
  });

  it("(f) direction is outbound when labelIds includes SENT, inbound otherwise", async () => {
    const base = (labelIds: string[]): gmail_v1.Schema$Message => ({
      id: "m-dir",
      threadId: "t7",
      internalDate: "1700000000000",
      labelIds,
      payload: {
        mimeType: "text/plain",
        headers: STD_HEADERS,
        body: { data: b64url("hello") },
      },
    });

    const outbound = new RealGmailAdapter({ client: stubFor(base(["SENT"])) });
    expect((await outbound.getMessage("m-dir")).direction).toBe("outbound");

    const inbound = new RealGmailAdapter({ client: stubFor(base(["INBOX"])) });
    expect((await inbound.getMessage("m-dir")).direction).toBe("inbound");
  });
});
