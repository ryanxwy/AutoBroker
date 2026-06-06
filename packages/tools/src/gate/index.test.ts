/**
 * L1 unit tests — L2 in-process gate (THE load-bearing safety boundary).
 *
 * Freezes the fail-CLOSED gate contract (see the safety invariants in CLAUDE.md):
 *   (a) malformed/absent structured request ⇒ throws, never parses prose;
 *   (b) the L1 env fuse throws BEFORE the approver is consulted;
 *   (c) an approver that errors or returns non-true ⇒ declined;
 *   (d) `commit` runs IFF the verdict is `approved` — the decline path causes
 *       zero side effects. Pure in-process — no network, no DB.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalMutationsBlockedError,
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

const FUSE = "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS";
const originalFuse = process.env[FUSE];

afterEach(() => {
  if (originalFuse === undefined) delete process.env[FUSE];
  else process.env[FUSE] = originalFuse;
});

describe("requestApproval — fail-closed validation (#1244 at the gate)", () => {
  it("throws MalformedGateRequestError on a non-object request", async () => {
    delete process.env[FUSE];
    await expect(requestApproval("send the email", approveAll)).rejects.toThrow(
      MalformedGateRequestError,
    );
  });

  it("throws on an unknown mutation kind", async () => {
    delete process.env[FUSE];
    await expect(
      requestApproval({ ...validRequest, kind: "rm_rf" }, approveAll),
    ).rejects.toThrow(MalformedGateRequestError);
  });

  it("throws on a missing runId", async () => {
    delete process.env[FUSE];
    await expect(
      requestApproval({ ...validRequest, runId: "" }, approveAll),
    ).rejects.toThrow(MalformedGateRequestError);
  });
});

describe("requestApproval — L1 env fuse (redundant outer ring)", () => {
  it("throws BEFORE consulting the approver when the fuse is armed", async () => {
    process.env[FUSE] = "1";
    let approverConsulted = false;
    const spyApprover: Approver = {
      decide: async () => {
        approverConsulted = true;
        return true;
      },
    };
    await expect(requestApproval(validRequest, spyApprover)).rejects.toThrow(
      ExternalMutationsBlockedError,
    );
    expect(approverConsulted).toBe(false);
  });
});

describe("requestApproval — approver verdicts", () => {
  it("declines when the approver says no", async () => {
    delete process.env[FUSE];
    const verdict = await requestApproval(validRequest, denyAll);
    expect(verdict.decision).toBe("declined");
    expect(verdict.autoApprove).toBe(false);
  });

  it("treats an erroring approver as a decline (fail-closed)", async () => {
    delete process.env[FUSE];
    const verdict = await requestApproval(validRequest, erroringApprover);
    expect(verdict.decision).toBe("declined");
  });

  it("approves only on an explicit true, with autoApprove false", async () => {
    delete process.env[FUSE];
    const verdict = await requestApproval(validRequest, approveAll);
    expect(verdict).toEqual({ decision: "approved", autoApprove: false });
  });
});

describe("withGate — commit gating", () => {
  it("runs commit exactly once on approval", async () => {
    delete process.env[FUSE];
    let commits = 0;
    const result = await withGate(validRequest, approveAll, async () => {
      commits += 1;
      return "sent";
    });
    expect(result).toBe("sent");
    expect(commits).toBe(1);
  });

  it("NEVER runs commit on a decline (zero side effects)", async () => {
    delete process.env[FUSE];
    let commits = 0;
    const result = await withGate(validRequest, denyAll, async () => {
      commits += 1;
      return "sent";
    });
    expect(commits).toBe(0);
    expect(result).toMatchObject({ decision: "declined" });
  });

  it("NEVER runs commit when the fuse is armed", async () => {
    process.env[FUSE] = "1";
    let commits = 0;
    await expect(
      withGate(validRequest, approveAll, async () => {
        commits += 1;
        return "sent";
      }),
    ).rejects.toThrow(ExternalMutationsBlockedError);
    expect(commits).toBe(0);
  });
});
