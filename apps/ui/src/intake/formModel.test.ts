/**
 * formModel.test — the pure form model (FRONTEND_LAYOUT §5.2-§5.4). Covers the
 * 18-field derivation from core, required marks/sections, per-field validation,
 * the year current-or-next constraint, and the form-decision serialization
 * (optional empty → null, required empty preserved, number coercion).
 */

import { describe, expect, it } from "vitest";

import { INTAKE_FIELD_META } from "@autobroker/core";

import {
  allowedYears,
  allRequiredValid,
  buildFormDecisionContent,
  fieldsForSection,
  INTAKE_FIELD_NAMES,
  isValidEmailShape,
  isValidPhoneShape,
  REQUIRED_FIELD_NAMES,
  requiredCompleteCount,
  SECTION_ORDER,
  validateField,
} from "./formModel.js";

const NOW = new Date("2026-06-04T00:00:00Z"); // year 2026.

describe("formModel — field set derivation from core", () => {
  it("renders all 18 META fields in the frozen order", () => {
    expect(INTAKE_FIELD_NAMES).toHaveLength(18);
    expect(INTAKE_FIELD_NAMES).toEqual(Object.keys(INTAKE_FIELD_META));
  });

  it("the required set is exactly the 6 form-contract fields", () => {
    expect(new Set(REQUIRED_FIELD_NAMES)).toEqual(
      new Set(["make", "model", "year", "location_query", "follow_up_email", "financing_preference"]),
    );
  });

  it("every field lands in one of the two sections; the union is all 18", () => {
    const all = SECTION_ORDER.flatMap((s) => fieldsForSection(s).map((f) => f.name));
    expect(new Set(all)).toEqual(new Set(INTAKE_FIELD_NAMES));
  });
});

describe("formModel — validation", () => {
  it("flags a required field when empty", () => {
    expect(validateField("make", "", NOW)).toMatch(/required/i);
    expect(validateField("make", "Hyundai", NOW)).toBeNull();
  });

  it("an optional empty field is valid", () => {
    expect(validateField("trim", "", NOW)).toBeNull();
    expect(validateField("trim", null, NOW)).toBeNull();
  });

  it("email + phone shapes", () => {
    expect(isValidEmailShape("a@b.com")).toBe(true);
    expect(isValidEmailShape("nope")).toBe(false);
    expect(validateField("follow_up_email", "bad", NOW)).toMatch(/email/i);
    expect(isValidPhoneShape("5551234")).toBe(true);
    expect(isValidPhoneShape("12")).toBe(false);
  });

  it("year accepts current-or-next only", () => {
    const [y0, y1] = allowedYears(NOW);
    expect([y0, y1]).toEqual([2026, 2027]);
    expect(validateField("year", 2026, NOW)).toBeNull();
    expect(validateField("year", 2027, NOW)).toBeNull();
    expect(validateField("year", 2025, NOW)).toMatch(/this year or next/i);
  });

  it("requiredCompleteCount + allRequiredValid track the 6 required fields", () => {
    const values = {
      make: "Hyundai",
      model: "Tucson",
      year: 2026,
      location_query: "Irvine, CA",
      follow_up_email: "me@example.com",
      financing_preference: "finance",
    };
    expect(requiredCompleteCount(values, NOW)).toBe(6);
    expect(allRequiredValid(values, NOW)).toBe(true);
    expect(allRequiredValid({ ...values, make: "" }, NOW)).toBe(false);
  });
});

describe("formModel — form-decision serialization", () => {
  it("optional empties → null; required empties preserved as ''; numbers coerced", () => {
    const content = buildFormDecisionContent({
      make: "Hyundai",
      model: "", // required empty → stays '' so the server rejects it
      year: 2026,
      trim: "", // optional empty → null
      search_radius_miles: "50", // number coercion
    });
    expect(content["make"]).toBe("Hyundai");
    expect(content["model"]).toBe(""); // required empty preserved
    expect(content["year"]).toBe(2026);
    expect(content["trim"]).toBeNull();
    expect(content["search_radius_miles"]).toBe(50);
  });
});
