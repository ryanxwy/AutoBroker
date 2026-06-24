/**
 * PortfolioStatusBar — the multi-profile header strip. Reports the portfolio by
 * COUNTS (never a blended color): "N searches · X NEED APPROVAL · Y ghosted ·
 * Z fail-closed · W healthy", with red escalating upward and NAMING the affected
 * profiles. Links to the /portfolio board.
 *
 * Renders ONLY when 2+ searches are active — a single-active session shows no
 * bar, so that path is byte-identical to before. Budget never appears (#9).
 *
 * Dependency wall: app/ui layer.
 */

import type { ApprovalInboxItem, PortfolioCard } from "../api/wire.js";
import { Link } from "../router.js";
import { summarizePortfolio } from "./portfolioSummary.js";

export function PortfolioStatusBar({
  cards,
  items,
}: {
  cards: readonly PortfolioCard[];
  items: readonly ApprovalInboxItem[];
}): JSX.Element | null {
  // The portfolio header is a MULTI-profile affordance; with 0/1 active search
  // there is nothing to disambiguate, so the bar is absent (single-active path
  // stays byte-identical).
  if (cards.length < 2) return null;

  const s = summarizePortfolio(cards, items);

  return (
    <div className="portfolio-status-bar" data-testid="portfolio-status-bar" role="status">
      <Link to="/portfolio" className="portfolio-status-link" data-testid="portfolio-status-link">
        {s.searches} searches
      </Link>
      {s.needApproval > 0 && (
        <span className="portfolio-count-alert" data-testid="portfolio-count-approval">
          {s.needApproval} NEED APPROVAL
        </span>
      )}
      {s.ghosted > 0 && (
        <span className="portfolio-count" data-testid="portfolio-count-ghosted">
          {s.ghosted} ghosted
        </span>
      )}
      {s.failClosed > 0 && (
        <span className="portfolio-count-fail" data-testid="portfolio-count-failclosed">
          {s.failClosed} fail-closed
        </span>
      )}
      <span className="portfolio-count-healthy" data-testid="portfolio-count-healthy">
        {s.healthy} healthy
      </span>
      {s.redNames.length > 0 && (
        <span className="portfolio-status-names" data-testid="portfolio-status-names">
          ⚠ {s.redNames.join(", ")}
        </span>
      )}
    </div>
  );
}
