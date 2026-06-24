/**
 * SagaCoordinator — the live bridge: it owns per-profile saga stacks, and on a run
 * ABORT (declined / error / canceled) it compensates that profile's stack LIFO,
 * routing any committed-send retraction tasks into the ApprovalInbox (never a silent
 * undo). A COMPLETED run drops the stack with no compensation.
 */

import { describe, it, expect } from "vitest";

import { SagaCoordinator } from "./sagaCoordinator.js";
import { ApprovalInbox } from "./approvalInbox.js";

function emptyInbox(): ApprovalInbox {
  return new ApprovalInbox({ listPendingGates: () => [], formDecision: async () => ({}) });
}

describe("SagaCoordinator", () => {
  it("on a declined run, compensates LIFO and routes a committed-send retraction into the inbox", async () => {
    const inbox = emptyInbox();
    const coord = new SagaCoordinator(inbox);
    const order: string[] = [];

    coord.stackFor("A").push({ key: "local", boundary: "local", undo: () => void order.push("local") });
    coord.stackFor("A").push({
      key: "sent",
      boundary: "send",
      retraction: {
        profileId: "A",
        runId: "run-A",
        kind: "retract_lead",
        reason: "pipeline_aborted_after_send",
        summary: { heading: "Retract?", lines: [{ label: "Vehicle", value: "2026 Honda Accord" }] },
      },
    });

    await coord.handleTerminal({ runId: "run-A", profileId: "A", skill: "quote_pipeline", terminalKind: "declined" });

    // local rolled back; the send NOT undone — it surfaced in the inbox.
    expect(order).toEqual(["local"]);
    const items = inbox.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "retraction", profileId: "A", reason: "retraction_required" });
  });

  it("on a completed run, drops the stack with no compensation", async () => {
    const inbox = emptyInbox();
    const coord = new SagaCoordinator(inbox);
    const order: string[] = [];
    coord.stackFor("A").push({ key: "local", boundary: "local", undo: () => void order.push("local") });

    await coord.handleTerminal({ runId: "run-A", profileId: "A", skill: "quote_pipeline", terminalKind: "completed" });

    expect(order).toEqual([]); // success never compensates
    // the stack was dropped: a later abort for A finds nothing.
    await coord.handleTerminal({ runId: "run-A2", profileId: "A", skill: "quote_pipeline", terminalKind: "error" });
    expect(order).toEqual([]);
  });

  it("a terminal for a profile with no saga stack is a no-op", async () => {
    const coord = new SagaCoordinator(emptyInbox());
    await expect(
      coord.handleTerminal({ runId: "run-X", profileId: "X", skill: "quote_pipeline", terminalKind: "declined" }),
    ).resolves.toBeUndefined();
  });
});
