/**
 * skillRuns portfolio additions — the cross-run gate lister (listPendingGates),
 * the run-lifecycle listener (onRunSuspended / onRunTerminal), and the terminal
 * hook's carry-map GC. Driven through the same fake-Mastra scripted-result harness
 * as skillRuns.test.ts (no DB, no real workflow).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  resetRuntimeGlueForTests,
  requestContactFlipForRun,
  __negotiationFollowupCarrySizesForTests,
  __resetNegotiationFollowupDepsForTests,
} from "@autobroker/workflows";

import {
  SkillRunService,
  type RunLifecycleEvent,
  type RunTerminalEvent,
} from "./skillRuns.js";
import { RunPubSub } from "./runPubSub.js";

afterEach(() => {
  resetRuntimeGlueForTests();
  __resetNegotiationFollowupDepsForTests();
});

/** Scripted WorkflowResult sequence — start() returns the first, each resume() the next. */
function fakeMastra(sequence: Array<Record<string, unknown>>) {
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
    resume: async () => next(),
  };
  const workflow = {
    createRun: async () => handle,
    getWorkflowRunById: async () => (started ? { status: last["status"] } : null),
  };
  return { getWorkflow: () => workflow } as never;
}

const SUSPEND_COLLECT = {
  status: "suspended",
  steps: {
    collect: { status: "suspended", suspendPayload: { kind: "data_collection", form_kind: "intake" } },
  },
};
const SUCCESS_DECLINED = { status: "success", result: { outcome: "declined" } };

/** svc.start takes an already-built input verbatim, so a search_profile_id field is
 *  honored for any skill (buildInput is not re-run here). */
function intakeInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { input_mode: "slash", freeform_text: null, seed_fields: null, ...extra };
}

describe("SkillRunService.listPendingGates — cross-run gate lister", () => {
  it("lists every parked gate keyed by (profileId, runId, decisionId) with step + payload", async () => {
    const svc = new SkillRunService(fakeMastra([SUSPEND_COLLECT]), new RunPubSub());
    const { runId } = await svc.start({
      skill: "search_profile_intake",
      runId: "u5-list-1",
      input: intakeInput({ search_profile_id: "profile-A" }),
    });
    const decisionId = svc.pendingOf(runId)!.decisionId;

    const gates = svc.listPendingGates();
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      runId: "u5-list-1",
      profileId: "profile-A",
      skill: "search_profile_intake",
      step: "collect",
      decisionId,
    });
    expect(gates[0]!.payload["kind"]).toBe("data_collection");
  });

  it("omits runs with no pending gate (running/terminal)", async () => {
    const svc = new SkillRunService(fakeMastra([SUCCESS_DECLINED]), new RunPubSub());
    await svc.start({ skill: "search_profile_intake", input: intakeInput() });
    expect(svc.listPendingGates()).toHaveLength(0);
  });
});

describe("SkillRunService run-lifecycle listeners", () => {
  it("fires onRunSuspended at the gate and onRunTerminal(declined) on decline, carrying profileId", async () => {
    const suspended: RunLifecycleEvent[] = [];
    const terminal: RunTerminalEvent[] = [];
    const svc = new SkillRunService(fakeMastra([SUSPEND_COLLECT, SUCCESS_DECLINED]), new RunPubSub());
    svc.addLifecycleListener({
      onRunSuspended: (e) => suspended.push(e),
      onRunTerminal: (e) => terminal.push(e),
    });

    const { runId } = await svc.start({
      skill: "search_profile_intake",
      runId: "u5-life-1",
      input: intakeInput({ search_profile_id: "profile-A" }),
    });
    expect(suspended).toEqual([{ runId: "u5-life-1", profileId: "profile-A", skill: "search_profile_intake" }]);

    const decisionId = svc.pendingOf(runId)!.decisionId;
    await svc.formDecision(runId, { decision_id: decisionId, decision: { action: "decline" } });

    expect(terminal).toEqual([
      { runId: "u5-life-1", profileId: "profile-A", skill: "search_profile_intake", terminalKind: "declined" },
    ]);
  });

  it("GCs the negotiation contact-flip carry for the run when it goes terminal", async () => {
    const svc = new SkillRunService(fakeMastra([SUSPEND_COLLECT, SUCCESS_DECLINED]), new RunPubSub());
    const { runId } = await svc.start({
      skill: "search_profile_intake",
      runId: "u5-gc-1",
      input: intakeInput({ search_profile_id: "profile-A" }),
    });
    // Simulate a leaked carry entry for this run.
    requestContactFlipForRun(runId, { threadId: "t1", dealerId: "d1", contactId: "c1" });
    expect(__negotiationFollowupCarrySizesForTests().flips).toBe(1);

    const decisionId = svc.pendingOf(runId)!.decisionId;
    await svc.formDecision(runId, { decision_id: decisionId, decision: { action: "decline" } });

    // The terminal hook cleared the carry for this run.
    expect(__negotiationFollowupCarrySizesForTests().flips).toBe(0);
  });
});
