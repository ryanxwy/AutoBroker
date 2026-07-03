/**
 * ApprovalInbox — aggregates every parked gate into one ranked queue keyed
 * (profileId, runId, decisionId), tagged by reason + the budget-free
 * BatchReviewCard summary. Driven through the fake-Mastra scripted-result harness.
 */

import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeGlueForTests, __resetNegotiationFollowupDepsForTests } from "@autobroker/workflows";

import { SkillRunService } from "../skillRuns.js";
import { RunPubSub } from "../runPubSub.js";
import { ApprovalInbox } from "./approvalInbox.js";
import { useFreshProductDb } from "../testProductDb.js";

// SkillRunService.start()/terminal teardown writes the activation registry
// (pipeline_state) on the product DB — give each case a fresh, migrated DB.
useFreshProductDb();

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

describe("ApprovalInbox.list — aggregate + rank + tag", () => {
  it("lists every parked gate keyed (profileId, runId, decisionId), with reason + summary, action-required first", async () => {
    // The fake Mastra is scripted per-service, so drive the read gate (link_scan) and
    // the send gate (lead_submit) on two services and merge via a composite lister —
    // the real server has ONE service; this only works around the scripted fake.
    const svc = new SkillRunService(fakeMastra([SUSPEND_LINK]), new RunPubSub());
    await svc.start({ skill: "inventory_link_scan", runId: "link-1", input: { search_profile_id: "B" } });

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

