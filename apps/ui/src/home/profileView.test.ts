/**
 * profileView.test — the pure label helpers. prettifySkill turns a snake_case
 * skill id into a human-friendly title (spaced, first character capitalized),
 * for the canvas run-view header (the buyer never sees a raw run id or id slug).
 */

import { describe, expect, it } from "vitest";

import { prettifySkill } from "./profileView.js";

describe("prettifySkill", () => {
  it("spaces snake_case and capitalizes the first character", () => {
    expect(prettifySkill("search_profile_intake")).toBe("Search profile intake");
    expect(prettifySkill("dealer_geosearch")).toBe("Dealer geosearch");
  });

  it("capitalizes a single word", () => {
    expect(prettifySkill("intake")).toBe("Intake");
  });

  it("returns empty for empty input", () => {
    expect(prettifySkill("")).toBe("");
  });
});
