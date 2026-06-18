/**
 * Canvas — the workbench main pane: a READ-ONLY projection of the active
 * search. Profile card (frozen identity chips + preference chips), dealer
 * tiles (the dealers projection route), and the what-happened/what's-next
 * feed, all derived from DB state over the read routes. With no active profile
 * it renders the empty state — the start-here surface (headline, the
 * first-steps walkthrough, and the Start CTA, one of the intake entries).
 *
 * Budget red-line: the canvas consumes the dealer-safe ProfileSnapshot (no
 * budget accessor) — budget can render only as the "internal-only" lock chip,
 * never a number. Identity chips are display-only: identity freezes at
 * confirm, so there is no identity edit here, ever.
 *
 * At /runs/:id the canvas doubles as the run workbench view: the run id line
 * binds the route to the run (stable run-view-id testid).
 */

import { useState } from "react";

import { ApiClient } from "../api/client.js";
import { useAsync, type AsyncState } from "../api/useApi.js";
import { useDataRefetch } from "../api/useDataChanged.js";
import type {
  DealerList,
  DealerRow,
  DigestView,
  IncentiveList,
  InventoryCompareResult,
  ProfileList,
  QuoteCompareResult,
  QuoteList,
  SkillRunSummary,
  ThreadList,
} from "../api/wire.js";
import {
  formatLocation,
  prettifySkill,
  toSnapshot,
  vehicleLabel,
  type ProfileSnapshot,
} from "../home/profileView.js";
import { Link } from "../router.js";
import { CanvasTabs } from "./CanvasTabs.js";
import { Incentives } from "./Incentives.js";
import { Pager } from "./Pager.js";
import { ProfileSummary } from "./ProfileSummary.js";
import { InventoryCandidates } from "./InventoryCandidates.js";
import { ProfileRemoveControl } from "./ProfileRemoveControl.js";
import { QuotesPanel } from "./QuotesPanel.js";
import { ThreadsSection } from "./ThreadsSection.js";
import { usePagedList } from "./usePagedList.js";

/** The data kinds the Canvas's read views render — stable module-level literals
 *  so useDataRefetch re-registers only when the refetch identity (not the array
 *  identity) changes. */
const PROFILE_KINDS = ["profiles"] as const;
const DEALER_KINDS = ["dealers"] as const;
/** The dealer-reply Threads section refetches on a threads/messages pulse (the
 *  inbox-pull skill writes both families). */
const THREAD_KINDS = ["threads", "messages"] as const;
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

export interface CanvasProps {
  client: ApiClient;
  /** Start intake (fresh unpinned session) — the empty-state CTA. */
  onStartIntake: () => void;
  /** Present when rendered at /runs/:id — binds the workbench to that run. */
  runId?: string | null;
  /** Whether the required DeepSeek key is configured. When false, the start CTA
   *  is disabled and points to Settings (the first-run gate). */
  deepseekReady?: boolean;
  /** Open the unified view/edit modal for the active profile. */
  onEditProfile: (id: string, name: string) => void;
  /** Open the irreversible hard-delete confirm for the active profile. */
  onDeleteProfile: (id: string, name: string) => void;
}

function str(row: DealerRow, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function num(row: DealerRow, key: string): number | null {
  const v = row[key];
  return typeof v === "number" ? v : null;
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
// profile card — frozen identity chips + preference chips (read-only)
// ---------------------------------------------------------------------------

function ProfileCard({
  snapshot,
  client,
  onEditProfile,
  onDeleteProfile,
}: {
  snapshot: ProfileSnapshot;
  client: ApiClient;
  /** Open the unified view/edit modal for this profile. */
  onEditProfile: (id: string, name: string) => void;
  /** Open the irreversible hard-delete confirm for this profile. */
  onDeleteProfile: (id: string, name: string) => void;
}): JSX.Element {
  const identity = [
    snapshot.year !== null ? String(snapshot.year) : null,
    snapshot.make,
    snapshot.model,
    snapshot.trim,
    formatLocation(snapshot.location),
  ].filter((c): c is string => c !== null && c !== "");
  const name = vehicleLabel(snapshot) || "this search";

  return (
    <section className="card profile-card" data-testid="canvas-profile-card">
      <h2 data-testid="canvas-vehicle">{vehicleLabel(snapshot) || "Active search"}</h2>

      {/* Frozen identity — display-only chips (never inputs; identity freezes at
          confirm — to change the vehicle, replace the search). */}
      <div className="chip-row" data-testid="profile-identity-frozen">
        <span className="chip-row-label">Identity</span>
        {identity.map((chip) => (
          <span className="mini-chip locked" key={chip}>
            {chip}
          </span>
        ))}
        <span className="muted chip-note">frozen at confirm — to change, replace the search</span>
      </div>

      <div className="chip-row">
        <span className="chip-row-label">Preferences</span>
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
          <button
            type="button"
            className="profile-edit-open"
            data-testid="profile-edit-open"
            onClick={() => onEditProfile(snapshot.id!, name)}
          >
            Edit preferences
          </button>
        )}
      </div>

      {/* Card foot — removal controls behind a ledger rule. The recoverable soft
          "Remove" (→ Closed searches) is the default; the irreversible
          "Delete permanently" sits beside it, one click to the confirm modal. */}
      {snapshot.id !== null && (
        <div className="profile-card-foot profile-card-removal">
          <ProfileRemoveControl client={client} profileId={snapshot.id} />
          <button
            type="button"
            className="btn-danger profile-hard-delete-open"
            data-testid="profile-hard-delete-open"
            onClick={() => onDeleteProfile(snapshot.id!, name)}
          >
            Delete permanently…
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// dealer tiles — materialized from profile_dealers rows
// ---------------------------------------------------------------------------

function DealerTile({ row, rank }: { row: DealerRow; rank: number }): JSX.Element {
  const distance = num(row, "distance_miles");
  return (
    <div className="tile" data-testid="canvas-dealer-tile">
      <div className="t-head">
        <span>
          {rank}. {str(row, "name") ?? "Unknown dealer"}
        </span>
        {distance !== null && <span className="muted">{distance.toFixed(1)} mi</span>}
      </div>
      {str(row, "address") !== null && <div className="t-addr">{str(row, "address")}</div>}
      <div className="t-status">
        {str(row, "candidate_status") ?? "candidate"}
        {(num(row, "lead_submission_count") ?? 0) > 0 && (
          <span className="mini-chip" data-testid="dealer-lead-submitted">
            {" "}
            lead submitted
          </span>
        )}
      </div>
    </div>
  );
}

// A stable module-level empty list so usePagedList's items reference is stable
// while dealers are loading/errored (avoids a page reset on every render).
const NO_DEALERS: DealerList = [];
const DEALER_PAGE_SIZE = 12;

function DealerTiles({ dealers }: { dealers: AsyncState<DealerList> }): JSX.Element {
  const rows = dealers.kind === "ok" ? dealers.data : NO_DEALERS;
  // A metro at the 125mi default can surface 30+ dealers — paginate like the
  // Inventory/Replies tabs so the list stays scannable for a non-technical buyer.
  const pager = usePagedList(rows, DEALER_PAGE_SIZE);
  return (
    <section data-testid="canvas-dealer-tiles">
      <h2>Dealers</h2>
      {dealers.kind === "loading" && <p className="muted">Loading dealers…</p>}
      {dealers.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load dealers: {dealers.message}
        </p>
      )}
      {dealers.kind === "ok" && rows.length === 0 && (
        <p className="muted" data-testid="canvas-dealers-empty">
          No dealers yet — search for dealers near you to get started.
        </p>
      )}
      {dealers.kind === "ok" && rows.length > 0 && (
        <>
          <div className="tile-grid">
            {pager.pageItems.map((row, i) => (
              <DealerTile
                key={str(row, "dealer_id") ?? String(pager.rangeStart + i)}
                row={row}
                rank={pager.rangeStart + i}
              />
            ))}
          </div>
          <Pager
            page={pager.page}
            pageCount={pager.pageCount}
            total={pager.total}
            rangeStart={pager.rangeStart}
            rangeEnd={pager.rangeEnd}
            onPrev={pager.prev}
            onNext={pager.next}
            canPrev={pager.canPrev}
            canNext={pager.canNext}
            noun="dealers"
          />
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
      : ["Quotes land here as the email pipeline skills come online."];

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
  deepseekReady = true,
  onEditProfile,
  onDeleteProfile,
}: CanvasProps): JSX.Element {
  const [tab, setTab] = useState<TabKey>("overview");
  const profiles = useAsync<ProfileList>(() => client.listProfiles("active"), []);
  const active: ProfileSnapshot | null =
    profiles.kind === "ok" && profiles.data.length > 0 ? toSnapshot(profiles.data[0]!) : null;
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
  // At /runs/:id the header shows a human-friendly name (vehicle, else the
  // running skill's prettified name) instead of the raw run id — the buyer
  // never reads a slug. Fetched only when a run is in view.
  const runStatus = useAsync<SkillRunSummary>(
    () => client.runStatus(runId!),
    [runId],
    runId !== null,
  );

  // Fresh-by-default: a data.changed pulse (or a window refocus) refetches
  // exactly these views in place — no manual reload. The active-profile list
  // tracks "profiles"; the dealer tiles track "dealers"; the Threads section
  // tracks "threads"/"messages" (the inbox-pull skill's data families).
  useDataRefetch(PROFILE_KINDS, profiles.refetch);
  useDataRefetch(DEALER_KINDS, dealers.refetch);
  useDataRefetch(THREAD_KINDS, threads.refetch);
  useDataRefetch(LEAD_KINDS, dealers.refetch);
  useDataRefetch(INVENTORY_KINDS, inventory.refetch);
  useDataRefetch(QUOTE_KINDS, quotes.refetch);
  useDataRefetch(QUOTE_KINDS, quotesRaw.refetch);
  useDataRefetch(INCENTIVE_KINDS, incentives.refetch);
  useDataRefetch(DIGEST_KINDS, digest.refetch);

  // Scalar inputs for the summary bento header.
  const digestProfile =
    digest.kind === "ok" && digest.data.profiles.length > 0 ? digest.data.profiles[0]! : null;

  // The visible run-view header: the active vehicle if known, else the running
  // skill's friendly name, else a neutral fallback. The raw run id stays in a
  // visually-hidden <code> for the harness binding (run-view-id), never on screen.
  const headerLabel =
    (active !== null ? vehicleLabel(active) : "") ||
    (runStatus.kind === "ok" ? prettifySkill(runStatus.data.skill) : "") ||
    "Your search";

  return (
    <div className="canvas" data-testid="canvas">
      {runId !== null && (
        <p className="muted canvas-runline" data-testid="run-view-line">
          <span className="run-view-label">
            {headerLabel} — follow along in the conversation on the right.
          </span>
          <code data-testid="run-view-id" className="run-view-id-hidden">{runId}</code>
        </p>
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
          {/* Context header — ProfileCard scrolls away ABOVE the sticky region. */}
          <ProfileCard
            client={client}
            snapshot={active}
            onEditProfile={onEditProfile}
            onDeleteProfile={onDeleteProfile}
          />

          {/* Sticky header region — the summary + the tab strip stick together
              below the topbar; only ONE owner of stickiness (the wrapper). */}
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
                { key: "replies", label: "Replies", count: threads.kind === "ok" ? threads.data.length : null },
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
            {tab === "inventory" && <InventoryCandidates inventory={inventory} />}
            {tab === "quotes" && (
              <QuotesPanel quotes={quotes} quotesRaw={quotesRaw} />
            )}
            {tab === "replies" && (
              <ThreadsSection
                threads={threads}
                dealerCount={dealers.kind === "ok" ? dealers.data.length : 0}
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
