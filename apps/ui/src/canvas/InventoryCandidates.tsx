/**
 * InventoryCandidates — the READ-ONLY "Inventory candidates" projection on the
 * workbench canvas. After the inventory scans collect public-website listings,
 * the /inventory_compare ranker scores them against the active search and the
 * top candidates surface here, each with a rank-reason chip row, a match-status
 * chip, the full VIN, the stock number, the listed price, and the dealer +
 * distance.
 *
 * LISTINGS ≠ QUOTES (load-bearing): these are public-website inventory
 * candidates ranked against the profile, NOT negotiated out-the-door quotes.
 * The heading reads "Inventory candidates" — NEVER "quotes" / "offers". There is
 * NO audit pill here (audit flags belong to the quote surfaces, not listings).
 *
 * Budget red line: a candidate renders the vehicle, the full VIN, the stock
 * number, the LISTED price (a public sticker, never an internal budget), the
 * dealer + distance, and the rank reasons — NEVER a budget. A null listed_price
 * renders an "incomplete" badge, never a fabricated number; a null stock_number
 * renders an em-dash. Presentational ONLY: it takes its rows as a PROP (an
 * AsyncState the host wires from the ranker route) and knows nothing about the
 * API client. LIGHT paper skin, mirroring the threads + dealer-tiles sections.
 */

import { useMemo, useState } from "react";

import type { AsyncState } from "../api/useApi.js";
import type { InventoryColorCrossCheckItem, InventoryCompareResult } from "../api/wire.js";
import { ClickableTile } from "./ClickableTile.js";
import { distanceLabel, dollarLabel, relativeDate } from "./format.js";
import { InventoryDetailModal } from "./InventoryDetailModal.js";
import { Pager } from "./Pager.js";
import { usePagedList } from "./usePagedList.js";

/** One ranked candidate the section renders. Extra server fields are tolerated
 *  and ignored. */
export interface InventoryCandidate {
  listing_id: string;
  vin: string | null;
  stock_number: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  exterior_color: string | null;
  interior_color: string | null;
  /** Public VDP href (or null) — the card's "View listing" click-through target. */
  listing_url: string | null;
  listed_price: number | null;
  msrp: number | null;
  /** The dealer's own LABELED market adjustment (markup) in dollars, or null. 0
   *  means "scanned, none"; a positive number is the only thing red-flagged. */
  dealer_markup: number | null;
  /** Dealer add-on line items (the junk buyers hate); [] when none captured. */
  add_ons: { label: string; amount: number }[];
  /** Sum of the add-on amounts in dollars, or null. */
  addons_total: number | null;
  /** A LABELED dealer discount (savings off MSRP) in dollars, or null — recovered
   *  by the folded LLM price-block read. */
  dealer_discount: number | null;
  /** A short verbatim manufacturer-incentive phrase, or null. Same provenance. */
  incentives_text: string | null;
  /** true when the listing's price was hidden behind a "Get your price" CTA. */
  price_gated: boolean;
  /** true ⇔ a price-stack region was actually read; false = "couldn't read"
   *  (distinct from a parsed-but-empty breakdown). */
  breakdown_parsed: boolean;
  inventory_status: string;
  dealer_name: string | null;
  distance_miles: number | null;
  reasons: string[];
  match_status: string;
  recommended: boolean;
  [key: string]: unknown;
}

/** The three dealership-style orderings the segmented sort control offers. */
export type InventorySort = "bestmatch" | "price" | "distance";

/** The price the lowest-price sort keys on, or null when there is no honest
 *  price to rank: a price-gated ("Get your price") listing or a null
 *  listed_price never sorts as $0 — both sink to the bottom (nulls-last). */
function priceSortKey(c: InventoryCandidate): number | null {
  return c.price_gated ? null : c.listed_price;
}

/**
 * Order the candidates for the chosen sort. `bestmatch` is a SERVER-ORDER
 * NO-OP: the rows arrive in the ranker's match-tier→score→id order (the order
 * `recommended`/`reasons` were computed against), so it passes the SAME array
 * straight through — never re-sorted, never keyed off the index-signature
 * `score`. The price/distance branches COPY first (`.sort()` mutates in place;
 * sorting the prop array would corrupt it) and put nulls LAST on both axes
 * (the canonical nulls-last comparator), so a gated/unknown row never floats to
 * the top as a fake cheapest/nearest.
 */
export function sortCandidates(rows: InventoryCandidate[], sort: InventorySort): InventoryCandidate[] {
  if (sort === "bestmatch") return rows;
  const copy = [...rows];
  if (sort === "price") {
    copy.sort((a, b) => {
      const av = priceSortKey(a);
      const bv = priceSortKey(b);
      if (av === null) return bv === null ? 0 : 1;
      if (bv === null) return -1;
      return av - bv;
    });
  } else {
    copy.sort((a, b) => {
      const av = a.distance_miles;
      const bv = b.distance_miles;
      if (av === null) return bv === null ? 0 : 1;
      if (bv === null) return -1;
      return av - bv;
    });
  }
  return copy;
}

/** "2026 Hyundai Tucson Limited"-style label from the candidate's identity
 *  fields (any null/empty part is dropped). */
export function vehicleHeader(c: InventoryCandidate): string {
  return [c.year !== null ? String(c.year) : null, c.make, c.model, c.trim]
    .filter((x): x is string => x !== null && x !== "")
    .join(" ");
}

function CandidateRow({
  row,
  onActivate,
}: {
  row: InventoryCandidate;
  onActivate: () => void;
}): JSX.Element {
  const header = vehicleHeader(row) || "Inventory listing";
  const price = dollarLabel(row.listed_price);
  const distance = distanceLabel(row.distance_miles);
  // ONE consolidated price-flag chip (never two). A LABELED dealer markup (RED)
  // outranks add-ons (AMBER); itemization stays in the detail modal. The ⚑ glyph
  // is decorative (aria-hidden) — the chip text carries the meaning (a11y: color
  // is never the only signal).
  const markup =
    typeof row.dealer_markup === "number" && row.dealer_markup > 0 ? row.dealer_markup : null;
  const addonsTotal = typeof row.addons_total === "number" ? row.addons_total : null;
  const hasAddons =
    (Array.isArray(row.add_ons) && row.add_ons.length > 0) ||
    (addonsTotal !== null && addonsTotal > 0);
  return (
    <ClickableTile
      testid="inventory-candidate-row"
      ariaLabel={`View details for ${header}`}
      onActivate={onActivate}
    >
      <div className="t-head">
        <span>{header}</span>
        <span
          className={`mini-chip inventory-match-${row.match_status}`}
          data-testid="inventory-match-status"
        >
          {row.match_status}
        </span>
        {/* A recommended listing whose availability the scan could not read
            (inventory_status "unknown") is surfaced honestly — we never claim a
            confirmed stock the scan didn't see. The data layer keeps the
            "unknown" distinction; this chip only renders on a recommended row. */}
        {row.recommended && row.inventory_status === "unknown" && (
          <span
            className="mini-chip inventory-avail-unconfirmed"
            data-testid="inventory-availability-caveat"
            title="This car is on the dealer's inventory page, but the scan couldn't confirm it's in stock."
          >
            availability unconfirmed
          </span>
        )}
      </div>
      <div className="t-addr">
        VIN <span data-testid="inventory-candidate-vin">{row.vin ?? "—"}</span>
        {" · stock "}
        {row.stock_number !== null && row.stock_number !== "" ? (
          <span data-testid="inventory-stock">{row.stock_number}</span>
        ) : (
          // A missing stock number renders an em-dash (never fabricated). A
          // dedicated testid lets a test assert the em-dash regardless of which
          // rank position the no-stock listing lands in.
          <span data-testid="inventory-stock-missing">—</span>
        )}
      </div>
      <div className="t-status">
        {price !== null ? (
          <span>{price}</span>
        ) : (
          <span className="mini-chip" data-testid="inventory-incomplete-badge">
            incomplete
          </span>
        )}
        {row.dealer_name !== null && row.dealer_name !== "" && (
          <span className="muted"> · {row.dealer_name}</span>
        )}
        {distance !== null && <span className="muted"> · {distance}</span>}
        {typeof row.listing_url === "string" && row.listing_url !== "" && (
          <>
            {" · "}
            <a
              href={row.listing_url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="inventory-listing-link"
              onClick={(e) => e.stopPropagation()}
            >
              View listing ↗
            </a>
          </>
        )}
      </div>
      {markup !== null ? (
        <div className="chip-row">
          <span className="mini-chip flag-chip flag-red" data-testid="inventory-markup-flag">
            <span aria-hidden="true">⚑</span> dealer markup +{dollarLabel(markup)}
          </span>
        </div>
      ) : hasAddons ? (
        <div className="chip-row">
          <span className="mini-chip flag-chip warn" data-testid="inventory-addons-flag">
            <span aria-hidden="true">⚑</span>{" "}
            {addonsTotal !== null && addonsTotal > 0
              ? `${dollarLabel(addonsTotal)} add-ons`
              : "dealer add-ons"}
          </span>
        </div>
      ) : null}
      {row.reasons.length > 0 && (
        <div className="chip-row">
          {row.reasons.map((reason) => (
            <span className="mini-chip" key={reason} data-testid="inventory-reason-chip">
              {reason}
            </span>
          ))}
        </div>
      )}
    </ClickableTile>
  );
}

/**
 * ColorCrossCheckTile — the color-config cross-check advisory. The scan found the
 * REAL stocked exterior-color names; the buyer's loose preference ("red") won't
 * exact-match them ("Radiant Red Metallic II"), so matching cars rank lower. This
 * explains WHY and offers each canonical name as an explicit ONE-TAP add (the
 * human taps — assist-not-autofill, product rule #1). Dismissible. No suspend,
 * no ranker change — adding the canonical name is what makes colorAxis fire.
 */
function ColorCrossCheckTile({
  items,
  onAdd,
  onDismiss,
}: {
  items: InventoryColorCrossCheckItem[];
  onAdd: (color: string) => Promise<void>;
  onDismiss: () => void;
}): JSX.Element {
  // The names the buyer has tapped this view — immediate feedback + no double-add
  // (the next ranker refetch drops a reconciled name from the suggestions anyway).
  const [added, setAdded] = useState<Set<string>>(new Set());
  const handleAdd = async (color: string): Promise<void> => {
    try {
      await onAdd(color);
      // Only mark added (the ✓) once the PATCH actually succeeded.
      setAdded((prev) => new Set(prev).add(color));
    } catch {
      // PATCH failed — leave the button enabled (no false ✓) so the buyer retries.
    }
  };
  return (
    <div className="color-crosscheck" role="note" data-testid="inventory-color-crosscheck">
      <strong>Color names don’t match what dealers stock</strong>
      <p>
        These color preferences don’t match the exact names dealers list, so
        matching listings may rank lower. Add a real stocked name to fix the ranking.
      </p>
      <ul>
        {items.map((it) => (
          <li key={it.requested}>
            <span className="cc-req">You said “{it.requested}”. Dealers stock:</span>
            <span className="cc-suggestions">
              {it.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="cc-add mini-chip"
                  data-testid="inventory-color-add"
                  disabled={added.has(s)}
                  onClick={() => void handleAdd(s)}
                >
                  {added.has(s) ? `Added ✓ ${s}` : `Add “${s}” to my colors`}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="cc-dismiss"
        data-testid="inventory-color-crosscheck-dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

export interface InventoryCandidatesProps {
  /** The profile's ranked candidates (the host wires this from the ranker route). */
  inventory: AsyncState<InventoryCompareResult>;
  /** The CANVAS-BOUND (already-pinned) profile id — keys the dismissed-set so a
   *  profile switch re-shows its own advisory. The one-tap add targets THIS id
   *  (the host's onAddPreferredColor closes over it), never a re-resolved
   *  newest-active (inv #6). */
  profileId?: string | null;
  /** Append a real stocked color name to the bound profile's preferred exterior
   *  colors via the existing PATCH path (the host wires client.patchProfile +
   *  query invalidation). Absent → the cross-check tile is not shown. */
  onAddPreferredColor?: (color: string) => Promise<void>;
}

const PAGE_SIZE = 12;

export function InventoryCandidates({
  inventory,
  profileId = null,
  onAddPreferredColor,
}: InventoryCandidatesProps): JSX.Element {
  const allCandidates =
    inventory.kind === "ok" ? (inventory.data.candidates as InventoryCandidate[]) : [];
  const recommendedCount = inventory.kind === "ok" ? inventory.data.recommendedCount : 0;
  const totalListings =
    inventory.kind === "ok"
      ? (inventory.data.totalListings ?? allCandidates.length)
      : 0;
  const scannedAtMax = inventory.kind === "ok" ? inventory.data.scannedAtMax : null;
  // Scan provenance: distinguishes "a scan ran, found 0" from "never scanned"
  // so the empty-state doesn't tell a user who just scanned to scan again.
  const sourcesScanned = inventory.kind === "ok" ? (inventory.data.sourcesScanned ?? 0) : 0;
  const sourcesBlocked = inventory.kind === "ok" ? (inventory.data.sourcesBlocked ?? 0) : 0;

  // Default to "recommended" when there are any recommended candidates; else "all".
  const [filter, setFilter] = useState<"recommended" | "all">(
    () => (recommendedCount > 0 ? "recommended" : "all"),
  );

  // Dealership-style sort (default best-match = the ranker's server order) +
  // curated filters: hide labeled-markup rows, cap the listed price.
  const [sort, setSort] = useState<InventorySort>("bestmatch");
  const [noMarkup, setNoMarkup] = useState(false);
  const [maxPriceText, setMaxPriceText] = useState("");
  // The active price cap, or null when the input is blank/zero/garbage (no cap).
  const maxPrice = useMemo(() => {
    const n = Number(maxPriceText);
    return maxPriceText.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
  }, [maxPriceText]);

  // The candidate whose read-only detail modal is open (null = closed).
  const [detail, setDetail] = useState<InventoryCandidate | null>(null);

  // Color cross-check advisory — actionable rows from the ranker result. A simple
  // per-profile dismissed-set suppresses the tile once dismissed (don't nag);
  // reconciled colors drop out at the data level on the next ranker refetch.
  const colorCrossCheck: InventoryColorCrossCheckItem[] =
    inventory.kind === "ok" ? (inventory.data.colorCrossCheck ?? []) : [];
  const [dismissedFor, setDismissedFor] = useState<Set<string>>(new Set());
  const ccKey = profileId ?? "";
  const showCrossCheck =
    onAddPreferredColor !== undefined &&
    colorCrossCheck.length > 0 &&
    !dismissedFor.has(ccKey);

  // Re-compute the visible list in one pass: scope filter → curated filters →
  // sort. A new array identity on every control/candidate change resets the
  // pager to page 1 (usePagedList watches the items reference); best-match with
  // no active filter passes `allCandidates` straight through (no needless copy).
  const filtered = useMemo(() => {
    let rows = filter === "recommended" ? allCandidates.filter((c) => c.recommended) : allCandidates;
    if (noMarkup) {
      // Drop exactly the rows that render the red dealer-markup flag (>0; a 0 is
      // "scanned, none" and stays).
      rows = rows.filter((c) => !(typeof c.dealer_markup === "number" && c.dealer_markup > 0));
    }
    if (maxPrice !== null) {
      // A capped price excludes null-price rows (no honest price to compare).
      rows = rows.filter((c) => c.listed_price !== null && c.listed_price <= maxPrice);
    }
    return sortCandidates(rows, sort);
  }, [allCandidates, filter, noMarkup, maxPrice, sort]);

  const pager = usePagedList(filtered, PAGE_SIZE);

  const scannedWhen = relativeDate(scannedAtMax);

  return (
    <section data-testid="canvas-inventory-candidates">
      <h2>Inventory candidates</h2>
      {showCrossCheck && (
        <ColorCrossCheckTile
          items={colorCrossCheck}
          onAdd={(color) => onAddPreferredColor?.(color) ?? Promise.resolve()}
          onDismiss={() => setDismissedFor((prev) => new Set(prev).add(ccKey))}
        />
      )}
      {inventory.kind === "loading" && <p className="muted">Loading inventory…</p>}
      {inventory.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load inventory: {inventory.message}
        </p>
      )}
      {inventory.kind === "ok" && totalListings === 0 && (
        <>
          <p className="muted" data-testid="canvas-inventory-empty">
            Listed 0 inventory candidates (recommended: 0).
          </p>
          <p className="muted" data-testid="inventory-empty-hint">
            {sourcesScanned > 0
              ? `Your last scan of ${sourcesScanned} dealer site${sourcesScanned === 1 ? "" : "s"} found no matching cars in stock` +
                (sourcesBlocked > 0
                  ? ` (${sourcesBlocked} site${sourcesBlocked === 1 ? "" : "s"} blocked automated scanning)`
                  : "") +
                ". Try widening the trim, or check back later."
              : "No inventory yet — run a site scan to find matching cars on dealer lots."}
          </p>
        </>
      )}
      {inventory.kind === "ok" && totalListings > 0 && (
        <>
          <div className="inventory-controls">
            {/* SCOPE — the existing Recommended/All segmented control. */}
            <div className="modeswitch" role="group" aria-label="Scope">
              <button
                type="button"
                className={filter === "recommended" ? "on" : undefined}
                aria-pressed={filter === "recommended"}
                data-testid="inventory-filter-recommended"
                onClick={() => setFilter("recommended")}
                disabled={recommendedCount === 0}
              >
                Recommended {recommendedCount}
              </button>
              <button
                type="button"
                className={filter === "all" ? "on" : undefined}
                aria-pressed={filter === "all"}
                data-testid="inventory-filter-all"
                onClick={() => setFilter("all")}
              >
                All {totalListings}
              </button>
            </div>
            {/* SORT — a sibling segmented control, labeled so the two groups read
                distinctly. Best-match is the ranker's order; the others re-rank. */}
            <div className="inventory-sortgroup">
              <span className="control-label" id="inventory-sort-label">
                Sort
              </span>
              <div className="modeswitch" role="group" aria-labelledby="inventory-sort-label">
                <button
                  type="button"
                  className={sort === "bestmatch" ? "on" : undefined}
                  aria-pressed={sort === "bestmatch"}
                  data-testid="inventory-sort-bestmatch"
                  onClick={() => setSort("bestmatch")}
                >
                  Best match
                </button>
                <button
                  type="button"
                  className={sort === "price" ? "on" : undefined}
                  aria-pressed={sort === "price"}
                  data-testid="inventory-sort-price"
                  onClick={() => setSort("price")}
                >
                  Lowest price
                </button>
                <button
                  type="button"
                  className={sort === "distance" ? "on" : undefined}
                  aria-pressed={sort === "distance"}
                  data-testid="inventory-sort-distance"
                  onClick={() => setSort("distance")}
                >
                  Nearest
                </button>
              </div>
            </div>
            {/* FILTERS — curated, distinct from the scope/sort segments. The
                no-markup chip echoes the red dealer-markup flag (⚑) to keep the
                association legible; state rides aria-pressed (not colour alone). */}
            <div className="inventory-filtergroup" role="group" aria-label="Filters">
              <button
                type="button"
                className={`filter-chip${noMarkup ? " on" : ""}`}
                aria-pressed={noMarkup}
                data-testid="inventory-filter-nomarkup"
                onClick={() => setNoMarkup((v) => !v)}
              >
                <span className="chip-flag" aria-hidden="true">
                  ⚑
                </span>{" "}
                No markup
              </button>
              <label className="filter-maxprice">
                <span className="control-label">Max</span>
                <span className="maxprice-affix" aria-hidden="true">
                  $
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={500}
                  placeholder="any"
                  className="maxprice-input"
                  data-testid="inventory-filter-maxprice"
                  aria-label="Maximum listed price"
                  value={maxPriceText}
                  onChange={(e) => setMaxPriceText(e.target.value)}
                />
              </label>
            </div>
            <p className="inventory-tally" data-testid="inventory-tally">
              {recommendedCount} recommended of {totalListings} listings
              {scannedWhen !== "" && (
                <span className="muted"> · scanned {scannedWhen}</span>
              )}
            </p>
          </div>
          {filtered.length === 0 ? (
            // Over-restrictive filters empty the set — say so plainly instead of a
            // blank tile-grid + a "0 listings" pager.
            <p className="muted" data-testid="inventory-filters-empty">
              No listings match these filters.
            </p>
          ) : (
            <>
              <div className="tile-grid">
                {pager.pageItems.map((row) => (
                  <CandidateRow
                    key={row.listing_id}
                    row={row}
                    onActivate={() => setDetail(row)}
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
                noun="listings"
              />
            </>
          )}
        </>
      )}
      <InventoryDetailModal row={detail} onClose={() => setDetail(null)} />
    </section>
  );
}
