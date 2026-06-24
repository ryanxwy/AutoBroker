/**
 * Portfolio — the Phase-3 board ABOVE the single-profile workbench. One card per
 * active search, GROUPED BY SEGMENT so different-brand competitors sit together
 * (Accord vs Camry → "Midsize sedans"). Each card shows vehicle + city +
 * best-OTD + dealer count + a last-activity clock + a derived pipeline stage +
 * a hot/warm/cold health dot. Drilling into a card focuses that pipeline in the
 * existing workbench (pin + home) — the workbench is the drill-in LEAF; heavy
 * per-profile detail is fetched there, not here.
 *
 * Budget red-line (#9): the board never shows a budget. `bestOtd` is the user's
 * own collected offer; `city` is the search location.
 *
 * Dependency wall: app/ui layer.
 */

import { ApiClient } from "../api/client.js";
import { useAsync } from "../api/useApi.js";
import { useDataRefetch } from "../api/useDataChanged.js";
import type { PortfolioCard, PortfolioStage, PortfolioView } from "../api/wire.js";
import { dollarLabel, relativeDate } from "../canvas/format.js";
import { OTHER_SEGMENT, segmentOf, segmentSlug } from "./segment.js";

// The board overviews EVERY profile, so it refetches on any write family (the
// list, dealer/lead/quote/incentive/thread writes, the digest). Global scope —
// it is not bound to one profile.
const PORTFOLIO_KINDS = [
  "portfolio",
  "profiles",
  "sessions",
  "dealers",
  "leads",
  "threads",
  "messages",
  "listings",
  "quotes",
  "incentives",
  "digest",
] as const;

/** Human labels for the six pipeline stages (Intake → … → Closeout). */
const STAGE_LABEL: Record<PortfolioStage, string> = {
  intake: "Intake",
  scan: "Scan",
  lead_submit: "Lead submit",
  awaiting_replies: "Awaiting replies",
  negotiation: "Negotiation",
  closeout: "Closeout",
};

const STAGE_ORDER: readonly PortfolioStage[] = [
  "intake",
  "scan",
  "lead_submit",
  "awaiting_replies",
  "negotiation",
  "closeout",
];

const HEALTH_LABEL: Record<string, string> = { hot: "Active", warm: "Idle", cold: "Cold" };

/** Group the cards by segment, preserving the digest's newest-first order within
 *  each group and ordering groups by first appearance (Other last). */
function groupBySegment(cards: readonly PortfolioCard[]): Array<{ segment: string; cards: PortfolioCard[] }> {
  const groups = new Map<string, PortfolioCard[]>();
  for (const card of cards) {
    const seg = segmentOf(card.vehicle);
    const list = groups.get(seg);
    if (list === undefined) groups.set(seg, [card]);
    else list.push(card);
  }
  const out = [...groups.entries()].map(([segment, cs]) => ({ segment, cards: cs }));
  // "Other searches" sinks to the bottom; everything else keeps insertion order.
  out.sort((a, b) => (a.segment === OTHER_SEGMENT ? 1 : 0) - (b.segment === OTHER_SEGMENT ? 1 : 0));
  return out;
}

function CardView({ card, onOpen }: { card: PortfolioCard; onOpen: (id: string) => void }): JSX.Element {
  const otd = dollarLabel(card.bestOtd);
  const when = relativeDate(card.lastActivityAt);
  return (
    <button
      type="button"
      className="portfolio-card"
      data-testid={`portfolio-card-${card.searchProfileId}`}
      onClick={() => onOpen(card.searchProfileId)}
    >
      <div className="portfolio-card-head">
        <span
          className={`portfolio-dot portfolio-dot-${card.health}`}
          data-testid={`portfolio-health-${card.searchProfileId}`}
          data-health={card.health}
          title={HEALTH_LABEL[card.health] ?? card.health}
          aria-label={`Health: ${HEALTH_LABEL[card.health] ?? card.health}`}
        />
        <span className="portfolio-vehicle" data-testid={`portfolio-vehicle-${card.searchProfileId}`}>
          {card.vehicle}
        </span>
      </div>
      {card.city !== "" && <div className="portfolio-city muted">{card.city}</div>}
      <div className="portfolio-card-meta">
        <span
          className="portfolio-stage"
          data-testid={`portfolio-stage-${card.searchProfileId}`}
          data-stage={card.stage}
        >
          {STAGE_LABEL[card.stage]}
        </span>
        <span className="portfolio-dealers" data-testid={`portfolio-dealers-${card.searchProfileId}`}>
          {card.dealerCount} {card.dealerCount === 1 ? "dealer" : "dealers"}
        </span>
        {otd !== null && (
          <span className="portfolio-otd" data-testid={`portfolio-otd-${card.searchProfileId}`}>
            Best OTD {otd}
          </span>
        )}
        {when !== "" && <span className="portfolio-when muted">{when}</span>}
      </div>
    </button>
  );
}

export function Portfolio({
  client,
  onOpen,
}: {
  client: ApiClient;
  /** Drill into a profile's workbench (App pins it + navigates home). */
  onOpen: (profileId: string) => void;
}): JSX.Element {
  const view = useAsync<PortfolioView>(() => client.getPortfolio(), []);
  useDataRefetch(PORTFOLIO_KINDS, view.refetch);

  return (
    <div className="portfolio-board" data-testid="portfolio-board">
      <div className="portfolio-head">
        <h1 aria-label="Portfolio">Portfolio</h1>
        {view.kind === "ok" && (
          <time className="portfolio-generated-at" dateTime={view.data.generatedAt}>
            {new Date(view.data.generatedAt).toLocaleString()}
          </time>
        )}
      </div>

      {view.kind === "loading" && <p className="muted">Loading your searches…</p>}

      {view.kind === "error" && (
        <p className="danger-text" role="alert" data-testid="portfolio-error">
          Couldn&apos;t load your portfolio: {view.message}
        </p>
      )}

      {view.kind === "ok" &&
        (view.data.empty ? (
          <section className="card canvas-empty" data-testid="portfolio-empty">
            <h1>No active searches yet.</h1>
            <p className="muted">
              Start a search for each vehicle you&apos;re cross-shopping — they run side by
              side here, grouped by segment.
            </p>
          </section>
        ) : (
          <div className="portfolio-segments">
            {groupBySegment(view.data.cards).map(({ segment, cards }) => (
              <section
                key={segment}
                className="portfolio-segment"
                data-testid={`portfolio-segment-${segmentSlug(segment)}`}
              >
                <h2 className="portfolio-segment-title">{segment}</h2>
                <ol className="portfolio-card-grid" aria-label={`${segment} searches`}>
                  {cards
                    .slice()
                    .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage))
                    .map((card) => (
                      <li key={card.searchProfileId}>
                        <CardView card={card} onOpen={onOpen} />
                      </li>
                    ))}
                </ol>
              </section>
            ))}
          </div>
        ))}
    </div>
  );
}
