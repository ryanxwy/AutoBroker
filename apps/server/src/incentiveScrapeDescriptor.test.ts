/**
 * incentive_scrape descriptor — unit tests over the first-encounter approval
 * resume seam. The suspended step is "resolveOemSource"; the generic
 * form-decision verbs map onto the workflow's typed save | skip | decline:
 * a bare accept approves the SHOWN candidate (save, url null), accept content
 * may correct the url or skip the brand, decline/cancel decline the WHOLE
 * run. The awaiting_user frame's form_kind is "approval" (the banner track).
 */

import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeGlueForTests } from "@autobroker/workflows";

import {
  FormDecisionError,
  SkillRunService,
  incentiveScrapeDescriptor,
} from "./skillRuns.js";
import { RunPubSub } from "./runPubSub.js";

afterEach(() => {
  resetRuntimeGlueForTests();
});

/** The first-encounter suspend payload (the approval card's spec_inline). */
const FIRST_ENCOUNTER_PAYLOAD = {
  kind: "approval",
  summary:
    "First encounter with a new incentive source for Hyundai Tucson Hybrid: " +
    "scrape https://www.hyundaiusa.com/us/en/offers ? Approving remembers this " +
    "source for future runs.",
  sensitive: true,
  oemUrl: "https://www.hyundaiusa.com/us/en/offers",
  normalizedUrl: "https://www.hyundaiusa.com/us/en/offers",
  make: "Hyundai",
  model: "Tucson Hybrid",
  reason: "oem_first_encounter",
};

const SUSPEND_FIRST_ENCOUNTER = {
  status: "suspended",
  steps: { resolveOemSource: { status: "suspended", suspendPayload: FIRST_ENCOUNTER_PAYLOAD } },
};

const SUCCESS_SCRAPED = {
  status: "success",
  result: { outcome: "scraped", resolution: "all_active", summary: "Checked 1 brand target(s)." },
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

async function startedToFirstEncounter(sequence: Array<Record<string, unknown>>) {
  const { mastra, resumes } = fakeMastra(sequence);
  const pubsub = new RunPubSub();
  const svc = new SkillRunService(mastra, pubsub);
  const { runId } = await svc.start({
    skill: "incentive_scrape",
    input: { search_profile_id: null },
  });
  const pending = svc.pendingOf(runId);
  expect(pending?.step).toBe("resolveOemSource");
  return { svc, pubsub, runId, decisionId: pending!.decisionId, resumes };
}

describe("incentive_scrape descriptor — buildInput", () => {
  it("accepts the bare body and the explicit profile pin", () => {
    expect(incentiveScrapeDescriptor.buildInput({})).toEqual({ search_profile_id: null });
    expect(
      incentiveScrapeDescriptor.buildInput({
        skill: "incentive_scrape",
        search_profile_id: "prof-1",
      }),
    ).toEqual({ search_profile_id: "prof-1" });
  });

  it("rejects a non-string search_profile_id as content_invalid", () => {
    expect(() => incentiveScrapeDescriptor.buildInput({ search_profile_id: 42 })).toThrowError(
      FormDecisionError,
    );
  });
});

describe("incentive_scrape — the first-encounter form-decision through the seam", () => {
  it("the awaiting_user frame carries form_kind approval + the typed spec_inline", async () => {
    const { pubsub, runId } = await startedToFirstEncounter([
      SUSPEND_FIRST_ENCOUNTER,
      SUCCESS_SCRAPED,
    ]);
    const frames = pubsub.snapshot(runId) as Array<{
      kind: string;
      payload: Record<string, unknown>;
    }>;
    const awaiting = frames.find((f) => f.kind === "awaiting_user");
    expect(awaiting?.payload["form_kind"]).toBe("approval");
    expect(awaiting?.payload["spec_inline"]).toEqual(FIRST_ENCOUNTER_PAYLOAD);
  });

  it("a bare accept approves the SHOWN candidate (save, url null — the Approve button)", async () => {
    const { svc, runId, decisionId, resumes } = await startedToFirstEncounter([
      SUSPEND_FIRST_ENCOUNTER,
      SUCCESS_SCRAPED,
    ]);
    const ack = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "accept" },
    });
    expect(ack).toEqual({ action: "accept", content: { action: "save", url: null } });
    expect(resumes).toEqual([{ action: "save", url: null }]);
  });

  it("accept content may correct the url (save) or skip the brand", async () => {
    expect(
      incentiveScrapeDescriptor.resume!(
        "resolveOemSource",
        { action: "accept", content: { url: "https://www.hyundaiusa.com/us/en/offers" } },
        FIRST_ENCOUNTER_PAYLOAD,
      ).resumeData,
    ).toEqual({ action: "save", url: "https://www.hyundaiusa.com/us/en/offers" });
    expect(
      incentiveScrapeDescriptor.resume!(
        "resolveOemSource",
        { action: "accept", content: { action: "skip" } },
        FIRST_ENCOUNTER_PAYLOAD,
      ).resumeData,
    ).toEqual({ action: "skip", url: null });
  });

  it("decline and cancel both map to the whole-run decline resume", async () => {
    const declined = { status: "success", result: { outcome: "declined" } };
    const { svc, runId, decisionId, resumes } = await startedToFirstEncounter([
      SUSPEND_FIRST_ENCOUNTER,
      declined,
    ]);
    const ack = await svc.formDecision(runId, {
      decision_id: decisionId,
      decision: { action: "decline" },
    });
    expect(ack).toEqual({ action: "decline", content: null });
    expect(resumes).toEqual([{ action: "decline", url: null }]);

    expect(
      incentiveScrapeDescriptor.resume!(
        "resolveOemSource",
        { action: "cancel" },
        FIRST_ENCOUNTER_PAYLOAD,
      ).resumeData,
    ).toEqual({ action: "decline", url: null });
  });

  it("unknown accept-content keys → 400 content_invalid (strict)", () => {
    expect(() =>
      incentiveScrapeDescriptor.resume!(
        "resolveOemSource",
        { action: "accept", content: { approved_dealer_ids: ["x"] } },
        FIRST_ENCOUNTER_PAYLOAD,
      ),
    ).toThrowError(FormDecisionError);
  });

  it("a decision on an unexpected suspended step → 400 unsupported_action", () => {
    expect(() =>
      incentiveScrapeDescriptor.resume!(
        "reviewGate", // a SIBLING skill's step name — not this descriptor's
        { action: "accept", content: {} },
        FIRST_ENCOUNTER_PAYLOAD,
      ),
    ).toThrowError(FormDecisionError);
  });
});
