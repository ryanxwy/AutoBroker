/**
 * negotiationStatus — the deterministic per-thread "where does this haggle stand"
 * overlay. Pure: it takes already-fetched signals and returns a status. This is a
 * READ-ONLY PROJECTION (never a stored column — so it can never drift the way the
 * ad-hoc threads.state writers do); it is recomputed each read from the current
 * quotes + the timing gate + the follow-up cap, mirroring profileHealth.
 *
 * Concession movement uses the deterministic NUMERIC otd trajectory (current vs
 * prior same-vehicle OTD), NOT the LLM-emitted dealer_quotes.intent — an LLM
 * mislabel can never alone flip the status (the adversarial-review ruling).
 *
 * The persisted threads.state lifecycle (replied/quoted -> negotiating ->
 * agreed/closed/suppressed) is untouched and remains authoritative for the
 * terminal facts; this overlay only adds the live-dynamics granularity
 * (countered / stalled / dormant / lead_sent) the flat state column can't express.
 */

import type { FollowupCapDecision, GateDecision } from "./replyTargets.js";

/** The live-dynamics status of one negotiation thread. */
export type NegotiationStatus =
  | "dead" // terminal: the thread was closed out or hygiene-suppressed
  | "agreed" // terminal: a deal was reached
  | "dormant" // we have stopped / will stop following up (cold gate or the cap)
  | "lead_sent" // we reached out, the dealer has not replied yet
  | "countered" // open quote whose OTD DROPPED vs the prior round — the dealer is conceding
  | "stalled" // open quote whose OTD is flat-or-worse across rounds — not moving
  | "quoted" // a single open quote, no movement to judge yet
  | "replied"; // the dealer replied but no extractable quote (or default)

export interface NegotiationStatusInput {
  /** threads.state (the persisted lifecycle fact). */
  persistedState: string;
  /** The timing gate (skip = cold past the silence window / wait / ready). */
  gate: GateDecision;
  /** The responsive follow-up cap (ok / unanswered_cap / total_cap). */
  cap: FollowupCapDecision;
  /** Latest INBOUND message timestamp (epoch ms), or null when never replied. */
  lastInboundAtMs: number | null;
  /** Total follow-ups we have ever sent on this thread. */
  roundsSent: number;
  /** This dealer's current open OTD (raw), or null when no open quote. */
  currentOtd: number | null;
  /** The prior same-vehicle OTD (raw), or null when there is no prior round. */
  priorOtd: number | null;
}

const TERMINAL_DEAD = new Set(["closed", "suppressed"]);

/**
 * Derive the live status (first match wins). Terminal persisted facts win first;
 * then the give-up signals (cold gate / cap) — a dormant thread is dormant even if
 * its last quote conceded, because we have stopped poking it; then lead-sent;
 * then the quote-movement overlay; then a bare reply.
 */
export function deriveNegotiationStatus(input: NegotiationStatusInput): NegotiationStatus {
  if (TERMINAL_DEAD.has(input.persistedState)) return "dead";
  if (input.persistedState === "agreed") return "agreed";

  // The give-up surface: a cold gate or the cap means we have stopped / will stop
  // following up — this is the "dealer has gone quiet" state, and it outranks the
  // quote overlay (a stale conceding quote on a dead thread is still dormant).
  if (input.gate === "skip" || input.cap !== "ok") return "dormant";

  // We reached out and the dealer has not replied (no quote can exist yet).
  // Forward-looking: today every thread is created with a co-inserted inbound
  // (applyInboxBatch), so this fires only once an outbound-first thread (a fresh
  // web-lead first touch) exists; it is harmless until then.
  if (input.lastInboundAtMs === null && input.roundsSent > 0) return "lead_sent";

  if (input.currentOtd !== null) {
    if (input.priorOtd === null) return "quoted"; // one data point — no movement
    return input.currentOtd < input.priorOtd ? "countered" : "stalled"; // dropped vs flat-or-worse
  }

  return "replied"; // an inbound with no extractable quote (or the default)
}
