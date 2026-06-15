import { describe, expect, it } from "vitest";

import { AuditFindingSchema } from "./auditFlag.js";

describe("AuditFindingSchema", () => {
  it("accepts a complete finding", () => {
    const finding = {
      code: "MATH_SANITY",
      severity: "warn" as const,
      text: "Quote arithmetic doesn't reconcile",
      suggestion: "Ask dealer for an itemized breakdown.",
    };
    expect(AuditFindingSchema.parse(finding)).toEqual(finding);
  });

  it("accepts a dynamic ADD_ON_<NAME> code (code is an open string)", () => {
    const finding = {
      code: "ADD_ON_PROPACK",
      severity: "warn" as const,
      text: 'Quote includes likely dealer add-on "Pro Pack"',
      suggestion: "Ask dealer to remove Pro Pack.",
    };
    expect(AuditFindingSchema.parse(finding).code).toBe("ADD_ON_PROPACK");
  });

  it("accepts all three severity buckets", () => {
    for (const severity of ["info", "warn", "block"] as const) {
      expect(
        AuditFindingSchema.parse({ code: "X", severity, text: "t", suggestion: "s" }).severity,
      ).toBe(severity);
    }
  });

  it("rejects an out-of-set severity", () => {
    expect(() =>
      AuditFindingSchema.parse({ code: "X", severity: "error", text: "t", suggestion: "s" }),
    ).toThrow();
  });

  it("rejects a missing suggestion", () => {
    expect(() =>
      AuditFindingSchema.parse({ code: "X", severity: "info", text: "t" }),
    ).toThrow();
  });
});
