/**
 * inbox non-substantive reply filter — the PURE predicate the negotiation
 * detail read uses to HIDE inbound replies that carry no negotiation value:
 * no-reply / do-not-reply mailers, auto-replies & bounces, CRM-relay noise that
 * never produced a quote, and conservative marketing/advertising blasts.
 *
 * A priced or substantive reply is ALWAYS shown: the positive override
 * (an extracted quote, or a quote-signal token in the prose) beats every HIDE
 * rule, so the filter can never swallow a real dealer number.
 *
 * Dependency wall: pure TS — only sibling inbox helpers (CRM host table +
 * quote-signal vocabulary), no DB, no LLM.
 */

import { detectCrmPlatformSender } from "./crm.js";
import { QUOTE_SIGNAL_TOKENS } from "./discovery.js";

/** The row shape the predicate reads — the minimal slice the detail read
 *  (T5) supplies per inbound message. `quoteExtractionIntent` is
 *  post-extraction-only (NULL for pending/failed messages). */
export interface ReplyFilterRow {
  senderEmail: string;
  subject: string;
  bodyText: string;
  quoteExtractionIntent: string | null;
  hasExtractedQuote: boolean;
}

/** A no-reply / do-not-reply mailer local-part. The `@` anchors it to the
 *  whole local part of the raw sender address. */
const NO_REPLY_RE = /^(no.?reply|do.?not.?reply)@/i;

/** Auto-reply / out-of-office / bounce subjects and bodies. */
const AUTO_REPLY_RE =
  /automatic reply|out of office|auto.?reply|undeliverable|delivery (status|has failed)|vacation/i;

/** Conservative advertising / marketing blast signals. */
const MARKETING_RE =
  /unsubscribe|newsletter|sales event|limited.time|this (weekend|week) only|special offer|clearance|year.end event|manager'?s special/i;

/** True when the prose carries any quote-signal token (e.g. a "$", "otd",
 *  "out-the-door"). Lowercased substring match — the same vocabulary the
 *  thread classifier uses. */
function hasQuoteSignal(haystack: string): boolean {
  const hay = haystack.toLowerCase();
  return QUOTE_SIGNAL_TOKENS.some((t) => hay.includes(t));
}

/**
 * True when an inbound reply is non-substantive and should be hidden from the
 * negotiation detail. The positive override (an extracted quote OR a
 * quote-signal token) ALWAYS wins, so a priced reply is never hidden. Pure.
 */
export function isNonSubstantiveReply(row: ReplyFilterRow): boolean {
  const prose = `${row.subject} ${row.bodyText}`;

  // Positive override — a priced/substantive reply is NEVER hidden.
  if (row.hasExtractedQuote === true) return false;
  if (hasQuoteSignal(prose)) return false;

  if (NO_REPLY_RE.test(row.senderEmail)) return true;
  if (AUTO_REPLY_RE.test(prose)) return true;
  if (row.quoteExtractionIntent === "auto_reply") return true;
  if (detectCrmPlatformSender(row.senderEmail)) return true;
  if (MARKETING_RE.test(prose)) return true;

  return false;
}
