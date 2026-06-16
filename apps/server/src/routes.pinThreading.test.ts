/**
 * Unit tests for withSessionPin — the launch-time fix that threads an EXPLICIT
 * session pin into a pin_required skill's start body so it runs on the pinned
 * search instead of STOPping "pin_required". Regression cover for the bug where
 * the NL router (POST /api/route) and a normal slash launch (POST /api/skill-runs)
 * carried no search_profile_id, so pin_required skills (quote_pipeline,
 * dealer_inbox_check, dealer_web_lead_submit, negotiation_followup,
 * dealer_closeout_email) stopped even when the session was explicitly pinned.
 */
import { describe, expect, it } from "vitest";

import { withSessionPin } from "./routes.js";

const PIN = "profile-26da90d9773f0161";

describe("withSessionPin", () => {
  it("threads the pin into a pin_required skill that carries no search_profile_id", () => {
    expect(withSessionPin({ skill: "quote_pipeline" }, "quote_pipeline", PIN)).toEqual({
      skill: "quote_pipeline",
      search_profile_id: PIN,
    });
    expect(withSessionPin({}, "dealer_inbox_check", PIN)).toEqual({ search_profile_id: PIN });
  });

  it("never clobbers an explicit search_profile_id (the STOP-picker's pick wins)", () => {
    const body = { search_profile_id: "picked-999" };
    // returned UNCHANGED (same reference) — the explicit pick is authoritative.
    expect(withSessionPin(body, "quote_pipeline", PIN)).toBe(body);
  });

  it("leaves infer_ok and exempt skills untouched (intake never inherits a pin)", () => {
    const geo = { skill: "dealer_geosearch" };
    expect(withSessionPin(geo, "dealer_geosearch", PIN)).toBe(geo);
    const intake = { skill: "search_profile_intake", freeform_text: "I want a Tucson" };
    expect(withSessionPin(intake, "search_profile_intake", PIN)).toBe(intake);
  });

  it("does nothing when there is no session pin — the skill still STOPs pin_required", () => {
    const body = { skill: "quote_pipeline" };
    expect(withSessionPin(body, "quote_pipeline", null)).toBe(body);
  });
});
