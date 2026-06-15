/**
 * dealer_reply_extract attachment fallback tree — for one message, download
 * each attachment's bytes through the injected adapter and run them through the
 * attachment-text seam (pdfjs text layer for PDFs, on-device OCR for images,
 * utf-8 decode for text). Aggregates the per-attachment outcomes so the workflow
 * can build the LLM prompt and decide the row's `extraction_method`.
 *
 * Rules inherited from the seam (do NOT re-implement):
 *   - PDFs are NEVER OCR'd — a no-text-layer PDF is an honest failure;
 *   - images go through on-device OCR (retry-once lives in the seam); off-mac or
 *     a missing helper degrades to a typed failure, never a throw;
 *   - the seam NEVER throws — every outcome is a typed result.
 *
 * The adapter download is read-only (no gate). A download throw is caught and
 * recorded as a per-attachment failure, so one bad attachment never aborts the
 * message.
 */

import type { AttachmentRef, AttachmentData, GmailAdapter } from "../gmail/types.js";
import {
  extractAttachmentText,
  classifyAttachment,
  type AttachmentClass,
  type AttachmentFallbackSpan,
  type ExtractOptions,
} from "../gmail/attachmentText.js";

/** The extraction method an attachment's text was won by — orthogonal to the
 *  provider, mirrors the table's `extraction_method` enum (sans `vision`, which
 *  is the model-layer native path, decided by the workflow, not here). */
export type AttachmentExtractionMethod = "text" | "ocr";

/** One attachment's outcome. On success, the extracted text + the method + the
 *  voiced fallback span (set only when the OCR path ran). On failure, the typed
 *  reason + a human detail. */
export type AttachmentOutcome =
  | {
      ok: true;
      ref: AttachmentRef;
      cls: AttachmentClass;
      text: string;
      method: AttachmentExtractionMethod;
      fallback: AttachmentFallbackSpan | null;
    }
  | {
      ok: false;
      ref: AttachmentRef;
      cls: AttachmentClass;
      reason: AttachmentFailureReason;
      detail: string;
    };

/** Why an attachment produced no text. `download_error` is the adapter-level
 *  failure; the rest are the seam's typed text-extraction failures. */
export type AttachmentFailureReason =
  | "download_error"
  | "pdf_no_text_layer"
  | "parse_error"
  | "ocr_unavailable"
  | "ocr_failed"
  | "no_quote";

/** The aggregate over a message's attachments — the per-attachment outcomes,
 *  the concatenated extracted text (success outcomes only, in order), and a
 *  rolled-up method/voiced-fallback summary the workflow surfaces. */
export interface PrepareAttachmentsResult {
  outcomes: AttachmentOutcome[];
  /** Concatenated text from every successful outcome, separated by blank lines. */
  text: string;
  /** True if ANY attachment yielded text. */
  anyText: boolean;
  /** True if ANY successful outcome came via OCR (so the workflow voices it and
   *  may stamp extraction_method='ocr'). */
  usedOcr: boolean;
  /** The voiced fallback spans (OCR) gathered across attachments. */
  fallbacks: AttachmentFallbackSpan[];
}

/** Options for {@link prepareAttachments} — inject the extractor seam in tests so
 *  the tree is exercised without the real pdfjs/Vision runtime. */
export interface PrepareAttachmentsOptions {
  /** Override the text extractor (defaults to the real seam). */
  extract?: (
    bytes: Uint8Array,
    mimeType: string,
    filename: string,
    opts?: ExtractOptions,
  ) => ReturnType<typeof extractAttachmentText>;
  /** Pass-through options forwarded to the extractor (pdf/ocr seams). */
  extractOptions?: ExtractOptions;
}

/**
 * Run the fallback tree over one message's attachments. For each ref:
 * download → extract → record a typed outcome. A download throw becomes a
 * `download_error` outcome (never propagates). The result aggregates the text
 * and the method/voiced-fallback summary.
 */
export async function prepareAttachments(
  messageId: string,
  attachments: readonly AttachmentRef[],
  adapter: GmailAdapter,
  opts: PrepareAttachmentsOptions = {},
): Promise<PrepareAttachmentsResult> {
  const extract = opts.extract ?? extractAttachmentText;
  const outcomes: AttachmentOutcome[] = [];

  for (const ref of attachments) {
    const cls = classifyAttachment(ref.mimeType);

    let data: AttachmentData;
    try {
      data = await adapter.downloadAttachment(messageId, ref);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      outcomes.push({ ok: false, ref, cls, reason: "download_error", detail });
      continue;
    }

    const result = await extract(data.bytes, data.mimeType, data.filename, opts.extractOptions);
    if (result.ok) {
      // The seam carries a fallback span only when the OCR path ran; that span
      // (or its absence) is how we distinguish a text-layer/utf-8 read from OCR.
      const method: AttachmentExtractionMethod = result.fallback === null ? "text" : "ocr";
      outcomes.push({
        ok: true,
        ref,
        cls: result.cls,
        text: result.text,
        method,
        fallback: result.fallback,
      });
    } else {
      outcomes.push({ ok: false, ref, cls: result.cls, reason: result.reason, detail: result.detail });
    }
  }

  const successes = outcomes.filter((o): o is Extract<AttachmentOutcome, { ok: true }> => o.ok);
  const text = successes.map((o) => o.text).join("\n\n");
  const fallbacks = successes
    .map((o) => o.fallback)
    .filter((s): s is AttachmentFallbackSpan => s !== null);

  return {
    outcomes,
    text,
    anyText: successes.length > 0,
    usedOcr: successes.some((o) => o.method === "ocr"),
    fallbacks,
  };
}
