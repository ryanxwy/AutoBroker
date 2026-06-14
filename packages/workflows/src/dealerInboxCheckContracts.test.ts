/**
 * L1 unit tests — the dealer_inbox_check contracts. Freezes the input schema,
 * the discriminated output union, the typed STOP, and the .strict() suspend
 * payload (rejects extra keys).
 */

import { describe, expect, it } from "vitest";

import {
  BatchReviewResumeSchema,
  DEALER_INBOX_CHECK_WORKFLOW_ID,
  DealerInboxCheckInputSchema,
  DealerInboxCheckOutputSchema,
  DealerInboxCheckStopError,
  InboxReviewSuspendSchema,
} from "./dealerInboxCheckContracts.js";

describe("DealerInboxCheckInputSchema", () => {
  it("accepts a pin and a null pin", () => {
    expect(DealerInboxCheckInputSchema.parse({ search_profile_id: "p1" })).toEqual({ search_profile_id: "p1" });
    expect(DealerInboxCheckInputSchema.parse({ search_profile_id: null })).toEqual({ search_profile_id: null });
  });
});

describe("DealerInboxCheckOutputSchema", () => {
  it("discriminates the three outcomes", () => {
    const checked = {
      outcome: "checked" as const,
      resolution: "pinned" as const,
      window: "2d",
      queries_run: 4,
      raw_hit_count: 3,
      unique_thread_count: 2,
      new_messages_count: 2,
      new_threads_count: 2,
      unique_dealers_replied: 2,
      unrouted_count: 0,
      rejected_count: 0,
      full_resync: false,
      summary: "Found 2 new replies for your Hyundai Tucson search.",
    };
    expect(DealerInboxCheckOutputSchema.parse(checked).outcome).toBe("checked");
    expect(DealerInboxCheckOutputSchema.parse({ outcome: "declined" }).outcome).toBe("declined");
    expect(DealerInboxCheckOutputSchema.parse({ outcome: "no_replies" }).outcome).toBe("no_replies");
  });
});

describe("DealerInboxCheckStopError", () => {
  it("carries the typed code", () => {
    const e = new DealerInboxCheckStopError("multiple_active_profiles", "pick one");
    expect(e.code).toBe("multiple_active_profiles");
    expect(e.name).toBe("DealerInboxCheckStopError");
    expect(e.message).toBe("pick one");
  });
});

describe("InboxReviewSuspendSchema (.strict())", () => {
  const valid = {
    kind: "batch_review" as const,
    question: "Save these dealer replies?",
    targets: [
      {
        dealer_id: "d1",
        name: "Example Hyundai",
        thread_ids: ["t1"],
        classification: "quoted" as const,
        snippet: "Sale price 33,995…",
      },
    ],
    unrouted: [{ thread_id: "t9", snippet: "unknown sender…" }],
    total_targets: 1,
  };

  it("round-trips the valid payload", () => {
    expect(InboxReviewSuspendSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an extra key", () => {
    expect(() => InboxReviewSuspendSchema.parse({ ...valid, sneaky: true })).toThrow();
  });
});

describe("BatchReviewResumeSchema (reused)", () => {
  it("accepts approve with a non-empty id list and decline", () => {
    expect(BatchReviewResumeSchema.parse({ action: "approve", approved_dealer_ids: ["d1"] }).action).toBe("approve");
    expect(BatchReviewResumeSchema.parse({ action: "decline" }).action).toBe("decline");
  });

  it("rejects an empty approve list", () => {
    expect(() => BatchReviewResumeSchema.parse({ action: "approve", approved_dealer_ids: [] })).toThrow();
  });
});

describe("DEALER_INBOX_CHECK_WORKFLOW_ID", () => {
  it("is the stable id", () => {
    expect(DEALER_INBOX_CHECK_WORKFLOW_ID).toBe("dealer_inbox_check");
  });
});
