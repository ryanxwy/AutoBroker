/**
 * giveUp — the deterministic "keep negotiating vs give up & switch dealership"
 * verdict for one dealer. Pure: it takes already-fetched, already-quality-gated
 * signals and returns a decision. No DB, no I/O, no LLM — the register and the
 * walk-away threshold are a function of the numbers, never of a prompt.
 *
 * This is the COMPLEMENT of profileHealth's per-profile HOT/WARM/COLD: a
 * per-dealer advisory recomputed on read (no stored score, no Bayesian/Glicko
 * scorecard — the owner-simplicity choice). It NEVER auto-sends anything and
 * never writes profile_dealers.status; the caller surfaces it as advice behind
 * the existing human-approval floor.
 *
 * BATNA model (raw OTD): a stalled dealer's expected $ improvement is ~0, the
 * cost of continuing is non-zero, and switching is only rational when a
 * strictly-better ALTERNATIVE exists — so give_up_switch requires a competing
 * quote that beats this dealer by at least the assertive margin. The competing
 * OTD MUST already be itemization- and confidence-gated by the read layer (the
 * symmetric guard): a single non-itemized lowball phantom must never recommend
 * abandoning a solid, fully-itemized dealer.
 *
 * OTD inputs are RAW otd_total (matching classifyQuoteSituation), NOT tax-
 * normalized — keeping the verdict coherent and changing no existing tone
 * behavior. Cross-state normalization is a deferred owner decision (it would
 * also shift the assertive-tone classifier's snapshots).
 */

import { ASSERTIVE_OTD_DELTA_USD } from "./constants.js";
import type { FollowupCapDecision, GateDecision } from "./replyTargets.js";

/** The verdict for one dealer. */
export type DealerVerdict = "continue" | "hold" | "give_up_switch";

/** The dominant signal behind a verdict (for a voiced, budget-free advisory). */
export type GiveUpReason =
  | "active" // continue: within gate + cap, conceding or still fresh
  | "silent" // genuine coldness: the dealer went quiet past the silence window
  | "non_improving" // engaged but flat-or-worse across consecutive same-vehicle quotes
  | "retrade" // the OTD jumped UP between quotes (fee padding / re-trade bad faith)
  | "unanswered_cap" // anti-pester pause (auto-resumes the moment the dealer replies)
  | "total_cap"; // the runaway follow-up ceiling

export interface GiveUpInput {
  /** The timing gate (skip = cold past the silence window / wait / ready). */
  gate: GateDecision;
  /** The responsive follow-up cap (ok / unanswered_cap / total_cap). */
  cap: FollowupCapDecision;
  /** This dealer's recent OTDs for the SAME vehicle, NEWEST first (raw otd_total,
   *  already confidence-floored by the read). Length < 2 can't show movement. */
  otdTrajectory: readonly number[];
  /** Whether this dealer's current open quote is fully itemized. */
  isItemized: boolean;
  /** This dealer's current open OTD (raw), or null when not quoted. */
  currentOtd: number | null;
  /** Best competing dealer's OTD (raw) — ALREADY itemization + confidence gated by
   *  the read (the symmetric-BATNA guard). null when no quality competitor exists. */
  bestCompetingOtd: number | null;
}

export interface GiveUpDecision {
  verdict: DealerVerdict;
  reason: GiveUpReason;
  /** How many dollars the best quality competitor beats this dealer by (>= 0),
   *  or null when the two OTDs are not comparable (current not itemized / null). */
  batnaGapUsd: number | null;
}

/**
 * Decide whether to keep negotiating with a dealer, hold it as a low-priority
 * fallback, or give up and switch to a better alternative. Every stall signal is
 * already debounced upstream — gate=skip needs the full silence window, the cap
 * needs repeated unanswered sends, the trajectory predicates need >= 2 same-
 * vehicle quotes — so no single cold reply can ever reach a give-up.
 */
export function dealerGiveUpDecision(input: GiveUpInput): GiveUpDecision {
  const traj = input.otdTrajectory;

  // Flat-or-worse across two consecutive same-vehicle quote pairs (needs 3
  // quotes — the read's GIVEUP_TRAJECTORY_WINDOW supplies exactly that): the
  // dealer is engaged but not moving. NEWEST-first, so improving (conceding) means
  // traj[0] < traj[1] < traj[2]; non-improving is the negation.
  const nonImproving = traj.length >= 3 && traj[0]! >= traj[1]! && traj[1]! >= traj[2]!;
  // The OTD jumped UP by more than the assertive margin between consecutive
  // quotes — the canonical doc-fee/add-on re-trade after a lower number.
  const retrade = traj.length >= 2 && traj[0]! > traj[1]! + ASSERTIVE_OTD_DELTA_USD;

  // Genuine give-up evidence: the dealer went cold, or is engaged-but-stuck.
  const coldStall = input.gate === "skip" || nonImproving || retrade;
  // A mere throttle, NOT a give-up: the anti-pester cap auto-resumes on the next
  // dealer reply, and the total ceiling is a runaway backstop — neither means the
  // dealer is worth abandoning, so they can only ever justify a hold.
  const pausedStall = input.cap === "unanswered_cap" || input.cap === "total_cap";

  let reason: GiveUpReason;
  if (input.gate === "skip") reason = "silent";
  else if (retrade) reason = "retrade";
  else if (nonImproving) reason = "non_improving";
  else if (input.cap === "total_cap") reason = "total_cap";
  else if (input.cap === "unanswered_cap") reason = "unanswered_cap";
  else reason = "active";

  // A non-itemized current quote (e.g. a monthly-payment-only stonewaller) is no
  // usable OTD — treat it as null so a real itemized competitor still wins BATNA.
  const currentForBatna = input.isItemized ? input.currentOtd : null;
  const betterBatna =
    input.bestCompetingOtd !== null &&
    (currentForBatna === null ||
      input.bestCompetingOtd <= currentForBatna - ASSERTIVE_OTD_DELTA_USD);
  const batnaGapUsd =
    input.bestCompetingOtd !== null && currentForBatna !== null
      ? Math.max(0, currentForBatna - input.bestCompetingOtd)
      : null;

  let verdict: DealerVerdict;
  if (coldStall && betterBatna) verdict = "give_up_switch";
  else if (coldStall || pausedStall) verdict = "hold";
  else verdict = "continue";

  return { verdict, reason, batnaGapUsd };
}
