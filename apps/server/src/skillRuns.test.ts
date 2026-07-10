/**
 * skillRuns unit tests — the per-skill descriptor registry plus the three-phase
 * idempotent form-decision claim state machine (driven through the intake
 * descriptor), isolated from the real Mastra workflow + DB by a minimal fake
 * Mastra instance. The integration suite exercises the claim
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

import {
  SkillRunService,
  FormDecisionError,
  ProfileRunConflictError,
  RUN_DESCRIPTORS,
} from "./skillRuns.js";
import { RunPubSub } from "./runPubSub.js";
import { useFreshProductDb } from "./testProductDb.js";

// SkillRunService.start()/terminal teardown writes the activation registry
// (pipeline_state) on the product DB — give each case a fresh, migrated DB.
useFreshProductDb();

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

const SUSPEND_CLOSEOUT_BATCH = {
  status: "suspended",
  steps: {
    batchReview: {
      status: "suspended",
      suspendPayload: {
        kind: "batch_review",
        targets: [{ dealer_id: "dealer-1", name: "Dealer One", website: "" }],
      },
    },
  },
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
): Promise<{ svc: SkillRunService; pubsub: RunPubSub; runId: string; decisionId: string }> {
  const pubsub = new RunPubSub();
  const svc = new SkillRunService(fakeMastra(sequence), pubsub);
  const { runId } = await svc.start({
    skill: "search_profile_intake",
    input: { input_mode: "slash", freeform_text: null, seed_fields: null },
  });
  const pending = svc.pendingOf(runId);
  expect(pending?.step).toBe("collect");
  return { svc, pubsub, runId, decisionId: pending!.decisionId };
}

describe("formDecision — idempotent replay (Phase 1 consumed-same-body)", () => {
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

describe("Auto-run my searches — outbound approval boundary", () => {
  it("never auto-resumes a newly parked send gate when the search scheduler is enabled", async () => {
    const original = process.env.AUTOBROKER_PORTFOLIO_SCHEDULER;
    process.env.AUTOBROKER_PORTFOLIO_SCHEDULER = "1";
    try {
      const pubsub = new RunPubSub();
      const svc = new SkillRunService(fakeMastra([SUSPEND_CLOSEOUT_BATCH]), pubsub);
      const { runId } = await svc.start({
        skill: "dealer_closeout_email",
        input: { search_profile_id: "profile-1" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(svc.pendingOf(runId)).toMatchObject({ step: "batchReview" });
      expect(svc.isTerminal(runId)).toBe(false);
      expect(pubsub.snapshot(runId).map((event) => event.kind)).toEqual([
        "init",
        "awaiting_user",
      ]);
    } finally {
      if (original === undefined) delete process.env.AUTOBROKER_PORTFOLIO_SCHEDULER;
      else process.env.AUTOBROKER_PORTFOLIO_SCHEDULER = original;
    }
  });
});

describe("start — durable profile ownership", () => {
  it("a competing service loses before it asks Mastra for a workflow", async () => {
    const owner = new SkillRunService(fakeMastra([SUSPEND_COLLECT]), new RunPubSub());
    await owner.start({
      skill: "dealer_geosearch",
      runId: "owner-run",
      input: { search_profile_id: "profile-owned" },
    });

    let getWorkflowCalls = 0;
    const competitorMastra = {
      getWorkflow: () => {
        getWorkflowCalls += 1;
        throw new Error("competitor reached Mastra before acquiring the profile");
      },
    } as never;
    const competitor = new SkillRunService(competitorMastra, new RunPubSub());

    await expect(
      competitor.start({
        skill: "dealer_geosearch",
        runId: "losing-run",
        input: { search_profile_id: "profile-owned" },
      }),
    ).rejects.toMatchObject({
      name: "ProfileRunConflictError",
      profileId: "profile-owned",
      liveRunId: "owner-run",
    } satisfies Partial<ProfileRunConflictError>);
    expect(getWorkflowCalls).toBe(0);
  });
});

describe("formDecision — in-flight + not-found + terminal guards", () => {
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
    const svc = new SkillRunService(mastra, pubsub);
    const { runId } = await svc.start({
      skill: "search_profile_intake",
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

describe("per-skill descriptor registry", () => {
  it("lists the intake descriptor under its skill id", () => {
    const d = RUN_DESCRIPTORS.find((x) => x.skillId === "search_profile_intake");
    expect(d).toBeDefined();
    expect(d!.workflowId).toBe("search_profile_intake");
    expect(d!.resume).toBeDefined();
  });

  it("the dealer_geosearch descriptor is wired (input shaping, driver kind, summary, no resume)", () => {
    const d = RUN_DESCRIPTORS.find((x) => x.skillId === "dealer_geosearch");
    expect(d).toBeDefined();
    expect(d!.workflowId).toBe("dealer_geosearch");
    // No HITL suspend in the workflow → no resume member (a form-decision
    // against a geosearch run 400s as unsupported_action in the service).
    expect(d!.resume).toBeUndefined();
    // driver_kind derives from policy('geosearch_extract') — deepseek default.
    expect(d!.driverKind()).toBe("deepseek_apikey");
    // The start-route envelope fields ride the same body — accepted + ignored.
    expect(d!.buildInput({ skill: "dealer_geosearch", input_mode: "slash" })).toEqual({
      search_profile_id: null,
    });
    expect(d!.buildInput({ search_profile_id: "abc123" })).toEqual({
      search_profile_id: "abc123",
    });
    // A mistyped per-skill field is a typed 400 content_invalid.
    expect(() => d!.buildInput({ search_profile_id: 42 })).toThrow(FormDecisionError);
    // summaryText passes the workflow-templated summary through.
    expect(d!.summaryText({ summary: "Registered 3 new dealer candidate(s)." })).toBe(
      "Registered 3 new dealer candidate(s).",
    );
    expect(d!.summaryText(undefined)).toBe("Dealer geosearch complete.");
  });

  it("start for an unregistered skill rejects with UnknownSkillError", async () => {
    const svc = new SkillRunService(fakeMastra([SUSPEND_COLLECT]), new RunPubSub());
    await expect(svc.start({ skill: "no_such_skill", input: {} })).rejects.toThrow(
      /unknown skill 'no_such_skill'/,
    );
  });
});

describe("error-path frame translation (Mastra flat step errors)", () => {
  // The Mastra default engine delivers step errors as FLAT toJSON()'d objects
  // {message, name, code} — NOT Error instances — identical live and after
  // snapshot rehydration. These tests pin the wire translation of that shape
  // and double as the tripwire for a future Mastra upgrade changing it.

  /** Start a geosearch run against a scripted failed result; returns the
   *  terminal error frame payload off the pubsub backlog. */
  async function errorPayloadFor(error: unknown): Promise<Record<string, unknown>> {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(fakeMastra([{ status: "failed", error }]), pubsub);
    const { runId } = await svc.start({
      skill: "dealer_geosearch",
      input: { search_profile_id: null },
    });
    expect(svc.isTerminal(runId)).toBe(true);
    const log = pubsub.snapshot(runId);
    const last = log[log.length - 1]!;
    expect(last.kind).toBe("error");
    return last.payload;
  }

  it("a flat {message, name, code} object → verbatim reason + name + code on the frame", async () => {
    const payload = await errorPayloadFor({
      message:
        "No active search profile found — dealer_geosearch needs one to know what to search for.",
      name: "DealerGeosearchStopError",
      code: "no_active_profile",
    });
    expect(payload).toEqual({
      reason:
        "No active search profile found — dealer_geosearch needs one to know what to search for.",
      name: "DealerGeosearchStopError",
      code: "no_active_profile",
    });
  });

  it("an Error instance → message as reason + name (no code unless string)", async () => {
    const payload = await errorPayloadFor(new Error("boom"));
    expect(payload).toEqual({ reason: "boom", name: "Error" });
  });

  it("a bare string → the reason verbatim", async () => {
    const payload = await errorPayloadFor("scan exploded");
    expect(payload).toEqual({ reason: "scan exploded" });
  });

  it("undefined / unshaped errors → the generic workflow_failed reason", async () => {
    expect(await errorPayloadFor(undefined)).toEqual({ reason: "workflow_failed" });
    expect(await errorPayloadFor(42)).toEqual({ reason: "workflow_failed" });
  });

  it("a non-string code (e.g. a numeric SqliteError-style code) is dropped, message kept", async () => {
    const payload = await errorPayloadFor({ message: "db locked", name: "SqliteError", code: 5 });
    expect(payload).toEqual({ reason: "db locked", name: "SqliteError" });
  });
});

describe("terminal text frame — resolution provenance copy", () => {
  it("a success result carrying resolution puts it on the text frame payload (done stays {})", async () => {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(
      fakeMastra([
        {
          status: "success",
          result: { summary: "Registered 3 new dealer candidate(s).", resolution: "pinned" },
        },
      ]),
      pubsub,
    );
    const { runId } = await svc.start({
      skill: "dealer_geosearch",
      input: { search_profile_id: "prof-1" },
    });
    const log = pubsub.snapshot(runId);
    const text = log.find((e) => e.kind === "text")!;
    expect(text.payload["resolution"]).toBe("pinned");
    expect(text.payload["text"]).toBe("Registered 3 new dealer candidate(s).");
    const done = log.find((e) => e.kind === "done")!;
    expect(done.payload).toEqual({});
  });

  it("a result with no resolution leaves the text frame metadata-free (skill-agnostic)", async () => {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(fakeMastra([SUSPEND_COLLECT, SUCCESS_CREATED]), pubsub);
    const { runId } = await svc.start({
      skill: "search_profile_intake",
      input: { input_mode: "slash", freeform_text: null, seed_fields: null },
    });
    await svc.formDecision(runId, {
      decision_id: svc.pendingOf(runId)!.decisionId,
      decision: { action: "accept", content: validContent() },
    });
    const text = pubsub.snapshot(runId).find((e) => e.kind === "text")!;
    expect("resolution" in text.payload).toBe(false);
  });
});

describe("terminal text frame — per_site provenance copy (F9 site_contribution)", () => {
  it("a success result carrying per_site puts the array on the text frame payload verbatim", async () => {
    const perSite = [
      { site_id: "cars_com", status: "scanned", listing_count: 5, error: null },
      { site_id: "visor_vin", status: "scanned", listing_count: 3, error: null },
    ];
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(
      fakeMastra([
        {
          status: "success",
          result: { summary: "Scanned 2 sites.", per_site: perSite },
        },
      ]),
      pubsub,
    );
    const { runId } = await svc.start({
      skill: "inventory_aggregator_scan",
      input: { search_profile_id: null },
    });
    const text = pubsub.snapshot(runId).find((e) => e.kind === "text")!;
    expect(text.payload["per_site"]).toEqual(perSite);
  });

  it("a result with no per_site leaves the text frame metadata-free (skill-agnostic)", async () => {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(
      fakeMastra([{ status: "success", result: { summary: "Registered 3 new dealer candidate(s)." } }]),
      pubsub,
    );
    const { runId } = await svc.start({
      skill: "dealer_geosearch",
      input: { search_profile_id: "prof-1" },
    });
    const text = pubsub.snapshot(runId).find((e) => e.kind === "text")!;
    expect("per_site" in text.payload).toBe(false);
  });
});

describe("data.changed pulse — fresh-by-default auto-refresh", () => {
  it("a successful run emits exactly one data.changed{profile_id, kinds} BEFORE done (not discarded)", async () => {
    const pubsub = new RunPubSub();
    // geosearch success carries searchProfileId — the pulse reads it for scope.
    const svc = new SkillRunService(
      fakeMastra([
        {
          status: "success",
          result: { summary: "Registered 3 new dealer candidate(s).", searchProfileId: "prof-7" },
        },
      ]),
      pubsub,
    );
    const { runId } = await svc.start({
      skill: "dealer_geosearch",
      input: { search_profile_id: "prof-7" },
    });

    const kinds = pubsub.snapshot(runId).map((e) => e.kind);
    // Ordering: ... text → data.changed → done (the pulse is NOT discarded by
    // the single-terminal invariant because it lands BEFORE done).
    expect(kinds).toEqual(["init", "text", "data.changed", "done"]);
    const pulse = pubsub.snapshot(runId).find((e) => e.kind === "data.changed")!;
    expect(pulse.payload).toEqual({ profile_id: "prof-7", kinds: ["dealers"] });
    // Exactly one pulse.
    expect(pubsub.snapshot(runId).filter((e) => e.kind === "data.changed")).toHaveLength(1);
  });

  it("dealer_reply_extract's pulse includes digest — the stale headline quote count refetches after an extract", async () => {
    const pubsub = new RunPubSub();
    // reply-extract writes dealer_quotes; the digest headline ("N quote(s),
    // lowest $X") re-aggregates from them, so the digest data family must ride
    // the pulse or the count stays stale until the next daily_digest while
    // best-OTD self-heals from the live quotes fetch.
    const svc = new SkillRunService(
      fakeMastra([
        { status: "success", result: { summary: "Extracted 3 quote(s).", searchProfileId: "prof-9" } },
      ]),
      pubsub,
    );
    const { runId } = await svc.start({
      skill: "dealer_reply_extract",
      input: { search_profile_id: "prof-9" },
    });
    const pulse = pubsub.snapshot(runId).find((e) => e.kind === "data.changed")!;
    expect(pulse.payload["kinds"]).toEqual(["quotes", "messages", "digest"]);
  });

  it("quote_pipeline's pulse includes digest (its reply-extract child writes dealer_quotes)", async () => {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(
      fakeMastra([
        { status: "success", result: { summary: "Pipeline complete.", searchProfileId: "prof-10" } },
      ]),
      pubsub,
    );
    const { runId } = await svc.start({
      skill: "quote_pipeline",
      input: { search_profile_id: "prof-10" },
    });
    const pulse = pubsub.snapshot(runId).find((e) => e.kind === "data.changed")!;
    expect(pulse.payload["kinds"]).toEqual(["quotes", "incentives", "listings", "messages", "digest"]);
  });

  it("the affectedKinds mapping is keyed on the skill (intake → profiles+sessions)", async () => {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(fakeMastra([SUSPEND_COLLECT, SUCCESS_CREATED]), pubsub);
    const { runId } = await svc.start({
      skill: "search_profile_intake",
      input: { input_mode: "slash", freeform_text: null, seed_fields: null },
    });
    await svc.formDecision(runId, {
      decision_id: svc.pendingOf(runId)!.decisionId,
      decision: { action: "accept", content: validContent() },
    });
    const pulse = pubsub.snapshot(runId).find((e) => e.kind === "data.changed")!;
    expect(pulse.payload["kinds"]).toEqual(["profiles", "sessions"]);
  });

  it("a DECLINED run emits NO data.changed (only the aborted terminal)", async () => {
    const { svc, pubsub, runId, decisionId } = await startedToCollect([
      SUSPEND_COLLECT,
      SUCCESS_DECLINED,
    ]);
    await svc.formDecision(runId, { decision_id: decisionId, decision: { action: "decline" } });
    const kinds = pubsub.snapshot(runId).map((e) => e.kind);
    expect(kinds).not.toContain("data.changed");
    expect(kinds[kinds.length - 1]).toBe("aborted");
  });

  it("a FAILED run emits NO data.changed (only the error terminal)", async () => {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(
      fakeMastra([{ status: "failed", error: new Error("boom") }]),
      pubsub,
    );
    const { runId } = await svc.start({
      skill: "dealer_geosearch",
      input: { search_profile_id: null },
    });
    const kinds = pubsub.snapshot(runId).map((e) => e.kind);
    expect(kinds).not.toContain("data.changed");
    expect(kinds[kinds.length - 1]).toBe("error");
  });

  it("a profile-less success pulses with profile_id null (refetches unscoped)", async () => {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(
      fakeMastra([{ status: "success", result: { summary: "done" } }]),
      pubsub,
    );
    const { runId } = await svc.start({
      skill: "dealer_geosearch",
      input: { search_profile_id: null },
    });
    const pulse = pubsub.snapshot(runId).find((e) => e.kind === "data.changed")!;
    expect(pulse.payload["profile_id"]).toBeNull();
  });
});

describe("formDecision — decline terminal projection", () => {
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

describe("start — non-blocking drive (the ack returns while the run is in flight)", () => {
  /** A fake whose start() hangs on a controllable promise — the no-suspend
   *  browser-skill shape (the whole workflow is one long drive segment). */
  function hangingMastra(): { mastra: never; finish: (result: Record<string, unknown>) => void } {
    let started = false;
    let last: Record<string, unknown> | null = null;
    let release: (r: Record<string, unknown>) => void = () => undefined;
    const gate = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const handle = {
      start: async () => {
        started = true;
        last = await gate;
        return last;
      },
      resume: async () => {
        throw new Error("no resume in this scenario");
      },
    };
    const workflow = {
      createRun: async () => handle,
      getWorkflowRunById: async () =>
        started ? { status: (last ?? { status: "running" })["status"] ?? "running" } : null,
    };
    return {
      mastra: { getWorkflow: () => workflow } as never,
      finish: (result) => release(result),
    };
  }

  it("start() acks immediately; the terminal frame lands when the drive settles", async () => {
    const pubsub = new RunPubSub();
    const { mastra, finish } = hangingMastra();
    const svc = new SkillRunService(mastra, pubsub);

    // The ack returns while the workflow is STILL RUNNING (the drive half is
    // not awaited) — a subscriber attached now sees the run live.
    const { runId } = await svc.start({
      skill: "search_profile_intake",
      input: { input_mode: "slash", freeform_text: null, seed_fields: null },
    });
    expect(pubsub.isTerminal(runId)).toBe(false);
    expect((await svc.statusSummary(runId))?.status).toBe("running");

    // The drive settles → the text+done frames land on the open channel.
    finish({ status: "success", result: { outcome: "created", vehicle: "x", location: "y" } });
    await new Promise((r) => setTimeout(r, 0));
    const kinds = pubsub.snapshot(runId).map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe("done");
  });

  it("a drive REJECTION lands as an error frame (the stream always terminates)", async () => {
    const pubsub = new RunPubSub();
    let started = false;
    const workflow = {
      createRun: async () => ({
        start: async () => {
          started = true;
          throw new Error("storage exploded mid-drive");
        },
      }),
      getWorkflowRunById: async () => (started ? { status: "failed" } : null),
    };
    const svc = new SkillRunService({ getWorkflow: () => workflow } as never, pubsub);
    const { runId } = await svc.start({
      skill: "search_profile_intake",
      input: { input_mode: "slash", freeform_text: null, seed_fields: null },
    });
    await new Promise((r) => setTimeout(r, 0));
    const last = pubsub.snapshot(runId).at(-1)!;
    expect(last.kind).toBe("error");
    expect(last.payload["reason"]).toBe("storage exploded mid-drive");
  });
});
