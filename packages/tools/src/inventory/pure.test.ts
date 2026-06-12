/**
 * L1 unit tests — inventory_site_scan deterministic core.
 *
 * The id/normalizer expectations below are FROZEN parity vectors: these exact
 * strings are the idempotency keys of dealer_inventory_sources and
 * inventory_listings, generated from the reference implementation this port
 * must stay byte-identical with. If one of these goes red, the code drifted —
 * fix the code, never the vector.
 */

import { describe, expect, it } from "vitest";
import {
  classifyMatchStatus,
  computeListingId,
  computeSourceId,
  isUsDealerBatch,
  normalizeListingUrl,
  RAW_LISTING_JSON_CAP_BYTES,
  truncateRawJson,
  urlNormalize,
  validateVinProvenance,
} from "./pure.js";

describe("urlNormalize — the lossless write-side key", () => {
  it.each([
    // [input, expected]
    [
      "https://Www.TustinHyundai.com/new-inventory/index.htm?model=Tucson&make=Hyundai",
      "https://www.tustinhyundai.com/new-inventory/index.htm?make=Hyundai&model=Tucson",
    ],
    ["https://dealer.example.com/new-vehicles//", "https://dealer.example.com/new-vehicles"],
    ["https://dealer.example.com", "https://dealer.example.com/"],
    ["https://dealer.example.com/path?b=2&a=1&", "https://dealer.example.com/path?a=1&b=2"],
    ["https://dealer.example.com/path#frag", "https://dealer.example.com/path"],
    // Scheme/host lowercase; PATH case is preserved.
    ["HTTPS://DEALER.example.COM/Path/", "https://dealer.example.com/Path"],
    // ";params" on the last path segment is dropped (jsessionid-style).
    [
      "https://dealer.example.com/inventory;jsessionid=abc?x=1",
      "https://dealer.example.com/inventory?x=1",
    ],
    ["", ""],
  ])("%s -> %s", (input, expected) => {
    expect(urlNormalize(input)).toBe(expected);
  });

  it("is LOSSLESS on query params — tracking junk survives here", () => {
    expect(urlNormalize("https://d.example/srp?utm_source=fb&make=Hyundai")).toBe(
      "https://d.example/srp?make=Hyundai&utm_source=fb",
    );
  });
});

describe("normalizeListingUrl — the VIN-absent dedup key (tracking stripped)", () => {
  it.each([
    [
      "https://dealer.example.com/vdp/2026-tucson?utm_source=fb&stock=H123&fbclid=zz",
      "https://dealer.example.com/vdp/2026-tucson?stock=H123",
    ],
    // Scheme-less input upgraded to https.
    [
      "dealer.example.com/vdp?gclid=1&vin=KM8J33A2XPU100001",
      "https://dealer.example.com/vdp?vin=KM8J33A2XPU100001",
    ],
    // Tracking keys match case-insensitively.
    ["https://dealer.example.com/vdp?REF=home&color=blue", "https://dealer.example.com/vdp?color=blue"],
    // "ref" is a PREFIX rule — refresh-style keys are stripped too (by design).
    ["https://dealer.example.com/vdp?refresh=1", "https://dealer.example.com/vdp"],
    // campaign* stripped; survivors sorted; fragment + trailing slash dropped.
    ["https://dealer.example.com/a/?campaign_id=9&z=1&a=2#x", "https://dealer.example.com/a?a=2&z=1"],
    ["", ""],
    ["   ", ""],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeListingUrl(input)).toBe(expected);
  });
});

describe("computeSourceId / computeListingId — frozen id vectors", () => {
  it("computeSourceId mints src_<sha256[:16]>", () => {
    expect(
      computeSourceId(
        "prof-1",
        "ab12cd34ef56ab78",
        "https://dealer.example.com/new-inventory?a=1&b=2",
      ),
    ).toBe("src_b450b93356a9ce1c");
  });

  it("computeListingId: VIN wins over the fallback URL", () => {
    expect(
      computeListingId(
        "prof-1",
        "ab12cd34ef56ab78",
        "KM8J33A2XPU100001",
        "https://dealer.example.com/vdp?a=1",
      ),
    ).toBe("lst_2e5a95076d988877");
  });

  it("computeListingId: null VIN keys on the URL", () => {
    expect(
      computeListingId("prof-1", "ab12cd34ef56ab78", null, "https://dealer.example.com/vdp?a=1"),
    ).toBe("lst_2551cadbf7e25867");
  });

  it("empty-string VIN counts as absent (falls through to the URL)", () => {
    expect(computeListingId("prof-1", "ab12cd34ef56ab78", "", "https://dealer.example.com/vdp?a=1")).toBe(
      "lst_2551cadbf7e25867",
    );
  });

  it("throws when both identity anchors are missing", () => {
    expect(() => computeListingId("p", "d", null, null)).toThrow(
      "listing requires VIN or fallback_url",
    );
    expect(() => computeListingId("p", "d", "", null)).toThrow(
      "listing requires VIN or fallback_url",
    );
  });
});

describe("classifyMatchStatus", () => {
  const P = [2026, "Hyundai", "Tucson"] as const;

  it("exact: profile-trim match, and acceptable-trims match (case-insensitive)", () => {
    expect(classifyMatchStatus(...P, "SEL", ["XRT", "Limited"], 2026, "Hyundai", "Tucson", "SEL")).toBe("exact");
    expect(classifyMatchStatus(...P, "SEL", ["XRT", "Limited"], 2026, "hyundai", "tucson", "xrt")).toBe("exact");
  });

  it("near: identity matches but trim missing or off-list", () => {
    expect(classifyMatchStatus(...P, "SEL", null, 2026, "Hyundai", "Tucson", null)).toBe("near");
    expect(classifyMatchStatus(...P, "SEL", null, 2026, "Hyundai", "Tucson", "Blueprint")).toBe("near");
    expect(classifyMatchStatus(...P, "SEL", [], 2026, "Hyundai", "Tucson", "")).toBe("near");
    // No profile trim at all: identity match alone is near, never exact.
    expect(classifyMatchStatus("2026", "Hyundai", "Tucson", null, null, 2026, "Hyundai", "Tucson", null)).toBe("near");
  });

  it("mismatch: year off (model match), wrong make/model, or profile identity missing", () => {
    expect(classifyMatchStatus(...P, null, null, 2025, "Hyundai", "Tucson", "SEL")).toBe("mismatch");
    expect(classifyMatchStatus(...P, null, null, 2026, "Kia", "Sportage", "LX")).toBe("mismatch");
    expect(classifyMatchStatus(null, "Hyundai", "Tucson", null, null, 2026, "Hyundai", "Tucson", null)).toBe("mismatch");
    expect(classifyMatchStatus(2026, null, null, null, null, 2026, "Hyundai", "Tucson", null)).toBe("mismatch");
  });

  it("unknown: any LISTING identity field missing", () => {
    expect(classifyMatchStatus(...P, null, null, null, "Hyundai", "Tucson", "SEL")).toBe("unknown");
    expect(classifyMatchStatus(...P, null, null, 2026, "Hyundai", null, "SEL")).toBe("unknown");
  });

  it("year compares as strings: int profile vs string listing agree", () => {
    expect(classifyMatchStatus("2026", "Hyundai", "Tucson", null, null, 2026, "Hyundai", "Tucson", null)).toBe("near");
  });
});

describe("validateVinProvenance", () => {
  const VIN = "KM8J33A2XPU100001";

  it("passes a well-formed VIN that appears verbatim (case-insensitive)", () => {
    expect(validateVinProvenance(VIN, `blah blah ${VIN.toLowerCase()} appears here`)).toBe(true);
  });

  it("rejects wrong length, forbidden I/O/Q chars, and absence from the snapshot", () => {
    expect(validateVinProvenance("KM8J33A2XPU10001", "km8j33a2xpu10001")).toBe(false); // 16 chars
    expect(validateVinProvenance("KM8I33A2XPU100001", "km8i33a2xpu100001")).toBe(false); // 'I'
    expect(validateVinProvenance(VIN, "different page text")).toBe(false);
  });

  it("rejects empty vin or empty snapshot", () => {
    expect(validateVinProvenance("", "x")).toBe(false);
    expect(validateVinProvenance(VIN, "")).toBe(false);
  });
});

describe("isUsDealerBatch", () => {
  it("classifies the whole batch in one call, index-aligned", () => {
    expect(
      isUsDealerBatch([
        { website: "https://tustinhyundai.com", name: "Tustin Hyundai" },
        { website: "https://dealer.ca", name: "Toronto Hyundai" },
        {},
      ]),
    ).toEqual([true, false, true]);
  });
});

describe("truncateRawJson — the 32KB write cap", () => {
  it("null → 'null'; strings pass through; objects serialize with sorted keys", () => {
    expect(truncateRawJson(null)).toBe("null");
    expect(truncateRawJson('{"a":1}')).toBe('{"a":1}');
    expect(truncateRawJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it("over-cap input wraps a truncated excerpt under the cap", () => {
    const big = "x".repeat(RAW_LISTING_JSON_CAP_BYTES + 100);
    const out = truncateRawJson(big);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(RAW_LISTING_JSON_CAP_BYTES);
    const parsed = JSON.parse(out) as { _truncated: boolean; _original_bytes: number; _excerpt: string };
    expect(parsed._truncated).toBe(true);
    expect(parsed._original_bytes).toBe(RAW_LISTING_JSON_CAP_BYTES + 100);
    expect(big.startsWith(parsed._excerpt)).toBe(true);
  });

  it("never cuts inside a multi-byte UTF-8 sequence", () => {
    // 3-byte chars positioned so the budget lands mid-sequence.
    const big = "€".repeat(20_000); // 60,000 bytes > cap
    const out = truncateRawJson(big);
    const parsed = JSON.parse(out) as { _excerpt: string };
    // Every char in the excerpt is intact (no U+FFFD replacement).
    expect(parsed._excerpt.includes("�")).toBe(false);
    expect(big.startsWith(parsed._excerpt)).toBe(true);
  });
});
