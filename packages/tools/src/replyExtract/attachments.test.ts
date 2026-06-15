/**
 * L1 unit tests — the attachment fallback tree. Freezes (with an INJECTED
 * adapter + extractor, no real pdfjs/Vision/network):
 *   - a PDF text-layer success → text, method 'text', no fallback span;
 *   - a no-text-layer PDF → honest fail, NEVER OCR'd (the extractor is asserted
 *     to never receive an OCR-eligible call for a PDF);
 *   - an image OCR success via the injected runner → method 'ocr' + a voiced span;
 *   - an image OCR unavailable → typed fail (degrade, no throw);
 *   - a download throw → a per-attachment download_error outcome (never aborts);
 *   - the aggregate text/anyText/usedOcr/fallbacks roll-up.
 */

import { describe, expect, it } from "vitest";

import type {
  AttachmentData,
  AttachmentRef,
  GmailAdapter,
  Message,
  Thread,
  ThreadRef,
  HistoryPage,
  HealthResult,
} from "../gmail/types.js";
import type { AttachmentTextResult, ExtractOptions } from "../gmail/attachmentText.js";
import { prepareAttachments } from "./attachments.js";

const enc = new TextEncoder();

function ref(over: Partial<AttachmentRef> = {}): AttachmentRef {
  return { attachmentId: "a-1", filename: "quote.pdf", mimeType: "application/pdf", sizeBytes: 10, ...over };
}

/** An adapter that returns canned bytes per attachmentId, or throws for ids in
 *  `throwFor`. Only downloadAttachment is exercised here; the rest are stubs. */
function fakeAdapter(opts: {
  bytesById?: Record<string, AttachmentData>;
  throwFor?: Set<string>;
}): GmailAdapter {
  const notUsed = (m: string) => () => Promise.reject(new Error(`unexpected call: ${m}`));
  return {
    kind: "fake",
    search: notUsed("search") as unknown as (q: string, n?: number) => Promise<ThreadRef[]>,
    getThread: notUsed("getThread") as unknown as (id: string) => Promise<Thread>,
    getMessage: notUsed("getMessage") as unknown as (id: string) => Promise<Message>,
    downloadAttachment(_messageId: string, r: AttachmentRef): Promise<AttachmentData> {
      if (opts.throwFor?.has(r.attachmentId)) {
        return Promise.reject(new Error("download blew up"));
      }
      const data = opts.bytesById?.[r.attachmentId];
      if (data === undefined) return Promise.reject(new Error("no bytes for " + r.attachmentId));
      return Promise.resolve(data);
    },
    historyList: notUsed("historyList") as unknown as (h: string) => Promise<HistoryPage>,
    getCurrentHistoryId: notUsed("getCurrentHistoryId") as unknown as () => Promise<string>,
    send: notUsed("send") as unknown as (raw: string) => Promise<{ messageId: string }>,
    health: notUsed("health") as unknown as () => Promise<HealthResult>,
  };
}

function data(over: Partial<AttachmentData> = {}): AttachmentData {
  return { filename: "quote.pdf", mimeType: "application/pdf", bytes: enc.encode("x"), ...over };
}

describe("prepareAttachments", () => {
  it("PDF text-layer success → text, method 'text', no fallback span", async () => {
    const a = ref({ attachmentId: "pdf-1" });
    const adapter = fakeAdapter({ bytesById: { "pdf-1": data() } });
    const extract = (): Promise<AttachmentTextResult> =>
      Promise.resolve({ ok: true, text: "OTD $38,120", cls: "pdf", fallback: null });

    const res = await prepareAttachments("msg-1", [a], adapter, { extract });
    expect(res.anyText).toBe(true);
    expect(res.usedOcr).toBe(false);
    expect(res.text).toBe("OTD $38,120");
    expect(res.outcomes[0]).toMatchObject({ ok: true, method: "text", cls: "pdf" });
  });

  it("no-text-layer PDF → honest fail, NEVER OCR'd", async () => {
    const a = ref({ attachmentId: "pdf-blank" });
    const adapter = fakeAdapter({ bytesById: { "pdf-blank": data() } });
    let sawOcrOption = false;
    const extract = (
      _b: Uint8Array,
      _m: string,
      _f: string,
      o?: ExtractOptions,
    ): Promise<AttachmentTextResult> => {
      // The seam owns the "never OCR a PDF" rule; assert we never hand a PDF an
      // OCR runner that would route it there.
      if (o?.ocrRunner !== undefined) sawOcrOption = true;
      return Promise.resolve({
        ok: false,
        reason: "pdf_no_text_layer",
        cls: "pdf",
        detail: "scanned PDF",
      });
    };

    const res = await prepareAttachments("msg-1", [a], adapter, { extract });
    expect(res.anyText).toBe(false);
    expect(res.outcomes[0]).toMatchObject({ ok: false, reason: "pdf_no_text_layer", cls: "pdf" });
    expect(sawOcrOption).toBe(false);
  });

  it("image OCR success via injected runner → method 'ocr' + a voiced span", async () => {
    const a = ref({ attachmentId: "img-1", filename: "q.png", mimeType: "image/png" });
    const adapter = fakeAdapter({
      bytesById: { "img-1": data({ filename: "q.png", mimeType: "image/png" }) },
    });
    const extract = (): Promise<AttachmentTextResult> =>
      Promise.resolve({
        ok: true,
        text: "Lease $399/mo",
        cls: "image",
        fallback: { kind: "image_ocr_vision", detail: "read via on-device OCR" },
      });

    const res = await prepareAttachments("msg-1", [a], adapter, { extract });
    expect(res.usedOcr).toBe(true);
    expect(res.text).toBe("Lease $399/mo");
    expect(res.fallbacks).toHaveLength(1);
    expect(res.outcomes[0]).toMatchObject({ ok: true, method: "ocr", cls: "image" });
  });

  it("image OCR unavailable → typed fail (degrade, no throw)", async () => {
    const a = ref({ attachmentId: "img-2", filename: "q.png", mimeType: "image/png" });
    const adapter = fakeAdapter({
      bytesById: { "img-2": data({ filename: "q.png", mimeType: "image/png" }) },
    });
    const extract = (): Promise<AttachmentTextResult> =>
      Promise.resolve({ ok: false, reason: "ocr_unavailable", cls: "image", detail: "off mac" });

    const res = await prepareAttachments("msg-1", [a], adapter, { extract });
    expect(res.anyText).toBe(false);
    expect(res.outcomes[0]).toMatchObject({ ok: false, reason: "ocr_unavailable", cls: "image" });
  });

  it("a download throw → a download_error outcome (never aborts the message)", async () => {
    const good = ref({ attachmentId: "pdf-ok" });
    const bad = ref({ attachmentId: "pdf-bad" });
    const adapter = fakeAdapter({
      bytesById: { "pdf-ok": data() },
      throwFor: new Set(["pdf-bad"]),
    });
    const extract = (): Promise<AttachmentTextResult> =>
      Promise.resolve({ ok: true, text: "OTD $1", cls: "pdf", fallback: null });

    const res = await prepareAttachments("msg-1", [bad, good], adapter, { extract });
    expect(res.outcomes).toHaveLength(2);
    expect(res.outcomes[0]).toMatchObject({ ok: false, reason: "download_error" });
    expect(res.outcomes[1]).toMatchObject({ ok: true });
    expect(res.anyText).toBe(true); // the good one still produced text
  });

  it("aggregates text across multiple successful attachments", async () => {
    const a1 = ref({ attachmentId: "p1" });
    const a2 = ref({ attachmentId: "p2" });
    const adapter = fakeAdapter({ bytesById: { p1: data(), p2: data() } });
    let n = 0;
    const extract = (): Promise<AttachmentTextResult> => {
      n += 1;
      return Promise.resolve({ ok: true, text: `page ${n}`, cls: "pdf", fallback: null });
    };
    const res = await prepareAttachments("msg-1", [a1, a2], adapter, { extract });
    expect(res.text).toBe("page 1\n\npage 2");
  });

  it("no attachments → empty aggregate", async () => {
    const res = await prepareAttachments("msg-1", [], fakeAdapter({}));
    expect(res.outcomes).toHaveLength(0);
    expect(res.anyText).toBe(false);
    expect(res.text).toBe("");
  });
});
