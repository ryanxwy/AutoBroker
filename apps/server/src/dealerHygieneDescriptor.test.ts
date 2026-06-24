/**
 * dealer_hygiene descriptor — unit tests over the per-stage resume seam.
 *
 * ONE resume vocabulary reused across THREE strictly-ordered suspended steps
 * (suspend5a orphans → suspend5b CRM threads → suspend5c CRM contacts): approve
 * an explicit id list (min 1) ⊆ the RETAINED stage payload's shown ids, or
 * decline = terminal/zero writes for the WHOLE run. An id outside the reviewed
 * set → 400 content_invalid (claim rolls back, suspend stays answerable); a
 * decision on any other suspended step → 400 unsupported_action. There is NO
 * approve-all wire member.
 */

import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeGlueForTests } from "@autobroker/workflows";

import {
  FormDecisionError,
  SkillRunService,
  dealerHygieneDescriptor,
} from "./skillRuns.js";
import { RunPubSub } from "./runPubSub.js";
import { useFreshProductDb } from "./testProductDb.js";

// SkillRunService.start()/terminal teardown writes the activation registry
// (pipeline_state) on the product DB — give each case a fresh, migrated DB.
useFreshProductDb();

afterEach(() => {
  resetRuntimeGlueForTests();
});

/** A stage suspend payload (the spec_inline a stage's batch_review card shows).
 *  The targets carry a generic `id` (thread_id for 5a/5b, contact_id for 5c). */
function stagePayload(
  stage: "orphans" | "crm_threads" | "crm_contacts",
  ids: string[],
): Record<string, unknown> {
  return {
    kind: "batch_review",
    stage,
    question: `Review the ${stage} cleanup items.`,
    targets: ids.map((id) => ({ id, name: `Name ${id}`, reason: "candidate" })),
    total: ids.length,
  };
}

/** A stage suspend, keyed by the suspended step id. */
function suspendAt(step: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { status: "suspended", steps: { [step]: { status: "suspended", suspendPayload: payload } } };
}

const SUCCESS_CLEANED = {
  status: "success",
  result: { outcome: "cleaned", resolution: "pinned", summary: "Cleaned up 1 orphan record." },
};

/** A scripted fake Mastra that also RECORDS every resume() resumeData. */
function fakeMastra(sequence: Array<Record<string, unknown>>) {
  let i = 0;
  let started = false;
  let last: Record<string, unknown> = sequence[0]!;
  const resumes: unknown[] = [];
  const next = () => {
    last = sequence[Math.min(i++, sequence.length - 1)]!;
    return last;
  };
  const handle = {
    start: async () => {
      started = true;
      return next();
    },
    resume: async (args: { resumeData: unknown }) => {
      resumes.push(args.resumeData);
      return next();
    },
  };
  const workflow = {
    createRun: async () => handle,
    getWorkflowRunById: async () => (started ? { status: last["status"] } : null),
  };
  return {
    mastra: { getWorkflow: () => workflow } as never,
    resumes,
  };
}

async function startedToStage(step: string, sequence: Array<Record<string, unknown>>) {
  const { mastra, resumes } = fakeMastra(sequence);
  const pubsub = new RunPubSub();
  const svc = new SkillRunService(mastra, pubsub);
  const { runId } = await svc.start({
    skill: "dealer_hygiene",
    input: { search_profile_id: "prof-1" },
  });
  const pending = svc.pendingOf(runId);
  expect(pending?.step).toBe(step);
  return { svc, pubsub, runId, decisionId: pending!.decisionId, resumes };
}

describe("dealer_hygiene descriptor — buildInput", () => {
  it("accepts the bare body and the explicit profile pin", () => {
    expect(dealerHygieneDescriptor.buildInput({})).toEqual({ search_profile_id: null });
    expect(
      dealerHygieneDescriptor.buildInput({
        skill: "dealer_hygiene",
        search_profile_id: "prof-1",
      }),
    ).toEqual({ search_profile_id: "prof-1" });
  });

  it("rejects a non-string search_profile_id as content_invalid", () => {
    expect(() => dealerHygieneDescriptor.buildInput({ search_profile_id: 42 })).toThrowError(
      FormDecisionError,
    );
  });
});

describe("dealer_hygiene — per-stage resume (the three suspended step ids)", () => {
  for (const [step, stage] of [
    ["suspend5a", "orphans"],
    ["suspend5b", "crm_threads"],
    ["suspend5c", "crm_contacts"],
  ] as const) {
    it(`${step} (${stage}): approve a shown subset shapes the {approved_ids} resume`, async () => {
      const payload = stagePayload(stage, ["x-1", "x-2"]);
      const { svc, runId, decisionId, resumes } = await startedToStage(step, [
        suspendAt(step, payload),
        SUCCESS_CLEANED,
      ]);
      const ack = await svc.formDecision(runId, {
        decision_id: decisionId,
        decision: { action: "accept", content: { approved_ids: ["x-1"] } },
      });
      expect(ack).toEqual({ action: "accept", content: { approved_ids: ["x-1"] } });
      expect(resumes).toEqual([{ action: "approve", approved_ids: ["x-1"] }]);
    });

    it(`${step} (${stage}): decline maps to the whole-run decline resume`, async () => {
      const declined = { status: "success", result: { outcome: "declined" } };
      const { svc, runId, decisionId, resumes } = await startedToStage(step, [
        suspendAt(step, stagePayload(stage, ["x-1"])),
        declined,
      ]);
      const ack = await svc.formDecision(runId, {
        decision_id: decisionId,
        decision: { action: "decline" },
      });
      expect(ack).toEqual({ action: "decline", content: null });
      expect(resumes).toEqual([{ action: "decline" }]);
    });

    it(`${step} (${stage}): an approved id NOT in the shown payload → 400 content_invalid`, async () => {
      const { svc, runId, decisionId, resumes } = await startedToStage(step, [
        suspendAt(step, stagePayload(stage, ["x-1"])),
        SUCCESS_CLEANED,
      ]);
      await expect(
        svc.formDecision(runId, {
          decision_id: decisionId,
          decision: { action: "accept", content: { approved_ids: ["x-1", "x-9"] } },
        }),
      ).rejects.toMatchObject({ code: "content_invalid", status: 400 });
      expect(resumes).toHaveLength(0);
      expect(svc.pendingOf(runId)?.decisionId).toBe(decisionId); // still answerable
    });
  }

  it("an empty approved list → 400 content_invalid (min 1)", async () => {
    const { svc, runId, decisionId } = await startedToStage("suspend5a", [
      suspendAt("suspend5a", stagePayload("orphans", ["x-1"])),
      SUCCESS_CLEANED,
    ]);
    await expect(
      svc.formDecision(runId, {
        decision_id: decisionId,
        decision: { action: "accept", content: { approved_ids: [] } },
      }),
    ).rejects.toMatchObject({ code: "content_invalid", status: 400 });
  });

  it("cancel normalizes to a decline resume", () => {
    expect(
      dealerHygieneDescriptor.resume!(
        "suspend5b",
        { action: "cancel" },
        stagePayload("crm_threads", ["x-1"]),
      ).resumeData,
    ).toEqual({ action: "decline" });
  });

  it("a decision on an unknown suspended step → 400 unsupported_action", () => {
    expect(() =>
      dealerHygieneDescriptor.resume!(
        "detect", // not one of the three suspend steps
        { action: "accept", content: { approved_ids: ["x-1"] } },
        stagePayload("orphans", ["x-1"]),
      ),
    ).toThrowError(FormDecisionError);
  });
});
