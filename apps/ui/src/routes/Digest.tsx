/**
 * Digest — the /digest result page: a daily summary of every active search
 * (or one pinned search). A PURE projection of the server-computed DigestView:
 * the daily-digest skill (deterministic, zero-LLM) pre-sorts each profile's
 * quotes OTD-ascending and marks the single best row, so this page never
 * re-sorts or re-classifies — it renders the fields verbatim. The one bit of
 * client formatting is turning the user's own OTD dollar figures into a
 * currency string; nothing else is reshaped here.
 *
 * Budget red-line: the DigestView carries NO budget field. OTD dollars are the
 * user's OWN collected offers (explicitly allowed); budget can render only as
 * the internal-only `.budget-lock` chip — never a number, anywhere on this page.
 *
 * Auto-refresh: the digest skill ends with a data.changed{kinds:["digest"]}
 * pulse; DIGEST_KINDS registers this page's refetch on the fresh-by-default bus
 * (mirrors Canvas), so a re-run lands without a manual reload. SWR via useAsync
 * keeps the last good view on screen during a background refresh (no flash).
 */

import type { ApiClient } from "../api/client.js";
import { useAsync } from "../api/useApi.js";
import { useDataRefetch } from "../api/useDataChanged.js";
import type {
  DigestView,
  DigestViewProfile,
  DigestViewQuoteRow,
} from "../api/wire.js";
import { navigate } from "../router.js";

/** The data kind this page renders — a stable module-level literal so
 *  useDataRefetch re-registers only when the refetch identity changes. */
const DIGEST_KINDS = ["digest"] as const;

/** Human label for a freshness class (the third, non-color signal alongside the
 *  glyph + the data-freshness attribute — color is never the only cue). */
const FRESHNESS_LABEL: Record<DigestViewQuoteRow["freshness"], string> = {
  fresh: "fresh",
  stale: "stale",
  missing: "no quote",
};
const FRESHNESS_GLYPH: Record<DigestViewQuoteRow["freshness"], string> = {
  fresh: "●",
  stale: "◐",
  missing: "○",
};

/** Format the user's own OTD dollar figure as currency (whole dollars). A null
 *  OTD (no offer landed) renders as an em-dash. This is the ONLY numeric
 *  formatting on the page, and it never touches a budget figure (there is none
 *  in the DigestView). */
function otdLabel(otd: number | null): string {
  if (otd === null) return "—";
  return otd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

// ---------------------------------------------------------------------------
// freshness chip — color + glyph + text label, keyed by data-freshness
// ---------------------------------------------------------------------------

function FreshnessChip({ freshness }: { freshness: DigestViewQuoteRow["freshness"] }): JSX.Element {
  return (
    <span className="digest-freshness" data-freshness={freshness}>
      <span aria-hidden="true">{FRESHNESS_GLYPH[freshness]}</span>
      {FRESHNESS_LABEL[freshness]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// quotes table — OTD-ascending rows (server order, never re-sorted)
// ---------------------------------------------------------------------------

function QuoteRow({ row }: { row: DigestViewQuoteRow }): JSX.Element {
  return (
    <li
      className={`digest-quote-row${row.isBest ? " is-best" : ""}`}
      data-testid="digest-quote-row"
      data-best={row.isBest}
    >
      <span className="digest-quote-dealer">
        {row.isBest && (
          <>
            <span className="digest-best-mark" aria-hidden="true">
              ★
            </span>
            <span className="digest-best-eyebrow">BEST</span>
          </>
        )}
        {row.dealerName}
      </span>
      <span className="digest-quote-fin">{row.financingMode}</span>
      <FreshnessChip freshness={row.freshness} />
      <span
        className="digest-quote-otd"
        // The single best row's OTD figure carries the harness-stable testid.
        {...(row.isBest ? { "data-testid": "digest-best-otd" } : {})}
      >
        {otdLabel(row.otdTotal)}
      </span>
    </li>
  );
}

function QuotesSection({ profile }: { profile: DigestViewProfile }): JSX.Element {
  return (
    <section className="digest-quotes" data-testid="digest-section-quotes" aria-labelledby={`dq-${profile.searchProfileId}`}>
      <h2 id={`dq-${profile.searchProfileId}`}>Quotes</h2>
      {profile.quotes.length === 0 ? (
        <p className="muted">No quotes yet — they land here as dealers reply.</p>
      ) : (
        <ul className="digest-quote-list">
          {profile.quotes.map((row) => (
            <QuoteRow key={row.quoteId} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// dealers — bound / replied-thread / awaiting tallies
// ---------------------------------------------------------------------------

function DealersSection({ profile }: { profile: DigestViewProfile }): JSX.Element {
  const stats: { label: string; value: number }[] = [
    { label: "dealers", value: profile.dealerCount },
    { label: "bound", value: profile.boundDealerCount },
    { label: "threads", value: profile.threadCount },
  ];
  return (
    <section className="digest-dealers" data-testid="digest-section-dealers" aria-labelledby={`dd-${profile.searchProfileId}`}>
      <h2 id={`dd-${profile.searchProfileId}`}>Dealers</h2>
      <div className="digest-stat-row">
        {stats.map((s) => (
          <span className="digest-stat" key={s.label}>
            <span className="digest-stat-num">{s.value}</span>
            <span className="digest-stat-label">{s.label}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// inventory freshness — three mini-bars (fresh / stale / missing)
// ---------------------------------------------------------------------------

function InventorySection({ profile }: { profile: DigestViewProfile }): JSX.Element {
  const mix = profile.freshnessMix;
  const total = mix.fresh + mix.stale + mix.missing;
  const bars: { kind: DigestViewQuoteRow["freshness"]; value: number }[] = [
    { kind: "fresh", value: mix.fresh },
    { kind: "stale", value: mix.stale },
    { kind: "missing", value: mix.missing },
  ];
  return (
    <section className="digest-inventory" data-testid="digest-section-inventory" aria-labelledby={`di-${profile.searchProfileId}`}>
      <h2 id={`di-${profile.searchProfileId}`}>Quote freshness</h2>
      <ul className="digest-bars">
        {bars.map((b) => (
          <li className="digest-bar-row" key={b.kind}>
            <span className="digest-bar-label" data-freshness={b.kind}>
              <span aria-hidden="true">{FRESHNESS_GLYPH[b.kind]}</span>
              {FRESHNESS_LABEL[b.kind]}
            </span>
            <span className="digest-bar-track">
              <span
                className="digest-bar-fill"
                data-freshness={b.kind}
                style={{ width: total > 0 ? `${(b.value / total) * 100}%` : "0%" }}
              />
            </span>
            <span className="digest-bar-num">{b.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// callout counts — needs-response + open-questions tallies
// ---------------------------------------------------------------------------

function CalloutSection({
  testid,
  labelId,
  title,
  glyph,
  count,
  emptyCopy,
}: {
  testid: string;
  labelId: string;
  title: string;
  glyph: string;
  count: number;
  emptyCopy: string;
}): JSX.Element {
  return (
    <section className="digest-callout" data-testid={testid} aria-labelledby={labelId}>
      <h2 id={labelId}>{title}</h2>
      {count > 0 ? (
        <p className="digest-callout-line">
          <span aria-hidden="true" className="digest-callout-glyph">
            {glyph}
          </span>
          <strong>{count}</strong> {count === 1 ? "thread" : "threads"} {title.toLowerCase()}.
        </p>
      ) : (
        <p className="muted">{emptyCopy}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// next actions — deterministic ordered list
// ---------------------------------------------------------------------------

function NextActionsSection({
  actions,
}: {
  actions: DigestView["nextActions"];
}): JSX.Element {
  return (
    <section className="digest-next-actions" data-testid="digest-section-next-actions" aria-labelledby="digest-na">
      <h2 id="digest-na">Next actions</h2>
      {actions.length === 0 ? (
        <p className="muted">Nothing waiting on you right now.</p>
      ) : (
        <ul className="feed digest-action-feed">
          {actions.map((a, i) => (
            <li className="feed-done" key={`${a.kind}-${a.profileId}-${i}`}>
              {a.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// one active-search section
// ---------------------------------------------------------------------------

function ProfileSection({ profile }: { profile: DigestViewProfile }): JSX.Element {
  return (
    <section
      className="card profile-card digest-profile"
      data-testid="digest-section-profile"
      aria-label={profile.vehicle}
    >
      <div className="digest-profile-head">
        <h2>{profile.vehicle || "Active search"}</h2>
        {profile.totalQuotes > 0 && profile.bestOtd !== null && (
          <span className="session-pill" data-status="done">
            best {otdLabel(profile.bestOtd)}
          </span>
        )}
        {profile.totalQuotes === 0 && (
          <span className="session-pill">awaiting quotes</span>
        )}
        {/* budget = a lock affordance only, never a number anywhere. */}
        <span className="mini-chip budget-lock">budget · internal-only</span>
      </div>

      <DealersSection profile={profile} />
      <QuotesSection profile={profile} />
      <CalloutSection
        testid="digest-section-needs-response"
        labelId={`dnr-${profile.searchProfileId}`}
        title="Needs response"
        glyph="⚑"
        count={profile.needsResponseCount}
        emptyCopy="No dealer is waiting on you."
      />
      <CalloutSection
        testid="digest-section-unanswered"
        labelId={`du-${profile.searchProfileId}`}
        title="Open questions"
        glyph="?"
        count={profile.unansweredQuestionCount}
        emptyCopy="No open questions."
      />
      <InventorySection profile={profile} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// the digest page
// ---------------------------------------------------------------------------

export function Digest({
  client,
  profileId,
}: {
  client: ApiClient;
  profileId: string | null;
}): JSX.Element {
  const view = useAsync<DigestView>(() => client.getDigest(profileId), [profileId]);

  // Fresh-by-default: a data.changed{kinds:["digest"]} pulse (the digest skill's
  // terminal write) or a window refocus refetches this view in place.
  useDataRefetch(DIGEST_KINDS, view.refetch);

  return (
    <div className="digest-page" data-testid="digest-page">
      <div className="digest-head">
        <h1 aria-label="Daily digest">Daily digest</h1>
        {view.kind === "ok" ? (
          <time className="digest-generated-at" data-testid="digest-generated-at" dateTime={view.data.generatedAt}>
            {new Date(view.data.generatedAt).toLocaleString()}
          </time>
        ) : (
          // The stamp slot always renders; an empty <time> until the read lands
          // keeps the testid present without inventing a timestamp.
          <time className="digest-generated-at" data-testid="digest-generated-at" />
        )}
      </div>

      {view.kind === "loading" && <p className="muted">Loading your digest…</p>}

      {view.kind === "error" && (
        <p className="danger-text" role="alert" data-testid="digest-error">
          Couldn&apos;t load your digest: {view.message}
        </p>
      )}

      {view.kind === "ok" &&
        (view.data.empty || view.data.state === "_NO_ACTIVE_SEARCHES" ? (
          <section className="card canvas-empty" data-testid="digest-empty">
            <h1>No active searches to summarize.</h1>
            <p className="muted">
              Start a search and AutoBroker will gather quotes — the best
              out-the-door price surfaces in your daily digest.
            </p>
            <button
              type="button"
              className="btn-primary"
              data-testid="digest-start-search"
              onClick={() => navigate("/")}
            >
              Start a new search
            </button>
          </section>
        ) : (
          <>
            {view.data.headline !== "" && (
              <p className="digest-headline muted">{view.data.headline}</p>
            )}
            <NextActionsSection actions={view.data.nextActions} />
            {view.data.profiles.map((profile) => (
              <ProfileSection key={profile.searchProfileId} profile={profile} />
            ))}
          </>
        ))}
    </div>
  );
}
