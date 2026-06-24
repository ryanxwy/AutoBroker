/**
 * dealer_inbox_check descriptor — unit tests over the batch_review resume seam.
 *
 * The suspended step is "batchReview"; the resume reuses the shared
 * batch_review vocabulary (approve an explicit dealer-id list ⊆ the RETAINED
 * suspend payload's shown targets, or decline = terminal/zero writes). ids
 * outside the reviewed set are a 400 content_invalid whose claim rolls back,
 * leaving the suspend answerable. REJECT is deferred — the accept content is the
 * plain {approved_dealer_ids} shape (no rejected_thread_ids member). A decision
 * on any other suspended step → 400 unsupported_action.
 */

import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeGlueForTests } from "@autobroker/workflows";

import {
  FormDecisionError,
  SkillRunService,
  dealerInboxCheckDescriptor,
} from "./skillRuns.js";
import { RunPubSub } from "./runPubSub.js";
import { useFreshProductDb } from "./testProductDb.js";

// SkillRunService.start()/terminal teardown writes the activation registry
// (pipeline_state) on the product DB — give each case a fresh, migrated DB.
useFreshProductDb();

afterEach(() => {
  resetRuntimeGlueForTests();
});

/** The batch_review suspend payload a 2-dealer review shows (the inbox card). */
const INBOX_PAYLOAD = {
  kind: "batch_review",
  question: "Save these dealer replies to your search?",
  targets: [
    {
      dealer_id: "d-a",
      name: "Dealer A",
      thread_ids: ["t-1"],
      classification: "replied",
      snippet: "Thanks for reaching out…",
    },
    {
      dealer_id: "d-b",
      name: "Dealer B",
      thread_ids: ["t-2"],
      classification: "quoted",
      snippet: "Here is your out-the-door price…",
    },
  ],
  unrouted: [],
  total_targets: 2,
};

const SUSPEND_BATCH = {
  status: "suspended",
  steps: { batchReview: { status: "suspended", suspendPayload: INBOX_PAYLOAD } },
};

const SUCCESS_CHECKED = {
  status: "success",
  result: { outcome: "checked", resolution: "pinned", summary: "Found 2 new replies." },
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
    skill: "dealer_inbox_check",
    input: { search_profile_id: "prof-1" },
  });
  const pending = svc.pendingOf(runId);
  expect(pending?.step).toBe("batchReview");
  return { svc, pubsub, runId, decisionId: pending!.decisionId, resumes };
}

describe("dealer_inbox_check descriptor — buildInput", () => {
  it("accepts the bare body and the explicit profile pin", () => {
    expect(dealerInboxCheckDescriptor.buildInput({})).toEqual({ search_profile_id: null });
    expect(
      dealerInboxCheckDescriptor.buildInput({
        skill: "dealer_inbox_check",
        search_profile_id: "prof-1",
      }),
    ).toEqual({ search_profile_id: "prof-1" });
  });

  it("rejects a non-string search_profile_id as content_invalid", () => {
    expect(() => dealerInboxCheckDescriptor.buildInput({ search_profile_id: 42 })).toThrowError(
      FormDecisionError,
    );
  });
});

describe("dealer_inbox_check — batch_review form-decision through the seam", () => {
  it("the awaiting_user frame carries form_kind batch_review + the spec_inline payload", async () => {
    const { pubsub, runId } = await startedToBatchReview([SUSPEND_BATCH, SUCCESS_CHECKED]);
    const frames = pubsub.snapshot(runId) as Array<{
      kind: string;
      payload: Record<string, unknown>;
    }>;
    const awaiting = frames.find((f) => f.kind === "awaiting_user");
    expect(awaiting?.payload["form_kind"]).toBe("batch_review");
    expect(awaiting?.payload["spec_inline"]).toEqual(INBOX_PAYLOAD);
  });

  it("decline maps to the whole-run decline resume (zero writes live in the workflow)", async () => {
    const declined = { status: "success", result: { outcome: "declined" } };
    const { svc, runId, decisionId, resumes } = await startedToBatchReview([
      SUSPEND_BATCH,
      declined,
    ]);
    const ack = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "decline" },
    });
    expect(ack).toEqual({ action: "decline", content: null });
    expect(resumes).toEqual([{ action: "decline" }]);
  });

  it("approved ids outside the reviewed targets → 400 content_invalid; the suspend stays answerable", async () => {
    const { svc, runId, decisionId, resumes } = await startedToBatchReview([
      SUSPEND_BATCH,
      SUCCESS_CHECKED,
    ]);

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

  it("a decision on an unexpected suspended step → 400 unsupported_action", () => {
    expect(() =>
      dealerInboxCheckDescriptor.resume!(
        "syncDiscover", // not this descriptor's suspended step
        { action: "accept", content: { approved_dealer_ids: ["d-a"] } },
        INBOX_PAYLOAD as unknown as Record<string, unknown>,
      ),
    ).toThrowError(FormDecisionError);
  });
});
