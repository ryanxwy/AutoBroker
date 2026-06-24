/**
 * inventory_site_scan descriptor — unit tests.
 *
 * The scan is READ-ONLY and auto-approves every in-radius target, so it never
 * pends a batch_review suspend: a scanned run drives straight to success with
 * no pending decision. These tests cover buildInput parsing/validation and the
 * no-suspend contract, exercised through the service with a fake Mastra
 * instance scripted over a start/resume sequence.
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

const SUCCESS_SCANNED = {
  status: "success",
  result: { outcome: "scanned", resolution: "pinned", summary: "Scanned 2 of 2." },
};

/** A scripted fake Mastra over a recorded start/resume sequence. */
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
    mastra: { getWorkflow: () => workflow } as never,
  };
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

describe("inventory_site_scan — no batch_review suspend pends for the scan", () => {
  it("a scanned run drives straight to success with NO pending decision", async () => {
    const { mastra } = fakeMastra([SUCCESS_SCANNED]);
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(mastra, pubsub);
    const { runId } = await svc.start({
      skill: "inventory_site_scan",
      input: { search_profile_id: "prof-1", dealer_ids: null, approved_by: null, max_targets: null },
    });
    expect(svc.pendingOf(runId)).toBeNull();
    const frames = pubsub.snapshot(runId) as Array<{ kind: string }>;
    expect(frames.some((f) => f.kind === "awaiting_user")).toBe(false);
  });
});
