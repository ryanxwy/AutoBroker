/**
 * Unit tests — the MIME walk (pure, no network). Freezes the canonical body
 * parse the real adapter depends on:
 *   - first text/plain wins, first text/html wins;
 *   - base64url body data decodes to utf-8;
 *   - every part carrying a body.attachmentId becomes an AttachmentRef, in
 *     depth-first order, with filename/mimeType/sizeBytes;
 *   - nested multipart trees recurse depth-first;
 *   - missing payload / missing parts yield empty results, not throws;
 *   - readPartHeader is case-insensitive, first-match-wins.
 *
 * Fixtures are hand-built Gmail-API message payloads — the exact tree shape the
 * wire returns — so the parse is proven without a live mailbox.
 */

import { describe, expect, it } from "vitest";

import { readPartHeader, walkParts } from "./mime.js";
import type { gmail_v1 } from "@googleapis/gmail";

type Part = gmail_v1.Schema$MessagePart;

/** base64url-encode utf-8 text the way Gmail encodes inline part bodies. */
function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("readPartHeader", () => {
  it("matches case-insensitively, first match wins, '' when absent", () => {
    const part: Part = {
      headers: [
        { name: "From", value: "a@x.com" },
        { name: "Subject", value: "Hello" },
        { name: "subject", value: "Second" },
      ],
    };
    expect(readPartHeader(part, "from")).toBe("a@x.com");
    expect(readPartHeader(part, "SUBJECT")).toBe("Hello");
    expect(readPartHeader(part, "to")).toBe("");
  });

  it("returns '' when a part has no headers", () => {
    expect(readPartHeader({}, "from")).toBe("");
  });
});

describe("walkParts", () => {
  it("returns empty results for a null/undefined payload", () => {
    expect(walkParts(undefined)).toEqual({ bodyText: "", bodyHtml: "", attachments: [] });
    expect(walkParts(null)).toEqual({ bodyText: "", bodyHtml: "", attachments: [] });
  });

  it("reads a single-part text/plain leaf, base64url-decoded", () => {
    const payload: Part = {
      mimeType: "text/plain",
      body: { size: 5, data: b64url("hello") },
    };
    const parsed = walkParts(payload);
    expect(parsed.bodyText).toBe("hello");
    expect(parsed.bodyHtml).toBe("");
    expect(parsed.attachments).toEqual([]);
  });

  it("picks first text/plain and first text/html from multipart/alternative", () => {
    const payload: Part = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("plain body") } },
        { mimeType: "text/html", body: { data: b64url("<p>html body</p>") } },
        { mimeType: "text/plain", body: { data: b64url("SECOND plain — ignored") } },
        { mimeType: "text/html", body: { data: b64url("<p>SECOND html — ignored</p>") } },
      ],
    };
    const parsed = walkParts(payload);
    expect(parsed.bodyText).toBe("plain body");
    expect(parsed.bodyHtml).toBe("<p>html body</p>");
  });

  it("collects every attachment part (multipart/mixed) with metadata", () => {
    const payload: Part = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("see attached") } },
            { mimeType: "text/html", body: { data: b64url("<p>see attached</p>") } },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "quote.pdf",
          body: { attachmentId: "att-1", size: 12345 },
        },
        {
          mimeType: "image/png",
          filename: "photo.png",
          body: { attachmentId: "att-2", size: 678 },
        },
      ],
    };
    const parsed = walkParts(payload);
    expect(parsed.bodyText).toBe("see attached");
    expect(parsed.bodyHtml).toBe("<p>see attached</p>");
    expect(parsed.attachments).toEqual([
      { attachmentId: "att-1", filename: "quote.pdf", mimeType: "application/pdf", sizeBytes: 12345 },
      { attachmentId: "att-2", filename: "photo.png", mimeType: "image/png", sizeBytes: 678 },
    ]);
  });

  it("recurses deeply nested multipart trees depth-first", () => {
    const payload: Part = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/related",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                { mimeType: "text/plain", body: { data: b64url("deep plain") } },
                { mimeType: "text/html", body: { data: b64url("<i>deep html</i>") } },
              ],
            },
            { mimeType: "image/gif", filename: "inline.gif", body: { attachmentId: "att-deep", size: 9 } },
          ],
        },
      ],
    };
    const parsed = walkParts(payload);
    expect(parsed.bodyText).toBe("deep plain");
    expect(parsed.bodyHtml).toBe("<i>deep html</i>");
    expect(parsed.attachments.map((a) => a.attachmentId)).toEqual(["att-deep"]);
  });

  it("treats a part with empty/absent body data as an empty body", () => {
    const payload: Part = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { size: 0 } }, // no data field
        { mimeType: "text/html" }, // no body at all
      ],
    };
    const parsed = walkParts(payload);
    expect(parsed.bodyText).toBe("");
    expect(parsed.bodyHtml).toBe("");
    expect(parsed.attachments).toEqual([]);
  });

  it("defaults sizeBytes to 0 and filename to '' when the part omits them", () => {
    const payload: Part = {
      mimeType: "application/octet-stream",
      body: { attachmentId: "att-x" }, // no size, no filename
    };
    const parsed = walkParts(payload);
    expect(parsed.attachments).toEqual([
      { attachmentId: "att-x", filename: "", mimeType: "application/octet-stream", sizeBytes: 0 },
    ]);
  });

  it("does not mistake an inline text part (no attachmentId) for an attachment", () => {
    const payload: Part = {
      mimeType: "text/plain",
      filename: "inline.txt", // filename present but NO attachmentId
      body: { data: b64url("just text") },
    };
    const parsed = walkParts(payload);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.bodyText).toBe("just text");
  });
});
