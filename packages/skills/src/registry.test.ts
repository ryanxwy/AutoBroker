/**
 * registry.test — the profile-pin posture tiering invariants. Every skill
 * carries a valid `profilePin`; the three tier sets are EXACTLY as specified;
 * the registry has all 18 skills.
 */

import { describe, expect, it } from "vitest";

import { SKILLS, type SkillProfilePin } from "./registry.js";

const VALID_PINS: readonly SkillProfilePin[] = ["exempt", "pin_required", "infer_ok"];

/** The authoritative tiering (by skill id). */
const EXEMPT = ["search_profile_intake"];
const PIN_REQUIRED = [
  "dealer_inbox_check",
  "dealer_web_lead_submit",
  "negotiation_followup",
  "dealer_closeout_email",
  "dealer_hygiene",
  "pipeline_reset",
  "quote_pipeline",
];
const INFER_OK = [
  "dealer_geosearch",
  "inventory_site_scan",
  "inventory_aggregator_scan",
  "inventory_link_scan",
  "incentive_scrape",
  "quote_audit",
  "quote_compare",
  "inventory_compare",
  "dealer_reply_extract",
  "daily_digest",
];

function idsWithPin(pin: SkillProfilePin): string[] {
  return SKILLS.filter((s) => s.profilePin === pin)
    .map((s) => s.id)
    .sort();
}

describe("registry — profilePin posture", () => {
  it("has all 18 skills", () => {
    expect(SKILLS).toHaveLength(18);
  });

  it("every skill declares a valid profilePin", () => {
    for (const s of SKILLS) {
      expect(VALID_PINS).toContain(s.profilePin);
    }
  });

  it("the three tier sets are exactly the specified ids", () => {
    expect(idsWithPin("exempt")).toEqual([...EXEMPT].sort());
    expect(idsWithPin("pin_required")).toEqual([...PIN_REQUIRED].sort());
    expect(idsWithPin("infer_ok")).toEqual([...INFER_OK].sort());
  });

  it("the three tiers partition all 18 skills (no skill in two tiers, none missing)", () => {
    const total = EXEMPT.length + PIN_REQUIRED.length + INFER_OK.length;
    expect(total).toBe(18);
    const all = new Set([...EXEMPT, ...PIN_REQUIRED, ...INFER_OK]);
    expect(all.size).toBe(18);
    for (const s of SKILLS) expect(all.has(s.id)).toBe(true);
  });

  it("intake is the sole exempt skill (it creates the profile)", () => {
    expect(idsWithPin("exempt")).toEqual(["search_profile_intake"]);
  });
});
