/**
 * invariants.test.ts — the multi-profile metamorphic/property invariants. TDD:
 * for EACH of the 8 invariants a fixture where it HOLDS (ok:true) and one where
 * it is VIOLATED (ok:false with a meaningful `detail`), plus an aggregator test
 * that `runAllInvariants` returns one result per applicable check.
 *
 * Five invariants read a REAL isolated tmp DB (makeTmpDb + the testSupport
 * inserters + direct SELECT-table seeds for profile_dealers/messages/threads/
 * thread_routing). Three are pure over typed inputs (traces / observations /
 * samples). ISOLATION: makeTmpDb() builds a throwaway tmp DB; never ~/.autobroker*.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@autobroker/db";

import { insertProfile, makeTmpDb, type TmpDb } from "../../testSupport.js";
import {
  assertBudgetNeverLeaks,
  assertDealershipExclusivity,
  assertFollowupCap,
  assertHistoryIdNoSkip,
  assertL2GateBeforeSend,
  assertMonotonicBestOtd,
  assertNoCrossProfileBleed,
  assertProfileAskBranch,
  runAllInvariants,
} from "./invariants.js";

// --- direct SELECT-only-table seed helpers (tables without a testSupport inserter) ---

function seedDealer(db: Db, dealerId: string): void {
  db.$client.prepare("INSERT OR IGNORE INTO dealers (dealer_id, name) VALUES (?, 'Test Dealer')").run(dealerId);
}

function seedProfileDealer(
  db: Db,
  opts: { profileId: string; dealerId: string; status: string; exclusionReason?: string | null },
): void {
  seedDealer(db, opts.dealerId);
  db.$client
    .prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status, exclusion_reason) VALUES (?, ?, ?, ?)",
    )
    .run(opts.profileId, opts.dealerId, opts.status, opts.exclusionReason ?? null);
}

function seedSubmittedLead(db: Db, opts: { submissionId: string; profileId: string; dealerId: string }): void {
  seedDealer(db, opts.dealerId);
  db.$client
    .prepare(
      "INSERT INTO lead_submissions (submission_id, search_profile_id, dealer_id, outcome, submission_channel) " +
        "VALUES (?, ?, ?, 'submitted', 'web_form')",
    )
    .run(opts.submissionId, opts.profileId, opts.dealerId);
}

function seedThread(db: Db, opts: { threadId: string; dealerId: string; profileId: string | null }): void {
  seedDealer(db, opts.dealerId);
  db.$client
    .prepare("INSERT INTO threads (thread_id, dealer_id, search_profile_id) VALUES (?, ?, ?)")
    .run(opts.threadId, opts.dealerId, opts.profileId);
}

let msgSeq = 0;
function seedMessage(
  db: Db,
  opts: { threadId: string; profileId: string | null; direction: "inbound" | "outbound"; body?: string },
): string {
  msgSeq += 1;
  const messageId = `m-${msgSeq}`;
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, thread_id, direction, search_profile_id, body_text) VALUES (?, ?, ?, ?, ?)",
    )
    .run(messageId, opts.threadId, opts.direction, opts.profileId, opts.body ?? null);
  return messageId;
}

let tmp: TmpDb;
let db: Db;

beforeEach(() => {
  tmp = makeTmpDb();
  db = tmp.db;
});

afterEach(() => {
  tmp.close();
});

// ---------------------------------------------------------------------------
// 1. dealership exclusivity
// ---------------------------------------------------------------------------

describe("assertDealershipExclusivity", () => {
  it("ok: at most one bound per dealer, every excluded_conflict voiced + silent for the loser", () => {
    insertProfile(db, "p1");
    insertProfile(db, "p2", { brand: "Toyota" });
    // p1 wins the dealer (bound); p2 lost the conflict (excluded, voiced, silent).
    seedProfileDealer(db, { profileId: "p1", dealerId: "d1", status: "bound" });
    seedProfileDealer(db, { profileId: "p2", dealerId: "d1", status: "excluded_conflict", exclusionReason: "engaged_by:p1" });
    const r = assertDealershipExclusivity(db);
    expect(r.assertionId).toBe("dealership_exclusivity");
    expect(r.ok).toBe(true);
  });

  it("violated (a): two profiles both bound to the same dealer", () => {
    insertProfile(db, "p1");
    insertProfile(db, "p2", { brand: "Toyota" });
    // Bypass the partial-unique index by seeding distinct dealer rows but a hand-
    // forged duplicate-bound state via a second dealer row would not collide; to
    // force the >1-bound condition we drop the index first (test-only seed).
    db.$client.prepare("DROP INDEX uq_profile_dealers_bound_dealer").run();
    seedProfileDealer(db, { profileId: "p1", dealerId: "d1", status: "bound" });
    seedProfileDealer(db, { profileId: "p2", dealerId: "d1", status: "bound" });
    const r = assertDealershipExclusivity(db);
    expect(r.ok).toBe(false);
    expect(r.detail).toBeTruthy();
    expect(r.detail).toContain("d1");
  });

  it("violated (b): an excluded_conflict row with no exclusion_reason (conflict not voiced)", () => {
    insertProfile(db, "p1");
    insertProfile(db, "p2", { brand: "Toyota" });
    seedProfileDealer(db, { profileId: "p1", dealerId: "d1", status: "bound" });
    seedProfileDealer(db, { profileId: "p2", dealerId: "d1", status: "excluded_conflict", exclusionReason: null });
    const r = assertDealershipExclusivity(db);
    expect(r.ok).toBe(false);
    expect(r.detail).toBeTruthy();
  });

  it("violated (c): the conflict loser still produced a submitted lead", () => {
    insertProfile(db, "p1");
    insertProfile(db, "p2", { brand: "Toyota" });
    seedProfileDealer(db, { profileId: "p1", dealerId: "d1", status: "bound" });
    seedProfileDealer(db, { profileId: "p2", dealerId: "d1", status: "excluded_conflict", exclusionReason: "engaged_by:p1" });
    // The loser (p2) must have ZERO submitted lead for d1 — seed one to violate.
    seedSubmittedLead(db, { submissionId: "ls-bad", profileId: "p2", dealerId: "d1" });
    const r = assertDealershipExclusivity(db);
    expect(r.ok).toBe(false);
    expect(r.detail).toBeTruthy();
  });

  it("violated (c): the conflict loser still produced an outbound message", () => {
    insertProfile(db, "p1");
    insertProfile(db, "p2", { brand: "Toyota" });
    seedProfileDealer(db, { profileId: "p1", dealerId: "d1", status: "bound" });
    seedProfileDealer(db, { profileId: "p2", dealerId: "d1", status: "excluded_conflict", exclusionReason: "engaged_by:p1" });
    // An outbound message on a thread of (p2, d1) — a send for the loser.
    seedThread(db, { threadId: "t-bad", dealerId: "d1", profileId: "p2" });
    seedMessage(db, { threadId: "t-bad", profileId: "p2", direction: "outbound", body: "hi" });
    const r = assertDealershipExclusivity(db);
    expect(r.ok).toBe(false);
    expect(r.detail).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. no cross-profile bleed
// ---------------------------------------------------------------------------

describe("assertNoCrossProfileBleed", () => {
  it("ok: every NOT-NULL search_profile_id row belongs to a known profile", () => {
    insertProfile(db, "p1");
    seedProfileDealer(db, { profileId: "p1", dealerId: "d1", status: "candidate" });
    const r = assertNoCrossProfileBleed(db, ["p1"]);
    expect(r.assertionId).toBe("no_cross_profile_bleed");
    expect(r.ok).toBe(true);
  });

  it("violated: a profile_dealers row references an unknown profile", () => {
    insertProfile(db, "p1");
    seedProfileDealer(db, { profileId: "p-stray", dealerId: "d1", status: "candidate" });
    const r = assertNoCrossProfileBleed(db, ["p1"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("p-stray");
  });
});

// ---------------------------------------------------------------------------
// 3. budget never leaks (#9)
// ---------------------------------------------------------------------------

describe("assertBudgetNeverLeaks", () => {
  function setBudget(profileId: string, budget: number): void {
    db.$client.prepare("UPDATE search_profiles SET budget_max = ? WHERE search_profile_id = ?").run(budget, profileId);
  }

  it("ok: no outbound message echoes the budget number in any rendering", () => {
    insertProfile(db, "p1");
    setBudget("p1", 38000);
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p1" });
    seedMessage(db, { threadId: "t1", profileId: "p1", direction: "outbound", body: "Looking for your best out-the-door price." });
    const r = assertBudgetNeverLeaks(db, ["p1"]);
    expect(r.assertionId).toBe("budget_no_leak");
    expect(r.ok).toBe(true);
  });

  it("violated: an outbound body contains the comma-formatted budget", () => {
    insertProfile(db, "p1");
    setBudget("p1", 38000);
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p1" });
    const leakId = seedMessage(db, { threadId: "t1", profileId: "p1", direction: "outbound", body: "I can stretch to $38,000 max." });
    const r = assertBudgetNeverLeaks(db, ["p1"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(leakId);
    // #9: the budget figure must NOT appear in the produced detail.
    expect(r.detail).not.toContain("38000");
    expect(r.detail).not.toContain("38,000");
  });

  it("violated: an outbound body contains the k-form (38k)", () => {
    insertProfile(db, "p1");
    setBudget("p1", 38000);
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p1" });
    const leakId = seedMessage(db, { threadId: "t1", profileId: "p1", direction: "outbound", body: "budget is around 38k" });
    const r = assertBudgetNeverLeaks(db, ["p1"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(leakId);
  });

  it("ok: an inbound message echoing the budget is NOT a leak (only outbound is scanned)", () => {
    insertProfile(db, "p1");
    setBudget("p1", 38000);
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p1" });
    seedMessage(db, { threadId: "t1", profileId: "p1", direction: "inbound", body: "We can do 38000 OTD." });
    const r = assertBudgetNeverLeaks(db, ["p1"]);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. history-id no skip (every inbound message attributed)
// ---------------------------------------------------------------------------

describe("assertHistoryIdNoSkip", () => {
  it("ok: every inbound message is attributed to a known profile", () => {
    insertProfile(db, "p1");
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p1" });
    seedMessage(db, { threadId: "t1", profileId: "p1", direction: "inbound", body: "reply" });
    const r = assertHistoryIdNoSkip(db, ["p1"]);
    expect(r.assertionId).toBe("history_id_no_skip");
    expect(r.ok).toBe(true);
  });

  it("violated: an inbound message with a null search_profile_id (a dropped historyId)", () => {
    insertProfile(db, "p1");
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p1" });
    const orphanId = seedMessage(db, { threadId: "t1", profileId: null, direction: "inbound", body: "orphan reply" });
    const r = assertHistoryIdNoSkip(db, ["p1"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(orphanId);
  });

  it("violated: an inbound message attributed to an unknown profile", () => {
    insertProfile(db, "p1");
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p-foreign" });
    const orphanId = seedMessage(db, { threadId: "t1", profileId: "p-foreign", direction: "inbound", body: "foreign reply" });
    const r = assertHistoryIdNoSkip(db, ["p1"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(orphanId);
  });
});

// ---------------------------------------------------------------------------
// 5. followup cap
// ---------------------------------------------------------------------------

describe("assertFollowupCap", () => {
  it("ok: trailing unanswered outbound count is within the ceiling", () => {
    insertProfile(db, "p1");
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p1" });
    // 3 trailing outbound (< default ceiling 10).
    seedMessage(db, { threadId: "t1", profileId: "p1", direction: "inbound" });
    seedMessage(db, { threadId: "t1", profileId: "p1", direction: "outbound" });
    seedMessage(db, { threadId: "t1", profileId: "p1", direction: "outbound" });
    seedMessage(db, { threadId: "t1", profileId: "p1", direction: "outbound" });
    const r = assertFollowupCap(db, ["p1"], 10);
    expect(r.assertionId).toBe("followup_cap");
    expect(r.ok).toBe(true);
  });

  it("ok: a trailing inbound resets the trailing-outbound run to zero", () => {
    insertProfile(db, "p1");
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p1" });
    for (let i = 0; i < 12; i += 1) seedMessage(db, { threadId: "t1", profileId: "p1", direction: "outbound" });
    seedMessage(db, { threadId: "t1", profileId: "p1", direction: "inbound" }); // trailing reply
    const r = assertFollowupCap(db, ["p1"], 10);
    expect(r.ok).toBe(true);
  });

  it("violated: more than `ceiling` consecutive trailing outbound", () => {
    insertProfile(db, "p1");
    seedThread(db, { threadId: "t1", dealerId: "d1", profileId: "p1" });
    for (let i = 0; i < 11; i += 1) seedMessage(db, { threadId: "t1", profileId: "p1", direction: "outbound" });
    const r = assertFollowupCap(db, ["p1"], 10);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("t1");
  });
});

// ---------------------------------------------------------------------------
// 6. L2 gate before send
// ---------------------------------------------------------------------------

describe("assertL2GateBeforeSend", () => {
  it("ok: every send is preceded by an approval_gate", () => {
    const r = assertL2GateBeforeSend([
      { runId: "r1", events: ["approval_gate", "send"] },
      { runId: "r2", events: ["approval_gate", "send", "approval_gate", "send"] },
    ]);
    expect(r.assertionId).toBe("l2_gate_before_send");
    expect(r.ok).toBe(true);
  });

  it("violated: a send with no preceding approval_gate", () => {
    const r = assertL2GateBeforeSend([{ runId: "r-bad", events: ["send"] }]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("r-bad");
  });

  it("violated: a send before its gate (wrong order)", () => {
    const r = assertL2GateBeforeSend([{ runId: "r-order", events: ["send", "approval_gate"] }]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("r-order");
  });
});

// ---------------------------------------------------------------------------
// 7. profile-ASK branch
// ---------------------------------------------------------------------------

describe("assertProfileAskBranch", () => {
  it("ok: pinned→run, 1→run, 0→stop, 2+→stop", () => {
    const r = assertProfileAskBranch([
      { activeCount: 3, pinned: true, outcome: "run" },
      { activeCount: 1, pinned: false, outcome: "run" },
      { activeCount: 0, pinned: false, outcome: "stop" },
      { activeCount: 2, pinned: false, outcome: "stop" },
    ]);
    expect(r.assertionId).toBe("profile_ask_branch");
    expect(r.ok).toBe(true);
  });

  it("violated: 2 active, not pinned, but it ran (must stop)", () => {
    const r = assertProfileAskBranch([{ activeCount: 2, pinned: false, outcome: "run" }]);
    expect(r.ok).toBe(false);
    expect(r.detail).toBeTruthy();
  });

  it("violated: 0 active but it ran (must stop)", () => {
    const r = assertProfileAskBranch([{ activeCount: 0, pinned: false, outcome: "run" }]);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. monotonic best OTD
// ---------------------------------------------------------------------------

describe("assertMonotonicBestOtd", () => {
  it("ok: best OTD is non-increasing over time per profile", () => {
    const r = assertMonotonicBestOtd([
      { profileId: "p1", t: 1, bestOtd: 40000 },
      { profileId: "p1", t: 2, bestOtd: 39000 },
      { profileId: "p1", t: 3, bestOtd: 39000 },
      { profileId: "p2", t: 1, bestOtd: 50000 },
      { profileId: "p2", t: 2, bestOtd: 48000 },
    ]);
    expect(r.assertionId).toBe("monotonic_best_otd");
    expect(r.ok).toBe(true);
  });

  it("violated: a profile's best OTD got WORSE (increased) over time", () => {
    const r = assertMonotonicBestOtd([
      { profileId: "p1", t: 1, bestOtd: 39000 },
      { profileId: "p1", t: 2, bestOtd: 41000 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("p1");
  });
});

// ---------------------------------------------------------------------------
// aggregator
// ---------------------------------------------------------------------------

describe("runAllInvariants", () => {
  it("runs the DB invariants always; the trace/sample ones only when provided", () => {
    insertProfile(db, "p1");
    seedProfileDealer(db, { profileId: "p1", dealerId: "d1", status: "candidate" });
    const dbOnly = runAllInvariants({ db, profileIds: ["p1"] });
    const dbIds = dbOnly.map((r) => r.assertionId).sort();
    expect(dbIds).toEqual(
      ["budget_no_leak", "dealership_exclusivity", "followup_cap", "history_id_no_skip", "no_cross_profile_bleed"].sort(),
    );
    expect(dbOnly.every((r) => r.ok)).toBe(true);

    const full = runAllInvariants({
      db,
      profileIds: ["p1"],
      traces: [{ runId: "r1", events: ["approval_gate", "send"] }],
      profileAsk: [{ activeCount: 1, pinned: false, outcome: "run" }],
      otdSeries: [{ profileId: "p1", t: 1, bestOtd: 40000 }],
    });
    const fullIds = full.map((r) => r.assertionId).sort();
    expect(fullIds).toEqual(
      [
        "budget_no_leak",
        "dealership_exclusivity",
        "followup_cap",
        "history_id_no_skip",
        "l2_gate_before_send",
        "monotonic_best_otd",
        "no_cross_profile_bleed",
        "profile_ask_branch",
      ].sort(),
    );
    expect(full.every((r) => r.ok)).toBe(true);
  });

  it("aggregates a failure with a meaningful detail", () => {
    insertProfile(db, "p1");
    // A cross-profile bleed: a stray profile id.
    seedProfileDealer(db, { profileId: "p-stray", dealerId: "d1", status: "candidate" });
    const results = runAllInvariants({ db, profileIds: ["p1"] });
    const bleed = results.find((r) => r.assertionId === "no_cross_profile_bleed");
    expect(bleed?.ok).toBe(false);
    expect(bleed?.detail).toContain("p-stray");
  });
});
