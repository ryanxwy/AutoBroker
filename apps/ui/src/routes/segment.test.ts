/**
 * segment — the board's vehicle→segment heuristic. Freezes that different-brand
 * competitors collapse to one segment and an unknown vehicle falls to its own
 * "Other searches" bucket, plus the testid slug.
 */

import { describe, expect, it } from "vitest";

import { OTHER_SEGMENT, segmentOf, segmentSlug } from "./segment.js";

describe("segmentOf", () => {
  it("groups different-brand compact SUVs together", () => {
    expect(segmentOf("2026 Toyota RAV4 XLE")).toBe("Compact SUVs");
    expect(segmentOf("2026 Hyundai Tucson SEL")).toBe("Compact SUVs");
    expect(segmentOf("2026 Honda CR-V EX")).toBe("Compact SUVs");
  });

  it("groups midsize sedans together across brands", () => {
    expect(segmentOf("2026 Honda Accord LX")).toBe("Midsize sedans");
    expect(segmentOf("2026 Toyota Camry SE")).toBe("Midsize sedans");
  });

  it("is case-insensitive", () => {
    expect(segmentOf("2026 toyota camry se")).toBe("Midsize sedans");
  });

  it("falls back to Other for an unrecognized model", () => {
    expect(segmentOf("2026 Lucid Air Touring")).toBe(OTHER_SEGMENT);
  });
});

describe("segmentSlug", () => {
  it("makes a testid-safe slug", () => {
    expect(segmentSlug("Compact SUVs")).toBe("compact-suvs");
    expect(segmentSlug("Other searches")).toBe("other-searches");
  });
});
