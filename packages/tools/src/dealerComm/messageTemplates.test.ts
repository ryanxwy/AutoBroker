/**
 * Byte snapshots of the dealer-facing body + subject. The whole point of these
 * templates is to be byte-stable, so the body is pinned as an exact string (not
 * a loose match): any wording / spacing / line-break change must re-pin here on
 * purpose. Also covers the financing dispatch, conditional lines, signature
 * extraction, budget redaction, and the followup subject rule.
 */

import { describe, expect, it } from "vitest";

import {
  safeBodyTemplate,
  safeSubjectLine,
  subjectForFollowup,
  type MessageProfile,
} from "./messageTemplates.js";

const FULL_PROFILE: MessageProfile = {
  year: 2026,
  make: "Hyundai",
  model: "Tucson",
  trim: "SEL",
  financingPreference: "finance",
  tradeInDescription: "2018 Honda Civic",
  militaryFirstResponder: 1,
  currentBrandOwner: 1,
  followUpEmail: "jordan.smith@example.com",
};

describe("safeBodyTemplate — byte snapshot", () => {
  it("renders the full-profile body byte-for-byte", () => {
    expect(safeBodyTemplate(FULL_PROFILE)).toBe(
      "Hi,\n" +
        "\n" +
        "I'm interested in purchasing a new 2026 Hyundai Tucson SEL. Could you please provide me with a detailed out-the-door (OTD) quote including all fees, taxes, and dealer charges?\n" +
        "\n" +
        "I'm interested in financing this vehicle. Please include your best financing rate (APR + term).\n" +
        "I have a 2018 Honda Civic I may trade in.\n" +
        "I'm eligible for military/first responder incentives.\n" +
        "I'm a current Hyundai owner.\n" +
        "\n" +
        "I prefer to handle everything via email for now and will reach out by phone once we've agreed on pricing.\n" +
        "\n" +
        "Thank you,\n" +
        "Jordan\n",
    );
  });

  it("renders a minimal cash profile body byte-for-byte", () => {
    const body = safeBodyTemplate({
      year: 2025,
      make: "Toyota",
      model: "RAV4",
      trim: "any",
      financingPreference: "cash",
      followUpEmail: null,
    });
    expect(body).toBe(
      "Hi,\n" +
        "\n" +
        "I'm interested in purchasing a new 2025 Toyota RAV4. Could you please provide me with a detailed out-the-door (OTD) quote including all fees, taxes, and dealer charges?\n" +
        "\n" +
        "I plan to pay cash.\n" +
        "\n" +
        "I prefer to handle everything via email for now and will reach out by phone once we've agreed on pricing.\n" +
        "\n" +
        "Thank you,\n" +
        "\n",
    );
  });

  it("ends with exactly one trailing newline", () => {
    const body = safeBodyTemplate(FULL_PROFILE);
    expect(body.endsWith("\n")).toBe(true);
    expect(body.endsWith("\n\n")).toBe(false);
  });
});

describe("safeBodyTemplate — financing dispatch", () => {
  const base: MessageProfile = { year: 2026, make: "Hyundai", model: "Tucson", trim: null };

  it("lease ask", () => {
    expect(safeBodyTemplate({ ...base, financingPreference: "lease" })).toContain(
      "I'm interested in leasing this vehicle. Please include your best lease offer (money factor + residual + 36 months / 10k miles per year).",
    );
  });

  it("undecided / unknown asks for both worlds", () => {
    const dual =
      "I'd like to compare both options. Please include both your best financing rate (APR + term) and your best lease offer (money factor + residual + 36 months / 10k miles per year).";
    expect(safeBodyTemplate({ ...base, financingPreference: "undecided" })).toContain(dual);
    expect(safeBodyTemplate({ ...base, financingPreference: null })).toContain(dual);
    expect(safeBodyTemplate({ ...base, financingPreference: "whatever" })).toContain(dual);
  });
});

describe("safeBodyTemplate — budget redaction", () => {
  it("redacts a budget figure that rides in on a trade-in description", () => {
    const body = safeBodyTemplate({
      year: 2026,
      make: "Hyundai",
      model: "Tucson",
      trim: null,
      financingPreference: "cash",
      tradeInDescription: "trade worth, my budget is $30,000",
      followUpEmail: "a@example.com",
    });
    expect(body).not.toContain("$30,000");
    expect(body).not.toMatch(/\bbudget\b/i);
    expect(body).toContain("[redacted]");
  });
});

describe("safeSubjectLine", () => {
  it("prefixes the vehicle phrase", () => {
    expect(safeSubjectLine(FULL_PROFILE)).toBe("[Quote Request] 2026 Hyundai Tucson SEL");
  });

  it("drops a missing/any trim", () => {
    expect(
      safeSubjectLine({ year: 2025, make: "Toyota", model: "RAV4", trim: "any" }),
    ).toBe("[Quote Request] 2025 Toyota RAV4");
  });

  it("falls back to the bare prefix with no vehicle", () => {
    expect(safeSubjectLine({})).toBe("[Quote Request]");
  });
});

describe("subjectForFollowup", () => {
  it("adds Re: to a fresh subject", () => {
    expect(subjectForFollowup("Quote Request")).toBe("Re: Quote Request");
  });

  it("does not double-prefix an existing reply", () => {
    expect(subjectForFollowup("Re: Quote Request")).toBe("Re: Quote Request");
  });

  it("placeholders an empty subject", () => {
    expect(subjectForFollowup("")).toBe("Re: (no subject)");
    expect(subjectForFollowup(null)).toBe("Re: (no subject)");
    expect(subjectForFollowup("   ")).toBe("Re: (no subject)");
  });
});
