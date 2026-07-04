/**
 * L1 unit tests — L2 in-process gate (THE load-bearing safety boundary).
 *
 * Freezes the fail-CLOSED gate contract (see the safety invariants in CLAUDE.md):
 *   (a) malformed/absent structured request ⇒ throws, never parses prose;
 *   (b) an approver that errors or returns non-true ⇒ declined;
 *   (c) `commit` runs IFF the verdict is `approved` — the decline path causes
 *       zero side effects. Pure in-process — no network, no DB.
 */

import { describe, expect, it } from "vitest";
import {
  MalformedGateRequestError,
  requestApproval,
  withGate,
  type Approver,
  type GateRequest,
} from "./index.js";

const validRequest: GateRequest = {
  kind: "gmail_send",
  runId: "run-test-1",
  summary: "Send email to dealer@example.com",
  payload: { to: "dealer@example.com" },
};

const approveAll: Approver = { decide: async () => true };
const denyAll: Approver = { decide: async () => false };
const erroringApprover: Approver = {
  decide: async () => {
    throw new Error("approver backend down");
  },
};

describe("requestApproval — fail-closed validation (malformed gate request)", () => {
  it("throws MalformedGateRequestError on a non-object request", async () => {
    await expect(requestApproval("send the email", approveAll)).rejects.toThrow(
      MalformedGateRequestError,
    );
  });

  it("throws on an unknown mutation kind", async () => {
    await expect(
      requestApproval({ ...validRequest, kind: "rm_rf" }, approveAll),
    ).rejects.toThrow(MalformedGateRequestError);
  });

  it("throws on a missing runId", async () => {
    await expect(
      requestApproval({ ...validRequest, runId: "" }, approveAll),
    ).rejects.toThrow(MalformedGateRequestError);
  });
});

describe("requestApproval — approver verdicts", () => {
  it("declines when the approver says no", async () => {
    const verdict = await requestApproval(validRequest, denyAll);
    expect(verdict.decision).toBe("declined");
    expect(verdict.autoApprove).toBe(false);
  });

  it("treats an erroring approver as a decline (fail-closed)", async () => {
    const verdict = await requestApproval(validRequest, erroringApprover);
    expect(verdict.decision).toBe("declined");
  });

  it("approves only on an explicit true, with autoApprove false", async () => {
    const verdict = await requestApproval(validRequest, approveAll);
    expect(verdict).toEqual({ decision: "approved", autoApprove: false });
  });
});

describe("withGate — commit gating", () => {
  it("runs commit exactly once on approval", async () => {
    let commits = 0;
    const result = await withGate(validRequest, approveAll, async () => {
      commits += 1;
      return "sent";
    });
    expect(result).toBe("sent");
    expect(commits).toBe(1);
  });

  it("NEVER runs commit on a decline (zero side effects)", async () => {
    let commits = 0;
    const result = await withGate(validRequest, denyAll, async () => {
      commits += 1;
      return "sent";
    });
    expect(commits).toBe(0);
    expect(result).toMatchObject({ decision: "declined" });
  });
});
