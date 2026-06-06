/**
 * WelcomeWizard — the first-run wizard. Shows ONLY on a true
 * first run: /api/profiles resolved + EMPTY + not previously dismissed (a
 * localStorage flag). Four steps (install Chrome / choose agent / connect Gmail /
 * install browser automation), closing with "run /search_profile_intake" — which
 * is the fourth intake entry, funnelling through the parent's onStart.
 */

import { useState } from "react";

const DISMISS_KEY = "autobroker:wizard-dismissed";

function dismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function persistDismiss(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* ignore */
  }
}

const STEPS = [
  "Install Chrome (the browser automation runs here).",
  "Choose your AI agent provider (DeepSeek by default).",
  "Connect Gmail so AutoBroker can reach dealers on your behalf.",
  "Install the browser automation extension.",
];

export function WelcomeWizard({
  profilesEmpty,
  onStart,
}: {
  profilesEmpty: boolean;
  onStart: () => void;
}): JSX.Element | null {
  const [hidden, setHidden] = useState(dismissed());
  if (hidden || !profilesEmpty) return null;
  return (
    <section className="card wizard" data-testid="welcome-wizard">
      <h2>Welcome to AutoBroker</h2>
      <p className="muted">A few one-time steps, then start your first search.</p>
      <ol>
        {STEPS.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <div className="gate-actions">
        <button type="button" className="btn-primary" data-testid="wizard-start" onClick={onStart}>
          Run /search_profile_intake
        </button>
        <button
          type="button"
          data-testid="wizard-dismiss"
          onClick={() => {
            persistDismiss();
            setHidden(true);
          }}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
