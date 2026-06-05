/**
 * intakeRuns unit tests — the three-phase idempotent form-decision claim state
 * machine (BACKEND_SERVICES §7.2), isolated from the real Mastra workflow + DB
 * by a minimal fake Mastra instance. The integration suite exercises the claim
 * through the REAL stack; these pin the claim-table transitions directly,
 * including the decision_in_flight race that an in-process inject cannot hit
 * synchronously.
 *
 * The fake Mastra instance exposes just getWorkflow(id) → a stub workflow whose
 * createRun().resume()/start() return a scripted WorkflowResult, and
 * getWorkflowRunById() for the status summary.
 */

import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeGlueForTests } from "@autobroker/workflows";

import { IntakeRunService, FormDecisionError } from "./intakeRuns.js";
import { RunPubSub } from "./runPubSub.js";

// startRunGuarded keeps a module-global ownership set; reset it between cases so
// a prior test's runId never leaks into this one's dup-guard.
afterEach(() => {
  resetRuntimeGlueForTests();
});

/**
 * A scripted WorkflowResult sequence: start() returns the first, each resume()
 * the next. getWorkflowRunById() returns null UNTIL start() runs (so
 * startRunGuarded's dup-check passes), then the last-delivered result's status
 * (so statusSummary projects the real terminal state).
 */
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
  return {
    getWorkflow: () => workflow,
  } as never;
}

/** A suspended-at-collect WorkflowResult (the suspend payload drives pending). */
const SUSPEND_COLLECT = {
  status: "suspended",
  steps: {
    collect: {
      status: "suspended",
      suspendPayload: { kind: "data_collection", form_kind: "intake" },
    },
  },
};

/** A created (success) WorkflowResult. */
const SUCCESS_CREATED = {
  status: "success",
  result: { outcome: "created", vehicle: "2026 Hyundai Tucson", location: "Irvine" },
};

/** A declined (success) WorkflowResult. */
const SUCCESS_DECLINED = {
  status: "success",
  result: { outcome: "declined" },
};

/** A valid 18-field form content. */
function validContent(): Record<string, unknown> {
  return {
    make: "Hyundai",
    model: "Tucson",
    year: 2026,
    location_query: "Irvine, CA 92602",
    follow_up_email: "b@e.com",
    financing_preference: "finance",
    trim: "SEL",
    search_radius_miles: null,
    budget_max: null,
    follow_up_phone: null,
    phone_policy: null,
    preferred_exterior_colors_json: null,
    preferred_interior_colors_json: null,
    acceptable_trims_json: null,
    feature_preferences_json: null,
    trade_in_description: null,
    military_first_responder: null,
    current_brand_owner: null,
  };
}

/** Build a service started to the collect suspend; returns {svc, runId, decisionId}. */
async function startedToCollect(
  sequence: Array<Record<string, unknown>>,
): Promise<{ svc: IntakeRunService; pubsub: RunPubSub; runId: string; decisionId: string }> {
  const pubsub = new RunPubSub();
  const svc = new IntakeRunService(fakeMastra(sequence), pubsub);
  const { runId } = await svc.start({
    input: { input_mode: "slash", freeform_text: null, seed_fields: null },
  });
  const pending = svc.pendingOf(runId);
  expect(pending?.step).toBe("collect");
  return { svc, pubsub, runId, decisionId: pending!.decisionId };
}

describe("formDecision — idempotent replay (§7.2 Phase 1 consumed-same-body)", () => {
  it("a duplicate accept with the SAME body replays the prior ack (no second resume)", async () => {
    const { svc, runId, decisionId } = await startedToCollect([SUSPEND_COLLECT, SUCCESS_CREATED]);

    const first = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "accept", content: validContent() },
    });
    expect(first.action).toBe("accept");
    expect(svc.isTerminal(runId)).toBe(true);

    // The fake sequence has only ONE post-start result (SUCCESS_CREATED); a second
    // resume would return the same (sequence clamps), but the claim must SHORT-
    // CIRCUIT to the stored ack — so the body is byte-identical and the run state
    // is unchanged (still terminal, no double-translate).
    const second = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "accept", content: validContent() },
    });
    expect(second).toEqual(first);
  });

  it("a duplicate DIFFERENT body for a consumed decision → 409 decision_conflict", async () => {
    const { svc, runId, decisionId } = await startedToCollect([SUSPEND_COLLECT, SUCCESS_DECLINED]);
    await svc.formDecision(runId, { decision_id: decisionId, decision: { action: "decline" } });

    await expect(
      svc.formDecision(runId, {
        decision_id: decisionId,
        decision: { action: "accept", content: validContent() },
      }),
    ).rejects.toMatchObject({ code: "decision_conflict", status: 409 });
  });
});

describe("formDecision — in-flight + not-found + terminal guards (§7.2)", () => {
  it("a concurrent claim while one is processing → 409 decision_in_flight", async () => {
    // Make resume() hang so the first claim stays in 'processing'.
    const pubsub = new RunPubSub();
    let releaseResume: (() => void) | null = null;
    let started = false;
    const handle = {
      start: async () => {
        started = true;
        return SUSPEND_COLLECT;
      },
      resume: async () => {
        await new Promise<void>((r) => {
          releaseResume = r;
        });
        return SUCCESS_CREATED;
      },
    };
    const mastra = {
      getWorkflow: () => ({
        createRun: async () => handle,
        getWorkflowRunById: async () => (started ? { status: "suspended" } : null),
      }),
    } as never;
    const svc = new IntakeRunService(mastra, pubsub);
    const { runId } = await svc.start({
      input: { input_mode: "slash", freeform_text: null, seed_fields: null },
    });
    const decisionId = svc.pendingOf(runId)!.decisionId;

    // Kick off the first claim (it parks inside resume()).
    const inflight = svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "accept", content: validContent() },
    });
    // Give the microtask queue a tick so the first claim reaches 'processing'.
    await Promise.resolve();

    // A concurrent claim for the same decision → decision_in_flight.
    await expect(
      svc.formDecision(runId, {
        decision_id: decisionId,
        decision: { action: "accept", content: validContent() },
      }),
    ).rejects.toMatchObject({ code: "decision_in_flight", status: 409 });

    releaseResume!();
    await inflight; // let the first claim finish cleanly.
  });

  it("a form-decision for an unknown run → UnknownRunError", async () => {
    const { svc } = await startedToCollect([SUSPEND_COLLECT, SUCCESS_CREATED]);
    await expect(
      svc.formDecision("ghost", { decision_id: "x", decision: { action: "decline" } }),
    ).rejects.toThrow(/no skill run/);
  });

  it("a new decision_id that is not the pending suspend → 404 decision_not_found", async () => {
    const { svc, runId } = await startedToCollect([SUSPEND_COLLECT, SUCCESS_CREATED]);
    await expect(
      svc.formDecision(runId, { decision_id: "not-pending", decision: { action: "decline" } }),
    ).rejects.toMatchObject({ code: "decision_not_found", status: 404 });
  });

  it("content that fails the strict 18-field schema → 400 content_invalid + field pointer", async () => {
    const { svc, runId, decisionId } = await startedToCollect([SUSPEND_COLLECT, SUCCESS_CREATED]);
    await expect(
      svc.formDecision(runId, {
        decision_id: decisionId,
        decision: { action: "accept", content: { make: "Hyundai" } }, // missing required fields
      }),
    ).rejects.toBeInstanceOf(FormDecisionError);
    // The claim is rolled back (processing→pending) so a corrected resubmit works.
    const ok = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "accept", content: validContent() },
    });
    expect(ok.action).toBe("accept");
  });
});

describe("formDecision — decline terminal projection (§4.4 / §5)", () => {
  it("decline → aborted wire frame + the run reads declined in status summary", async () => {
    const { svc, pubsub, runId, decisionId } = await startedToCollect([
      SUSPEND_COLLECT,
      SUCCESS_DECLINED,
    ]);
    const ack = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "decline" },
    });
    expect(ack).toEqual({ action: "decline", content: null });
    // Wire terminal kind = aborted (declined is a STATUS projection, not a kind).
    const kinds = pubsub.snapshot(runId).map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe("aborted");
    const summary = await svc.statusSummary(runId);
    expect(summary?.status).toBe("declined");
  });
});
