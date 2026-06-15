/**
 * renderDigest — the deterministic 7-section digest renderer (plain markdown)
 * and the one-line notification headline. ZERO LLM, ZERO budget figures.
 *
 * The 7 sections map 1:1 to the UI testids:
 *   1 profile / today's progress  → digest-section-profile
 *   2 dealers                     → digest-section-dealers
 *   3 quotes (offers)             → digest-section-quotes
 *   4 needs-response callouts     → (rendered inside next-actions on the page)
 *   5 unanswered-question callouts→ (rendered inside next-actions on the page)
 *   6 inventory freshness         → digest-section-quotes neighbour
 *   7 next actions                → digest-section-next-actions
 *
 * OTD amounts ARE rendered (those are dealer-quoted prices the buyer should
 * see), but the buyer's private budget ceiling NEVER appears — the payload
 * never carries it. The CALLER must still pass both `renderDigestText` and
 * `digestHeadline` outputs through `assertNoBudget(...)` before writing or
 * notifying (a load-bearing semantic check, CLAUDE.md §9).
 */

import { NO_ACTIVE_SEARCHES, type DigestPayload, type DigestProfileGroup } from "./generateDigest.js";

/** The exact text rendered when no active searches resolved. */
export const NO_ACTIVE_SEARCHES_TEXT = "No active searches to summarize." as const;

/** Format an OTD amount as a plain dollar figure (these are dealer prices, not
 *  the buyer's ceiling). A null OTD renders as "(no OTD yet)". */
function formatOtd(otd: number | null): string {
  if (otd === null) return "(no OTD yet)";
  return `$${Math.round(otd).toLocaleString("en-US")}`;
}

function renderProfileSection(g: DigestProfileGroup): string {
  const lines: string[] = [];
  lines.push(`## ${g.vehicle}`);
  lines.push(
    `Today's progress: ${g.dealerCount} dealer(s), ${g.threadCount} thread(s), ` +
      `${g.needsResponseCount} awaiting your response, ${g.unansweredQuestionCount} open question(s).`,
  );
  return lines.join("\n");
}

function renderDealerSection(g: DigestProfileGroup): string {
  return (
    `**Dealers** — ${g.dealerCount} on this search` +
    (g.boundDealerCount > 0 ? `, ${g.boundDealerCount} bound (lead targets).` : ".")
  );
}

function renderQuotesSection(g: DigestProfileGroup): string {
  if (g.offers.length === 0) {
    return "**Quotes** — no captured quotes yet.";
  }
  const lines: string[] = [];
  lines.push(
    `**Quotes** — ${g.totalQuotes} captured` +
      (g.bestOtd !== null ? `, best out-the-door ${formatOtd(g.bestOtd)}.` : "."),
  );
  for (const o of g.offers) {
    lines.push(
      `- ${o.dealerName} — ${formatOtd(o.otdTotal)} (${o.financingMode}, listing ${o.freshness})`,
    );
  }
  return lines.join("\n");
}

function renderFreshnessSection(g: DigestProfileGroup): string {
  const { fresh, stale, missing } = g.freshnessMix;
  return `**Inventory freshness** — ${fresh} fresh, ${stale} stale, ${missing} missing.`;
}

/**
 * Render the full digest as plain markdown. The header section names the 7
 * slots; an empty (no-active) payload renders the exact sentinel text.
 */
export function renderDigestText(payload: DigestPayload): string {
  if (payload.state === NO_ACTIVE_SEARCHES || payload.profiles.length === 0) {
    return `# Daily digest\n\n${NO_ACTIVE_SEARCHES_TEXT}\n`;
  }

  const blocks: string[] = ["# Daily digest"];
  for (const g of payload.profiles) {
    blocks.push(renderProfileSection(g)); // slot 1
    blocks.push(renderDealerSection(g)); // slot 2
    blocks.push(renderQuotesSection(g)); // slot 3 + slot 6 below
    blocks.push(renderFreshnessSection(g)); // slot 6
  }

  // slots 4 + 5 + 7 — needs-response, unanswered questions, next actions
  // (these are the deterministic "judgment" lines derived from counts).
  if (payload.nextActions.length > 0) {
    const nextLines = ["## Next actions"];
    for (const a of payload.nextActions) nextLines.push(`- ${a.label}`);
    blocks.push(nextLines.join("\n"));
  } else {
    blocks.push("## Next actions\n- Nothing needs your attention right now.");
  }

  return `${blocks.join("\n\n")}\n`;
}

/**
 * The one-line notification headline. Counts only — NO budget. Best OTD (a
 * dealer price) is surfaced when present. The caller MUST `assertNoBudget` it.
 */
export function digestHeadline(payload: DigestPayload): string {
  if (payload.state === NO_ACTIVE_SEARCHES || payload.profiles.length === 0) {
    return "No active searches to summarize — start one in intake.";
  }
  const profileCount = payload.profiles.length;
  const totalNeeds = payload.profiles.reduce((n, g) => n + g.needsResponseCount, 0);
  const totalQuotes = payload.profiles.reduce((n, g) => n + g.totalQuotes, 0);
  const bestBit =
    payload.overallBestOtd !== null
      ? ` Lowest out-the-door ${formatOtd(payload.overallBestOtd)}.`
      : "";
  const needsBit = totalNeeds > 0 ? ` ${totalNeeds} awaiting your response.` : "";
  return (
    `Daily digest: ${profileCount} active search(es), ${totalQuotes} quote(s).` +
    bestBit +
    needsBit
  );
}
