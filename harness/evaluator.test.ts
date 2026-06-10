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

/** Build an EvalContext from a profileId, snapshotting before(null)/after(id). */
function ctxFor(profileId: string | null): EvalContext {
  const before = snapshotCounts(null, tmp.db);
  const after = snapshotCounts(profileId, tmp.db);
  return { profileId, before, after, runWindow: { from: "2026-06-05", to: "2026-06-05~" } };
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
