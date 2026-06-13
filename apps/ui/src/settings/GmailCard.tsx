/**
 * GmailCard — the onboarding shell for the Gmail connection. The OAuth connect
 * wiring lands in a later slice; this is the disabled placeholder that reserves
 * the surface so the structure (not just the content) stays stable when the real
 * connect flow swaps in. The testids are fixed for that future swap.
 */

export interface GmailCardProps {
  /** Whether Gmail is connected (the server reports false until the wiring lands). */
  connected: boolean;
}

export function GmailCard({ connected }: GmailCardProps): JSX.Element {
  return (
    <section className="card key-row gmail-card" data-testid="gmail-card" aria-labelledby="gmail-label">
      <label id="gmail-label" className="key-row-label">
        Gmail
      </label>
      <p className="muted key-row-desc">
        Connect a Gmail account so AutoBroker can read dealer replies and send
        quotes on your behalf. Every send always waits for your explicit approval.
      </p>
      <div className="key-row-controls">
        <button type="button" data-testid="gmail-connect" disabled>
          Connect Gmail
        </button>
        <span className="muted">{connected ? "Connected" : "Coming soon"}</span>
      </div>
    </section>
  );
}
