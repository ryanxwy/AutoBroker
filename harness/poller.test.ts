/**
 * poller.test.ts — the Approver impls. deny_all is airtight;
 * approve_safe is fail-OPEN denylist for the read-only cluster (DENY a recognized
 * mutation/arbitrary-code marker, allow-once otherwise). The deny path IS the test.
 */

import { describe, expect, it } from "vitest";

import type { GateRequest } from "@autobroker/tools";

import { approveSafe, approverFor, denyAll } from "./poller.js";

const req = (kind: string, summary = "", payload: Record<string, unknown> = {}): GateRequest =>
  ({ kind, runId: "r1", summary, payload }) as GateRequest;

describe("denyAll (airtight)", () => {
  it("declines every gate unconditionally", async () => {
    expect(await denyAll.decide(req("gmail_send"))).toBe(false);
    expect(await denyAll.decide(req("typed_yes_confirm"))).toBe(false);
    expect(await denyAll.decide(req("anything"))).toBe(false);
  });
});

describe("approveSafe (fail-OPEN denylist, read-only cluster)", () => {
  const safe = approveSafe();

  it("DENIES a recognized mutation kind", async () => {
    expect(await safe.decide(req("gmail_send"))).toBe(false);
    expect(await safe.decide(req("dealer_form_submit"))).toBe(false);
  });

  it("DENIES an arbitrary-code escape in the summary/payload", async () => {
    expect(await safe.decide(req("run", "please run python3 -c 'x'"))).toBe(false);
    expect(await safe.decide(req("x", "", { cmd: "bash -c rm" }))).toBe(false);
  });

  it("ALLOWS-ONCE an unrecognized gate (fail-open, read-only only)", async () => {
    expect(await safe.decide(req("read_profile"))).toBe(true);
    expect(await safe.decide(req("some_benign_read"))).toBe(true);
  });
});

describe("approverFor", () => {
  it("resolves deny_all / approve_safe", () => {
    expect(approverFor("deny_all")).toBe(denyAll);
    expect(typeof approverFor("approve_safe").decide).toBe("function");
  });
});
