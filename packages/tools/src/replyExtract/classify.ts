/**
 * dealer_reply_extract deterministic classifiers — pure functions, NO LLM, NO
 * I/O. They decide the per-message quote class, normalize an OTD price string to
 * float dollars, classify the body-parse intent, and regex a quote shape out of
 * a message body. The LLM step downstream reads these to decide whether a
 * message is worth a structured extraction at all.
 *
 * NOTE on the two "intent" notions: `classifyIntent` here is the BODY-PARSE
 * intent (`unsubscribe | quote | ask_for_visit | unrelated`) used by the
 * deterministic class decision. It is NOT the LLM emit `message_intent` enum
 * (`real_quote | counter | stall | come_in | auto_reply`) — do not conflate.
 */

import type { AttachmentRef } from "../gmail/types.js";
import { classifyAttachment } from "../gmail/attachmentText.js";

// ---------------------------------------------------------------------------
// Message-level quote class
// ---------------------------------------------------------------------------

/** The deterministic per-message quote class — which extraction path (if any)
 *  the message warrants. */
export type MessageQuoteClass = "pdf_quote" | "image_quote" | "text_quote" | "no_quote";

/** A message body + its attachment refs — the inputs the class decision reads.
 *  Kept minimal so the classifier is a pure function over plain data. */
export interface ClassifyMessageInput {
  body: string;
  attachments: readonly AttachmentRef[];
}

/**
 * Classify one message into a quote class. Attachment classes win over the body
 * (a PDF/image quote is the richest source); among attachments a PDF outranks an
 * image. With no quote-bearing attachment, a body that parses to a quote shape
 * is `text_quote`; otherwise `no_quote`.
 *
 * A future-promise body ("I'll send numbers tomorrow") with no real figures and
 * no quote-bearing attachment is `no_quote`.
 */
export function classifyMessageQuoteClass(input: ClassifyMessageInput): MessageQuoteClass {
  let hasPdf = false;
  let hasImage = false;
  for (const ref of input.attachments) {
    const cls = classifyAttachment(ref.mimeType);
    if (cls === "pdf") hasPdf = true;
    else if (cls === "image") hasImage = true;
  }
  if (hasPdf) return "pdf_quote";
  if (hasImage) return "image_quote";
  if (parseQuoteFromBody(input.body) !== null) return "text_quote";
  return "no_quote";
}

// ---------------------------------------------------------------------------
// OTD price normalization
// ---------------------------------------------------------------------------

/** Matches an ENTIRE price token: optional leading $, digits with optional
 *  thousands commas and decimals, optional k/K suffix. Anchored so that free
 *  text like "2026 Tucson" or "call 555-1234" does not produce a false match. */
const PRICE_RE = /^\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kK])?$/;

/**
 * Normalize a raw price string to FLOAT DOLLARS, or null when no real number is
 * present.
 *
 *   "$12,345"   → 12345
 *   "12345.00"  → 12345
 *   "$12k"      → 12000
 *   "12K"       → 12000
 *   "$43k"      → 43000
 *   "free"      → null
 *   "call us"   → null
 *
 * Strips the leading "$" and thousands commas; a trailing k/K multiplies by
 * 1000. Non-numeric / placeholder strings → null.
 */
export function normalizeOtdPrice(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const m = PRICE_RE.exec(raw.trim());
  if (m === null) return null;
  const digits = m[1]!.replace(/,/g, "");
  const value = Number.parseFloat(digits);
  if (!Number.isFinite(value)) return null;
  const isThousands = m[2] !== undefined;
  return isThousands ? value * 1000 : value;
}

// ---------------------------------------------------------------------------
// Body-parse intent
// ---------------------------------------------------------------------------

/** The body-parse intent taxonomy (distinct from the LLM emit message_intent). */
export type BodyIntent = "unsubscribe" | "quote" | "ask_for_visit" | "unrelated";

const UNSUBSCRIBE_RE = /\b(unsubscribe|opt[\s-]?out|stop\s+emails?|remove\s+me)\b/i;
const VISIT_RE = /\b(come\s+in|stop\s+by|visit\s+(us|the\s+(store|dealership))|test\s+drive|schedule\s+(an?\s+)?appointment|see\s+you\s+(here|at))\b/i;

/**
 * Classify a body's intent with a fixed precedence:
 *   unsubscribe > quote > ask_for_visit > unrelated.
 *
 * `unsubscribe` ALWAYS wins (short-circuit) — it is a safety contract: an
 * unsubscribe request is honored even if the same body also looks quote-shaped.
 */
export function classifyIntent(body: string): BodyIntent {
  if (typeof body !== "string") return "unrelated";
  if (UNSUBSCRIBE_RE.test(body)) return "unsubscribe";
  if (parseQuoteFromBody(body) !== null) return "quote";
  if (VISIT_RE.test(body)) return "ask_for_visit";
  return "unrelated";
}

// ---------------------------------------------------------------------------
// parseQuoteFromBody — regex extraction of a quote shape
// ---------------------------------------------------------------------------

/** A 17-char VIN (no I/O/Q per the standard alphabet). */
const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/;
const TRIM_RE = /\btrim\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9 +/-]{0,30})/i;
const OTD_RE = /\b(?:otd|out[\s-]?the[\s-]?door)\b[^$0-9]{0,12}(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*[kK]?)/i;
const MSRP_RE = /\bmsrp\b[^$0-9]{0,12}(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*[kK]?)/i;
const DOC_FEE_RE = /\bdoc(?:ument)?\s*fee\b[^$0-9]{0,12}(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*[kK]?)/i;
const INCENTIVE_RE = /\b(rebate|incentive|cash\s+back|bonus\s+cash)\b/i;
/** A bare selling/sale/price figure with a dollar amount. */
const PRICE_FIELD_RE = /\b(?:sale|selling|price)\b[^$0-9]{0,12}(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*[kK]?)/i;

/** A quote shape parsed from a body — every field is best-effort; the whole
 *  result is null when NOTHING quote-shaped was found. */
export interface ParsedBodyQuote {
  vin: string | null;
  trim: string | null;
  otd: number | null;
  msrp: number | null;
  docFee: number | null;
  sellingPrice: number | null;
  hasIncentive: boolean;
}

/**
 * Regex a quote shape out of a message body. Returns null when nothing
 * quote-shaped is present (no VIN, no recognized money field, no incentive
 * keyword) — a plain "thanks for reaching out, I'll be in touch" body yields
 * null. A future-promise with no real numbers is therefore `no_quote` upstream.
 */
export function parseQuoteFromBody(body: string): ParsedBodyQuote | null {
  if (typeof body !== "string" || body.trim() === "") return null;

  const vinMatch = VIN_RE.exec(body);
  const trimMatch = TRIM_RE.exec(body);
  const otd = matchMoney(OTD_RE, body);
  const msrp = matchMoney(MSRP_RE, body);
  const docFee = matchMoney(DOC_FEE_RE, body);
  const sellingPrice = matchMoney(PRICE_FIELD_RE, body);
  const hasIncentive = INCENTIVE_RE.test(body);

  const anyShape =
    vinMatch !== null ||
    otd !== null ||
    msrp !== null ||
    docFee !== null ||
    sellingPrice !== null ||
    hasIncentive;
  if (!anyShape) return null;

  return {
    vin: vinMatch?.[1] ?? null,
    trim: trimMatch?.[1]?.trim() ?? null,
    otd,
    msrp,
    docFee,
    sellingPrice,
    hasIncentive,
  };
}

/** Run a labeled-money regex and normalize its captured group to float dollars. */
function matchMoney(re: RegExp, body: string): number | null {
  const m = re.exec(body);
  if (m === null || m[1] === undefined) return null;
  return normalizeOtdPrice(m[1]);
}
