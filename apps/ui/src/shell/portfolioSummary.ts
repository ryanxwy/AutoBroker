/**
 * portfolioSummary — the pure header-by-counts derivation. The portfolio status
 * bar reports COUNTS, never a blended health color: "N searches · X NEED
 * APPROVAL · Y ghosted · W healthy", and NAMES the profiles that are red
 * (an action-required item: an irreversible send or a saga retraction) so a
 * problem escalates upward and points at the vehicle. Derived from the board
 * cards + the approval queue (ApprovalItem[]); no I/O, no budget.
 *
 * Dependency wall: app/ui layer.
 */

import type { ApprovalItem, PortfolioCard } from "../api/wire.js";

/** The profileHealth reason emitted when every thread of a cold profile is
 *  capped — i.e. the dealers went silent ("ghosted"). */
const GHOSTED_REASON = "all_threads_capped";

export interface PortfolioCounts {
  /** Active searches on the board. */
  searches: number;
  /** Parked gates + retraction tasks awaiting the user. */
  needApproval: number;
  /** Profiles whose dealers went silent (all follow-up threads capped). */
  ghosted: number;
  /** Searches with no flagged problem. */
  healthy: number;
  /** The names of the red (action-required) items, deduped, queue order — the
   *  header names these. */
  redNames: string[];
}

/** Compute the header counts from the board cards + the approval queue. */
export function summarizePortfolio(
  cards: readonly PortfolioCard[],
  items: readonly ApprovalItem[],
): PortfolioCounts {
  const ghosted = cards.filter((c) => c.reasons.includes(GHOSTED_REASON)).length;

  // A profile is unhealthy when it has a queue item or its dealers went silent.
  const unhealthy = new Set<string>();
  for (const i of items) if (i.profileId !== null) unhealthy.add(i.profileId);
  for (const c of cards) if (c.reasons.includes(GHOSTED_REASON)) unhealthy.add(c.searchProfileId);
  const healthy = cards.filter((c) => !unhealthy.has(c.searchProfileId)).length;

  // Name the RED (action-required) items, deduped by profile (else run), in queue
  // order — the budget-free summary heading, else a prettified skill name.
  const seen = new Set<string>();
  const redNames: string[] = [];
  for (const i of items) {
    if (!i.actionRequired) continue;
    const key = i.profileId ?? i.runId ?? `idx-${redNames.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    redNames.push(i.summary?.heading ?? i.skill.replace(/_/g, " "));
  }

  return { searches: cards.length, needApproval: items.length, ghosted, healthy, redNames };
}
