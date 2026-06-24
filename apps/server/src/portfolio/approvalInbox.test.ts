/**
 * ApprovalInbox — aggregates every parked gate (+ saga retraction tasks) into one
 * ranked queue keyed (profileId, runId, decisionId), tagged by reason + the budget-
 * free BatchReviewCard summary, and routes a single decision through the existing
 * idempotent formDecision. Driven through the fake-Mastra scripted-result harness.
 */

import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeGlueForTests, __resetNegotiationFollowupDepsForTests } from "@autobroker/workflows";

import { SkillRunService } from "../skillRuns.js";
import { RunPubSub } from "../runPubSub.js";
import { ApprovalInbox } from "./approvalInbox.js";

afterEach(() => {
  resetRuntimeGlueForTests();
  __resetNegotiationFollowupDepsForTests();
});

function fakeMastra(sequence: Array<Record<string, unknown>>, counters?: { resume: number }) {
  let i = 0;
  let started = false;
  let last: Record<string, unknown> = sequence[0]!;
  const next = () => {
    last = sequence[Math.min(i++, sequence.length - 1)]!;
    return last;
  };
  const handle = {
    start: async () => {
      started = true;
      return next();
    },
    resume: async () => {
      if (counters) counters.resume += 1;
      return next();
    },
  };
  const workflow = {
    createRun: async () => handle,
    getWorkflowRunById: async () => (started ? { status: last["status"] } : null),
  };
  return { getWorkflow: () => workflow } as never;
}

const SUSPEND_LEAD = {
  status: "suspended",
  steps: {
    batchReview: {
      status: "suspended",
      suspendPayload: {
        kind: "batch_review",
        question: "Submit?",
        targets: [],
        summary: {
          heading: "Each approved dealer gets one brief inquiry containing only:",
          lines: [
            { label: "Vehicle", value: "2026 Honda Accord" },
            { label: "Your email", value: "b@e.com" },
            { label: "Phone", value: "a placeholder number — your real number is never shared" },
          ],
        },
      },
    },
  },
};
const SUSPEND_LINK = {
  status: "suspended",
  steps: { reviewGate: { status: "suspended", suspendPayload: { kind: "batch_review", targets: [] } } },
};
const SUSPEND_COLLECT = {
  status: "suspended",
  steps: { collect: { status: "suspended", suspendPayload: { kind: "data_collection" } } },
};
const SUCCESS_DECLINED = { status: "success", result: { outcome: "declined" } };

describe("ApprovalInbox.list — aggregate + rank + tag", () => {
  it("lists every parked gate keyed (profileId, runId, decisionId), with reason + summary, action-required first", async () => {
    const svc = new SkillRunService(fakeMastra([SUSPEND_LINK]), new RunPubSub());
    // start a read gate (link_scan) first, then an irreversible send gate (lead_submit).
    await svc.start({ skill: "inventory_link_scan", runId: "link-1", input: { search_profile_id: "B" } });
    const leadSvc = svc; // same service, second run on a different fake is not needed — use one service with two runs
    // a second run on the SAME service needs its own scripted suspend; re-create the service-bound mastra per run is
    // not possible, so drive the lead run on a second service and merge via a composite lister.
    void leadSvc;

    const leadService = new SkillRunService(fakeMastra([SUSPEND_LEAD]), new RunPubSub());
    await leadService.start({ skill: "dealer_web_lead_submit", runId: "lead-1", input: { search_profile_id: "A" } });

    // Composite lister over both services (the real server has one service; the test
    // uses two only because the fake mastra is scripted per-service).
    const inbox = new ApprovalInbox({
      listPendingGates: () => [...svc.listPendingGates(), ...leadService.listPendingGates()],
      formDecision: (runId, body) =>
        svc.has(runId) ? svc.formDecision(runId, body) : leadService.formDecision(runId, body),
    });

    const items = inbox.list();
    expect(items).toHaveLength(2);

    // action-required (the send) ranks above the read gate.
    expect(items[0]).toMatchObject({
      kind: "gate",
      profileId: "A",
      runId: "lead-1",
      skill: "dealer_web_lead_submit",
      reason: "lead_submit",
      actionRequired: true,
    });
    expect(items[0]!.decisionId).toBeTruthy();
    expect(items[0]!.summary?.lines.map((l) => l.label)).toEqual(["Vehicle", "Your email", "Phone"]);

    expect(items[1]).toMatchObject({
      profileId: "B",
      runId: "link-1",
      reason: "link_scan",
      actionRequired: false,
    });
  });

  it("never surfaces budget in any item summary (#9)", async () => {
    const leadService = new SkillRunService(fakeMastra([SUSPEND_LEAD]), new RunPubSub());
    await leadService.start({ skill: "dealer_web_lead_submit", runId: "lead-2", input: { search_profile_id: "A" } });
    const inbox = new ApprovalInbox(leadService);
    for (const item of inbox.list()) {
      const blob = JSON.stringify(item.summary ?? {}).toLowerCase();
      expect(blob).not.toContain("budget");
      expect(blob).not.toContain("$");
    }
  });
});

describe("ApprovalInbox.route — idempotent single-decision routing", () => {
  it("delegates to formDecision and a double-tap of the same decision does NOT double-fire", async () => {
    const counters = { resume: 0 };
    const svc = new SkillRunService(fakeMastra([SUSPEND_COLLECT, SUCCESS_DECLINED], counters), new RunPubSub());
    await svc.start({ skill: "search_profile_intake", runId: "route-1", input: { search_profile_id: "A" } });
    const inbox = new ApprovalInbox(svc);

    const decisionId = svc.pendingOf("route-1")!.decisionId;
    const ack1 = await inbox.route({ runId: "route-1", decisionId, action: "decline" });
    const ack2 = await inbox.route({ runId: "route-1", decisionId, action: "decline" });

    expect(ack2).toEqual(ack1); // idempotent replay of the stored ack
    expect(counters.resume).toBe(1); // the underlying Mastra resume fired exactly once
  });
});

describe("ApprovalInbox retraction tasks", () => {
  it("surfaces an enqueued retraction as an action-required item with no live decisionId", () => {
    const empty = new ApprovalInbox({ listPendingGates: () => [], formDecision: async () => ({}) });
    empty.enqueueRetraction({
      profileId: "A",
      runId: "aborted-run-1",
      kind: "retract_lead",
      reason: "pipeline_aborted_after_send",
      summary: { heading: "Retract the inquiry you sent?", lines: [{ label: "Vehicle", value: "2026 Honda Accord" }] },
    });
    const items = empty.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "retraction",
      profileId: "A",
      runId: "aborted-run-1",
      reason: "retraction_required",
      actionRequired: true,
      decisionId: null,
    });
  });
});
