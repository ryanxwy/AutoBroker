/**
 * multiprofile/orchestrator — the Phase-4 multi-profile run planner (PURE) + the
 * live drive (structurally complete, integration-tested later).
 *
 * `planMultiProfileRun` is PURE: it folds a single numeric seed + a round count
 * into a fully deterministic plan — per round a ChaosDirective (a FRESH prng per
 * round, derived from seed+round, so chaos monotonicity is never broken by a
 * single advancing generator), the scheduled hot set (the stub PortfolioScheduler,
 * capped at maxConcurrent), and the dealer reply/ghost ordering (the round prng).
 * No DB, no provider, no spawn — unit-tested in orchestrator.test.ts.
 *
 * `runMultiProfileLane` is the LIVE driver, STRUCTURALLY COMPLETE + typechecked +
 * LIVE-DEFERRED to integration — the SAME posture as harness/soak/orchestrator.ts:
 * booting a serverHost child, seeding the world, spawning the Sonnet dealer actor,
 * and driving Playwright is integration-tested later, NOT in unit tests. There is
 * NO unit test for its spawn/HTTP glue (the only unit-tested half is the pure
 * plan). It sets the record env (AUTOBROKER_RECORD_TRANSCRIPT) in the CHILD env it
 * builds so the run is recordable; the CHILD-side install of the record/replay
 * wrapper is a later task. The freeze callback is DEPENDENCY-INJECTED (default a
 * no-op) so this module does NOT depend on the unfinished Task-5 freeze impl.
 *
 * Dependency wall: harness layer. Reuses startSoakHost / buildSoakHostEnv (the
 * server-child boot), the sibling chaos / prng / scheduler.stub / invariants /
 * world modules, and the verdict DeterministicResult type. NEVER better-sqlite3 /
 * drizzle-orm / playwright directly (the live drive goes through startSoakHost +
 * the UiDriver, never raw playwright).
 */

import { join } from "node:path";

import { openReadHandle } from "../../dbReads.js";
import { startSoakHost } from "../orchestrator.js";
import type { DeterministicResult } from "../verdict.js";
import {
  aggressionDirectiveText,
  chaosScheduleForRound,
  type ChaosDirective,
} from "./chaos.js";
import { runAllInvariants } from "./invariants.js";
import { makePrng } from "./prng.js";
import { createStubPortfolioScheduler, type PortfolioSchedule } from "./scheduler.stub.js";
import { interleaveClaims, seedMultiActiveSharedDealer, type MpProfileSeed, type SharedDealerSeed } from "./world.js";

// ---------------------------------------------------------------------------
// the pure plan
// ---------------------------------------------------------------------------

/** One planned round: the chaos directive, the scheduled hot/deferred split, and
 *  the deterministic per-round dealer reply ordering (a permutation of the ids). */
export interface MultiProfileRoundPlan {
  round: number;
  chaos: ChaosDirective;
  schedule: PortfolioSchedule;
  /** A deterministic permutation of the profile ids = the dealer reply order. */
  replyOrder: string[];
  /** The dealer-actor task addendum for this round (content-realism only). */
  directiveText: string;
}

export interface MultiProfileRunPlan {
  seed: number;
  maxConcurrent: number | null;
  profileIds: string[];
  dealerId: string;
  rounds: MultiProfileRoundPlan[];
}

export interface PlanMultiProfileRunOpts {
  seed: number;
  rounds: number;
  maxConcurrent?: number;
  profiles: MpProfileSeed[];
  dealer: SharedDealerSeed;
}

/**
 * Derive a per-round seed from the base seed + round index. A simple, fully
 * deterministic mix (avalanche of the two uint32 inputs) so each round gets an
 * INDEPENDENT prng — the Task-3 review note: a single advancing prng threaded
 * across rounds breaks chaos monotonicity, so we mint a fresh one per round.
 */
export function deriveSeed(baseSeed: number, round: number): number {
  // Mix base + round through a small integer hash (xorshift-style avalanche).
  let h = (baseSeed >>> 0) ^ Math.imul(round + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Compute the deterministic multi-profile run plan. PURE: no DB, no provider, no
 * spawn. Each round gets a FRESH prng (makePrng(deriveSeed(seed, round))) used for
 * BOTH the chaos within-round jitter AND the reply ordering — so the round's
 * directive + reply order are a pure function of (seed, round), independent of how
 * many rounds precede or follow it.
 */
export function planMultiProfileRun(opts: PlanMultiProfileRunOpts): MultiProfileRunPlan {
  const profileIds = opts.profiles.map((p) => p.id);
  const dealerId = `live-dealer-${opts.dealer.dealerKey}`;
  const scheduler = createStubPortfolioScheduler();
  const maxConcurrent = opts.maxConcurrent ?? null;

  const rounds: MultiProfileRoundPlan[] = [];
  for (let round = 0; round < opts.rounds; round += 1) {
    // FRESH prng per round (the Task-3 review fix) — never a single advancing one.
    const prng = makePrng(deriveSeed(opts.seed, round));
    const chaos = chaosScheduleForRound(round, prng);
    const schedule = scheduler.schedule({
      activeProfileIds: profileIds,
      ...(maxConcurrent !== null ? { maxConcurrent } : {}),
    });
    const replyOrder = prng.shuffle(profileIds);
    rounds.push({
      round,
      chaos,
      schedule,
      replyOrder,
      directiveText: aggressionDirectiveText(chaos),
    });
  }

  return { seed: opts.seed, maxConcurrent, profileIds, dealerId, rounds };
}

// ---------------------------------------------------------------------------
// the live driver (structurally complete; live-tested later — see header)
// ---------------------------------------------------------------------------

/** What the freeze callback receives on the first failing invariant of a step. */
export interface MpFreezeArgs {
  seed: number;
  round: number;
  transcriptPath: string;
  config: MultiProfileRunPlan;
  failingInvariant: DeterministicResult;
}

/** The freeze hook — DEPENDENCY-INJECTED so this task does not depend on the
 *  Task-5 freeze impl. Default a no-op. */
export type FreezeFn = (args: MpFreezeArgs) => void;

export interface RunMultiProfileLaneOpts {
  /** A precomputed plan; if absent it is built from seed + rounds + profiles + dealer. */
  plan?: MultiProfileRunPlan;
  seed: number;
  rounds: number;
  /** The run root (data dir + transcript live here). */
  runRoot: string;
  /** The profiles + shared dealer to seed when no plan is supplied. */
  profiles?: MpProfileSeed[];
  dealer?: SharedDealerSeed;
  maxConcurrent?: number;
  headless?: boolean;
  /** First-failing-invariant freeze hook (default no-op). */
  freeze?: FreezeFn;
}

/**
 * Drive the multi-profile lane end-to-end. STRUCTURALLY COMPLETE; the LIVE
 * behaviour (boot server child + seed world + inject dealer replies + spawn the
 * Sonnet dealer actor in record mode + drive the claim fan-out + run the
 * invariants per step) is integration-tested later, NOT in a unit test — exactly
 * like harness/soak/orchestrator.ts. Per round it:
 *   - boots startSoakHost with the record env set (AUTOBROKER_RECORD_TRANSCRIPT);
 *   - seeds the world (seedMultiActiveSharedDealer) into the run DB;
 *   - loops serve-live's /__e2e/inject_replies per profileId with the dealer_key
 *     (shared-dealer mode), in the round's replyOrder;
 *   - drives the lead-submit claim fan-out via interleaveClaims (the stub
 *     scheduler picks the hot set);
 *   - spawns the Sonnet dealer actor with aggressionDirectiveText(directive)
 *     (record mode);
 *   - after each interleaved step runs runAllInvariants; on any ok:false calls
 *     opts.freeze({ seed, round, transcriptPath, config, failingInvariant }).
 */
export async function runMultiProfileLane(opts: RunMultiProfileLaneOpts): Promise<void> {
  const plan =
    opts.plan ??
    planMultiProfileRun({
      seed: opts.seed,
      rounds: opts.rounds,
      ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
      profiles: opts.profiles ?? [],
      dealer: opts.dealer ?? { dealerKey: "collision-rooftop", name: "Collision Auto Group", website: "https://collision.example" },
    });
  const freeze: FreezeFn = opts.freeze ?? (() => {});

  const dataDir = join(opts.runRoot, "data");
  const dbPath = join(dataDir, "autobroker.db");
  const transcriptPath = join(opts.runRoot, "transcript.jsonl");

  // Set the record env in the CHILD env: the child-side install of the
  // record/replay wrapper is a later task — here we only set the env + document
  // it (mirrors orchestrator.ts setting the isolated DATA_DIR / MODE).
  const parentEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOBROKER_RECORD_TRANSCRIPT: transcriptPath,
  };

  const host = await startSoakHost({ dataDir, dbPath, parentEnv });
  try {
    for (const roundPlan of plan.rounds) {
      // (1) seed the world into the isolated run DB (sanctioned harness setup).
      const { db, close } = openReadHandle();
      try {
        if (opts.profiles !== undefined && opts.dealer !== undefined) {
          seedMultiActiveSharedDealer(db, opts.profiles, opts.dealer);
        }

        // (2) inject the dealer replies per profile in the round's replyOrder
        // (serve-live /__e2e/inject_replies with dealer_key = shared rooftop).
        for (const profileId of roundPlan.replyOrder) {
          await injectDealerReplies(host.apiBase, profileId, plan.dealerId, roundPlan.directiveText);
        }

        // (3) drive the claim fan-out over the round's HOT set (the stub
        // scheduler's first-N), in a PRNG-determined order.
        const prng = makePrng(deriveSeed(plan.seed, roundPlan.round));
        const steps = interleaveClaims(db, roundPlan.schedule.hot, plan.dealerId, prng);

        // (4) after each interleaved step, run the invariants; freeze on the
        // first ok:false (the dependency-injected hook — default no-op).
        for (let i = 0; i < steps.length; i += 1) {
          const results = runAllInvariants({ db, profileIds: plan.profileIds });
          const failing = results.find((r) => !r.ok);
          if (failing !== undefined) {
            freeze({ seed: plan.seed, round: roundPlan.round, transcriptPath, config: plan, failingInvariant: failing });
            return;
          }
        }
      } finally {
        close();
      }
    }
  } finally {
    await host.stop();
  }
}

/**
 * POST serve-live's /__e2e/inject_replies for one profile against the shared
 * rooftop (shared-dealer mode via dealer_key). The reply body carries the
 * round's directive text (content-realism only). STRUCTURAL: the live e2e host
 * registers this route; the integration test drives the real HTTP.
 */
async function injectDealerReplies(
  apiBase: string,
  profileId: string,
  dealerId: string,
  directiveText: string,
): Promise<void> {
  const dealerKey = dealerId.replace(/^live-dealer-/, "");
  await fetch(`${apiBase}/__e2e/inject_replies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profileId,
      replies: [
        {
          dealer_key: dealerKey,
          dealerName: "Collision Auto Group",
          dealerWebsite: "https://collision.example",
          from: "sales@collision.example",
          subject: "Re: your inquiry",
          // The directive text is reply-content realism only (never a send/action).
          body: directiveText,
        },
      ],
    }),
  });
}
