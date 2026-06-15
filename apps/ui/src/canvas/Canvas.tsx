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

import { useRef, useState } from "react";

import { ApiClient } from "../api/client.js";
import { useAsync, type AsyncState } from "../api/useApi.js";
import { useDataRefetch } from "../api/useDataChanged.js";
import type {
  DealerList,
  DealerRow,
  InventoryCompareResult,
  ProfileList,
  QuoteCompareResult,
  QuoteList,
  ThreadList,
} from "../api/wire.js";
import { formatLocation, toSnapshot, vehicleLabel, type ProfileSnapshot } from "../home/profileView.js";
import { Link } from "../router.js";
import { InventoryCandidates } from "./InventoryCandidates.js";
import { ProfileEditPanel } from "./ProfileEditPanel.js";
import { ProfileRemoveControl } from "./ProfileRemoveControl.js";
import { QuoteCompare } from "./QuoteCompare.js";
import { Quotes } from "./Quotes.js";
import { ThreadsSection } from "./ThreadsSection.js";

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

export interface CanvasProps {
  client: ApiClient;
  /** Start intake (fresh unpinned session) — the empty-state CTA. */
  onStartIntake: () => void;
  /** Present when rendered at /runs/:id — binds the workbench to that run. */
  runId?: string | null;
  /** Whether the required DeepSeek key is configured. When false, the start CTA
   *  is disabled and points to Settings (the first-run gate). */
  deepseekReady?: boolean;
  /** Whether the cross-provider RETRY key (Anthropic) is configured. Gates the
   *  Threads section's manual "retry failed extractions" affordance. */
  anthropicReady?: boolean;
  /** Launch the MANUAL cross-provider retry of a profile's failed extractions
   *  (escalate:true). The host owns the launch (session/pin threading); the
   *  active profile id is passed so the host pins it. */
  onRetryFailedExtractions?: (profileId: string) => void;
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
  client,
  snapshot,
  onSaved,
}: {
  client: ApiClient;
  snapshot: ProfileSnapshot;
  /** Invoked after a successful preference save — the host refetches the list
   *  (the snapshot the read view renders comes from the refreshed profiles). */
  onSaved: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const identity = [
    snapshot.year !== null ? String(snapshot.year) : null,
    snapshot.make,
    snapshot.model,
    snapshot.trim,
    formatLocation(snapshot.location),
  ].filter((c): c is string => c !== null && c !== "");

  // Cancel/save both return focus to the Edit-preferences button (a11y).
  const exitEdit = (): void => {
    setEditing(false);
    // Focus returns after the read view re-renders.
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };
  const handleSaved = (): void => {
    onSaved();
    exitEdit();
  };

  return (
    <section className="card profile-card" data-testid="canvas-profile-card">
      <h2 data-testid="canvas-vehicle">{vehicleLabel(snapshot) || "Active search"}</h2>

      {/* Frozen identity — display-only chips. In edit mode they dim + carry the
          explicit lock affordance; they are NEVER inputs. */}
      <div className="chip-row" data-testid="profile-identity-frozen">
        <span className="chip-row-label">Identity</span>
        {identity.map((chip) => (
          <span
            className="mini-chip locked"
            key={chip}
            {...(editing
              ? {
                  "aria-disabled": true,
                  title:
                    "identity is frozen — use Replace (delete + recreate) to change the vehicle",
                }
              : {})}
          >
            {editing && <span aria-hidden="true">🔒</span>}
            {chip}
          </span>
        ))}
        <span className="muted chip-note">frozen at confirm — to change, replace the search</span>
      </div>

      {editing ? (
        snapshot.id !== null ? (
          <ProfileEditPanel
            client={client}
            profileId={snapshot.id}
            onSaved={handleSaved}
            onCancel={exitEdit}
          />
        ) : null
      ) : (
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
              ref={editButtonRef}
              type="button"
              className="profile-edit-open"
              data-testid="profile-edit-open"
              aria-expanded={editing}
              onClick={() => setEditing(true)}
            >
              Edit preferences
            </button>
          )}
        </div>
      )}

      {/* Card foot — the soft-delete control, separated from the preferences by
          a ledger rule. Only in the read view (never while editing). */}
      {!editing && snapshot.id !== null && (
        <div className="profile-card-foot">
          <ProfileRemoveControl client={client} profileId={snapshot.id} />
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
      <div className="t-status">{str(row, "candidate_status") ?? "candidate"}</div>
    </div>
  );
}

function DealerTiles({ dealers }: { dealers: AsyncState<DealerList> }): JSX.Element {
  return (
    <section data-testid="canvas-dealer-tiles">
      <h2>Dealers</h2>
      {dealers.kind === "loading" && <p className="muted">Loading dealers…</p>}
      {dealers.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load dealers: {dealers.message}
        </p>
      )}
      {dealers.kind === "ok" && dealers.data.length === 0 && (
        <p className="muted" data-testid="canvas-dealers-empty">
          No dealers yet — run /dealer_geosearch to find dealers near you.
        </p>
      )}
      {dealers.kind === "ok" && dealers.data.length > 0 && (
        <div className="tile-grid">
          {dealers.data.map((row, i) => (
            <DealerTile key={str(row, "dealer_id") ?? String(i)} row={row} rank={i + 1} />
          ))}
        </div>
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
      ? ["Find dealers near you — run /dealer_geosearch."]
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
// the canvas
// ---------------------------------------------------------------------------

export function Canvas({
  client,
  onStartIntake,
  runId = null,
  deepseekReady = true,
  anthropicReady = false,
  onRetryFailedExtractions,
}: CanvasProps): JSX.Element {
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

  return (
    <div className="canvas" data-testid="canvas">
      {runId !== null && (
        <p className="muted canvas-runline">
          Run <code data-testid="run-view-id">{runId}</code> — follow along in the conversation
          on the right.
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
          <ProfileCard client={client} snapshot={active} onSaved={profiles.refetch} />
          <DealerTiles dealers={dealers} />
          <InventoryCandidates inventory={inventory} />
          <QuoteCompare quotes={quotes} />
          <Quotes quotes={quotesRaw} />
          <ThreadsSection
            threads={threads}
            dealerCount={dealers.kind === "ok" ? dealers.data.length : 0}
            anthropicReady={anthropicReady}
            onRetryFailedExtractions={() => {
              if (activeId !== null) onRetryFailedExtractions?.(activeId);
            }}
          />
          <CanvasFeed
            snapshot={active}
            dealerCount={dealers.kind === "ok" ? dealers.data.length : null}
          />
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
