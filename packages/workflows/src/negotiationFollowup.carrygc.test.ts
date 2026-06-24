import { describe, it, expect, afterEach } from "vitest";

import {
  requestContactFlipForRun,
  clearContactFlipForRun,
  __negotiationFollowupCarrySizesForTests,
  __resetNegotiationFollowupDepsForTests,
} from "./negotiationFollowup.js";

/**
 * The two module-level carry Maps (contactFlipRequestsByRun /
 * pendingFlipApproveByRun) leak in production: contactFlipRequestsByRun is set
 * by requestContactFlipForRun and NEVER deleted on any production path. The new
 * clearContactFlipForRun(runId) is the symmetric remover the terminal hook calls
 * so a terminal/declined run does not leak its entry.
 */
describe("negotiationFollowup contact-flip carry GC", () => {
  afterEach(() => {
    __resetNegotiationFollowupDepsForTests();
  });

  it("clearContactFlipForRun deletes the registered flip carry for that run only", () => {
    requestContactFlipForRun("run-A", { threadId: "t1", dealerId: "d1", contactId: "c1" });
    requestContactFlipForRun("run-B", { threadId: "t2", dealerId: "d2", contactId: "c2" });
    expect(__negotiationFollowupCarrySizesForTests().flips).toBe(2);

    clearContactFlipForRun("run-A");

    const sizes = __negotiationFollowupCarrySizesForTests();
    expect(sizes.flips).toBe(1); // only run-A removed; run-B untouched
    expect(sizes.pendingApprove).toBe(0);
  });

  it("clearContactFlipForRun is idempotent (a second clear is a no-op)", () => {
    requestContactFlipForRun("run-A", { threadId: "t1", dealerId: "d1", contactId: "c1" });
    clearContactFlipForRun("run-A");
    expect(__negotiationFollowupCarrySizesForTests().flips).toBe(0);
    // double-tap: still clean, no throw
    clearContactFlipForRun("run-A");
    expect(__negotiationFollowupCarrySizesForTests().flips).toBe(0);
  });
});
