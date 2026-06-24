/**
 * portfolioSummary — the pure header-by-counts derivation. The portfolio status
 * bar reports COUNTS, never a blended health color: "N searches · X NEED
 * APPROVAL · Y ghosted · Z fail-closed · W healthy", and NAMES the profiles that
 * are red (a parked gate or a #1244 fail-closed) so a problem escalates upward
 * and points at the vehicle. Derived from the board cards + the approval-inbox
 * items; no I/O, no budget.
 *
 * Dependency wall: app/ui layer.
 */

import type { ApprovalInboxItem, PortfolioCard } from "../api/wire.js";

export interface PortfolioCounts {
  /** Active searches on the board. */
  searches: number;
  /** Parked gates awaiting approval (non-fail-closed inbox items). */
  needApproval: number;
  /** Profiles whose dealer went silent (health reason "ghosted"). */
  ghosted: number;
  /** Runs in a #1244 fail-closed state (inbox items flagged fail_closed). */
  failClosed: number;
  /** Searches with no flagged problem. */
  healthy: number;
  /** The vehicles of the red (action-required) profiles, deduped, in inbox
   *  order — the header names these. */
  redNames: string[];
}

/** Compute the header counts from the board cards + the approval-inbox items. */
export function summarizePortfolio(
  cards: readonly PortfolioCard[],
  items: readonly ApprovalInboxItem[],
): PortfolioCounts {
  const failItems = items.filter((i) => i.reason === "fail_closed");
  const approvalItems = items.filter((i) => i.reason !== "fail_closed");
  const ghosted = cards.filter((c) => c.reasons.includes("ghosted")).length;

  // A profile is RED (flagged) when it has a parked gate or a fail-closed run.
  const flagged = new Set<string>();
  for (const i of items) if (i.profileId !== null) flagged.add(i.profileId);
  // Ghosting is an amber ambient signal, not red — but it still isn't "healthy".
  const unhealthy = new Set(flagged);
  for (const c of cards) if (c.reasons.includes("ghosted")) unhealthy.add(c.searchProfileId);
  const healthy = cards.filter((c) => !unhealthy.has(c.searchProfileId)).length;

  // Name the red profiles (deduped by profile, inbox order, vehicle present).
  const seen = new Set<string>();
  const redNames: string[] = [];
  for (const i of items) {
    const key = i.profileId ?? i.runId;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i.vehicle !== null && i.vehicle !== "") redNames.push(i.vehicle);
  }

  return {
    searches: cards.length,
    needApproval: approvalItems.length,
    ghosted,
    failClosed: failItems.length,
    healthy,
    redNames,
  };
}
