/**
 * WhatHappensNext — three heuristic cards (FRONTEND_LAYOUT §6). Computed from the
 * active snapshot's dealer_count / thread_count / best_otd (best quote / pipeline
 * state / next likely action). Consumes the dealer-SAFE ProfileSnapshot — no
 * budget. When there is no profile it nudges toward intake.
 */

import type { ProfileSnapshot } from "./profileView.js";

interface NextCard {
  title: string;
  body: string;
}

function computeCards(snapshot: ProfileSnapshot | null): NextCard[] {
  if (snapshot === null) {
    return [
      { title: "Start here", body: "Create your first search to kick off the pipeline." },
      { title: "Dealers", body: "AutoBroker will find dealers near you once you have a search." },
      { title: "Best price", body: "The best out-the-door price shows up here as quotes land." },
    ];
  }
  const dealers = snapshot.dealerCount ?? 0;
  const threads = snapshot.threadCount ?? 0;
  const best = snapshot.bestOtd;
  return [
    {
      title: "Best quote",
      body: best !== null ? `Best out-the-door so far: $${best.toLocaleString()}.` : "No quotes yet — they'll appear as dealers reply.",
    },
    {
      title: "Pipeline state",
      body: `${dealers} dealer(s) found · ${threads} thread(s) open.`,
    },
    {
      title: "Next likely action",
      body:
        threads === 0
          ? "Send your first dealer lead to start gathering quotes."
          : "Follow up on open threads to push for a better price.",
    },
  ];
}

export function WhatHappensNext({ snapshot }: { snapshot: ProfileSnapshot | null }): JSX.Element {
  const cards = computeCards(snapshot);
  return (
    <section data-testid="what-next">
      <h2>What happens next</h2>
      <div className="what-next">
        {cards.map((c, i) => (
          <div className="card" key={i} data-testid={`what-next-card-${i}`}>
            <h3>{c.title}</h3>
            <p className="muted">{c.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
