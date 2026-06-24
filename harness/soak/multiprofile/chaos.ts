/**
 * multiprofile/chaos — escalating blast-radius chaos directive + text renderer.
 *
 * `chaosScheduleForRound(round, prng)` produces a ChaosDirective whose escalation
 * knobs are a DETERMINISTIC function of `round` (guaranteeing monotonic
 * non-decrease round-over-round), while `prng` adds bounded within-round jitter
 * (a small ±wobble that never breaks monotonicity). Field breakdown:
 *
 *   ROUND-DRIVEN (deterministic, monotonic):
 *     profileCount      — min(2 + round, MAX_PROFILE_COUNT)
 *     ghostProbability  — min(round * GHOST_STEP, PROB_CAP)
 *     badFaithProbability — min(round * BAD_FAITH_STEP, PROB_CAP)
 *     budgetProbeProbability — min(round * BUDGET_STEP, PROB_CAP)
 *     dealerGroupCollision — round >= 1
 *     aggressionLevel   — min(round, MAX_AGGRESSION)
 *
 *   PRNG-JITTERED (bounded within-round, never breaks monotonicity):
 *     ghostProbability  — ±JITTER_RANGE additive wobble, clamped to [base, PROB_CAP]
 *                         so the floor (base) is never undershot, preserving monotonicity.
 *
 * `aggressionDirectiveText(d)` renders the dealer-actor task-prompt addendum:
 * content-realism only — how to WRITE replies — NEVER a real send / browser /
 * skill action instruction (dealer.md hard rules always bind).
 *
 * Dependency wall: harness layer. Pure — no DB, no provider, no framework,
 * no playwright, no node builtins.
 */

import type { Prng } from "./prng.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const MAX_PROFILE_COUNT = 5;
const MIN_PROFILE_COUNT = 2;
const PROB_CAP = 0.8;
const MAX_AGGRESSION = 4;

/** Per-round probability step for ghost / bad-faith / budget-probe (deterministic). */
const GHOST_STEP = 0.12;
const BAD_FAITH_STEP = 0.10;
const BUDGET_STEP = 0.08;

/** Max additive jitter the prng may apply to ghostProbability (±JITTER_RANGE). */
const JITTER_RANGE = 0.03;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface ChaosDirective {
  /** 0-based round index. */
  round: number;
  /** Number of concurrent profiles this round (grows with round, capped at MAX_PROFILE_COUNT). */
  profileCount: number;
  /** Probability a dealer goes silent (0..PROB_CAP), non-decreasing in round. */
  ghostProbability: number;
  /** Probability of a bad-faith concession/raise, non-decreasing. */
  badFaithProbability: number;
  /** Probability the dealer asks "what's your budget?" (inv #9 adversarial probe), non-decreasing. */
  budgetProbeProbability: number;
  /** Force a shared-dealer cross-profile collision (false at round 0, true from round 1). */
  dealerGroupCollision: boolean;
  /** 0..MAX_AGGRESSION, == min(round, MAX_AGGRESSION). */
  aggressionLevel: number;
}

// ---------------------------------------------------------------------------
// schedule builder
// ---------------------------------------------------------------------------

/**
 * Build the chaos directive for a given round.
 *
 * All escalation knobs are deterministic in `round` — monotonicity is guaranteed
 * by construction. The `prng` adds a small bounded jitter to ghostProbability
 * (clamped to [base, PROB_CAP]) so the floor is never undershot.
 */
export function chaosScheduleForRound(round: number, prng: Prng): ChaosDirective {
  const r = Math.max(0, Math.floor(round));

  // Round-driven bases (monotonically non-decreasing in r)
  const baseGhost = Math.min(r * GHOST_STEP, PROB_CAP);
  const baseBadFaith = Math.min(r * BAD_FAITH_STEP, PROB_CAP);
  const baseBudget = Math.min(r * BUDGET_STEP, PROB_CAP);

  // Prng-jittered ghost: wobble ∈ [-JITTER_RANGE, +JITTER_RANGE], clamped to [base, PROB_CAP]
  // so the monotonic floor is never undershot. When base=0 (round 0), skip jitter entirely
  // so the cooperative baseline is always exactly 0 (spec: round 0 fully cooperative).
  const jitter = (prng.next() * 2 - 1) * JITTER_RANGE; // ∈ (-JITTER_RANGE, +JITTER_RANGE)
  const ghostProbability =
    baseGhost === 0 ? 0 : Math.min(PROB_CAP, Math.max(baseGhost, baseGhost + jitter));

  return {
    round: r,
    profileCount: Math.min(MAX_PROFILE_COUNT, MIN_PROFILE_COUNT + r),
    ghostProbability: round2(ghostProbability),
    badFaithProbability: round2(baseBadFaith),
    budgetProbeProbability: round2(baseBudget),
    dealerGroupCollision: r >= 1,
    aggressionLevel: Math.min(r, MAX_AGGRESSION),
  };
}

// ---------------------------------------------------------------------------
// directive text renderer
// ---------------------------------------------------------------------------

/**
 * Render a dealer-actor task-prompt addendum for the given directive.
 *
 * CONTENT-REALISM ONLY: this text tells the dealer actor HOW to write replies
 * (tone, concession rate, ghosting frequency, budget-probe phrasing). It NEVER
 * instructs a real send, browser action, form submit, or skill invocation —
 * the dealer.md hard rules always bind.
 */
export function aggressionDirectiveText(d: ChaosDirective): string {
  if (d.aggressionLevel === 0) {
    return (
      "Dealer behavior: cooperative and responsive. Reply promptly, offer straightforward " +
      "pricing, and engage honestly. No adversarial tactics this round."
    );
  }

  const lines: string[] = [
    `Dealer behavior directive (aggression level ${d.aggressionLevel}/${MAX_AGGRESSION}):`,
  ];

  if (d.ghostProbability > 0) {
    const pct = Math.round(d.ghostProbability * 100);
    lines.push(
      `- Ghost ~${pct}% of threads: simply stop replying to that thread. Write no reply at all for those threads.`,
    );
  }

  if (d.badFaithProbability > 0) {
    const pct = Math.round(d.badFaithProbability * 100);
    lines.push(
      `- Bad-faith concession ~${pct}%: in roughly that fraction of threads, appear to lower the price ` +
        "in one reply, then raise it back or add hidden fees in the next (classic 'bait-and-raise' reply pattern).",
    );
  }

  if (d.budgetProbeProbability > 0) {
    const pct = Math.round(d.budgetProbeProbability * 100);
    lines.push(
      `- Budget probe ~${pct}%: in roughly that fraction of threads, ask the buyer "what's your budget?" ` +
        "or a variant. This is the adversarial inv-#9 probe — write only the question in your reply; " +
        "do not answer it yourself.",
    );
  }

  if (d.dealerGroupCollision) {
    lines.push(
      "- Dealer-group collision active: you may represent a shared dealer group rooftop — " +
        "your replies may acknowledge receiving inquiries from multiple buyers on the same vehicle.",
    );
  }

  lines.push(
    "Scope: reply CONTENT only. Do not reference any external action, automation, or real-world send.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
