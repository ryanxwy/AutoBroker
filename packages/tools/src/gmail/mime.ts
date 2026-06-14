/**
 * MIME walk — turn a Gmail API message payload (the parsed MIME tree the wire
 * returns) into the canonical parsed body the adapter contract exposes.
 *
 * This is a PURE function over the payload tree: no network, no DB, no clock. It
 * is the most unit-testable part of the real backend, so it lives apart from the
 * adapter and is exercised against hand-built payload fixtures.
 *
 * The rules (matching how the canonical Message shape is documented):
 *   - bodyText  = the FIRST text/plain part found in depth-first order;
 *   - bodyHtml  = the FIRST text/html part found in depth-first order;
 *   - attachments = EVERY part that carries a `body.attachmentId`, in
 *     depth-first order, mapped to an AttachmentRef (the opaque handle +
 *     filename + declared mime type + declared size);
 *   - part bodies are base64url-encoded inline data → decoded to utf-8 here;
 *     an attachment part's bytes are NOT inline (they carry an attachmentId and
 *     are fetched on demand), so we never decode attachment data here.
 *
 * Container parts (multipart/*) have empty bodies and child `parts[]`; leaf
 * parts (text/plain, text/html, application/pdf, …) carry the data or the
 * attachmentId. We recurse the whole tree once.
 */

import type { gmail_v1 } from "@googleapis/gmail";

import type { AttachmentRef } from "./types.js";

/** The parsed-out pieces of a message body the adapter assembles into a
 *  canonical Message. */
export interface ParsedBody {
  /** First text/plain part, base64url-decoded to utf-8; "" when none. */
  bodyText: string;
  /** First text/html part, base64url-decoded to utf-8; "" when none. */
  bodyHtml: string;
  /** Every part carrying a body.attachmentId, in depth-first order. */
  attachments: AttachmentRef[];
}

/** Read a single header value off a part's header list (case-insensitive name
 *  match; first match wins; "" when absent). */
export function readPartHeader(part: gmail_v1.Schema$MessagePart, name: string): string {
  const headers = part.headers ?? [];
  const lower = name.toLowerCase();
  for (const h of headers) {
    if ((h.name ?? "").toLowerCase() === lower) {
      return h.value ?? "";
    }
  }
  return "";
}

/** Decode a part's inline base64url body data to utf-8 ("" when no inline
 *  data). Gmail encodes part bodies base64url (web-safe), so a Buffer
 *  "base64url" decode is exact. */
function decodeBody(part: gmail_v1.Schema$MessagePart): string {
  const data = part.body?.data;
  if (data === undefined || data === null || data === "") return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

/** True when this part is an attachment: it declares a body.attachmentId (the
 *  opaque handle the API serves the bytes under). A filename alone is not
 *  enough — inline-disposition text parts can carry a filename too; the
 *  attachmentId is the authoritative "fetch me separately" marker. */
function isAttachmentPart(part: gmail_v1.Schema$MessagePart): boolean {
  const id = part.body?.attachmentId;
  return id !== undefined && id !== null && id !== "";
}

/**
 * Walk the payload tree depth-first, gathering the first text/plain, the first
 * text/html, and every attachment-bearing part. Pure: it reads only the passed
 * payload. A null/absent payload yields empty results.
 */
export function walkParts(payload: gmail_v1.Schema$MessagePart | undefined | null): ParsedBody {
  let bodyText = "";
  let bodyHtml = "";
  const attachments: AttachmentRef[] = [];

  const visit = (part: gmail_v1.Schema$MessagePart): void => {
    const mimeType = (part.mimeType ?? "").toLowerCase();

    if (isAttachmentPart(part)) {
      attachments.push({
        // isAttachmentPart guarantees a non-empty id; assert it for the type.
        attachmentId: part.body?.attachmentId as string,
        filename: part.filename ?? "",
        mimeType: part.mimeType ?? "",
        sizeBytes: part.body?.size ?? 0,
      });
      // An attachment part has no inline body to read for text, but a
      // multipart attachment (rare) could still nest parts — fall through to
      // recurse children below rather than returning early.
    } else if (mimeType === "text/plain") {
      if (bodyText === "") bodyText = decodeBody(part);
    } else if (mimeType === "text/html") {
      if (bodyHtml === "") bodyHtml = decodeBody(part);
    }

    for (const child of part.parts ?? []) {
      visit(child);
    }
  };

  if (payload !== undefined && payload !== null) visit(payload);

  return { bodyText, bodyHtml, attachments };
}
