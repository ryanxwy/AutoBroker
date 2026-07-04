/**
 * Canvas — the workbench main pane: a READ-ONLY projection of the active
 * search. Profile strip (vehicle + location + preference chips + controls),
 * dealer tiles (the dealers projection route), and the what-happened/what's-next
 * feed, all derived from DB state over the read routes. With no active profile
 * it renders the empty state — the start-here surface (headline, the
 * first-steps walkthrough, and the Start CTA, one of the intake entries).
 *
 * Budget red-line: the canvas consumes the dealer-safe ProfileSnapshot (no
 * budget accessor) — budget can render only as the "internal-only" lock chip,
 * never a number. Identity freezes at confirm, so there is no identity edit
 * here, ever.
 *
 * At /runs/:id the canvas doubles as the run workbench view: a visually-hidden
 * run-id binder ties the route to the run (stable run-view-id testid).
 */

import { useState } from "react";

import { ApiClient } from "../api/client.js";
import { useAsync, type AsyncState } from "../api/useApi.js";
import { invalidate, useDataRefetch } from "../api/useDataChanged.js";
import type {
  DealerList,
  DealerNegotiationList,
  DigestView,
  IncentiveList,
  InventoryCompareResult,
  ProfileList,
  ProfileRow,
  QuoteCompareResult,
  QuoteList,
  ThreadList,
} from "../api/wire.js";
import {
  formatLocation,
  toSnapshot,
  vehicleLabel,
  type ProfileSnapshot,
} from "../home/profileView.js";
import { Link } from "../router.js";
import { CanvasTabs } from "./CanvasTabs.js";
import { DealerTiles } from "./DealerTiles.js";
import { Incentives } from "./Incentives.js";
import { ProfileSummary } from "./ProfileSummary.js";
import { InventoryCandidates } from "./InventoryCandidates.js";
import { ProfileRemoveControl } from "./ProfileRemoveControl.js";
import { NegotiationsBoard } from "./NegotiationsBoard.js";
import { QuotesPanel } from "./QuotesPanel.js";

/** The data kinds the Canvas's read views render — stable module-level literals
 *  so useDataRefetch re-registers only when the refetch identity (not the array
 *  identity) changes. */
const PROFILE_KINDS = ["profiles"] as const;
const DEALER_KINDS = ["dealers"] as const;
/** The dealer-reply Threads section refetches on a threads/messages pulse (the
 *  inbox-pull skill writes both families). */
const THREAD_KINDS = ["threads", "messages"] as const;
/** The Negotiations board is derived from the dealer/thread/quote/message/lead
 *  families — any of those writes can shift a dealer's negotiation status, tally,
 *  or BATNA gap, so the grid refetches on a pulse to any of them. */
const NEGOTIATION_KINDS = ["dealers", "threads", "quotes", "messages", "lead_submissions"] as const;
/** A submitted lead changes the dealer/pipeline rail: the lead-submit skill writes
 *  a lead_submissions row, may set a dealer's contact_email, and an email fallback
 *  writes a (fake) messages row — refetch the dealer tiles on any of those. */
const LEAD_KINDS = ["lead_submissions", "dealers", "messages"] as const;
/** The Inventory candidates section refetches on a listings pulse (the
 *  inventory scans write that family; the ranker itself writes nothing). */
const INVENTORY_KINDS = ["listings"] as const;
/** The Quote compare AND the raw Extracted-quotes sections both refetch on a
 *  quotes pulse (the quote_audit + dealer_reply_extract skills write that family;
 *  the compare ranker + the raw projection themselves write nothing). */
const QUOTE_KINDS = ["quotes"] as const;
/** The Incentives section refetches on an incentives pulse (the incentive_scrape
 *  skill writes that family; the read projection itself writes nothing). */
const INCENTIVE_KINDS = ["incentives"] as const;
/** The summary header refetches on a digest pulse (the daily_digest skill
 *  writes that family; the read projection itself writes nothing). */
const DIGEST_KINDS = ["digest"] as const;

/** Parse a profile row's `preferred_exterior_colors_json` (a JSON string column)
 *  into a string[] — tolerant of null/garbage (→ []). The append path reads the
 *  current list so a one-tap add never clobbers existing colors. */
function parsePreferredColors(row: ProfileRow | null): string[] {
  if (row === null) return [];
  const raw = row["preferred_exterior_colors_json"];
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export interface CanvasProps {
  client: ApiClient;
  /** Start intake (fresh unpinned session) — the empty-state CTA. */
  onStartIntake: () => void;
  /** Present when rendered at /runs/:id — binds the workbench to that run. */
  runId?: string | null;
  /** The EXPLICIT focused profile (the route/run pipeline's profile, threaded
   *  from the session pin). When set, the workbench binds to THIS profile instead
   *  of the newest-active `data[0]` — the multi-profile rebind. When absent
   *  (the single-active home path), `data[0]` is used, byte-identical to before. */
  profileId?: string | null;
  /** Whether the required DeepSeek key is configured. When false, the start CTA
   *  is disabled and points to Settings (the first-run gate). */
  deepseekReady?: boolean;
  /** Open the unified view/edit modal for the active profile. */
  onEditProfile: (id: string, name: string) => void;
}

// ---------------------------------------------------------------------------
// empty state — the start-here surface (headline + first steps + CTA)
// ---------------------------------------------------------------------------

function CanvasEmptyState({
  onStartIntake,
  deepseekReady,
}: {
  onStartIntake: () => void;
  deepseekReady: boolean;
}): JSX.Element {
  return (
    <section className="card canvas-empty" data-testid="canvas-empty">
      <h1>Find your next car the smart way</h1>
      <p className="muted">
        Tell AutoBroker what you want. It contacts dealers, gathers quotes, and
        brings back the best out-the-door price — you stay in control of every send.
      </p>
      <ol className="muted">
        <li>Start a search — the form takes about a minute.</li>
        <li>AutoBroker finds dealers near you.</li>
        <li>Quotes come back; the best out-the-door price surfaces here.</li>
        <li>Every outbound send waits for your explicit approval.</li>
      </ol>
      <button
        type="button"
        className="btn-primary"
        data-testid="canvas-start-search"
        data-deepseek-ready={deepseekReady}
        disabled={!deepseekReady}
        onClick={onStartIntake}
      >
        Start a new search
      </button>
      {!deepseekReady && (
        <p className="muted" data-testid="skills-locked-notice" style={{ marginTop: 10 }}>
          Add your DeepSeek key in <Link to="/settings">Settings</Link> first.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// profile strip — one slim row: vehicle + location + preference chips + controls
// (read-only; identity freezes at confirm — to change the vehicle, replace the
// search. Hard delete lives in the edit modal's danger zone, not here.)
// ---------------------------------------------------------------------------

function ProfileCard({
  snapshot,
  client,
  onEditProfile,
}: {
  snapshot: ProfileSnapshot;
  client: ApiClient;
  /** Open the unified view/edit modal for this profile. */
  onEditProfile: (id: string, name: string) => void;
}): JSX.Element {
  const name = vehicleLabel(snapshot) || "this search";
  const location = formatLocation(snapshot.location);

  return (
    <section className="card profile-card" data-testid="canvas-profile-card">
      <h2 data-testid="canvas-vehicle">{vehicleLabel(snapshot) || "Active search"}</h2>
      {location !== null && location !== "" && (
        <span className="muted profile-strip-location">{location}</span>
      )}
      {snapshot.searchRadiusMiles !== null && (
        <span className="mini-chip" data-testid="profile-pref-radius">
          {snapshot.searchRadiusMiles} mi radius
        </span>
      )}
      {snapshot.financingPreference !== null && (
        <span className="mini-chip">financing · {snapshot.financingPreference}</span>
      )}
      {snapshot.phonePolicy !== "real" && <span className="mini-chip">fake-phone</span>}
      {/* budget is a lock affordance ONLY — never a number, anywhere. */}
      <span className="mini-chip budget-lock">budget · internal-only</span>
      <span style={{ flex: 1 }} />
      {snapshot.id !== null && (
        <>
          <button
            type="button"
            className="profile-edit-open"
            data-testid="profile-edit-open"
            onClick={() => onEditProfile(snapshot.id!, name)}
          >
            Edit preferences
          </button>
          {/* The recoverable soft "Remove" (→ Closed searches); its inline
              confirm gate-card wraps below the strip row. */}
          <ProfileRemoveControl client={client} profileId={snapshot.id} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// feed — what happened / what's next, derived from the projected state
// ---------------------------------------------------------------------------

function CanvasFeed({
  snapshot,
  dealerCount,
}: {
  snapshot: ProfileSnapshot;
  dealerCount: number | null;
}): JSX.Element {
  const happened: string[] = [`Intake captured the ${vehicleLabel(snapshot) || "active"} search.`];
  if (dealerCount !== null && dealerCount > 0) {
    happened.push(`Geosearch found ${dealerCount} dealer(s).`);
  }
  const next: string[] =
    dealerCount === null || dealerCount === 0
      ? ["Find dealers near you to get started."]
      : ["Quotes land here as dealers reply."];

  return (
    <section className="card feed" data-testid="canvas-feed">
      <h2>What happened / what&apos;s next</h2>
      <ul>
        {happened.map((line) => (
          <li className="feed-done" key={line}>
            {line}
          </li>
        ))}
      </ul>
      <ul>
        {next.map((line) => (
          <li className="muted" key={line}>
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// overview panel — the calm orientation tab (the feed + deterministic
// next-actions). It surfaces NO quote/OTD numbers — the best OTD lives in the
// sticky summary, so each number keeps a single home (no redundancy).
// ---------------------------------------------------------------------------

function OverviewPanel({
  snapshot,
  dealerCount,
  digest,
}: {
  snapshot: ProfileSnapshot;
  dealerCount: number | null;
  digest: AsyncState<DigestView>;
}): JSX.Element {
  const nextActions = digest.kind === "ok" ? digest.data.nextActions : [];
  return (
    <>
      <CanvasFeed snapshot={snapshot} dealerCount={dealerCount} />
      {nextActions.length > 0 && (
        <section className="card" data-testid="canvas-next-actions">
          <h2>Next actions</h2>
          <ul>
            {nextActions.map((a) => (
              <li className="muted" key={`${a.kind}-${a.profileId}`}>
                {a.label}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// bestOtd derivation — lowest non-null otd_total across digest + quote-compare rows
// ---------------------------------------------------------------------------

/** Derive the best (lowest) OTD across ALL quotes. The compare ranker buckets by
 *  deal-type (finance/lease) and drops 'unspecified'-mode quotes, so its rows are
 *  only a SUBSET — the digest's bestOtd is the server-computed min over every
 *  quote. Take the min of BOTH so the headline metric never under-reports the
 *  cheapest deal (live-e2e 巡检: the bento showed $37,684 while the digest line
 *  right beside it said the lowest OTD was $36,900, an unspecified-mode quote the
 *  compare buckets excluded). */
function deriveBestOtd(
  quotes: AsyncState<QuoteCompareResult>,
  digest: AsyncState<DigestView>,
): number | null {
  const candidates: number[] = [];
  // The all-quotes min (includes deal-types the compare ranker buckets out).
  if (digest.kind === "ok" && digest.data.profiles.length > 0) {
    const d = digest.data.profiles[0]!.bestOtd;
    if (d !== null) candidates.push(d);
  }
  // The compare-ranker finance + lease + cash rows (a subset; kept so a fresh
  // compare still drives the metric before the next digest recompute). Cash is
  // included so a cash-preference buyer (whose quotes route ONLY into the cash
  // bucket) doesn't under-report Best-OTD here.
  if (quotes.kind === "ok") {
    for (const r of [...quotes.data.finance, ...quotes.data.lease, ...(quotes.data.cash ?? [])]) {
      if (r.otd_total !== null) candidates.push(r.otd_total);
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

// ---------------------------------------------------------------------------
// the canvas
// ---------------------------------------------------------------------------

/** The workbench tabs — one domain per tab; "overview" is the default landing. */
type TabKey = "overview" | "dealers" | "inventory" | "quotes" | "replies" | "incentives";

export function Canvas({
  client,
  onStartIntake,
  runId = null,
  profileId = null,
  deepseekReady = true,
  onEditProfile,
}: CanvasProps): JSX.Element {
  const [tab, setTab] = useState<TabKey>("overview");
  const profiles = useAsync<ProfileList>(() => client.listProfiles("active"), []);
  // The EXPLICIT focused profile (the route/run pipeline's profile). Fetched only
  // when a profileId is supplied — the multi-profile rebind. When absent the
  // workbench falls back to the newest-active `data[0]`, byte-identical to before.
  const explicit = useAsync<ProfileRow>(
    () => client.getProfile(profileId!),
    [profileId],
    profileId !== null,
  );
  // Bind to the EXPLICIT focused profile only while it resolves AND is still
  // active; a stale pin (the search was closed or hard-deleted out from under the
  // session) must NOT strand the workbench on a gone/closed search — fall back to
  // the newest-active data[0] (exactly the byte-identical single-active path).
  const explicitStatus =
    explicit.kind === "ok" ? (explicit.data["status"] as unknown) : undefined;
  const explicitActive =
    profileId !== null &&
    explicit.kind === "ok" &&
    (explicitStatus === "active" || explicitStatus === null || explicitStatus === undefined)
      ? explicit.data
      : null;
  const activeRow: ProfileRow | null =
    explicitActive !== null
      ? explicitActive
      : profiles.kind === "ok" && profiles.data.length > 0
        ? profiles.data[0]!
        : null;
  const active: ProfileSnapshot | null = activeRow !== null ? toSnapshot(activeRow) : null;
  const activeId = active?.id ?? null;
  const dealers = useAsync<DealerList>(
    () => client.listProfileDealers(activeId ?? ""),
    [activeId],
    activeId !== null,
  );
  const threads = useAsync<ThreadList>(
    () => client.listProfileThreads(activeId ?? ""),
    [activeId],
    activeId !== null,
  );
  const negotiations = useAsync<DealerNegotiationList>(
    () => client.listDealerNegotiations(activeId ?? ""),
    [activeId],
    activeId !== null,
  );
  const inventory = useAsync<InventoryCompareResult>(
    () => client.listProfileInventoryCompare(activeId ?? ""),
    [activeId],
    activeId !== null,
  );
  const quotes = useAsync<QuoteCompareResult>(
    () => client.listProfileQuoteCompare(activeId ?? ""),
    [activeId],
    activeId !== null,
  );
  const quotesRaw = useAsync<QuoteList>(
    () => client.listProfileQuotes(activeId ?? ""),
    [activeId],
    activeId !== null,
  );
  const incentives = useAsync<IncentiveList>(
    () => client.listProfileIncentives(activeId ?? ""),
    [activeId],
    activeId !== null,
  );
  const digest = useAsync<DigestView>(
    () => client.getDigest(activeId ?? null),
    [activeId],
    activeId !== null,
  );
  // Fresh-by-default: a data.changed pulse (or a window refocus) refetches
  // exactly these views in place — no manual reload. The active-profile list
  // tracks "profiles"; the dealer tiles track "dealers"; the Threads section
  // tracks "threads"/"messages" (the inbox-pull skill's data families).
  // The profile LIST stays GLOBAL (it isn't profile-specific); the explicit
  // profile read + every per-profile sub-resource is SCOPED to activeId so a
  // write in ANOTHER profile never refetches this focused workbench (a null
  // profile_id pulse — a global/headless write — still refetches everything).
  useDataRefetch(PROFILE_KINDS, profiles.refetch);
  useDataRefetch(PROFILE_KINDS, explicit.refetch, activeId);
  useDataRefetch(DEALER_KINDS, dealers.refetch, activeId);
  useDataRefetch(THREAD_KINDS, threads.refetch, activeId);
  useDataRefetch(NEGOTIATION_KINDS, negotiations.refetch, activeId);
  useDataRefetch(LEAD_KINDS, dealers.refetch, activeId);
  useDataRefetch(INVENTORY_KINDS, inventory.refetch, activeId);
  useDataRefetch(QUOTE_KINDS, quotes.refetch, activeId);
  useDataRefetch(QUOTE_KINDS, quotesRaw.refetch, activeId);
  useDataRefetch(INCENTIVE_KINDS, incentives.refetch, activeId);
  useDataRefetch(DIGEST_KINDS, digest.refetch, activeId);

  // Scalar inputs for the summary bento header.
  const digestProfile =
    digest.kind === "ok" && digest.data.profiles.length > 0 ? digest.data.profiles[0]! : null;

  // Color cross-check one-tap add: APPEND a real stocked color name to the
  // CANVAS-BOUND profile's preferred exterior colors via the existing PATCH path
  // (never re-resolving newest-active — inv #6). Read the current colors so the
  // add never clobbers; skip a duplicate. Invalidate listings (the ranker
  // recomputes colorAxis + the cross-check) and profiles (the chips refresh).
  const addPreferredColor = async (color: string): Promise<void> => {
    if (activeId === null) return;
    const current = parsePreferredColors(activeRow);
    if (current.some((c) => c.toLowerCase() === color.toLowerCase())) return;
    await client.patchProfile(activeId, {
      preferredExteriorColorsJson: JSON.stringify([...current, color]),
    });
    invalidate(["listings", "profiles"], activeId);
  };

  return (
    <div className="canvas" data-testid="canvas">
      {/* The raw run id in a visually-hidden <code> — the harness binds the
          route to the run via run-view-id; nothing visible renders for it. */}
      {runId !== null && (
        <code data-testid="run-view-id" className="run-view-id-hidden">{runId}</code>
      )}
      {profiles.kind === "ok" && active === null && (
        // Mid-run (intake still collecting) the CTA would just duplicate the
        // form in the rail — show the quiet pending line instead.
        runId === null ? (
          <CanvasEmptyState onStartIntake={onStartIntake} deepseekReady={deepseekReady} />
        ) : (
          <p className="muted" data-testid="canvas-pending">
            Your search takes shape here as the run progresses.
          </p>
        )
      )}
      {active !== null && (
        <>
          {/* Context header — part of the canvas's FIXED header zone (it no longer
              scrolls away): the canvas is a flex column and only the tab panel
              below scrolls, so the profile card + summary + tabs stay put while
              the active panel's content (incl. its bottom pager) scrolls in a
              bounded region. See .canvas / [role=tabpanel] in styles.css. */}
          <ProfileCard client={client} snapshot={active} onEditProfile={onEditProfile} />

          {/* Header region — the summary + tab strip; the bottom of the fixed
              header zone, above the single scrolling panel. */}
          <div className="canvas-stickyhead">
            <ProfileSummary
              bestOtd={deriveBestOtd(quotes, digest)}
              dealerCount={dealers.kind === "ok" ? dealers.data.length : null}
              quoteCount={quotesRaw.kind === "ok" ? quotesRaw.data.length : null}
              threadCount={threads.kind === "ok" ? threads.data.length : null}
              needsReplyCount={digestProfile?.needsResponseCount ?? null}
              inventoryRecommended={inventory.kind === "ok" ? inventory.data.recommendedCount : null}
              inventoryTotal={inventory.kind === "ok" ? inventory.data.totalListings : null}
              headline={digest.kind === "ok" ? digest.data.headline : null}
            />
            <CanvasTabs
              active={tab}
              onSelect={(k) => setTab(k as TabKey)}
              tabs={[
                { key: "overview", label: "Overview", count: null },
                { key: "dealers", label: "Dealers", count: dealers.kind === "ok" ? dealers.data.length : null },
                {
                  key: "inventory",
                  label: "Inventory",
                  count: inventory.kind === "ok" ? inventory.data.candidates.length : null,
                },
                { key: "quotes", label: "Quotes", count: quotesRaw.kind === "ok" ? quotesRaw.data.length : null },
                {
                  key: "replies",
                  label: "Negotiations",
                  count: negotiations.kind === "ok" ? negotiations.data.length : null,
                },
                {
                  key: "incentives",
                  label: "Incentives",
                  count: incentives.kind === "ok" ? incentives.data.length : null,
                },
              ]}
            />
          </div>

          {/* Only the active tab's panel renders below the sticky header. */}
          <div
            role="tabpanel"
            id={`canvas-panel-${tab}`}
            aria-labelledby={`canvas-tab-${tab}-tab`}
            data-testid={`canvas-panel-${tab}`}
          >
            {tab === "overview" && (
              <OverviewPanel
                snapshot={active}
                dealerCount={dealers.kind === "ok" ? dealers.data.length : null}
                digest={digest}
              />
            )}
            {tab === "dealers" && <DealerTiles dealers={dealers} />}
            {tab === "inventory" && (
              <InventoryCandidates
                inventory={inventory}
                profileId={activeId}
                {...(activeId !== null ? { onAddPreferredColor: addPreferredColor } : {})}
              />
            )}
            {tab === "quotes" && (
              <QuotesPanel
                quotes={quotes}
                quotesRaw={quotesRaw}
                {...(activeId !== null
                  ? { quoteSourceUrl: (quoteId: string) => client.quoteSourceUrl(activeId, quoteId) }
                  : {})}
              />
            )}
            {tab === "replies" && (
              <NegotiationsBoard
                negotiations={negotiations}
                dealerCount={dealers.kind === "ok" ? dealers.data.length : 0}
                {...(activeId !== null
                  ? {
                      fetchDetail: (dealerId: string) =>
                        client.getDealerNegotiationDetail(activeId, dealerId),
                      fetchSummary: (dealerId: string) =>
                        client.getDealerNegotiationSummary(activeId, dealerId),
                    }
                  : {})}
              />
            )}
            {tab === "incentives" && <Incentives incentives={incentives} />}
          </div>
        </>
      )}
      {profiles.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load your searches: {profiles.message}
        </p>
      )}
    </div>
  );
}
