/**
 * L1 unit tests — SearchProfileIntakeInputSchema + INTAKE_FIELD_META (B1).
 *
 * Pure Zod parse tests; no DB, no framework. Freezes:
 *   (a) the 18-field happy path parses (6 required + 12 nullable);
 *   (b) absence of EACH required field fails (the form-contract required set);
 *   (c) META keys exactly match the schema shape keys (structural drift guard);
 *   (d) budget_max sensitivity = 'internal_only'; derived sets are correct.
 */

import { describe, expect, it } from "vitest";
import {
  SearchProfileIntakeInputSchema,
  INTAKE_FIELD_META,
  INTAKE_REQUIRED_FIELDS,
  INTAKE_INTERNAL_ONLY_FIELDS,
  type SearchProfileIntakeInput,
  type IntakeFieldName,
} from "./intake.js";

/** Happy path: 6 required filled, all 12 optional present (as null is allowed). */
const HAPPY: SearchProfileIntakeInput = {
  make: "Hyundai",
  model: "Tucson Hybrid",
  year: 2026,
  location_query: "Irvine, CA 92614",
  follow_up_email: "buyer@example.com",
  financing_preference: "finance",
  trim: null,
  search_radius_miles: null,
  budget_max: null,
  follow_up_phone: null,
  phone_policy: null,
  preferred_exterior_colors_json: null,
  preferred_interior_colors_json: null,
  acceptable_trims_json: null,
  feature_preferences_json: null,
  trade_in_description: null,
  military_first_responder: null,
  current_brand_owner: null,
};

const REQUIRED: IntakeFieldName[] = [
  "make",
  "model",
  "year",
  "location_query",
  "follow_up_email",
  "financing_preference",
];

describe("SearchProfileIntakeInputSchema — 18 fields", () => {
  it("parses the happy path", () => {
    const parsed = SearchProfileIntakeInputSchema.parse(HAPPY);
    expect(Object.keys(parsed)).toHaveLength(18);
    expect(parsed.make).toBe("Hyundai");
    expect(parsed.financing_preference).toBe("finance");
  });

  it("fills optional fields when provided", () => {
    const parsed = SearchProfileIntakeInputSchema.parse({
      ...HAPPY,
      trim: "Limited",
      budget_max: 42000,
      phone_policy: "fake",
      military_first_responder: 1,
    });
    expect(parsed.trim).toBe("Limited");
    expect(parsed.budget_max).toBe(42000);
    expect(parsed.military_first_responder).toBe(1);
  });

  it.each(REQUIRED)("fails when required field %s is absent", (field) => {
    const { [field]: _omitted, ...rest } = HAPPY;
    expect(() => SearchProfileIntakeInputSchema.parse(rest)).toThrow();
  });

  it("fails on an empty required string (make/model/location/email)", () => {
    expect(() =>
      SearchProfileIntakeInputSchema.parse({ ...HAPPY, make: "" }),
    ).toThrow();
  });

  it("rejects an unknown key (.strict)", () => {
    expect(() =>
      SearchProfileIntakeInputSchema.parse({ ...HAPPY, bogus: 1 }),
    ).toThrow();
  });

  it("rejects an out-of-enum financing_preference", () => {
    expect(() =>
      SearchProfileIntakeInputSchema.parse({ ...HAPPY, financing_preference: "barter" }),
    ).toThrow();
  });
});

/** The frozen 18-field canonical UI render order (FRONTEND §5.1). */
const CANONICAL_ORDER: IntakeFieldName[] = [
  "make",
  "model",
  "trim",
  "year",
  "location_query",
  "search_radius_miles",
  "budget_max",
  "follow_up_email",
  "follow_up_phone",
  "phone_policy",
  "preferred_exterior_colors_json",
  "preferred_interior_colors_json",
  "acceptable_trims_json",
  "feature_preferences_json",
  "financing_preference",
  "trade_in_description",
  "military_first_responder",
  "current_brand_owner",
];

describe("INTAKE_FIELD_META — structural drift guard", () => {
  it("META keys exactly match the schema shape keys (same set)", () => {
    const schemaKeys = Object.keys(SearchProfileIntakeInputSchema.shape).sort();
    const metaKeys = Object.keys(INTAKE_FIELD_META).sort();
    expect(metaKeys).toEqual(schemaKeys);
    expect(metaKeys).toHaveLength(18);
  });

  it("META key ORDER deep-equals the frozen canonical render order", () => {
    expect(Object.keys(INTAKE_FIELD_META)).toEqual(CANONICAL_ORDER);
  });

  it("required flags match the 6-field required set exactly", () => {
    expect([...INTAKE_REQUIRED_FIELDS].sort()).toEqual([...REQUIRED].sort());
  });

  it("budget_max is the only internal_only field", () => {
    expect(INTAKE_FIELD_META.budget_max.sensitivity).toBe("internal_only");
    expect(INTAKE_INTERNAL_ONLY_FIELDS).toEqual(["budget_max"]);
  });

  it("PII fields carry sensitivity 'pii'", () => {
    expect(INTAKE_FIELD_META.follow_up_email.sensitivity).toBe("pii");
    expect(INTAKE_FIELD_META.follow_up_phone.sensitivity).toBe("pii");
    expect(INTAKE_FIELD_META.trade_in_description.sensitivity).toBe("pii");
  });

  it("every field has a non-empty 中文 label and a known section", () => {
    for (const name of Object.keys(INTAKE_FIELD_META) as IntakeFieldName[]) {
      const meta = INTAKE_FIELD_META[name];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(["Car & contact", "Optional / Buyer context"]).toContain(meta.section);
    }
  });
});
