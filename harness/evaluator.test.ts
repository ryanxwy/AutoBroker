/**
 * evaluator.test.ts — OFFLINE anchor + verdict tests. Scores each of the 6+1
 * anchors against fixture SSE transcripts
 * synthesized from the REAL committed wire shapes (init→awaiting_user→text→done,
 * init→awaiting_user→aborted{user_declined}) and an ISOLATED tmp DB whose rows
 * mimic what the SUT would have written. NO live server, NO LLM call.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRunDetailFromEvents } from "./detail.js";
import { snapshotCounts } from "./dbReads.js";
import {
  buildVerdict,
  computeConfidence,
  evalAnchor,
  type AnchorResult,
  type EvalContext,
} from "./evaluator.js";
import {
  createdRunFrames,
  declinedRunFrames,
  forceOverrideRunFrames,
  malformedFailClosedFrames,
  insertAudit,
  insertLedgerRow,
  insertProfile,
  insertSubmittedLead,
  makeTmpDb,
  type TmpDb,
} from "./testSupport.js";

let tmp: TmpDb;

beforeEach(() => {
  tmp = makeTmpDb();
});
afterEach(() => {
  tmp.close();
});

/** Build an EvalContext from a profileId, snapshotting before(null)/after(id).
 *  Pass baseline to set externalMutationBaseline on the context (for the
 *  delta-path keystone tests). */
function ctxFor(profileId: string | null, baseline?: number): EvalContext {
  const before = snapshotCounts(null, tmp.db);
  const after = snapshotCounts(profileId, tmp.db);
  return {
    profileId,
    before,
    after,
    runWindow: { from: "2026-06-05", to: "2026-06-05~" },
    ...(baseline !== undefined ? { externalMutationBaseline: baseline } : {}),
  };
}

describe("run_status anchor", () => {
  it("PASS when terminalStatus ∈ expect (created → done)", () => {
    const detail = buildRunDetailFromEvents("r1", createdRunFrames(), "done");
    const r = evalAnchor({ kind: "run_status", expect: ["done"] }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(true);
    expect(r.observed).toBe("done");
  });

  it("declined wire (aborted{user_declined}) projects to declined via status", () => {
    // The decline lands as `aborted` on the WIRE; the projected status is `declined`.
    const detail = buildRunDetailFromEvents("r2", declinedRunFrames(), "declined");
    const r = evalAnchor({ kind: "run_status", expect: ["declined"] }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(true);
    expect(detail.terminalStatus).toBe("declined");
  });

  it("FAIL when terminal not in expect", () => {
    const detail = buildRunDetailFromEvents("r3", createdRunFrames(), "done");
    const r = evalAnchor({ kind: "run_status", expect: ["declined"] }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(false);
  });
});

describe("driver_kind anchor (two-place lock-step)", () => {
  it("PASS when init.driver_kind === expect", () => {
    const detail = buildRunDetailFromEvents("r1", createdRunFrames(), "done");
    const r = evalAnchor({ kind: "driver_kind", expect: "deepseek_apikey" }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(true);
  });

  it("FAIL when the emitted label drifts from the expect (silent-break guard)", () => {
    const frames = createdRunFrames();
    frames[0]!.payload["driver_kind"] = "agent"; // emitter drifted.
    const detail = buildRunDetailFromEvents("r1", frames, "done");
    const r = evalAnchor({ kind: "driver_kind", expect: "deepseek_apikey" }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(false);
  });
});

describe("table_min_rows anchor (profile-scoped delta)", () => {
  it("created run: +1 search_profiles profile-scoped delta PASSES", () => {
    const ctxBefore = ctxFor(null); // snapshot before with null profile.
    insertProfile(tmp.db, "p-1");
    const after = snapshotCounts("p-1", tmp.db);
    const ctx: EvalContext = { ...ctxBefore, profileId: "p-1", after };
    const r = evalAnchor({ kind: "table_min_rows", table: "search_profiles", scope: "profile", deltaMin: 1 }, detailDone("p-1"), tmp.db, ctx);
    expect(r.ok).toBe(true);
    expect(r.observed).toBe(1);
  });

  it("decline run: exact delta 0 PASSES (zero write)", () => {
    const ctx = ctxFor(null); // nothing created.
    const r = evalAnchor({ kind: "table_min_rows", table: "search_profiles", scope: "profile", deltaMin: 0, exact: true }, declinedDetail(), tmp.db, ctx);
    expect(r.ok).toBe(true);
    expect(r.observed).toBe(0);
  });

  it("audit_log action='search_profile_intake' profile-scoped delta PASSES", () => {
    insertProfile(tmp.db, "p-2");
    insertAudit(tmp.db, { auditId: "a-1", action: "search_profile_intake", profileId: "p-2" });
    const ctx = ctxFor("p-2");
    const r = evalAnchor({ kind: "table_min_rows", table: "audit_log", scope: "profile", action: "search_profile_intake", deltaMin: 1 }, detailDone("p-2"), tmp.db, ctx);
    expect(r.ok).toBe(true);
  });

  it("forced-audit row (null profile id) is counted UNSCOPED via scope=global", () => {
    // The forced-audit row has search_profile_id=NULL — a profile-scoped count would
    // miss it; scope=global counts by action.
    insertAudit(tmp.db, { auditId: "a-f", action: "intake_verification_forced", profileId: null });
    const ctx = ctxFor("p-3");
    const r = evalAnchor({ kind: "table_min_rows", table: "audit_log", scope: "global", action: "intake_verification_forced", deltaMin: 1 }, detailDone("p-3"), tmp.db, ctx);
    expect(r.ok).toBe(true);
    expect(r.observed).toBe(1);
  });
});

describe("no_external_mutation KEYSTONE anchor", () => {
  it("clean intake run PASSES (no submitted lead, no send/submit audit)", () => {
    insertProfile(tmp.db, "p-1");
    insertAudit(tmp.db, { auditId: "a-1", action: "search_profile_intake", profileId: "p-1" });
    const r = evalAnchor({ kind: "no_external_mutation" }, detailDone("p-1"), tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(true);
    expect(r.observed).toBe(0);
  });

  it("a submitted lead is caught (tolerance 0)", () => {
    insertSubmittedLead(tmp.db, { submissionId: "s-1", dealerId: "d-1" });
    const r = evalAnchor({ kind: "no_external_mutation" }, detailDone(null), tmp.db, ctxFor(null));
    expect(r.ok).toBe(false);
    expect(Number(r.observed)).toBeGreaterThanOrEqual(1);
  });

  it("a send/submit-shaped audit action is caught", () => {
    insertAudit(tmp.db, { auditId: "a-s", action: "gmail_send", profileId: null });
    const r = evalAnchor({ kind: "no_external_mutation" }, detailDone(null), tmp.db, ctxFor(null));
    expect(r.ok).toBe(false);
  });

  it("a real gmail-send tool_call event is caught off the SSE stream", () => {
    const frames = createdRunFrames();
    frames.splice(2, 0, { ts: "2026-06-05T00:00:09.000Z", kind: "tool_call", payload: { name: "gmail_send", mode: "real" } });
    const detail = buildRunDetailFromEvents("r1", frames, "done");
    const r = evalAnchor({ kind: "no_external_mutation" }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(false);
  });

  it("(baseline-delta) baseline absorbs a pre-existing submitted lead → keystone PASSES", () => {
    // Seed 1 submitted lead before the run (pre-existing world state).
    insertSubmittedLead(tmp.db, { submissionId: "s-pre", dealerId: "d-1" });
    // Baseline captures the pre-run count (1). The run adds nothing new.
    const r = evalAnchor({ kind: "no_external_mutation" }, detailDone(null), tmp.db, ctxFor(null, 1));
    expect(r.ok).toBe(true);
    expect(r.observed).toBe(0); // delta = 1 − 1 = 0
  });

  it("(baseline-delta) a NEW submitted lead added after baseline is still caught", () => {
    // Seed the pre-existing lead (baseline = 1).
    insertSubmittedLead(tmp.db, { submissionId: "s-pre", dealerId: "d-1" });
    // A second lead added during the run (simulates a run-produced mutation).
    insertSubmittedLead(tmp.db, { submissionId: "s-new", dealerId: "d-2" });
    // baseline=1 → delta = 2 − 1 = 1 → violation.
    const r = evalAnchor({ kind: "no_external_mutation" }, detailDone(null), tmp.db, ctxFor(null, 1));
    expect(r.ok).toBe(false);
    expect(Number(r.observed)).toBe(1); // exactly 1 new mutation
  });

  it("(baseline-delta) baseline higher than live count clamps to 0 (Math.max guard)", () => {
    // No rows in DB, but baseline=2 (e.g. rows were deleted externally). The
    // Math.max(0, 0 − 2) = 0 clamp must prevent a false RED.
    const r = evalAnchor({ kind: "no_external_mutation" }, detailDone(null), tmp.db, ctxFor(null, 2));
    expect(r.ok).toBe(true);
    expect(r.observed).toBe(0);
  });
});

describe("cost_and_time anchor (ledger rows; NULL-not-$0)", () => {
  it("PASS when a usage-bearing ledger row exists for the run", () => {
    insertLedgerRow(tmp.db, { runId: "r-cost", costUsd: 0.0009, latencyMs: 7320 });
    const r = evalAnchor({ kind: "cost_and_time" }, detailDone("p-1", "r-cost"), tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(true);
  });

  it("PASS when usage missing but recorded NULL-not-$0 (cost NULL + unavailable)", () => {
    insertLedgerRow(tmp.db, { runId: "r-null", costUsd: null, pricingSource: "unavailable", failReason: "usage_missing" });
    const r = evalAnchor({ kind: "cost_and_time" }, detailDone("p-1", "r-null"), tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(true);
  });

  it("FAIL when NO ledger row was written for the run", () => {
    const r = evalAnchor({ kind: "cost_and_time" }, detailDone("p-1", "r-absent"), tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(false);
  });

  it("optional=true: an empty ledger PASSES (zero-LLM happy path declared)", () => {
    const r = evalAnchor({ kind: "cost_and_time", optional: true }, detailDone("p-1", "r-absent"), tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(true);
    expect(r.observed).toBe(0);
  });

  it("optional=true still rejects a silent-$0 row when rows DO exist", () => {
    insertLedgerRow(tmp.db, { runId: "r-zero", costUsd: 0, pricingSource: "unavailable" });
    const r = evalAnchor({ kind: "cost_and_time", optional: true }, detailDone("p-1", "r-zero"), tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(false);
  });
});

describe("approval_gate anchor (gate-before-prose)", () => {
  it("force-override run: gate frame precedes the first prose text → PASS", () => {
    const detail = buildRunDetailFromEvents("r-fo", forceOverrideRunFrames(), "done");
    const r = evalAnchor({ kind: "approval_gate", gateBeforeProse: true }, detail, tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(true);
  });

  it("a prose text BEFORE any gate frame → FAIL gate-before-prose", () => {
    const frames = [
      { ts: "2026-06-05T00:00:01.000Z", kind: "init", payload: { driver_kind: "deepseek_apikey" } },
      { ts: "2026-06-05T00:00:02.000Z", kind: "text", payload: { text: "thinking…" } },
      { ts: "2026-06-05T00:00:03.000Z", kind: "awaiting_user", payload: { form_kind: "force_override", decision_id: "x" } },
      { ts: "2026-06-05T00:00:04.000Z", kind: "done", payload: {} },
    ];
    const detail = buildRunDetailFromEvents("r-bad", frames, "done");
    const r = evalAnchor({ kind: "approval_gate", gateBeforeProse: true }, detail, tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(false);
  });

  it("expect='absent' PASSES when no gate frame ever flowed (the no-re-ask proof)", () => {
    const frames = [
      { ts: "2026-06-12T00:00:01.000Z", kind: "init", payload: { driver_kind: "deepseek_apikey" } },
      { ts: "2026-06-12T00:00:02.000Z", kind: "text", payload: { text: "all fresh, skipped" } },
      { ts: "2026-06-12T00:00:03.000Z", kind: "done", payload: {} },
    ];
    const detail = buildRunDetailFromEvents("r-noask", frames, "done");
    const r = evalAnchor({ kind: "approval_gate", expect: "absent" }, detail, tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(true);
  });

  it("expect='absent' FAILS when a gate rendered (the run asked again)", () => {
    const detail = buildRunDetailFromEvents("r-asked", forceOverrideRunFrames(), "done");
    const r = evalAnchor({ kind: "approval_gate", expect: "absent" }, detail, tmp.db, ctxFor("p-1"));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("must never ask");
  });
});

describe("malformed_tool_call anchor (framework-new)", () => {
  it("normal run: expect='absent' PASSES (no malformed signal)", () => {
    const detail = buildRunDetailFromEvents("r1", createdRunFrames(), "done");
    const r = evalAnchor({ kind: "malformed_tool_call", expect: "absent" }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(true);
  });

  it("injected #1244: expect='fail_closed' PASSES on a safe terminal (error)", () => {
    const detail = buildRunDetailFromEvents("r-mf", malformedFailClosedFrames(), "error");
    const r = evalAnchor({ kind: "malformed_tool_call", expect: "fail_closed" }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(true);
  });

  it("a malformed signal that ends in `done` (prose fallthrough) FAILS fail_closed", () => {
    const frames = [
      { ts: "2026-06-05T00:00:01.000Z", kind: "init", payload: { driver_kind: "deepseek_apikey" } },
      { ts: "2026-06-05T00:00:02.000Z", kind: "awaiting_user", payload: { form_kind: "malformed_tool_call", decision_id: "x" } },
      { ts: "2026-06-05T00:00:03.000Z", kind: "done", payload: {} },
    ];
    const detail = buildRunDetailFromEvents("r-bad", frames, "done");
    const r = evalAnchor({ kind: "malformed_tool_call", expect: "fail_closed" }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(false);
  });
});

describe("resolution anchor (profile-resolution provenance)", () => {
  function framesWithResolution(resolution: string | null) {
    return [
      { ts: "t0", kind: "init", payload: { run_id: "r1", skill: "dealer_geosearch", driver_kind: "deepseek_apikey" } },
      {
        ts: "t1",
        kind: "text",
        payload: { text: "Registered 3 new dealer candidate(s).", ...(resolution !== null ? { resolution } : {}) },
      },
      { ts: "t2", kind: "done", payload: {} },
    ];
  }

  it("passes when the terminal text frame carries the expected provenance", () => {
    const detail = buildRunDetailFromEvents("r1", framesWithResolution("pinned"), "done");
    const r = evalAnchor({ kind: "resolution", expect: "pinned" }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(true);
    expect(r.observed).toBe("pinned");
  });

  it("fails on a provenance mismatch (pinned expected, inferred_newest observed)", () => {
    const detail = buildRunDetailFromEvents("r1", framesWithResolution("inferred_newest"), "done");
    const r = evalAnchor({ kind: "resolution", expect: "pinned" }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(false);
    expect(r.observed).toBe("inferred_newest");
  });

  it("fails LOUD-but-evidenced when no text frame carries resolution (not threaded)", () => {
    const detail = buildRunDetailFromEvents("r1", framesWithResolution(null), "done");
    const r = evalAnchor({ kind: "resolution", expect: "inferred_newest" }, detail, tmp.db, ctxFor(null));
    expect(r.ok).toBe(false);
    expect(r.observed).toBeNull();
    expect(r.detail).toMatch(/no text frame carried a resolution/);
  });
});

describe("browser_activity anchor (present default; absent for the decline path)", () => {
  function framesWithBrowser(withBrowser: boolean) {
    return [
      { ts: "t0", kind: "init", payload: { run_id: "r1", skill: "inventory_site_scan", driver_kind: "deepseek_apikey" } },
      ...(withBrowser
        ? [{ ts: "t1", kind: "browser.opened", payload: { url: "https://dealer.example/" } }]
        : []),
      { ts: "t2", kind: "aborted", payload: { reason: "user_declined" } },
    ];
  }

  it("default (present): passes only when browser frames flowed", () => {
    const withB = buildRunDetailFromEvents("r1", framesWithBrowser(true), "done");
    expect(evalAnchor({ kind: "browser_activity" }, withB, tmp.db, ctxFor(null)).ok).toBe(true);
    const withoutB = buildRunDetailFromEvents("r1", framesWithBrowser(false), "done");
    expect(evalAnchor({ kind: "browser_activity" }, withoutB, tmp.db, ctxFor(null)).ok).toBe(false);
  });

  it("expect=absent: passes on ZERO browser frames (a batch decline never navigates)", () => {
    const withoutB = buildRunDetailFromEvents("r1", framesWithBrowser(false), "declined");
    const r = evalAnchor({ kind: "browser_activity", expect: "absent" }, withoutB, tmp.db, ctxFor(null));
    expect(r.ok).toBe(true);
  });

  it("expect=absent: FAILS when any browser frame flowed", () => {
    const withB = buildRunDetailFromEvents("r1", framesWithBrowser(true), "declined");
    const r = evalAnchor({ kind: "browser_activity", expect: "absent" }, withB, tmp.db, ctxFor(null));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/must never navigate/);
  });
});

describe("four-tier verdict", () => {
  const okAnchor = (kind: string): AnchorResult => ({ kind, ok: true, expected: 1, observed: 1 });
  const failAnchor = (kind: string): AnchorResult => ({ kind, ok: false, expected: 1, observed: 0, detail: "fail" });
  const cc = { s1: "", s2: "", s3: "", confidence: "high" as const };

  const okUi = { surface: "api:/api/profiles/p1", selector: "profile-row", expected: "p1", observed: "present", ok: true };

  it("all anchors ok + a passing ui_check + high confidence → GREEN", () => {
    const v = buildVerdict({ cellId: "c", caseId: "case", layer: "L2", runId: "r", anchors: [okAnchor("run_status"), okAnchor("no_external_mutation")], uiChecks: [okUi], crossCheck: cc });
    expect(v.verdict).toBe("GREEN");
    expect(v.status).toBe("PASS");
  });

  it("vacuous-confirmation guard: L2+ with ZERO ui_checks is RED, never GREEN", () => {
    const v = buildVerdict({ cellId: "c", caseId: "case", layer: "L2", runId: "r", anchors: [okAnchor("run_status"), okAnchor("no_external_mutation")], crossCheck: cc });
    expect(v.verdict).toBe("RED");
    expect(v.defect_flag?.kind).toBe("ui_checks");
  });

  it("vacuous-confirmation guard does not apply below L2 (L1 pure-fn layer)", () => {
    const v = buildVerdict({ cellId: "c", caseId: "case", layer: "L1", runId: "r", anchors: [okAnchor("run_status")], crossCheck: cc });
    expect(v.verdict).toBe("GREEN");
  });

  it("keystone failure → BLOCKER (never RED)", () => {
    const v = buildVerdict({ cellId: "c", caseId: "case", layer: "L2", runId: "r", anchors: [okAnchor("run_status"), failAnchor("no_external_mutation")], crossCheck: cc });
    expect(v.verdict).toBe("BLOCKER");
    expect(v.defect_flag?.kind).toBe("no_external_mutation");
  });

  it("a non-keystone functional anchor failure → RED", () => {
    const v = buildVerdict({ cellId: "c", caseId: "case", layer: "L2", runId: "r", anchors: [failAnchor("table_min_rows")], crossCheck: cc });
    expect(v.verdict).toBe("RED");
  });

  it("a waivable anchor failure with a recorded reason → GREEN_WITH_WAIVER", () => {
    const v = buildVerdict({
      cellId: "c",
      caseId: "case",
      layer: "L2",
      runId: "r",
      anchors: [okAnchor("run_status"), failAnchor("browser_activity")],
      crossCheck: cc,
      waiver: { kind: "browser_activity", reason: "narrative slot unreachable (geocode-only step)" },
    });
    expect(v.verdict).toBe("GREEN_WITH_WAIVER");
    expect(v.waived_anchor?.kind).toBe("browser_activity");
  });

  it("lane defaults to api and records ui when passed (additive field)", () => {
    const def = buildVerdict({ cellId: "c", caseId: "case", layer: "L2", runId: "r", anchors: [okAnchor("run_status")], uiChecks: [okUi], crossCheck: cc });
    expect(def.lane).toBe("api");
    const ui = buildVerdict({ cellId: "c", caseId: "case", layer: "L2", lane: "ui", runId: "r", anchors: [okAnchor("run_status")], uiChecks: [okUi], crossCheck: cc });
    expect(ui.lane).toBe("ui");
  });

  it("a table_min_rows failure is waivable ONLY by an explicit table_min_rows waiver", () => {
    // The targeted empty-real-world-result waiver (Maps yields zero candidates).
    const explicit = buildVerdict({
      cellId: "c",
      caseId: "case",
      layer: "L2",
      runId: "r",
      anchors: [okAnchor("run_status"), okAnchor("no_external_mutation"), failAnchor("table_min_rows")],
      uiChecks: [okUi],
      crossCheck: cc,
      waiver: { kind: "table_min_rows", reason: "Maps yielded zero dealer candidates in radius" },
    });
    expect(explicit.verdict).toBe("GREEN_WITH_WAIVER");
    // A generic waiver naming a DIFFERENT kind still cannot cover it.
    const generic = buildVerdict({
      cellId: "c",
      caseId: "case",
      layer: "L2",
      runId: "r",
      anchors: [failAnchor("table_min_rows")],
      uiChecks: [okUi],
      crossCheck: cc,
      waiver: { kind: "browser_activity", reason: "unrelated" },
    });
    expect(generic.verdict).toBe("RED");
  });

  it("the keystone stays non-waivable even with an explicit waiver", () => {
    const v = buildVerdict({
      cellId: "c",
      caseId: "case",
      layer: "L2",
      runId: "r",
      anchors: [failAnchor("no_external_mutation")],
      uiChecks: [okUi],
      crossCheck: cc,
      waiver: { kind: "no_external_mutation", reason: "never" },
    });
    expect(v.verdict).toBe("BLOCKER");
  });

  it("confidence=low (S1/S2/S3 contradiction) → RED even with anchors ok", () => {
    const v = buildVerdict({ cellId: "c", caseId: "case", layer: "L2", runId: "r", anchors: [okAnchor("run_status")], crossCheck: { ...cc, confidence: "low" } });
    expect(v.verdict).toBe("RED");
  });

  it("an explicit regression → BLOCKER", () => {
    const v = buildVerdict({ cellId: "c", caseId: "case", layer: "L2", runId: "r", anchors: [okAnchor("run_status")], crossCheck: cc, regression: { kind: "frozen_invariant", detail: "schema drift" } });
    expect(v.verdict).toBe("BLOCKER");
  });
});

describe("computeConfidence", () => {
  it("all three agree → high", () => {
    expect(computeConfidence({ s1Ok: true, s2Ok: true, s3Ok: true })).toBe("high");
  });
  it("a contradiction → low", () => {
    expect(computeConfidence({ s1Ok: true, s2Ok: false, s3Ok: true })).toBe("low");
  });
  it("S2 unavailable but S1+S3 agree → medium", () => {
    expect(computeConfidence({ s1Ok: true, s2Ok: false, s3Ok: true, s2Available: false })).toBe("medium");
  });
});

// --- detail builders for the DB-anchor tests (no SSE server needed) ----------

function detailDone(_profileId: string | null, runId = "r1") {
  return buildRunDetailFromEvents(runId, createdRunFrames(), "done");
}
function declinedDetail() {
  return buildRunDetailFromEvents("r-dec", declinedRunFrames(), "declined");
}
