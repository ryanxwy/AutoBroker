/**
 * incentive_scrape descriptor — unit tests over buildInput. The skill
 * auto-approves every new OEM source (owner directive), so it has NO
 * first-encounter suspend / resume seam: buildInput is the only descriptor
 * surface to exercise.
 */

import { describe, expect, it } from "vitest";

import { FormDecisionError, incentiveScrapeDescriptor } from "./skillRuns.js";

describe("incentive_scrape descriptor — buildInput", () => {
  it("accepts the bare body and the explicit profile pin", () => {
    expect(incentiveScrapeDescriptor.buildInput({})).toEqual({ search_profile_id: null });
    expect(
      incentiveScrapeDescriptor.buildInput({
        skill: "incentive_scrape",
        search_profile_id: "prof-1",
      }),
    ).toEqual({ search_profile_id: "prof-1" });
  });

  it("rejects a non-string search_profile_id as content_invalid", () => {
    expect(() => incentiveScrapeDescriptor.buildInput({ search_profile_id: 42 })).toThrowError(
      FormDecisionError,
    );
  });
});
