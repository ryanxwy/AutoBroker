/**
 * routes unit tests — the pure route helpers. The full route surface is pinned
 * by server.integration.test.ts; this file covers the extracted pure pieces
 * (currently the legacy-/stream screenshot filter).
 */

import { describe, expect, it } from "vitest";

import { sanitizeFilename, stripScreenshotField } from "./routes.js";

describe("stripScreenshotField — the legacy /stream never carries base64", () => {
  it("removes screenshot_b64 and keeps the rest of the payload", () => {
    const ev = {
      ts: "2026-06-12T00:00:00.000Z",
      kind: "browser.action",
      payload: { type: "navigate", target: "https://x.example/", screenshot_b64: "QUJD" },
    };
    const out = stripScreenshotField(ev);
    expect(out.payload).toEqual({ type: "navigate", target: "https://x.example/" });
    expect(JSON.stringify(out)).not.toContain("screenshot_b64");
    // The input frame is not mutated (the same frame object feeds other readers).
    expect((ev.payload as Record<string, unknown>)["screenshot_b64"]).toBe("QUJD");
  });

  it("passes screenshotless frames through untouched (same reference)", () => {
    const ev = {
      ts: "2026-06-12T00:00:00.000Z",
      kind: "browser.action",
      payload: { type: "navigate", target: "https://x.example/" },
    };
    expect(stripScreenshotField(ev)).toBe(ev);
  });

  it("tolerates non-object payloads", () => {
    const ev = { ts: "t", kind: "text", payload: null };
    expect(stripScreenshotField(ev)).toBe(ev);
  });
});

describe("sanitizeFilename — Content-Disposition value guard", () => {
  it("passes a plain filename through untouched", () => {
    expect(sanitizeFilename("quote.png")).toBe("quote.png");
  });

  it("strips the value-delimiting quote and CR/LF (header-injection guard)", () => {
    expect(sanitizeFilename('q"\r\nuote.png')).toBe("quote.png");
  });

  it("neutralizes the `;`/`=` parameter delimiters so no bogus disposition param rides along", () => {
    // Without the strip, this would smuggle a `filename*=` param out of the quoted value.
    expect(sanitizeFilename('q.png"; filename*=UTF-8\'\'evil.exe')).toBe(
      "q.png_ filename*_UTF-8''evil.exe",
    );
    expect(sanitizeFilename("a;b=c.pdf")).toBe("a_b_c.pdf");
  });

  it("collapses non-ASCII to underscores and falls back to a generic name when empty", () => {
    expect(sanitizeFilename("résumé.pdf")).toBe("r_sum_.pdf");
    expect(sanitizeFilename("")).toBe("source");
  });
});
