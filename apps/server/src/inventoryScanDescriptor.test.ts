/**
 * inventory_site_scan descriptor + the pending-payload seam — unit tests.
 *
 * The batch_review resume must validate the approved id list against the
 * RETAINED suspend payload (the exact targets the card showed): ids outside
 * that set are a 400 content_invalid whose claim rolls back, leaving the
 * suspend answerable (retryable). cancel normalizes to a decline resume.
 * The seam itself (RunState.pending retaining {step, decisionId, payload} and
 * RunDescriptor.resume's third argument) is exercised through the service with
 * a fake Mastra instance that records what resume() was actually handed —
 * intake's descriptor ignores the new argument, so its own tests stay green
 * unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeGlueForTests } from "@autobroker/workflows";

import {
  FormDecisionError,
  SkillRunService,
  inventorySiteScanDescriptor,
} from "./skillRuns.js";
import { RunPubSub } from "./runPubSub.js";

afterEach(() => {
  resetRuntimeGlueForTests();
});

/** The batch_review suspend payload a 2-target review shows. */
const BATCH_PAYLOAD = {
  kind: "batch_review",
  question: "Scan these dealers' inventory now?",
  targets: [
    { dealer_id: "d-a", name: "Dealer A", website: "https://www.d-a.com" },
    { dealer_id: "d-b", name: "Dealer B", website: "https://www.d-b.com" },
  ],
  skipped: [{ dealer_id: "d-c", name: "Dealer C", reason: "no_website" }],
  total_targets: 2,
  total_in_radius: 2,
};

const SUSPEND_BATCH = {
  status: "suspended",
  steps: { batchReview: { status: "suspended", suspendPayload: BATCH_PAYLOAD } },
};

const SUCCESS_SCANNED = {
  status: "success",
  result: { outcome: "scanned", resolution: "pinned", summary: "Scanned 2 of 2." },
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

async function startedToBatchReview(sequence: Array<Record<string, unknown>>) {
  const { mastra, resumes } = fakeMastra(sequence);
  const pubsub = new RunPubSub();
  const svc = new SkillRunService(mastra, pubsub);
  const { runId } = await svc.start({
    skill: "inventory_site_scan",
    input: { search_profile_id: "prof-1", dealer_ids: null, approved_by: null, max_targets: null },
  });
  const pending = svc.pendingOf(runId);
  expect(pending?.step).toBe("batchReview");
  return { svc, pubsub, runId, decisionId: pending!.decisionId, resumes };
}

describe("inventory_site_scan descriptor — buildInput", () => {
  it("parses the csv dealer_ids and defaults the optional fields", () => {
    expect(
      inventorySiteScanDescriptor.buildInput({
        skill: "inventory_site_scan",
        dealer_ids: " d-a, d-b ,,",
      }),
    ).toEqual({
      search_profile_id: null,
      dealer_ids: ["d-a", "d-b"],
      approved_by: null,
      max_targets: null,
    });
    expect(inventorySiteScanDescriptor.buildInput({})).toEqual({
      search_profile_id: null,
      dealer_ids: null,
      approved_by: null,
      max_targets: null,
    });
  });

  it("rejects a non-positive max_targets as content_invalid", () => {
    expect(() => inventorySiteScanDescriptor.buildInput({ max_targets: 0 })).toThrowError(
      FormDecisionError,
    );
  });
});

describe("inventory_site_scan — batch_review form-decision through the seam", () => {
  it("the awaiting_user frame carries form_kind batch_review + the spec_inline payload", async () => {
    const { pubsub, runId } = await startedToBatchReview([SUSPEND_BATCH, SUCCESS_SCANNED]);
    const frames = pubsub.snapshot(runId) as Array<{ kind: string; payload: Record<string, unknown> }>;
    const awaiting = frames.find((f) => f.kind === "awaiting_user");
    expect(awaiting?.payload["form_kind"]).toBe("batch_review");
    expect(awaiting?.payload["spec_inline"]).toEqual(BATCH_PAYLOAD);
  });

  it("approved ids outside the reviewed targets → 400 content_invalid; the suspend stays answerable", async () => {
    const { svc, runId, decisionId, resumes } = await startedToBatchReview([
      SUSPEND_BATCH,
      SUCCESS_SCANNED,
    ]);

    // ids ⊄ targets → 400, claim rolled back, NO Mastra resume fired.
    await expect(
      svc.formDecision(runId, {
        decision_id: decisionId,
        decision: { action: "accept", content: { approved_dealer_ids: ["d-a", "d-x"] } },
      }),
    ).rejects.toMatchObject({ code: "content_invalid", status: 400 });
    expect(resumes).toHaveLength(0);
    expect(svc.pendingOf(runId)?.decisionId).toBe(decisionId); // still pending

    // the SAME decisionId then succeeds with a valid subset (retryable).
    const ack = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "accept", content: { approved_dealer_ids: ["d-a"] } },
    });
    expect(ack).toEqual({ action: "accept", content: { approved_dealer_ids: ["d-a"] } });
    expect(resumes).toEqual([{ action: "approve", approved_dealer_ids: ["d-a"] }]);
  });

  it("an empty approved list → 400 content_invalid (min 1)", async () => {
    const { svc, runId, decisionId } = await startedToBatchReview([
      SUSPEND_BATCH,
      SUCCESS_SCANNED,
    ]);
    await expect(
      svc.formDecision(runId, {
        decision_id: decisionId,
        decision: { action: "accept", content: { approved_dealer_ids: [] } },
      }),
    ).rejects.toMatchObject({ code: "content_invalid", status: 400 });
  });

  it("cancel normalizes to a decline resume (terminal, zero-write semantics live in the workflow)", async () => {
    const declined = { status: "success", result: { outcome: "declined" } };
    const { svc, runId, decisionId, resumes } = await startedToBatchReview([
      SUSPEND_BATCH,
      declined,
    ]);
    const ack = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "cancel" },
    });
    expect(ack).toEqual({ action: "cancel", content: null });
    expect(resumes).toEqual([{ action: "decline" }]);
  });

  it("a decision on an unexpected suspended step → 400 unsupported_action", () => {
    expect(() =>
      inventorySiteScanDescriptor.resume!(
        "collect",
        { action: "accept", content: {} },
        BATCH_PAYLOAD as unknown as Record<string, unknown>,
      ),
    ).toThrowError(FormDecisionError);
  });
});
