/**
 * Static HTML renderer for the local daily-digest snapshot. It consumes the
 * same DigestPayload as the text and live views: no queries, no scripts, no
 * external resources, and no invented age for attention items.
 *
 * Every payload string crosses escapeHtml() before interpolation. The caller
 * must still run assertNoBudget(html) before writing it.
 */

import { NO_ACTIVE_SEARCHES, type DigestPayload, type DigestProfileGroup } from "./generateDigest.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function formatOtd(value: number | null): string {
  return value === null ? "No OTD yet" : `$${Math.round(value).toLocaleString("en-US")}`;
}

function renderProfile(group: DigestProfileGroup): string {
  const offers =
    group.offers.length === 0
      ? "<p>No captured quotes yet.</p>"
      : `<ul>${group.offers
          .map(
            (offer) =>
              `<li><strong>${escapeHtml(offer.dealerName)}</strong> — ${escapeHtml(formatOtd(offer.otdTotal))}` +
              ` <span class="muted">(${escapeHtml(offer.financingMode)}, listing ${escapeHtml(offer.freshness)})</span></li>`,
          )
          .join("")}</ul>`;

  return `<article class="profile">
    <h2>${escapeHtml(group.vehicle)}</h2>
    <div class="metrics">
      <span><strong>${group.dealerCount}</strong> dealers</span>
      <span><strong>${group.threadCount}</strong> threads</span>
      <span><strong>${group.totalQuotes}</strong> quotes</span>
      <span><strong>${escapeHtml(formatOtd(group.bestOtd))}</strong> best OTD</span>
    </div>
    <p>${group.boundDealerCount} bound dealer(s); ${group.needsResponseCount} awaiting your response; ${group.unansweredQuestionCount} open question(s).</p>
    <h3>Quotes</h3>${offers}
    <p class="muted">Inventory: ${group.freshnessMix.fresh} fresh, ${group.freshnessMix.stale} stale, ${group.freshnessMix.missing} missing.</p>
  </article>`;
}

/** Render a standalone file://-safe digest snapshot. */
export function renderDigestHtml(payload: DigestPayload): string {
  if (payload.state === NO_ACTIVE_SEARCHES || payload.profiles.length === 0) {
    return "";
  }

  const generatedAt = new Date(payload.generatedAtMs).toISOString();
  const attention =
    payload.nextActions.length === 0
      ? "<p>Nothing needs your attention right now.</p>"
      : `<ul>${payload.nextActions
          .map((action) => `<li><span class="tag">${escapeHtml(action.kind)}</span> ${escapeHtml(action.label)}</li>`)
          .join("")}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AutoBroker daily digest</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }
    body { width: min(920px, calc(100% - 40px)); margin: 0 auto; padding: 32px 0 64px; }
    header, section, .profile { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 14px; padding: 18px 20px; margin: 0 0 18px; }
    h1, h2, h3 { line-height: 1.2; }
    h1 { margin: 0 0 6px; } h2 { margin-top: 0; } h3 { margin-bottom: 6px; }
    .metrics { display: flex; flex-wrap: wrap; gap: 8px; }
    .metrics span, .tag { border-radius: 999px; padding: 3px 9px; background: color-mix(in srgb, CanvasText 9%, transparent); }
    .muted { opacity: .72; } li { margin: 6px 0; }
  </style>
</head>
<body>
  <header><h1>Daily digest</h1><div class="muted">Generated ${escapeHtml(generatedAt)}</div></header>
  <section><h2>Needs attention</h2>${attention}</section>
  ${payload.profiles.map(renderProfile).join("\n  ")}
</body>
</html>
`;
}
