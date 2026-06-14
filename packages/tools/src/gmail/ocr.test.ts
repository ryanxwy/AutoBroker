/**
 * Unit tests — the macOS Vision OCR runner. No live Vision call: the platform
 * check and the subprocess invocation are both injectable, so the typed outcomes
 * are proven deterministically on any host.
 *
 * Covers:
 *   - off-darwin → typed `unavailable`, never throws, never runs the helper;
 *   - darwin + a stub helper → image bytes map to the helper stdout (trimmed)
 *     and the success carries the voiced OCR fallback span;
 *   - darwin + a failing helper → typed `failed`, never throws.
 *
 * No test invokes the real on-device Vision helper — every outcome is proven with
 * an injected runner so the suite is host-independent.
 */

import { describe, expect, it } from "vitest";

import { runImageOcr } from "./ocr.js";

const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // a few PNG-magic bytes — content is irrelevant to the stub

describe("runImageOcr", () => {
  it("returns a typed `unavailable` off macOS and never invokes the helper", async () => {
    let ran = false;
    const result = await runImageOcr(IMG, "quote.png", {
      platformName: "linux",
      runner: async () => {
        ran = true;
        return "should never run";
      },
    });
    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unavailable");
      expect(result.detail).toContain("linux");
    }
  });

  it("maps the helper stdout to recognized text and voices the OCR span (darwin)", async () => {
    const result = await runImageOcr(IMG, "quote.png", {
      platformName: "darwin",
      runner: async (path) => {
        expect(path).toContain("quote.png"); // staged temp file carries the basename
        return "  Hyundai Tucson SEL  $28,450  \n";
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("Hyundai Tucson SEL  $28,450"); // trimmed
      expect(result.fallback).toEqual({
        kind: "image_ocr_vision",
        detail: expect.stringContaining("quote.png"),
      });
    }
  });

  it("returns a typed `failed` (no throw) when the helper errors", async () => {
    const result = await runImageOcr(IMG, "photo.jpg", {
      platformName: "darwin",
      runner: async () => {
        throw new Error("spawn autobroker ENOENT");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("failed");
      expect(result.detail).toContain("ENOENT");
    }
  });

  it("falls back to a safe temp name when the filename is empty", async () => {
    const result = await runImageOcr(IMG, "", {
      platformName: "darwin",
      runner: async (path) => {
        expect(path).toContain("image.bin");
        return "x";
      },
    });
    expect(result.ok).toBe(true);
  });

  // NOTE: no test invokes the real on-device Vision helper. The typed,
  // non-throwing contract is fully proven above with an injected runner; a live
  // helper call would be host-dependent (helper may be absent or block), which
  // the suite must never depend on.
});
