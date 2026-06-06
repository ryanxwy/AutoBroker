/**
 * Hero — the home headline + "Start a new search" CTA. The
 * CTA is one of the four intake entries that funnel through
 * launchIntakeWithFreshSession; here it calls the parent's onStartSearch.
 */

export function Hero({ onStartSearch }: { onStartSearch: () => void }): JSX.Element {
  return (
    <section className="card" data-testid="hero">
      <h1>Find your next car the smart way</h1>
      <p className="muted">
        Tell AutoBroker what you want. It contacts dealers, gathers quotes, and
        brings back the best out-the-door price — you stay in control of every send.
      </p>
      <button
        type="button"
        className="btn-primary"
        data-testid="hero-start-search"
        onClick={onStartSearch}
        style={{ marginTop: 8 }}
      >
        Start a new search
      </button>
    </section>
  );
}
