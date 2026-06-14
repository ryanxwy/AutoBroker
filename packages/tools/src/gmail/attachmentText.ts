/**
 * Attachment text extraction — turn a downloaded attachment (bytes + mimeType +
 * filename) into plain text so the downstream per-message LLM extractor can read
 * a PDF/image quote without seeing raw bytes.
 *
 * FIRST-MATCH-WINS chain, keyed off a PURE classifier:
 *   - pdf   → pdfjs-dist text-LAYER extraction (NEVER OCR — see below);
 *   - image → on-device macOS Vision OCR (delegated to ./ocr.js);
 *   - text  → utf-8 decode of the bytes;
 *   - other → no_quote (nothing to read).
 *
 * PDF IS NEVER OCR'd. pdfjs reads the embedded text layer only. A scanned /
 * image-only PDF has no text layer, so it yields empty text — and that is an
 * HONEST FAILURE, never a silent empty success and never an OCR attempt. Rasterizing
 * a PDF to feed OCR is explicitly out of scope: a text-less PDF is reported failed.
 *
 * RETRY POLICY: image decode is retried at most ONCE (no backoff) — a transient
 * decode hiccup gets a second shot, nothing more. PDF parse, rate/auth/network
 * errors → failed with NO retry.
 *
 * TYPED RESULT: the outcome distinguishes extracted-text from an honest failure,
 * and carries the voiced fallback span when the OCR path was taken (the
 * transient/equivalent fallback must be voiced; this pure tools-layer function
 * has no emitter, so it RETURNS the span for the caller to render).
 *
 * NO NETWORK / NO LLM / NO KEY: the only external touch is the local on-device
 * OCR subprocess (./ocr.js), and only for images. PDFs and text are pure in-process.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { runImageOcr, type OcrFallbackSpan } from "./ocr.js";

/** The attachment classes the extractor knows how to handle. `no_quote` is the
 *  catch-all for parts there is nothing to read text out of. */
export type AttachmentClass = "pdf" | "image" | "text" | "no_quote";

/**
 * Pure classifier — map a declared MIME type to its extraction class. No I/O, so
 * it is independently unit-testable. Matching is case-insensitive and tolerant of
 * a charset suffix (e.g. "text/plain; charset=utf-8").
 */
export function classifyAttachment(mimeType: string): AttachmentClass {
  const mime = (mimeType.toLowerCase().split(";")[0] ?? "").trim();
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/plain") return "text";
  return "no_quote";
}

/** The voiced fallback span an extraction may carry. Today only the image→OCR
 *  path produces one (re-exported from the OCR runner). */
export type AttachmentFallbackSpan = OcrFallbackSpan;

/**
 * The typed extraction outcome:
 *   - `ok:true`  → `text` (the extracted body) + `cls` (which path ran) + the
 *     voiced `fallback` span when one was taken (null otherwise);
 *   - `ok:false` → `reason` distinguishing the honest-failure modes, + a human
 *     `detail`. NEVER thrown — the caller branches on the flag.
 *
 * Failure reasons:
 *   - `pdf_no_text_layer` — a valid PDF with no embedded text (scanned/image-only);
 *     this is the explicit "do not OCR a PDF" honest failure.
 *   - `parse_error`       — the bytes could not be parsed (corrupt/empty/not the
 *     declared type).
 *   - `ocr_unavailable`   — image path, but OCR is not available (off macOS).
 *   - `ocr_failed`        — image path, OCR ran but could not read text.
 *   - `no_quote`          — the part is not a class we extract text from.
 */
export type AttachmentTextResult =
  | { ok: true; text: string; cls: AttachmentClass; fallback: AttachmentFallbackSpan | null }
  | {
      ok: false;
      reason: "pdf_no_text_layer" | "parse_error" | "ocr_unavailable" | "ocr_failed" | "no_quote";
      cls: AttachmentClass;
      detail: string;
    };

/** Seam for the PDF text-layer extractor (injected in tests so the chain can be
 *  exercised without the pdfjs runtime). Returns the concatenated text-layer
 *  content; throws on a corrupt/unparseable PDF. */
export type PdfTextExtractor = (bytes: Uint8Array) => Promise<string>;

/** Seam for the image OCR runner (injected in tests to avoid a real Vision
 *  call). Mirrors {@link runImageOcr}'s contract. */
export type ImageOcrRunner = typeof runImageOcr;

/** Options for {@link extractAttachmentText} — all overridable for tests. */
export interface ExtractOptions {
  pdfExtractor?: PdfTextExtractor;
  ocrRunner?: ImageOcrRunner;
}

/**
 * Extract text from one downloaded attachment. Dispatches on the pure classifier:
 *
 *   - pdf   → text-LAYER extraction; empty text → `pdf_no_text_layer` (honest
 *     failure, NEVER OCR'd); parse throw → `parse_error`;
 *   - image → on-device OCR (one decode retry, no backoff); unavailable →
 *     `ocr_unavailable`, failed → `ocr_failed`; success carries the voiced span;
 *   - text  → utf-8 decode;
 *   - other → `no_quote`.
 *
 * NEVER throws — every failure mode is a typed `ok:false` result.
 */
export async function extractAttachmentText(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
  opts: ExtractOptions = {},
): Promise<AttachmentTextResult> {
  const cls = classifyAttachment(mimeType);

  switch (cls) {
    case "pdf":
      return extractPdf(bytes, opts.pdfExtractor ?? extractPdfTextLayer);
    case "image":
      return extractImage(bytes, filename, opts.ocrRunner ?? runImageOcr);
    case "text":
      return { ok: true, text: decodeUtf8(bytes), cls, fallback: null };
    case "no_quote":
      return {
        ok: false,
        reason: "no_quote",
        cls,
        detail: `nothing to extract from ${mimeType || "(no mime type)"}`,
      };
  }
}

/** PDF path: text-layer only. Empty result → honest `pdf_no_text_layer` (the
 *  "never OCR a PDF" rule); a parse throw → `parse_error`. */
async function extractPdf(
  bytes: Uint8Array,
  extractor: PdfTextExtractor,
): Promise<AttachmentTextResult> {
  let text: string;
  try {
    text = await extractor(bytes);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "parse_error", cls: "pdf", detail: `could not parse PDF: ${detail}` };
  }
  if (text.trim() === "") {
    // A valid PDF with no embedded text layer (scanned / image-only). We do NOT
    // rasterize-and-OCR a PDF — this is an honest failure the caller records.
    return {
      ok: false,
      reason: "pdf_no_text_layer",
      cls: "pdf",
      detail: "PDF has no embedded text layer (scanned/image-only); not OCR'd",
    };
  }
  return { ok: true, text, cls: "pdf", fallback: null };
}

/** Image path: on-device OCR with a single decode retry (no backoff). Maps the
 *  OCR runner's typed outcome onto the attachment result. */
async function extractImage(
  bytes: Uint8Array,
  filename: string,
  ocr: ImageOcrRunner,
): Promise<AttachmentTextResult> {
  let result = await ocr(bytes, filename);

  // Retry ONCE on a transient OCR failure (decode hiccup) — no backoff. An
  // `unavailable` result (wrong platform) is NOT retried: it will never change.
  if (!result.ok && result.reason === "failed") {
    result = await ocr(bytes, filename);
  }

  if (result.ok) {
    return { ok: true, text: result.text, cls: "image", fallback: result.fallback };
  }
  if (result.reason === "unavailable") {
    return { ok: false, reason: "ocr_unavailable", cls: "image", detail: result.detail };
  }
  return { ok: false, reason: "ocr_failed", cls: "image", detail: result.detail };
}

/** Decode bytes as utf-8 (lenient — invalid sequences become U+FFFD, never throw). */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------------
// pdfjs-dist text-layer extractor (the production PDF path)
// ---------------------------------------------------------------------------

/** Resolve pdfjs's bundled standard-fonts dir at runtime (no hardcoded path), so
 *  the text layer renders without the "standardFontDataUrl missing" warning. */
function standardFontDataUrl(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  return join(dirname(entry), "..", "..", "standard_fonts") + "/";
}

/**
 * Production PDF text-LAYER extractor via pdfjs-dist (legacy build — the Node
 * target, no DOM). Concatenates every page's text-content items. This reads the
 * EMBEDDED text only; it does not and must not rasterize/OCR. A scanned PDF
 * returns "" here, which the caller turns into the honest `pdf_no_text_layer`.
 *
 * Throws on a corrupt/unparseable PDF (the caller maps that to `parse_error`).
 */
async function extractPdfTextLayer(bytes: Uint8Array): Promise<string> {
  // Lazy import: keep module load cheap and avoid pulling the pdfjs runtime into
  // consumers that only need the pure classifier.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes,
    // Node target: fonts from the bundled data dir. Text-only extraction never
    // invokes font rendering, so the eval path is never reached.
    standardFontDataUrl: standardFontDataUrl(),
  });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join("");
      pages.push(pageText);
    }
    return pages.join("\n").trim();
  } finally {
    await task.destroy();
  }
}
