/**
 * inventory_aggregator_scan descriptor — unit tests. The aggregator scan is
 * READ-ONLY and auto-scans its static shopping-site set with NO approval gate,
 * so it never pends a suspend: a scanned run drives straight to success with no
 * pending decision (like geosearch). The driver_kind is the LIVE-LLM label
 * derived from the policy() route the shared inventory_extract useCase takes,
 * and the success pulse names the "listings" data family.
 */

import { afterEach, describe, expect, it } from "vitest";

import { providerDriverKind } from "@autobroker/core";
import { policy } from "@autobroker/model";
import { resetRuntimeGlueForTests } from "@autobroker/workflows";

import {
  FormDecisionError,
  SkillRunService,
  inventoryAggregatorScanDescriptor,
} from "./skillRuns.js";
import { RunPubSub } from "./runPubSub.js";
import { useFreshProductDb } from "./testProductDb.js";

// SkillRunService.start()/terminal teardown writes the activation registry
// (pipeline_state) on the product DB — give each case a fresh, migrated DB.
useFreshProductDb();

afterEach(() => {
  resetRuntimeGlueForTests();
});

const SUCCESS_SCANNED = {
  status: "success",
  result: {
    outcome: "scanned",
    resolution: "inferred_newest",
    summary: "Cars.com: 3 listings · Edmunds: 2 listings. Kept 4 listings matching your Sport-L trim.",
  },
};

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

describe("inventory_aggregator_scan descriptor — buildInput", () => {
  it("accepts the bare body and the explicit profile pin; ignores envelope fields", () => {
    expect(inventoryAggregatorScanDescriptor.buildInput({})).toEqual({
      search_profile_id: null,
    });
    expect(
      inventoryAggregatorScanDescriptor.buildInput({
        skill: "inventory_aggregator_scan",
        input_mode: "slash",
        search_profile_id: "prof-1",
      }),
    ).toEqual({ search_profile_id: "prof-1" });
  });

  it("rejects a non-string search_profile_id as content_invalid", () => {
    expect(() =>
      inventoryAggregatorScanDescriptor.buildInput({ search_profile_id: 42 }),
    ).toThrowError(FormDecisionError);
  });
});

describe("inventory_aggregator_scan descriptor — autonomous (no resume)", () => {
  it("declares NO resume member (a form-decision 400s as unsupported_action)", () => {
    expect(inventoryAggregatorScanDescriptor.resume).toBeUndefined();
  });

  it("driver_kind derives from policy('inventory_extract') (lock-step with a provider swap)", () => {
    expect(inventoryAggregatorScanDescriptor.driverKind()).toBe(
      providerDriverKind(policy("inventory_extract").provider),
    );
  });

  it("a scanned run drives straight to success + pulses the 'listings' data family", async () => {
    const { mastra } = fakeMastra(SUCCESS_SCANNED);
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(mastra, pubsub);
    const { runId } = await svc.start({
      skill: "inventory_aggregator_scan",
      input: { search_profile_id: "prof-1" },
    });
    expect(svc.pendingOf(runId)).toBeNull();
    const frames = pubsub.snapshot(runId) as Array<{ kind: string }>;
    expect(frames.some((f) => f.kind === "awaiting_user")).toBe(false);
    const pulse = pubsub.snapshot(runId).find((e) => e.kind === "data.changed")!;
    expect(pulse.payload["kinds"]).toEqual(["listings"]);
  });
});
