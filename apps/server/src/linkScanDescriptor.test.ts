/**
 * inventory_link_scan descriptor — unit tests over the shared batch_review
 * resume seam. The card's approved ids carry SOURCE ids on this skill; the
 * resume must still validate them against the RETAINED suspend payload (the
 * exact rows the card showed) through the same generic dealer_id key, with
 * the suspended step named "reviewGate". cancel normalizes to a decline
 * resume; a decision on any other step is unsupported_action.
 */

import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeGlueForTests } from "@autobroker/workflows";

import {
  FormDecisionError,
  SkillRunService,
  inventoryLinkScanDescriptor,
} from "./skillRuns.js";
import { RunPubSub } from "./runPubSub.js";
import { useFreshProductDb } from "./testProductDb.js";

// SkillRunService.start()/terminal teardown writes the activation registry
// (pipeline_state) on the product DB — give each case a fresh, migrated DB.
useFreshProductDb();

afterEach(() => {
  resetRuntimeGlueForTests();
});

/** The batch_review suspend payload a 2-link review shows (source-id rows). */
const LINK_BATCH_PAYLOAD = {
  kind: "batch_review",
  question: "Open and scan these inventory links now?",
  targets: [
    { dealer_id: "src_aaaa", name: "Dealer A", website: "https://www.d-a.com/new-inventory/" },
    { dealer_id: "src_bbbb", name: "Dealer B", website: "https://www.d-b.com/new-inventory/" },
  ],
  skipped: [{ dealer_id: "src_cccc", name: "Dealer C", reason: "bare_homepage" }],
  total_targets: 2,
  total_in_radius: 3,
};

const SUSPEND_REVIEW = {
  status: "suspended",
  steps: { reviewGate: { status: "suspended", suspendPayload: LINK_BATCH_PAYLOAD } },
};

const SUCCESS_SCANNED = {
  status: "success",
  result: { outcome: "scanned", resolution: "pinned", summary: "Scanned 2 of 2 approved link(s)." },
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

async function startedToReviewGate(sequence: Array<Record<string, unknown>>) {
  const { mastra, resumes } = fakeMastra(sequence);
  const pubsub = new RunPubSub();
  const svc = new SkillRunService(mastra, pubsub);
  const { runId } = await svc.start({
    skill: "inventory_link_scan",
    input: { search_profile_id: null },
  });
  const pending = svc.pendingOf(runId);
  expect(pending?.step).toBe("reviewGate");
  return { svc, pubsub, runId, decisionId: pending!.decisionId, resumes };
}

describe("inventory_link_scan descriptor — buildInput", () => {
  it("accepts the bare body and the explicit profile pin", () => {
    expect(inventoryLinkScanDescriptor.buildInput({})).toEqual({ search_profile_id: null });
    expect(
      inventoryLinkScanDescriptor.buildInput({
        skill: "inventory_link_scan",
        search_profile_id: "prof-1",
      }),
    ).toEqual({ search_profile_id: "prof-1" });
  });

  it("rejects a non-string search_profile_id as content_invalid", () => {
    expect(() => inventoryLinkScanDescriptor.buildInput({ search_profile_id: 42 })).toThrowError(
      FormDecisionError,
    );
  });
});

describe("inventory_link_scan — batch_review form-decision through the seam", () => {
  it("the awaiting_user frame carries form_kind batch_review + the spec_inline payload", async () => {
    const { pubsub, runId } = await startedToReviewGate([SUSPEND_REVIEW, SUCCESS_SCANNED]);
    const frames = pubsub.snapshot(runId) as Array<{ kind: string; payload: Record<string, unknown> }>;
    const awaiting = frames.find((f) => f.kind === "awaiting_user");
    expect(awaiting?.payload["form_kind"]).toBe("batch_review");
    expect(awaiting?.payload["spec_inline"]).toEqual(LINK_BATCH_PAYLOAD);
  });

  it("approved SOURCE ids outside the reviewed rows → 400 content_invalid; the suspend stays answerable", async () => {
    const { svc, runId, decisionId, resumes } = await startedToReviewGate([
      SUSPEND_REVIEW,
      SUCCESS_SCANNED,
    ]);

    await expect(
      svc.formDecision(runId, {
        decision_id: decisionId,
        decision: { action: "accept", content: { approved_dealer_ids: ["src_aaaa", "src_zzzz"] } },
      }),
    ).rejects.toMatchObject({ code: "content_invalid", status: 400 });
    expect(resumes).toHaveLength(0);
    expect(svc.pendingOf(runId)?.decisionId).toBe(decisionId); // still pending

    const ack = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "accept", content: { approved_dealer_ids: ["src_aaaa"] } },
    });
    expect(ack).toEqual({ action: "accept", content: { approved_dealer_ids: ["src_aaaa"] } });
    expect(resumes).toEqual([{ action: "approve", approved_dealer_ids: ["src_aaaa"] }]);
  });

  it("cancel normalizes to a decline resume (terminal, zero-write semantics live in the workflow)", async () => {
    const declined = { status: "success", result: { outcome: "declined" } };
    const { svc, runId, decisionId, resumes } = await startedToReviewGate([
      SUSPEND_REVIEW,
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
      inventoryLinkScanDescriptor.resume!(
        "batchReview", // the SIBLING skill's step name — not this descriptor's
        { action: "accept", content: {} },
        LINK_BATCH_PAYLOAD as unknown as Record<string, unknown>,
      ),
    ).toThrowError(FormDecisionError);
  });
});
