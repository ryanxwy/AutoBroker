/**
 * uiDriver.test.ts — the PURE selector-plan helpers only (no browser launch;
 * the driver verbs themselves are exercised by the live UI-lane runs).
 */

import { describe, expect, it } from "vitest";

import { planFormActions, runIdFromPath, tid } from "./uiDriver.js";

describe("planFormActions (case content → widget DOM actions)", () => {
  it("maps text/number fields to fill, radios to check, checkboxes to setChecked", () => {
    const actions = planFormActions({
      make: "Hyundai",
      search_radius_miles: 25,
      year: 2026,
      financing_preference: "finance",
      phone_policy: "fake",
      military_first_responder: 0,
      current_brand_owner: 1,
    });
    expect(actions).toContainEqual({ kind: "fill", testid: "intake-field-make", value: "Hyundai" });
    expect(actions).toContainEqual({ kind: "fill", testid: "intake-field-search_radius_miles", value: "25" });
    expect(actions).toContainEqual({ kind: "check", testid: "intake-field-year-2026" });
    expect(actions).toContainEqual({ kind: "check", testid: "intake-field-financing_preference-finance" });
    expect(actions).toContainEqual({ kind: "check", testid: "intake-field-phone_policy-fake" });
    expect(actions).toContainEqual({ kind: "setChecked", testid: "intake-field-military_first_responder", checked: false });
    expect(actions).toContainEqual({ kind: "setChecked", testid: "intake-field-current_brand_owner", checked: true });
  });

  it("skips null/absent fields — only fields present in the case content are touched", () => {
    const actions = planFormActions({ make: "Hyundai", trim: null });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ testid: "intake-field-make" });
  });
});

describe("runIdFromPath / tid", () => {
  it("parses /runs/:id and rejects other routes", () => {
    expect(runIdFromPath("/runs/abc-123")).toBe("abc-123");
    expect(runIdFromPath("/runs/abc-123/")).toBe("abc-123");
    expect(runIdFromPath("/profiles/p1")).toBeNull();
    expect(runIdFromPath("/")).toBeNull();
  });

  it("tid builds the stable data-testid selector", () => {
    expect(tid("chat-send")).toBe('[data-testid="chat-send"]');
  });
});
