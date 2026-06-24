/**
 * collision.test.ts — THE headline Phase-4 deterministic verify. ONE cohesive
 * seeded mock/replay multi-profile run with NO PROVIDER anywhere.
 *
 * The story (per task-4-brief §collision.test.ts):
 *   1. isolated tmp DB; seed TWO different-brand active profiles sharing ONE dealer
 *      via seedMultiActiveSharedDealer (A=Honda Accord EX-L, B=Toyota Camry XSE).
 *   2. install a ReplayModel via __setHarnessModelWrapper built from a small
 *      recorded transcript (record a makeStructuredObjectModel call through
 *      recordingModel into an in-memory sink → TraceIndex → replayModel). So any
 *      SUT model call in this run resolves with NO provider. Reset in a finally.
 *   3. with makePrng(fixed seed), interleaveClaims(db, [A,B], dealerId, prng).
 *   4. assert the collision resolved: exactly one 'claimed' (its row 'bound'); the
 *      other 'conflict' with a non-empty heldByVehicle (VOICED) + its row
 *      'excluded_conflict' + exclusion_reason='engaged_by:<winner>'.
 *   5. assert ZERO SEND for the loser: assertDealershipExclusivity ok; ZERO
 *      submitted lead + ZERO outbound message for the loser (there are none).
 *   6. assert ALL invariants: runAllInvariants({db, profileIds:[A,B]}) → every ok.
 *   7. replay leg, NO provider: resolveModel("deepseek.cheap").doGenerate(SAME_OPTS)
 *      returns the recorded result token-for-token (deep-equal); re-assert all
 *      invariants still hold.
 *   8. engage-then-abort (no permanent lock): releaseDealerClaims(winner) then
 *      claimDealer(loser) now succeeds; exclusivity still holds.
 *
 * NO live provider: the "real" model is a deterministic v3 fake (testSupport's
 * makeStructuredObjectModel) recorded once, replayed with no provider. budget #9:
 * the seeded budgetMax values exist only so budget_no_leak has data — we assert
 * the leak invariant PASSES and never print a budget figure.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Db } from "@autobroker/db";
import { claimDealer, releaseDealerClaims } from "@autobroker/tools";
import {
  __resetHarnessModelWrapper,
  __setHarnessModelWrapper,
  recordingModel,
  replayModel,
  resolveModel,
  TraceIndex,
  type TranscriptEvent,
  type TranscriptSink,
} from "@autobroker/model";
import { makeStructuredObjectModel } from "@autobroker/model";

import { makeTmpDb } from "../../testSupport.js";
import { assertDealershipExclusivity, runAllInvariants } from "./invariants.js";
import { makePrng } from "./prng.js";
import { interleaveClaims, seedMultiActiveSharedDealer } from "./world.js";

// The fixed multi-profile seed: two DIFFERENT-BRAND active profiles sharing ONE
// rooftop. Budgets feed budget_no_leak only — never printed (inv #9).
const PROFILE_A = {
  id: "collide-accord",
  year: 2026,
  make: "Honda",
  model: "Accord",
  trim: "EX-L",
  budgetMax: 40000,
};
const PROFILE_B = {
  id: "collide-camry",
  year: 2026,
  make: "Toyota",
  model: "Camry",
  trim: "XSE",
  budgetMax: 42000,
};
const SHARED_DEALER = {
  dealerKey: "collision-rooftop",
  name: "Collision Auto Group",
  website: "https://collision.example",
};

/** In-memory transcript sink (same idiom as recordReplay.test.ts). */
function memSink(): TranscriptSink & { events: TranscriptEvent[] } {
  const events: TranscriptEvent[] = [];
  return { events, append: (ev) => events.push(ev) };
}

/** A minimal v3 call-options object around a single user message. Typed loosely
 *  (the harness does not import @ai-sdk/provider) — the shape resolveModel's
 *  doGenerate accepts is `{ prompt }` with the v3 message shape. */
function callOpts(text: string): { prompt: unknown } {
  return { prompt: [{ role: "user", content: [{ type: "text", text }] }] };
}

afterEach(() => __resetHarnessModelWrapper());

describe("collision — seeded mock/replay multi-profile run (NO provider)", () => {
  it("shared-dealer collision: one bound + one excluded(voiced) + zero send for the loser + all invariants + replay leg + engage-then-abort", async () => {
    const tmp = makeTmpDb();
    const db: Db = tmp.db;
    const profileIds = [PROFILE_A.id, PROFILE_B.id];

    // (2) Record ONE call through recordingModel into an in-memory sink, build a
    // TraceIndex, and install a ReplayModel via the registry DI seam. Any SUT
    // model call in this run now resolves with NO provider. The recorded "real"
    // model is a deterministic v3 fake (no live LLM). SAME_OPTS is reused for the
    // explicit replay leg (step 7) — it must hash-match the recorded call.
    const SAME_OPTS = callOpts("multi-profile collision replay probe");
    const realModel = makeStructuredObjectModel({ object: { verdict: "ok" } });
    const sink = memSink();
    const recorder = recordingModel(
      realModel as Parameters<typeof recordingModel>[0],
      sink,
      { runId: "collision-run", alias: "deepseek.cheap" },
    );
    const recorded = await recorder.doGenerate(SAME_OPTS as never);
    const index = new TraceIndex(sink.events);
    __setHarnessModelWrapper((_model, alias) =>
      replayModel(index, { alias, modelId: sink.events[0]!.modelId }),
    );

    try {
      // (1) Seed two different-brand active profiles + ONE shared dealer + a
      // 'candidate' profile_dealers row per profile (mirrors serve-live B2).
      const { dealerId } = seedMultiActiveSharedDealer(db, [PROFILE_A, PROFILE_B], SHARED_DEALER);
      expect(dealerId).toBe(`live-dealer-${SHARED_DEALER.dealerKey}`);

      // (3) Drive the claim fan-out in a PRNG-determined order.
      const steps = interleaveClaims(db, profileIds, dealerId, makePrng(1234));
      expect(steps).toHaveLength(2);

      // (4) Exactly one 'claimed', the other 'conflict' with a VOICED holder.
      const claimed = steps.filter((s) => s.result.kind === "claimed");
      const conflicts = steps.filter((s) => s.result.kind === "conflict");
      expect(claimed).toHaveLength(1);
      expect(conflicts).toHaveLength(1);

      const winner = claimed[0]!.profileId;
      const loserStep = conflicts[0]!;
      const loser = loserStep.profileId;
      expect(winner).not.toBe(loser);

      // The conflict is VOICED: a non-empty held-by vehicle label, no budget figure.
      const conflictResult = loserStep.result as {
        kind: "conflict";
        heldByProfileId: string;
        heldByVehicle: string;
      };
      expect(conflictResult.heldByProfileId).toBe(winner);
      expect(conflictResult.heldByVehicle.trim().length).toBeGreaterThan(0);
      expect(conflictResult.heldByVehicle).toMatch(/Honda|Toyota/);

      // The winner's row is 'bound'; the loser's row is 'excluded_conflict' with
      // exclusion_reason='engaged_by:<winner>'.
      const winnerRow = rowStatus(db, winner, dealerId);
      const loserRow = rowStatus(db, loser, dealerId);
      expect(winnerRow.status).toBe("bound");
      expect(loserRow.status).toBe("excluded_conflict");
      expect(loserRow.exclusion_reason).toBe(`engaged_by:${winner}`);

      // (5) ZERO SEND for the loser. The exclusivity invariant proves: no double
      // bind, every conflict voiced, ZERO submitted lead + ZERO outbound message
      // for any excluded_conflict row. Plus a direct count for the loser.
      expect(assertDealershipExclusivity(db).ok).toBe(true);
      expect(submittedLeadCount(db, loser, dealerId)).toBe(0);
      expect(outboundMessageCount(db, loser, dealerId)).toBe(0);

      // (6) Every invariant holds.
      const before = runAllInvariants({ db, profileIds });
      for (const r of before) expect(r.ok, `${r.assertionId}: ${r.detail ?? ""}`).toBe(true);
      // budget_no_leak specifically PASSES (inv #9: the figure exists in seed data
      // but never reaches an outbound body — and we never print the number here).
      expect(before.find((r) => r.assertionId === "budget_no_leak")?.ok).toBe(true);

      // (7) REPLAY leg, NO provider: resolveModel returns the wrapped ReplayModel;
      // doGenerate(SAME_OPTS) returns the recorded result token-for-token. (Cast
      // through unknown: resolveModel's LanguageModel union is wider than the v3
      // doGenerate shape we exercise — the wrapper guarantees a v3 ReplayModel.)
      const replayResolved = resolveModel("deepseek.cheap") as unknown as {
        doGenerate: (o: unknown) => Promise<unknown>;
      };
      const replayed = await replayResolved.doGenerate(SAME_OPTS);
      expect(replayed).toEqual(recorded);

      // re-assert all invariants still hold after the replay leg.
      const after = runAllInvariants({ db, profileIds });
      for (const r of after) expect(r.ok, `${r.assertionId}: ${r.detail ?? ""}`).toBe(true);

      // (8) ENGAGE-THEN-ABORT (no permanent lock): release the winner, then the
      // loser can claim the freed rooftop.
      expect(releaseDealerClaims({ searchProfileId: winner, db })).toBe(1);
      const retry = claimDealer({ searchProfileId: loser, dealerId, db });
      expect(retry.kind).toBe("claimed");
      expect(rowStatus(db, loser, dealerId).status).toBe("bound");
      // Exclusivity still holds (the winner's row is now 'closed_out', the loser bound).
      expect(assertDealershipExclusivity(db).ok).toBe(true);
    } finally {
      tmp.close();
    }
  });
});

// --- read-only helpers (the test's own assertions; SELECT-only) -------------

function rowStatus(
  db: Db,
  profileId: string,
  dealerId: string,
): { status: string; exclusion_reason: string | null } {
  return db.$client
    .prepare(
      "SELECT status, exclusion_reason FROM profile_dealers WHERE search_profile_id = ? AND dealer_id = ?",
    )
    .get(profileId, dealerId) as { status: string; exclusion_reason: string | null };
}

function submittedLeadCount(db: Db, profileId: string, dealerId: string): number {
  const row = db.$client
    .prepare(
      "SELECT COUNT(*) AS n FROM lead_submissions WHERE search_profile_id = ? AND dealer_id = ? AND outcome = 'submitted'",
    )
    .get(profileId, dealerId) as { n: number };
  return row.n;
}

function outboundMessageCount(db: Db, profileId: string, dealerId: string): number {
  const row = db.$client
    .prepare(
      "SELECT COUNT(*) AS n FROM messages m JOIN threads t ON t.thread_id = m.thread_id " +
        "WHERE t.search_profile_id = ? AND t.dealer_id = ? AND m.direction = 'outbound'",
    )
    .get(profileId, dealerId) as { n: number };
  return row.n;
}
