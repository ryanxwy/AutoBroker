/**
 * L1 unit tests — the dealer_closeout_email contracts. Freezes the input
 * schema, the 3-member discriminated output union (sent | declined |
 * skip_all_reset), the typed STOP, the generalized profile-STOP classifier, the
 * reused batch_review suspend/resume vocabularies, and the stable workflow id.
 */

import { describe, expect, it } from "vitest";

import {
  BatchReviewResumeSchema,
  BatchReviewSuspendSchema,
  DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID,
  DealerCloseoutEmailInputSchema,
  DealerCloseoutEmailOutputSchema,
  DealerCloseoutEmailStopError,
  profileStopCode,
} from "./dealerCloseoutEmailContracts.js";

const PROFILE = "a1b2c3d4e5f60718";

describe("DealerCloseoutEmailInputSchema", () => {
  it("accepts a pinned synth-hash id and a null pin", () => {
    expect(DealerCloseoutEmailInputSchema.parse({ search_profile_id: PROFILE })).toEqual({
      search_profile_id: PROFILE,
    });
    expect(DealerCloseoutEmailInputSchema.parse({ search_profile_id: null })).toEqual({
      search_profile_id: null,
    });
  });

  it("accepts a synth-hash search_profile_id (the product id format, not a UUID)", () => {
    expect(
      DealerCloseoutEmailInputSchema.parse({ search_profile_id: PROFILE }).search_profile_id,
    ).toBe(PROFILE);
  });

  it("rejects a non-string search_profile_id", () => {
    expect(() => DealerCloseoutEmailInputSchema.parse({ search_profile_id: 123 })).toThrow();
  });
});

describe("DealerCloseoutEmailOutputSchema", () => {
  const sent = {
    outcome: "sent" as const,
    resolution: "pinned" as const,
    closed_thread_ids: ["t1", "t2"],
    emails_sent: 0,
    profile_status_transition: "closed" as const,
    skipped_no_address: 1,
    summary: "Closed out 2 dealers for your Hyundai Tucson search.",
    search_profile_id: PROFILE,
  };

  it("discriminates the three outcomes", () => {
    expect(DealerCloseoutEmailOutputSchema.parse(sent).outcome).toBe("sent");
    expect(DealerCloseoutEmailOutputSchema.parse({ outcome: "declined" }).outcome).toBe(
      "declined",
    );
    const reset = {
      outcome: "skip_all_reset" as const,
      search_profile_id: PROFILE,
      reset_requested: true as const,
      summary: "Skipped all closeouts; pipeline reset requested.",
    };
    expect(DealerCloseoutEmailOutputSchema.parse(reset).outcome).toBe("skip_all_reset");
  });

  it("rejects a sent payload missing a field", () => {
    const { closed_thread_ids: _omit, ...partial } = sent;
    expect(() => DealerCloseoutEmailOutputSchema.parse(partial)).toThrow();
  });

  it("rejects a skip_all_reset payload with reset_requested:false", () => {
    expect(() =>
      DealerCloseoutEmailOutputSchema.parse({
        outcome: "skip_all_reset",
        search_profile_id: PROFILE,
        reset_requested: false,
        summary: "x",
      }),
    ).toThrow();
  });
});

describe("DealerCloseoutEmailStopError", () => {
  it("carries the typed code", () => {
    const e = new DealerCloseoutEmailStopError("pin_required", "pin one first");
    expect(e.code).toBe("pin_required");
    expect(e.name).toBe("DealerCloseoutEmailStopError");
    expect(e.message).toBe("pin one first");
  });
});

describe("profileStopCode", () => {
  it("maps the 0 / 1 / 2+ active branches", () => {
    expect(profileStopCode(0)).toBe("no_active_profile");
    expect(profileStopCode(1)).toBe("pin_required");
    expect(profileStopCode(2)).toBe("multiple_active_profiles");
    expect(profileStopCode(7)).toBe("multiple_active_profiles");
  });
});

describe("batch_review suspend/resume (reused)", () => {
  it("round-trips a valid suspend payload", () => {
    const valid = {
      kind: "batch_review" as const,
      question: "Send closeout emails to these dealers?",
      targets: [{ dealer_id: "d1", name: "Jim Click Hyundai", website: "" }],
      skipped: [],
      total_targets: 1,
      total_in_radius: 1,
    };
    expect(BatchReviewSuspendSchema.parse(valid)).toEqual(valid);
  });

  it("accepts approve with a non-empty id list and decline", () => {
    expect(
      BatchReviewResumeSchema.parse({ action: "approve", approved_dealer_ids: ["d1"] }).action,
    ).toBe("approve");
    expect(BatchReviewResumeSchema.parse({ action: "decline" }).action).toBe("decline");
  });
});

describe("DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID", () => {
  it("is the stable id", () => {
    expect(DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID).toBe("dealer_closeout_email");
  });
});
