/**
 * routes unit tests — the pure route helpers. The full route surface is pinned
 * by server.integration.test.ts; this file covers the extracted pure pieces
 * (currently the legacy-/stream screenshot filter).
 */

import { describe, expect, it } from "vitest";

import { stripScreenshotField } from "./routes.js";

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
