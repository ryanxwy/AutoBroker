/**
 * Unit tests — anti-bot block-signature classifier. Pure string/status checks;
 * pins the signature vocabulary, the http_<status> fallback for blocky HTTP
 * codes, and the 8 KB scan-window cutoff.
 */

import { describe, expect, it } from "vitest";
import { classifyBlockSignature } from "./blockSignature.js";

describe("classifyBlockSignature", () => {
  it('classifies a Cloudflare interstitial as "cloudflare"', () => {
    const body = "<title>Just a moment | Cloudflare</title>";
    expect(classifyBlockSignature(body, 200)).toBe("cloudflare");
  });

  it('classifies a CAPTCHA challenge as "captcha"', () => {
    const body = "<p>Please solve the CAPTCHA below to continue.</p>";
    expect(classifyBlockSignature(body, 200)).toBe("captcha");
  });

  it("returns null for a normal page", () => {
    const body = "<html><body><h1>New Inventory</h1><p>42 vehicles</p></body></html>";
    expect(classifyBlockSignature(body, 200)).toBeNull();
  });

  it('labels a 403 with an unrecognized body as "http_403"', () => {
    const body = "<html><body>Forbidden</body></html>";
    expect(classifyBlockSignature(body, 403)).toBe("http_403");
  });

  it('catches "Access Denied" inside the first 8 KB even on a 200', () => {
    const body = "x".repeat(4096) + "Access Denied" + "x".repeat(4096);
    expect(classifyBlockSignature(body, 200)).toBe("access denied");
  });

  it("ignores a signature that starts beyond the 8 KB scan window", () => {
    const body = "x".repeat(8192) + "cloudflare";
    expect(classifyBlockSignature(body, 200)).toBeNull();
  });
});
