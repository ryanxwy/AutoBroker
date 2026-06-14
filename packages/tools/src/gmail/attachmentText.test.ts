/**
 * Unit tests — attachment text extraction. Deterministic: the OCR call is stubbed
 * so no test reaches macOS Vision, and the PDF path runs the REAL pdfjs-dist
 * text-layer extractor over two committed base64 PDF fixtures (one with a text
 * layer, one without).
 *
 * Covers:
 *   - the PURE classifier over all four classes (pdf / image / text / no_quote),
 *     case- and charset-tolerant;
 *   - a text-PDF → extracted text via the real pdfjs text layer;
 *   - a scanned/text-less PDF → honest `pdf_no_text_layer` (NOT OCR'd);
 *   - a corrupt/empty buffer → `parse_error` (no crash);
 *   - text/plain → utf-8 decode;
 *   - image → OCR (stubbed): success carries the voiced span; unavailable and
 *     failed map to the typed image failures; a transient OCR `failed` is retried
 *     exactly once.
 *
 * The two PDF fixtures are minimal hand-built PDFs (single page); the text one
 * carries "Hello AutoBroker quote 12345" in its content stream, the blank one
 * carries an empty content stream (stands in for a scanned, text-less PDF).
 */

import { describe, expect, it, vi } from "vitest";

import { classifyAttachment, extractAttachmentText } from "./attachmentText.js";
import type { OcrResult } from "./ocr.js";

// A minimal 1-page PDF whose content stream shows "Hello AutoBroker quote 12345".
const TEXT_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTkgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiA3MiA3MDAgVGQgKEhlbGxvIEF1dG9Ccm9rZXIgcXVvdGUgMTIzNDUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjAKJSVFT0Y=";

// A minimal 1-page PDF with an EMPTY content stream (no text layer) — the
// scanned / image-only stand-in.
const BLANK_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxID4+CnN0cmVhbQogCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjAyIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNSAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMjUyCiUlRU9G";

function bytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Build a stub OCR runner with a canned typed result, counting invocations. */
function stubOcr(result: OcrResult): {
  runner: (b: Uint8Array, f: string) => Promise<OcrResult>;
  calls: () => number;
} {
  let n = 0;
  return {
    runner: async () => {
      n += 1;
      return result;
    },
    calls: () => n,
  };
}

describe("classifyAttachment (pure)", () => {
  it("maps each class, case- and charset-insensitively", () => {
    expect(classifyAttachment("application/pdf")).toBe("pdf");
    expect(classifyAttachment("APPLICATION/PDF")).toBe("pdf");
    expect(classifyAttachment("image/png")).toBe("image");
    expect(classifyAttachment("image/jpeg")).toBe("image");
    expect(classifyAttachment("Image/HEIC")).toBe("image");
    expect(classifyAttachment("text/plain")).toBe("text");
    expect(classifyAttachment("text/plain; charset=utf-8")).toBe("text");
    expect(classifyAttachment("application/octet-stream")).toBe("no_quote");
    expect(classifyAttachment("application/zip")).toBe("no_quote");
    expect(classifyAttachment("")).toBe("no_quote");
  });
});

describe("extractAttachmentText — PDF (real pdfjs text layer)", () => {
  it("extracts the embedded text layer from a text PDF", async () => {
    const res = await extractAttachmentText(bytes(TEXT_PDF_B64), "application/pdf", "quote.pdf");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.cls).toBe("pdf");
      expect(res.text).toContain("Hello AutoBroker quote 12345");
      expect(res.fallback).toBeNull(); // PDF path never OCRs → no fallback span
    }
  });

  it("reports an honest `pdf_no_text_layer` for a scanned/text-less PDF (never OCR'd)", async () => {
    // An OCR runner that would THROW if the PDF path ever tried to OCR — proving
    // a text-less PDF is an honest failure, not a silent OCR fallback.
    const guard = vi.fn(async (): Promise<OcrResult> => {
      throw new Error("PDF must never be routed to OCR");
    });
    const res = await extractAttachmentText(bytes(BLANK_PDF_B64), "application/pdf", "scan.pdf", {
      ocrRunner: guard,
    });
    expect(guard).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("pdf_no_text_layer");
      expect(res.cls).toBe("pdf");
    }
  });

  it("reports `parse_error` (no crash) on a corrupt buffer", async () => {
    const corrupt = new Uint8Array(Buffer.from("this is definitely not a pdf", "utf8"));
    const res = await extractAttachmentText(corrupt, "application/pdf", "broken.pdf");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("parse_error");
      expect(res.cls).toBe("pdf");
    }
  });

  it("reports `parse_error` (no crash) on an empty buffer", async () => {
    const res = await extractAttachmentText(new Uint8Array(0), "application/pdf", "empty.pdf");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("parse_error");
  });
});

describe("extractAttachmentText — text/plain", () => {
  it("utf-8 decodes a text part", async () => {
    const body = "Out-the-door price: $31,200 — includes destination.";
    const res = await extractAttachmentText(
      new Uint8Array(Buffer.from(body, "utf8")),
      "text/plain; charset=utf-8",
      "quote.txt",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.cls).toBe("text");
      expect(res.text).toBe(body);
      expect(res.fallback).toBeNull();
    }
  });
});

describe("extractAttachmentText — image (OCR stubbed)", () => {
  const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it("returns OCR text and the voiced fallback span on success", async () => {
    const ocr = stubOcr({
      ok: true,
      text: "Tucson Limited $33,990",
      fallback: { kind: "image_ocr_vision", detail: "quote.png read via on-device macOS Vision OCR" },
    });
    const res = await extractAttachmentText(img, "image/png", "quote.png", { ocrRunner: ocr.runner });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.cls).toBe("image");
      expect(res.text).toBe("Tucson Limited $33,990");
      expect(res.fallback).toEqual({ kind: "image_ocr_vision", detail: expect.any(String) });
    }
    expect(ocr.calls()).toBe(1); // success → no retry
  });

  it("maps OCR `unavailable` to `ocr_unavailable` (and does NOT retry)", async () => {
    const ocr = stubOcr({ ok: false, reason: "unavailable", detail: "not darwin" });
    const res = await extractAttachmentText(img, "image/png", "quote.png", { ocrRunner: ocr.runner });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ocr_unavailable");
      expect(res.cls).toBe("image");
    }
    expect(ocr.calls()).toBe(1); // unavailable never changes → no retry
  });

  it("retries a transient OCR `failed` exactly once, then maps to `ocr_failed`", async () => {
    const ocr = stubOcr({ ok: false, reason: "failed", detail: "vision timeout" });
    const res = await extractAttachmentText(img, "image/jpeg", "photo.jpg", { ocrRunner: ocr.runner });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("ocr_failed");
    expect(ocr.calls()).toBe(2); // one retry, no backoff
  });

  it("a retry that succeeds yields the OCR text", async () => {
    let n = 0;
    const runner = async (): Promise<OcrResult> => {
      n += 1;
      if (n === 1) return { ok: false, reason: "failed", detail: "transient" };
      return {
        ok: true,
        text: "second-try text",
        fallback: { kind: "image_ocr_vision", detail: "d" },
      };
    };
    const res = await extractAttachmentText(img, "image/png", "q.png", { ocrRunner: runner });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe("second-try text");
    expect(n).toBe(2);
  });
});

describe("extractAttachmentText — no_quote", () => {
  it("reports `no_quote` for an unhandled mime type", async () => {
    const res = await extractAttachmentText(
      new Uint8Array([1, 2, 3]),
      "application/octet-stream",
      "blob.bin",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("no_quote");
      expect(res.cls).toBe("no_quote");
    }
  });
});
