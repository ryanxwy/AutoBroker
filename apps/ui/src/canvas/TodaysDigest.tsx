/**
 * TodaysDigest — the READ-ONLY daily-digest summary on the workbench canvas. The
 * daily_digest skill (deterministic, zero-LLM) computes a per-search snapshot
 * (dealer/thread tallies, the freshness mix, the best out-the-door); previously
 * it surfaced only as a one-line chat summary + the standalone /digest page, with
 * no presence on the dashboard. This card scopes the digest to the ACTIVE search
 * and renders the headline + the key tallies + the best OTD, so the at-a-glance
 * state lives on the workbench alongside the other sections.
 *
 * Budget red line: the digest carries NO budget on the wire. `bestOtd` is the
 * user's OWN collected offer (rendered); a budget number is never shown.
 * Presentational ONLY: it takes the digest as a PROP (an AsyncState the host
 * wires from GET /api/digest) and knows nothing about the API client. LIGHT paper
 * skin, reusing the chip vocabulary of the profile + incentives sections (no new
 * styling — the metrics are mini-chips, cohesive with the rest of the canvas).
 */

import type { AsyncState } from "../api/useApi.js";
import type { DigestView, DigestViewProfile } from "../api/wire.js";

/** A "$35,500" out-the-door label (no cents), or null for a missing total. */
function dollarLabel(value: number | null): string | null {
  if (value === null) return null;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function DigestBody({
  profile,
  headline,
}: {
  profile: DigestViewProfile;
  headline: string;
}): JSX.Element {
  const bestOtd = dollarLabel(profile.bestOtd);
  return (
    // A single `tile` (not a tile-grid item): the bordered summary container, and
    // `.t-status` is styled under `.tile` — so the best-OTD line reads correctly.
    <div className="tile" data-testid="canvas-digest-card">
      <p className="muted" data-testid="canvas-digest-headline">
        {headline}
      </p>
      <div className="chip-row" data-testid="canvas-digest-metrics">
        <span className="mini-chip">{profile.dealerCount} dealers</span>
        <span className="mini-chip">{profile.threadCount} threads</span>
        <span className="mini-chip">{profile.totalQuotes} quotes</span>
        {profile.needsResponseCount > 0 && (
          <span className="mini-chip">{profile.needsResponseCount} need reply</span>
        )}
      </div>
      {bestOtd !== null ? (
        <div className="t-status" data-testid="canvas-digest-best-otd">
          Best out-the-door: <strong>{bestOtd}</strong>
        </div>
      ) : (
        <div className="t-status muted">No out-the-door quotes yet.</div>
      )}
    </div>
  );
}

export interface TodaysDigestProps {
  /** The active search's digest (the host wires this from GET /api/digest scoped
   *  to the active profile). */
  digest: AsyncState<DigestView>;
}

export function TodaysDigest({ digest }: TodaysDigestProps): JSX.Element {
  // Scoped to the active profile → the payload carries at most that one profile.
  const profile: DigestViewProfile | null =
    digest.kind === "ok" ? (digest.data.profiles[0] ?? null) : null;
  return (
    <section data-testid="canvas-digest">
      <h2>Today&apos;s digest</h2>
      {digest.kind === "loading" && <p className="muted">Loading digest…</p>}
      {digest.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load the digest: {digest.message}
        </p>
      )}
      {digest.kind === "ok" && profile === null && (
        <p className="muted" data-testid="canvas-digest-empty">
          No digest yet — run /daily_digest for a summary of where this search stands.
        </p>
      )}
      {digest.kind === "ok" && profile !== null && (
        <DigestBody profile={profile} headline={digest.data.headline} />
      )}
    </section>
  );
}
