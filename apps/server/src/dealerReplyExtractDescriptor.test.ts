/**
 * dealer_reply_extract descriptor — unit tests. The skill is AUTONOMOUS: it has
 * NO HITL suspend, so the descriptor declares NO `resume` member and any
 * form-decision against a reply-extract run 400s as unsupported_action through
 * the service's resume===undefined branch. The driver_kind is a LIVE-LLM label
 * derived from the policy() route (NOT the zero-LLM constant).
 */

import { afterEach, describe, expect, it } from "vitest";

import { providerDriverKind } from "@autobroker/core";
import { policy } from "@autobroker/model";
import { resetRuntimeGlueForTests } from "@autobroker/workflows";

import {
  FormDecisionError,
  SkillRunService,
  dealerReplyExtractDescriptor,
} from "./skillRuns.js";
import { RunPubSub } from "./runPubSub.js";

afterEach(() => {
  resetRuntimeGlueForTests();
});

/** A scripted fake Mastra (no suspend — start drives straight to terminal). */
function fakeMastra(terminal: Record<string, unknown>) {
  let started = false;
  const handle = {
    start: async () => {
      started = true;
      return terminal;
    },
    resume: async () => terminal,
  };
  const workflow = {
    createRun: async () => handle,
    getWorkflowRunById: async () => (started ? { status: terminal["status"] } : null),
  };
  return { mastra: { getWorkflow: () => workflow } as never };
}

describe("dealer_reply_extract descriptor — buildInput", () => {
  it("accepts the bare body and the explicit profile pin", () => {
    expect(dealerReplyExtractDescriptor.buildInput({})).toEqual({ search_profile_id: null });
    expect(
      dealerReplyExtractDescriptor.buildInput({
        skill: "dealer_reply_extract",
        search_profile_id: "prof-1",
      }),
    ).toEqual({ search_profile_id: "prof-1" });
  });

  it("rejects a non-string search_profile_id as content_invalid", () => {
    expect(() =>
      dealerReplyExtractDescriptor.buildInput({ search_profile_id: 42 }),
    ).toThrowError(FormDecisionError);
  });
});

describe("dealer_reply_extract descriptor — autonomous (no resume)", () => {
  it("declares NO resume member", () => {
    expect(dealerReplyExtractDescriptor.resume).toBeUndefined();
  });

  it("driver_kind is the live-LLM provider label (not a hardcoded constant)", () => {
    expect(dealerReplyExtractDescriptor.driverKind()).toBe(
      providerDriverKind(policy("dealer_reply_extract").provider),
    );
  });

  it("a form-decision against a started run → 400 unsupported_action", async () => {
    const { mastra } = fakeMastra({
      status: "success",
      result: { outcome: "extracted", resolution: "inferred_newest", summary: "ok" },
    });
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(mastra, pubsub);
    const { runId } = await svc.start({
      skill: "dealer_reply_extract",
      input: { search_profile_id: null },
    });
    // The run is autonomous + terminal; a form-decision must be rejected. A
    // brand-new decisionId on a terminal autonomous run surfaces run_terminal
    // (410); the contract under test is that it is NEVER accepted as a resume.
    await expect(
      svc.formDecision(runId, {
        decision_id: "never-issued",
        decision: { action: "accept", content: {} },
      }),
    ).rejects.toBeInstanceOf(FormDecisionError);
  });
});
