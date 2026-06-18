/**
 * inbox/quoteSourceDoc — re-fetch a quote's SOURCE document (the dealer-sent PDF
 * or image the quote was extracted from) ON DEMAND through the gmail adapter.
 *
 * READ-ONLY, no gate, no mutation, no new write. Nothing about the source bytes
 * is persisted: the extract pipeline stored only the parsed quote row plus its
 * `source_gmail_message_id`; this re-reads that message's attachment bytes live
 * every call (fake mailbox in the fake/blocked lane, real Gmail otherwise),
 * exactly the way reply_extract obtains attachment bytes — `createGmailAdapter`
 * (default fake) + `adapter.getMessage` / `adapter.downloadAttachment`.
 *
 * The adapter calls are wrapped in try/catch: a transient adapter failure (an
 * unreachable mailbox, a deleted message) degrades to `null`, NEVER a throw — the
 * route renders a 404, not a 500.
 *
 * GUARDS: only an image/* or application/pdf attachment is served (the first
 * matching ref on the message), and only up to 25 MiB — anything else returns
 * null so the route never streams an unexpected or unbounded blob.
 */

import type { Db } from "@autobroker/db";

import { createGmailAdapter } from "../gmail.js";
import type { AttachmentRef, GmailAdapter } from "../gmail/types.js";

/** The max source-document size streamed back (bytes). Larger → null. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** True for the served document mime allowlist: any image, or a PDF. */
function isAllowedMime(mimeType: string): boolean {
  return /^image\//i.test(mimeType) || mimeType === "application/pdf";
}

export interface ReadQuoteSourceDocArgs {
  profileId: string;
  quoteId: string;
}

export interface ReadQuoteSourceDocOpts {
  /** Inject a gmail adapter (tests); defaults to the env-driven factory. */
  adapter?: GmailAdapter;
}

export interface QuoteSourceDoc {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

/**
 * Re-fetch the source document for one (profileId, quoteId). Returns null when:
 * the quote does not exist for that profile, the source message has no
 * allowlisted attachment, the attachment exceeds the size cap, or any adapter
 * read throws (transient fallback — never propagates to the route).
 */
export async function readQuoteSourceDoc(
  db: Db,
  args: ReadQuoteSourceDocArgs,
  opts: ReadQuoteSourceDocOpts = {},
): Promise<QuoteSourceDoc | null> {
  // Ownership SELECT: the quote must belong to THIS profile (no cross-profile
  // read). A missing row → null.
  const row = db.$client
    .prepare(
      "SELECT source_gmail_message_id FROM dealer_quotes WHERE quote_id = ? AND search_profile_id = ?",
    )
    .get(args.quoteId, args.profileId) as { source_gmail_message_id: string } | undefined;
  if (row === undefined) return null;
  const sourceMessageId = row.source_gmail_message_id;

  const adapter = opts.adapter ?? createGmailAdapter();

  try {
    const msg = await adapter.getMessage(sourceMessageId);
    // The first attachment whose declared mime is in the allowlist (image or PDF).
    const ref: AttachmentRef | undefined = msg.attachments.find((a) => isAllowedMime(a.mimeType));
    if (ref === undefined) return null;

    const data = await adapter.downloadAttachment(sourceMessageId, ref);
    // Re-check the RESOLVED mime (the download reports the authoritative type) and
    // enforce the size cap before returning any bytes.
    if (!isAllowedMime(data.mimeType)) return null;
    if (data.bytes.length > MAX_SOURCE_BYTES) return null;

    return { bytes: data.bytes, mimeType: data.mimeType, filename: data.filename };
  } catch {
    // Transient adapter failure (unreachable mailbox, deleted message) → null,
    // never a throw. The route renders a 404.
    return null;
  }
}
