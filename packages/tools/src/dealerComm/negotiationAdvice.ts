/**
 * negotiationAdvice — the buyer-facing deterministic composers that turn the pure
 * deciders (negotiation status, quote tone, give-up verdict, timing gate, and
 * follow-up cap) into rendered advice strings for the negotiation cards.
 *
 * Every function here is PURE: no I/O, no DB, no LLM — the wording is a fixed
 * function of the already-decided inputs, so a template edit can never drift a
 * value out from under a card snapshot.
 *
 * Safety floor (load-bearing): these strings are buyer-facing, so they carry ONLY
 * the buyer's own dealer-quote $ figures — never the buyer's budget, and never a
 * COMPETING DEALER NAME. The BATNA is surfaced as the scalar dollar gap alone
 * ("$X behind best competing quote"), exactly mirroring the payload contract.
 */

import type { DealerVerdict, GiveUpReason } from "./giveUp.js";
import type { NegotiationStatus } from "./negotiationStatus.js";
import type { FollowupCapDecision, GateDecision } from "./replyTargets.js";
import type { QuoteTone } from "./quoteSituation.js";

/** Render a raw dollar figure as a buyer-facing string ("$32,500"). */
function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------------------
// composeStatusLine — the one-line "where this haggle stands"
// ---------------------------------------------------------------------------

/** The buyer-facing label for each live-dynamics status. */
const STATUS_LABEL: Record<NegotiationStatus, string> = {
  countered: "Dealer conceding",
  stalled: "Stalled",
  quoted: "Quoted",
  replied: "Replied, no quote",
  lead_sent: "Lead sent, awaiting reply",
  dormant: "Dormant",
  agreed: "Agreed",
  dead: "Closed out",
};

/** Responsiveness phrasing from the timing gate. */
const GATE_PHRASE: Record<GateDecision, string> = {
  ready: "ready to follow up",
  wait: "recently contacted",
  skip: "gone quiet",
};

export interface StatusLineInput {
  /** The live-dynamics negotiation status (deriveNegotiationStatus). */
  status: NegotiationStatus;
  /** How many emails have been exchanged on this thread. */
  emailCount: number;
  /** Whether the dealer has sent at least one quote. */
  quoteSent: boolean;
  /** The current open OTD (raw), or null when not quoted. */
  currentOtd: number | null;
  /** The prior same-vehicle OTD (raw), or null when there is no prior round. */
  priorOtd: number | null;
  /** The timing gate (responsiveness). */
  gate: GateDecision;
  /** Dollars this dealer is behind the best quality competitor (>= 0), or null. */
  batnaGapUsd: number | null;
}

/**
 * Compose the buyer-facing status line: a status label, the email/quote count,
 * the latest OTD movement, responsiveness, and the BATNA gap — joined into one
 * line. Non-applicable segments are dropped (never fabricated).
 */
export function composeStatusLine(input: StatusLineInput): string {
  const segments: string[] = [STATUS_LABEL[input.status]];

  const emailWord = input.emailCount === 1 ? "email" : "emails";
  const quotePart = input.quoteSent ? "quote received" : "no quote yet";
  segments.push(`${input.emailCount} ${emailWord}, ${quotePart}`);

  const movement = composeOtdMovement(input.currentOtd, input.priorOtd);
  if (movement !== null) segments.push(movement);

  segments.push(GATE_PHRASE[input.gate]);

  if (input.batnaGapUsd !== null && input.batnaGapUsd > 0) {
    segments.push(`${usd(input.batnaGapUsd)} behind best competing quote`);
  }

  return segments.join(" · ");
}

/** The OTD-movement segment, or null when there is no quote to describe. */
function composeOtdMovement(currentOtd: number | null, priorOtd: number | null): string | null {
  if (currentOtd === null) return null;
  if (priorOtd === null) return `OTD ${usd(currentOtd)}`;
  if (currentOtd < priorOtd) return `OTD down ${usd(priorOtd - currentOtd)} to ${usd(currentOtd)}`;
  if (currentOtd > priorOtd) return `OTD up ${usd(currentOtd - priorOtd)} to ${usd(currentOtd)}`;
  return `OTD flat at ${usd(currentOtd)}`;
}

// ---------------------------------------------------------------------------
// composeNegotiationStrategy — the tone x verdict recommendation
// ---------------------------------------------------------------------------

export interface NegotiationStrategyInput {
  /** The quote-situation tone (classifyQuoteSituation). */
  tone: QuoteTone;
  /** The give-up verdict (dealerGiveUpDecision). */
  verdict: DealerVerdict;
  /** The dominant give-up reason (for the cap-reason override). */
  reason: GiveUpReason;
  /** Dollars behind the best quality competitor (>= 0), or null. */
  batnaGapUsd: number | null;
  /** Whether this dealer's current open quote is fully itemized. */
  isItemized: boolean;
}

/**
 * Compose the strategy sentence. Precedence: a give-up-switch verdict and a
 * cap-driven pause both override the tone (they describe what to DO next, which
 * outranks how to phrase a push); otherwise the four-tone template applies.
 * Carries $ figures only — never a competing dealer name.
 */
export function composeNegotiationStrategy(input: NegotiationStrategyInput): string {
  if (input.verdict === "give_up_switch") {
    if (input.batnaGapUsd !== null) {
      return (
        `A fully itemized competing quote is ${usd(input.batnaGapUsd)} lower ` +
        `out-the-door. Recommend giving up on this dealer and switching to the ` +
        `stronger offer.`
      );
    }
    return (
      `This dealer's quote is not itemized, while a competing dealer has a ` +
      `verified, lower out-the-door offer. Recommend switching to the stronger offer.`
    );
  }

  if (input.reason === "total_cap") {
    return `This thread has hit the follow-up ceiling — no further automated follow-ups will be sent.`;
  }
  if (input.reason === "unanswered_cap") {
    return `This dealer has not answered the last follow-ups — pause further outreach until they reply.`;
  }

  switch (input.tone) {
    case "conservative":
      return `The current quote is an estimate, not itemized. Ask for a full itemized out-the-door breakdown before pushing on price.`;
    case "assertive":
      return input.batnaGapUsd !== null
        ? `This quote is ${usd(input.batnaGapUsd)} above the best competing out-the-door price. Push hard for a matching number.`
        : `This quote is well above the best competing out-the-door price. Push hard for a matching number.`;
    case "moderate":
      return `This quote is close to the best competing offer. Ask for a modest improvement to close the remaining gap.`;
    case "appreciative":
      return `This quote is at or below the best competing offer. Thank the dealer and ask them to hold the price while you finish comparing.`;
  }
}

// ---------------------------------------------------------------------------
// composeNextSteps — the ordered action list
// ---------------------------------------------------------------------------

export interface NextStepsInput {
  /** The timing gate. */
  gate: GateDecision;
  /** The follow-up cap. */
  cap: FollowupCapDecision;
  /** The give-up verdict. */
  verdict: DealerVerdict;
  /** Whether the dealer has sent at least one quote. */
  hasQuote: boolean;
  /** Audit-finding suggestion strings (already budget-safe), appended in order. */
  auditSuggestions: string[];
}

/**
 * Compose the ordered next-steps list: a give-up step (when switching), the
 * timing step (cap overrides gate), the missing-quote ask (when no quote yet),
 * then the audit suggestions in their given order. Always non-empty.
 */
export function composeNextSteps(input: NextStepsInput): string[] {
  const steps: string[] = [];

  if (input.verdict === "give_up_switch") {
    steps.push("Switch your focus to the stronger competing offer.");
  }

  steps.push(composeTimingStep(input.gate, input.cap));

  if (!input.hasQuote) {
    steps.push("Ask the dealer for a full itemized out-the-door quote.");
  }

  for (const s of input.auditSuggestions) steps.push(s);

  return steps;
}

/** The single timing step. The cap (anti-pester) overrides the gate. */
function composeTimingStep(gate: GateDecision, cap: FollowupCapDecision): string {
  if (cap === "total_cap") {
    return "Follow-up ceiling reached — stop automated follow-ups on this thread.";
  }
  if (cap === "unanswered_cap") {
    return "Pause follow-ups until the dealer replies.";
  }
  if (gate === "skip") {
    return "Dealer has gone quiet — consider dropping this thread.";
  }
  if (gate === "wait") {
    return "Recently contacted — wait before sending the next follow-up.";
  }
  return "Ready to send the next follow-up now.";
}
