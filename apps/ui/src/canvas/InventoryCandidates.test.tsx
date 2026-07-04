// @vitest-environment happy-dom
/**
 * InventoryCandidates.test — the presentational Inventory candidates canvas
 * section. Proves: the segmented filter (Recommended/All), the tally line, the
 * pagination via usePagedList/Pager, loading/error states, and the empty state.
 * All existing testids remain intact.
 */

import { act } from "react";
import { describe, expect, it } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import type { InventoryCompareResult } from "../api/wire.js";
import { change, click, render } from "../test/render.js";
import { InventoryCandidates, sortCandidates } from "./InventoryCandidates.js";

/** The detail modal portals to document.body — query it off the document. */
const docQuery = (testId: string): HTMLElement | null =>
  document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
/** Click a portalled (document.body) node inside act(). */
function clickDoc(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Set a <select> value + fire React's change inside act() (the shared `change`
 *  helper is typed for input/textarea; a select needs its own setter). */
function changeSelect(node: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    setter?.call(node, value);
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: InventoryCompareResult): AsyncState<InventoryCompareResult> {
  return { kind: "ok", data };
}

function makeCandidate(
  overrides: Partial<{
    listing_id: string;
    vin: string | null;
    stock_number: string | null;
    year: number | null;
    make: string | null;
    model: string | null;
    trim: string | null;
    exterior_color: string | null;
    interior_color: string | null;
    listing_url: string | null;
    listed_price: number | null;
    msrp: number | null;
    dealer_markup: number | null;
    add_ons: { label: string; amount: number }[];
    addons_total: number | null;
    dealer_discount: number | null;
    incentives_text: string | null;
    price_gated: boolean;
    breakdown_parsed: boolean;
    inventory_status: string;
    dealer_id: string;
    dealer_name: string | null;
    distance_miles: number | null;
    source_type: string | null;
    source_host: string | null;
    score: number;
    reasons: string[];
    match_status: string;
    recommended: boolean;
  }> = {},
) {
  return {
    listing_id: "lst-1",
    vin: "KM8JBCAE3RU000042",
    stock_number: "STK-1",
    year: 2026,
    make: "Hyundai",
    model: "Tucson Hybrid",
    trim: "Limited",
    exterior_color: "Shimmering Silver",
    interior_color: "Gray Cloth",
    listing_url: "https://dealer.example.com/vdp/lst-1",
    listed_price: 44175,
    msrp: 46500,
    dealer_markup: null,
    add_ons: [],
    addons_total: null,
    dealer_discount: null,
    incentives_text: null,
    price_gated: false,
    breakdown_parsed: false,
    inventory_status: "in_stock",
    dealer_id: "dealer-1",
    dealer_name: "Jim Click Hyundai",
    distance_miles: 4.2,
    source_type: null,
    source_host: null,
    score: 0.85,
    reasons: ["trim_exact", "preferred_color"],
    match_status: "exact",
    recommended: true,
    ...overrides,
  };
}

function makeResult(
  candidates: ReturnType<typeof makeCandidate>[],
  overrides: Partial<{
    recommendedCount: number;
    totalListings: number;
    scannedAtMax: string | null;
    colorCrossCheck: { requested: string; suggestions: string[] }[];
    sourcesScanned: number;
    sourcesBlocked: number;
    shoppingSourcesScanned: number;
    shoppingSourcesBlocked: number;
    sameVinCollapsed: number;
  }> = {},
): InventoryCompareResult {
  return {
    candidates,
    recommendedCount: candidates.filter((c) => c.recommended).length,
    totalListings: candidates.length,
    scannedAtMax: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("InventoryCandidates — empty state", () => {
  it("renders the empty sentinel when totalListings is 0", () => {
    const { query } = render(
      <InventoryCandidates
        inventory={ok(makeResult([], { totalListings: 0, recommendedCount: 0 }))}
      />,
    );
    expect(query("canvas-inventory-empty")).not.toBeNull();
    expect(query("canvas-inventory-empty")!.textContent).toBe(
      "Listed 0 inventory candidates (recommended: 0).",
    );
  });

  it("renders an actionable hint when totalListings is 0", () => {
    const { query } = render(
      <InventoryCandidates
        inventory={ok(makeResult([], { totalListings: 0, recommendedCount: 0 }))}
      />,
    );
    expect(query("inventory-empty-hint")).not.toBeNull();
    expect(query("inventory-empty-hint")!.textContent).toContain("run a site scan");
  });

  it("does not render the filter or tally when totalListings is 0", () => {
    const { query } = render(
      <InventoryCandidates
        inventory={ok(makeResult([], { totalListings: 0, recommendedCount: 0 }))}
      />,
    );
    expect(query("inventory-filter-recommended")).toBeNull();
    expect(query("inventory-filter-all")).toBeNull();
    expect(query("inventory-tally")).toBeNull();
  });

  it("counts blocked shopping sites when scanned=0 (the all-blocked copy) — never 'aggregator' jargon", () => {
    const { query } = render(
      <InventoryCandidates
        inventory={ok(
          makeResult([], {
            totalListings: 0,
            recommendedCount: 0,
            shoppingSourcesScanned: 0,
            shoppingSourcesBlocked: 3,
          }),
        )}
      />,
    );
    const hint = query("inventory-empty-hint")!;
    expect(hint.textContent).toBe(
      "Nothing found yet — 3 shopping sites blocked automated scanning. Try again later or run a dealer site scan.",
    );
    expect(hint.textContent).not.toContain("aggregator");
  });

  it("keeps the dealer-site sentence unchanged when only dealer sources exist", () => {
    const { query } = render(
      <InventoryCandidates
        inventory={ok(
          makeResult([], { totalListings: 0, recommendedCount: 0, sourcesScanned: 2 }),
        )}
      />,
    );
    const hint = query("inventory-empty-hint")!;
    expect(hint.textContent).toBe(
      "Your last scan of 2 dealer sites found no matching cars in stock. Try widening the trim, or check back later.",
    );
  });

  it("appends a plain shopping clause when both dealer and shopping sources were reached", () => {
    const { query } = render(
      <InventoryCandidates
        inventory={ok(
          makeResult([], {
            totalListings: 0,
            recommendedCount: 0,
            sourcesScanned: 1,
            shoppingSourcesBlocked: 2,
          }),
        )}
      />,
    );
    const hint = query("inventory-empty-hint")!.textContent ?? "";
    expect(hint).toContain("1 dealer site found no matching cars in stock");
    expect(hint).toContain("2 shopping sites blocked automated scanning");
  });
});

// ---------------------------------------------------------------------------
// Provenance line (shopping-site listings render "via {host}")
// ---------------------------------------------------------------------------

describe("InventoryCandidates — source provenance line", () => {
  it("renders the muted 'via {host}' line for an aggregator_srp row", () => {
    const row = makeCandidate({
      source_type: "aggregator_srp",
      source_host: "www.cars.com",
    });
    const { query } = render(<InventoryCandidates inventory={ok(makeResult([row]))} />);
    const line = query("inventory-source-line");
    expect(line).not.toBeNull();
    expect(line!.textContent).toBe("via www.cars.com");
    // The Incentives muted-line pattern: a t-status muted div (no new chip class).
    expect(line!.className).toContain("muted");
    expect(line!.className).toContain("t-status");
  });

  it("does NOT render the source line for a dealer-site row (source_type null)", () => {
    const row = makeCandidate({ source_type: null, source_host: null });
    const { query } = render(<InventoryCandidates inventory={ok(makeResult([row]))} />);
    expect(query("inventory-source-line")).toBeNull();
  });

  it("does NOT render the source line when source_host is null despite an aggregator type", () => {
    const row = makeCandidate({ source_type: "aggregator_srp", source_host: null });
    const { query } = render(<InventoryCandidates inventory={ok(makeResult([row]))} />);
    expect(query("inventory-source-line")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Filter: default recommended when recommendedCount > 0
// ---------------------------------------------------------------------------

describe("InventoryCandidates — segmented filter", () => {
  it("defaults to Recommended when recommendedCount > 0", () => {
    const recommended = makeCandidate({ listing_id: "lst-r", recommended: true });
    const other = makeCandidate({ listing_id: "lst-o", recommended: false });
    const result = makeResult([recommended, other]);
    const { all, get } = render(<InventoryCandidates inventory={ok(result)} />);

    // Only the recommended candidate row is visible by default.
    expect(all("inventory-candidate-row")).toHaveLength(1);

    // The Recommended filter button is active (aria-pressed=true).
    const recBtn = get("inventory-filter-recommended");
    expect(recBtn.getAttribute("aria-pressed")).toBe("true");
    const allBtn = get("inventory-filter-all");
    expect(allBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("defaults to All when recommendedCount is 0", () => {
    const c1 = makeCandidate({ listing_id: "lst-1", recommended: false });
    const c2 = makeCandidate({ listing_id: "lst-2", recommended: false });
    const result = makeResult([c1, c2], { recommendedCount: 0 });
    const { all, get } = render(<InventoryCandidates inventory={ok(result)} />);

    // Both rows visible.
    expect(all("inventory-candidate-row")).toHaveLength(2);
    const allBtn = get("inventory-filter-all");
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches to All when the All button is clicked", () => {
    const recommended = makeCandidate({ listing_id: "lst-r", recommended: true });
    const other = makeCandidate({ listing_id: "lst-o", recommended: false });
    const result = makeResult([recommended, other]);
    const { all, get } = render(<InventoryCandidates inventory={ok(result)} />);

    // Click All — both rows should appear.
    click(get("inventory-filter-all"));
    expect(all("inventory-candidate-row")).toHaveLength(2);
    expect(get("inventory-filter-all").getAttribute("aria-pressed")).toBe("true");
    expect(get("inventory-filter-recommended").getAttribute("aria-pressed")).toBe("false");
  });

  it("Recommended button is disabled when recommendedCount is 0", () => {
    const c1 = makeCandidate({ listing_id: "lst-1", recommended: false });
    const result = makeResult([c1], { recommendedCount: 0 });
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);
    expect((get("inventory-filter-recommended") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Availability-unconfirmed caveat (the 0-rec-on-unknown fix)
// ---------------------------------------------------------------------------

describe("InventoryCandidates — availability-unconfirmed caveat", () => {
  it("renders the caveat on a recommended row whose inventory_status is 'unknown'", () => {
    const row = makeCandidate({
      listing_id: "lst-unknown",
      recommended: true,
      inventory_status: "unknown",
    });
    const { query } = render(<InventoryCandidates inventory={ok(makeResult([row]))} />);
    expect(query("inventory-availability-caveat")).not.toBeNull();
  });

  it("does not render the caveat on a recommended row with a confirmed in_stock status", () => {
    const row = makeCandidate({
      listing_id: "lst-instock",
      recommended: true,
      inventory_status: "in_stock",
    });
    const { query } = render(<InventoryCandidates inventory={ok(makeResult([row]))} />);
    expect(query("inventory-availability-caveat")).toBeNull();
  });

  it("does not render the caveat on a non-recommended unknown row (the All view)", () => {
    // A non-recommended 'unknown' row only shows in the All view; it carries no
    // caveat (the caveat is exclusively a recommend-time honesty marker).
    const row = makeCandidate({
      listing_id: "lst-unknown-norec",
      recommended: false,
      inventory_status: "unknown",
    });
    const { query, get } = render(
      <InventoryCandidates inventory={ok(makeResult([row], { recommendedCount: 0 }))} />,
    );
    // Default filter is All when recommendedCount is 0, so the row is visible.
    expect(get("inventory-candidate-row")).not.toBeNull();
    expect(query("inventory-availability-caveat")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tally line
// ---------------------------------------------------------------------------

describe("InventoryCandidates — tally line", () => {
  it("renders the tally with correct counts", () => {
    const recommended = makeCandidate({ listing_id: "lst-r", recommended: true });
    const other = makeCandidate({ listing_id: "lst-o", recommended: false });
    const result = makeResult([recommended, other]);
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);

    const tally = get("inventory-tally");
    expect(tally.textContent).toContain("1 recommended of 2 listings");
  });

  it("does not render budget in the tally", () => {
    const recommended = makeCandidate({ listing_id: "lst-r", recommended: true });
    const result = makeResult([recommended]);
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);
    const tally = get("inventory-tally");
    // No "budget" word, no "$" in the tally (listed price stays in the tile, not here).
    expect(tally.textContent).not.toContain("budget");
  });

  it("renders scanned relative date when scannedAtMax is present", () => {
    const result = makeResult([makeCandidate()], {
      scannedAtMax: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(get("inventory-tally").textContent).toContain("2 days ago");
  });

  it("omits the scanned part when scannedAtMax is null", () => {
    const result = makeResult([makeCandidate()], { scannedAtMax: null });
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(get("inventory-tally").textContent).not.toContain("scanned");
  });
});

// ---------------------------------------------------------------------------
// Candidate row rendering (existing testids preserved)
// ---------------------------------------------------------------------------

describe("InventoryCandidates — candidate row fields", () => {
  it("renders the full VIN, stock number, and price", () => {
    const result = makeResult([makeCandidate()]);
    const { get, all } = render(<InventoryCandidates inventory={ok(result)} />);

    expect(all("inventory-candidate-row")).toHaveLength(1);
    expect(get("inventory-candidate-vin").textContent).toBe("KM8JBCAE3RU000042");
    expect(get("inventory-stock").textContent).toBe("STK-1");
    expect(get("inventory-match-status").textContent).toBe("exact");
  });

  it("renders inventory-incomplete-badge for a null listed_price", () => {
    const result = makeResult([makeCandidate({ listed_price: null })]);
    const { query } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(query("inventory-incomplete-badge")).not.toBeNull();
  });

  it("renders inventory-stock-missing (em-dash) for a null stock_number", () => {
    const result = makeResult([makeCandidate({ stock_number: null })]);
    const { query } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(query("inventory-stock-missing")).not.toBeNull();
    expect(query("inventory-stock")).toBeNull();
  });

  it("renders reason chips", () => {
    const result = makeResult([makeCandidate({ reasons: ["trim_exact", "preferred_color"] })]);
    const { all } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(all("inventory-reason-chip")).toHaveLength(2);
  });

  it("renders a 'View listing' link to the VDP when listing_url is present", () => {
    const result = makeResult([makeCandidate({ listing_url: "https://dealer.test/vdp/42" })]);
    const { query } = render(<InventoryCandidates inventory={ok(result)} />);
    const link = query("inventory-listing-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://dealer.test/vdp/42");
    expect(link?.getAttribute("target")).toBe("_blank");
    // noopener severs window.opener (anti reverse-tabnabbing) on the browser path.
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("omits the 'View listing' link when listing_url is null", () => {
    const result = makeResult([makeCandidate({ listing_url: null })]);
    const { query } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(query("inventory-listing-link")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Consolidated price-flag chip (one chip max: RED markup > AMBER add-ons)
// ---------------------------------------------------------------------------

describe("InventoryCandidates — consolidated flag chip", () => {
  it("renders a RED markup flag with '+$' text when dealer_markup > 0", () => {
    const result = makeResult([makeCandidate({ dealer_markup: 2500 })]);
    const { query } = render(<InventoryCandidates inventory={ok(result)} />);
    const chip = query("inventory-markup-flag");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("+$2,500");
    expect(chip!.className).toContain("flag-red");
    // The ⚑ glyph is decorative — aria-hidden so the text carries the meaning.
    const glyph = chip!.querySelector('[aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.textContent).toBe("⚑");
    // No add-ons chip when markup wins.
    expect(query("inventory-addons-flag")).toBeNull();
  });

  it("renders an AMBER add-ons flag (no markup) when add-ons are present", () => {
    const result = makeResult([
      makeCandidate({
        dealer_markup: null,
        add_ons: [{ label: "Nitrogen tire fill", amount: 299 }],
        addons_total: 299,
      }),
    ]);
    const { query } = render(<InventoryCandidates inventory={ok(result)} />);
    const chip = query("inventory-addons-flag");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("$299 add-ons");
    expect(chip!.className).toContain("warn");
    expect(chip!.querySelector('[aria-hidden="true"]')!.textContent).toBe("⚑");
    expect(query("inventory-markup-flag")).toBeNull();
  });

  it("shows exactly ONE flag chip (markup wins) when both markup and add-ons exist", () => {
    const result = makeResult([
      makeCandidate({
        dealer_markup: 1500,
        add_ons: [{ label: "Paint protection", amount: 999 }],
        addons_total: 999,
      }),
    ]);
    const { query, container } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(query("inventory-markup-flag")).not.toBeNull();
    expect(query("inventory-addons-flag")).toBeNull();
    expect(container.querySelectorAll(".flag-chip")).toHaveLength(1);
  });

  it("renders NO flag chip when there is no markup and no add-ons", () => {
    const result = makeResult([
      makeCandidate({ dealer_markup: 0, add_ons: [], addons_total: null }),
    ]);
    const { query, container } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(query("inventory-markup-flag")).toBeNull();
    expect(query("inventory-addons-flag")).toBeNull();
    expect(container.querySelectorAll(".flag-chip")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Detail modal (clickable tile → portalled read-only modal)
// ---------------------------------------------------------------------------

describe("InventoryCandidates — detail modal", () => {
  it("opens the portalled modal showing the VIN + price when a row is clicked", () => {
    const result = makeResult([makeCandidate()]);
    const r = render(<InventoryCandidates inventory={ok(result)} />);

    // No modal until a row is clicked.
    expect(docQuery("modal-dialog")).toBeNull();

    click(r.get("inventory-candidate-row"));

    const dialog = docQuery("modal-dialog");
    expect(dialog).not.toBeNull();
    expect(docQuery("inventory-detail-title")!.textContent).toContain("Hyundai");
    expect(dialog!.textContent).toContain("KM8JBCAE3RU000042"); // full VIN
    expect(dialog!.textContent).toContain("$44,175"); // listed price
    r.unmount();
  });

  it("closes the modal when Close is clicked", () => {
    const result = makeResult([makeCandidate()]);
    const r = render(<InventoryCandidates inventory={ok(result)} />);

    click(r.get("inventory-candidate-row"));
    expect(docQuery("modal-dialog")).not.toBeNull();

    clickDoc(docQuery("inventory-detail-close")!);
    expect(docQuery("modal-dialog")).toBeNull();
    r.unmount();
  });

  it("keeps the inline 'View listing' link intact (href/target/rel) on the tile", () => {
    const result = makeResult([makeCandidate({ listing_url: "https://dealer.test/vdp/42" })]);
    const { query } = render(<InventoryCandidates inventory={ok(result)} />);
    const link = query("inventory-listing-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://dealer.test/vdp/42");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("shows the Stock # row in the modal when the stock number is present", () => {
    const result = makeResult([makeCandidate({ stock_number: "STK-7" })]);
    const r = render(<InventoryCandidates inventory={ok(result)} />);
    click(r.get("inventory-candidate-row"));
    const modal = docQuery("inventory-detail-modal");
    expect(modal!.textContent).toContain("Stock #");
    expect(modal!.textContent).toContain("STK-7");
    r.unmount();
  });

  it("OMITS the Stock # row in the modal when the stock number is null (no em-dash)", () => {
    const result = makeResult([makeCandidate({ stock_number: null })]);
    const r = render(<InventoryCandidates inventory={ok(result)} />);
    click(r.get("inventory-candidate-row"));
    const modal = docQuery("inventory-detail-modal");
    // Consistent with the other detail rows: a null field omits its row rather
    // than rendering an em-dash placeholder.
    expect(modal!.textContent).not.toContain("Stock #");
    expect(modal!.textContent).not.toContain("—");
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("InventoryCandidates — pagination", () => {
  it("renders no pager when there are 12 or fewer items", () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      makeCandidate({ listing_id: `lst-${i}`, recommended: true }),
    );
    const result = makeResult(candidates);
    const { query } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(query("canvas-pager")).toBeNull();
    expect(query("inventory-candidate-row")).not.toBeNull();
  });

  it("renders a pager and limits to 12 items per page when there are more than 12", () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate({ listing_id: `lst-${i}`, recommended: true }),
    );
    const result = makeResult(candidates, { totalListings: 15 });
    const { query, all } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(query("canvas-pager")).not.toBeNull();
    expect(all("inventory-candidate-row")).toHaveLength(12);
  });

  it("navigates to the next page when Next is clicked", () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate({ listing_id: `lst-${i}`, recommended: true }),
    );
    const result = makeResult(candidates, { totalListings: 15 });
    const { all, get } = render(<InventoryCandidates inventory={ok(result)} />);

    expect(all("inventory-candidate-row")).toHaveLength(12);
    click(get("canvas-pager-next"));
    expect(all("inventory-candidate-row")).toHaveLength(3);
  });

  it("resets to page 1 when the filter changes", () => {
    // 13 recommended + 2 non-recommended
    const candidates = [
      ...Array.from({ length: 13 }, (_, i) =>
        makeCandidate({ listing_id: `lst-r${i}`, recommended: true }),
      ),
      makeCandidate({ listing_id: "lst-o1", recommended: false }),
      makeCandidate({ listing_id: "lst-o2", recommended: false }),
    ];
    const result = makeResult(candidates, { totalListings: 15 });
    const { all, get } = render(<InventoryCandidates inventory={ok(result)} />);

    // On page 1 of recommended (12 of 13 visible).
    expect(all("inventory-candidate-row")).toHaveLength(12);

    // Click All — should reset to page 1 of all 15.
    click(get("inventory-filter-all"));
    expect(all("inventory-candidate-row")).toHaveLength(12);
    // Pager still visible (15 > 12).
    expect(get("canvas-pager")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Color config cross-check advisory tile
// ---------------------------------------------------------------------------

describe("InventoryCandidates — color config cross-check", () => {
  const cc = [{ requested: "red", suggestions: ["Radiant Red Metallic II", "Rallye Red"] }];

  it("renders the advisory tile with the real stocked names when there are suggestions", () => {
    const result = makeResult([makeCandidate()], { colorCrossCheck: cc });
    const { query, all } = render(
      <InventoryCandidates
        inventory={ok(result)}
        profileId="prof-1"
        onAddPreferredColor={async () => {}}
      />,
    );
    expect(query("inventory-color-crosscheck")).not.toBeNull();
    const adds = all("inventory-color-add");
    expect(adds).toHaveLength(2);
    expect(adds[0]!.textContent).toContain("Radiant Red Metallic II");
    expect(adds[1]!.textContent).toContain("Rallye Red");
  });

  it("Add calls onAddPreferredColor with the canonical name and marks added on SUCCESS", async () => {
    const calls: string[] = [];
    const result = makeResult([makeCandidate()], { colorCrossCheck: cc });
    const { all } = render(
      <InventoryCandidates
        inventory={ok(result)}
        profileId="prof-1"
        onAddPreferredColor={async (c) => {
          calls.push(c);
        }}
      />,
    );
    click(all("inventory-color-add")[0]!);
    await act(async () => {}); // flush the awaited PATCH + the success setAdded
    expect(calls).toEqual(["Radiant Red Metallic II"]);
    // The tapped suggestion shows the ✓ + disables (no double-add) once it resolved.
    expect((all("inventory-color-add")[0]! as HTMLButtonElement).disabled).toBe(true);
    expect(all("inventory-color-add")[0]!.textContent).toContain("Added");
  });

  it("does NOT mark added when onAddPreferredColor REJECTS (button stays actionable, no false ✓)", async () => {
    const result = makeResult([makeCandidate()], { colorCrossCheck: cc });
    const { all } = render(
      <InventoryCandidates
        inventory={ok(result)}
        profileId="prof-1"
        onAddPreferredColor={async () => {
          throw new Error("patch failed");
        }}
      />,
    );
    click(all("inventory-color-add")[0]!);
    await act(async () => {}); // flush the awaited (rejecting) PATCH
    const btn = all("inventory-color-add")[0]! as HTMLButtonElement;
    expect(btn.disabled).toBe(false); // still actionable — retry allowed
    expect(btn.textContent).not.toContain("Added"); // no optimistic ✓ on failure
  });

  it("dismiss hides the tile", () => {
    const result = makeResult([makeCandidate()], { colorCrossCheck: cc });
    const { query, get } = render(
      <InventoryCandidates
        inventory={ok(result)}
        profileId="prof-1"
        onAddPreferredColor={async () => {}}
      />,
    );
    expect(query("inventory-color-crosscheck")).not.toBeNull();
    click(get("inventory-color-crosscheck-dismiss"));
    expect(query("inventory-color-crosscheck")).toBeNull();
  });

  it("is absent when there are no cross-check suggestions", () => {
    const result = makeResult([makeCandidate()]); // no colorCrossCheck
    const { query } = render(
      <InventoryCandidates
        inventory={ok(result)}
        profileId="prof-1"
        onAddPreferredColor={async () => {}}
      />,
    );
    expect(query("inventory-color-crosscheck")).toBeNull();
  });

  it("is absent when no add handler is wired (nothing to act on)", () => {
    const result = makeResult([makeCandidate()], { colorCrossCheck: cc });
    const { query } = render(<InventoryCandidates inventory={ok(result)} profileId="prof-1" />);
    expect(query("inventory-color-crosscheck")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sort — pure sortCandidates (server-order no-op + copy-before-sort + nulls last)
// ---------------------------------------------------------------------------

describe("sortCandidates (pure)", () => {
  it("best-match is a SERVER-ORDER no-op — returns the SAME array, never re-sorted", () => {
    const rows = [
      makeCandidate({ listing_id: "a", listed_price: 50000 }),
      makeCandidate({ listing_id: "b", listed_price: 10000 }),
      makeCandidate({ listing_id: "c", listed_price: 30000 }),
    ];
    const out = sortCandidates(rows, "bestmatch");
    // Identity pass-through: no copy, no reorder (the server's match-tier order stands).
    expect(out).toBe(rows);
    expect(out.map((r) => r.listing_id)).toEqual(["a", "b", "c"]);
  });

  it("price sort COPIES (input unmutated), ascending, with price_gated/null sinking last", () => {
    const a = makeCandidate({ listing_id: "a", listed_price: 50000 });
    const b = makeCandidate({ listing_id: "b", listed_price: 10000 });
    const cNull = makeCandidate({ listing_id: "c", listed_price: null });
    const dGated = makeCandidate({ listing_id: "d", listed_price: 1, price_gated: true });
    const rows = [a, b, cNull, dGated];
    const out = sortCandidates(rows, "price");
    // A copy — the prop array is never mutated by .sort().
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.listing_id)).toEqual(["a", "b", "c", "d"]);
    // 10k < 50k, then the null-price and the price_gated (never sorted as $0/$1) last.
    expect(out.map((r) => r.listing_id)).toEqual(["b", "a", "c", "d"]);
  });

  it("distance sort COPIES (input unmutated), ascending, with null distance last", () => {
    const a = makeCandidate({ listing_id: "a", distance_miles: 9 });
    const b = makeCandidate({ listing_id: "b", distance_miles: 2 });
    const cNull = makeCandidate({ listing_id: "c", distance_miles: null });
    const rows = [a, b, cNull];
    const out = sortCandidates(rows, "distance");
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.listing_id)).toEqual(["a", "b", "c"]);
    expect(out.map((r) => r.listing_id)).toEqual(["b", "a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Sort — segmented control (rendered row order)
// ---------------------------------------------------------------------------

describe("InventoryCandidates — sort control", () => {
  const vinOrder = (all: (t: string) => HTMLElement[]): (string | null)[] =>
    all("inventory-candidate-vin").map((n) => n.textContent);

  // All three recommended so they all render under the default Recommended filter
  // (<=12 → no pager). Server order is [A(50k/9mi), B(10k/2mi), C(null/null)].
  const cands = (): ReturnType<typeof makeCandidate>[] => [
    makeCandidate({ listing_id: "a", vin: "VINAAAAAAAAAAAAA1", listed_price: 50000, distance_miles: 9, recommended: true }),
    makeCandidate({ listing_id: "b", vin: "VINBBBBBBBBBBBBB2", listed_price: 10000, distance_miles: 2, recommended: true }),
    makeCandidate({ listing_id: "c", vin: "VINCCCCCCCCCCCCC3", listed_price: null, distance_miles: null, recommended: true }),
  ];

  it("defaults to best-match and preserves the server order byte-for-byte", () => {
    const { all, get } = render(<InventoryCandidates inventory={ok(makeResult(cands()))} />);
    expect(get("inventory-sort-bestmatch").getAttribute("aria-pressed")).toBe("true");
    expect(vinOrder(all)).toEqual(["VINAAAAAAAAAAAAA1", "VINBBBBBBBBBBBBB2", "VINCCCCCCCCCCCCC3"]);
  });

  it("lowest-price sorts ascending with the null-price row last", () => {
    const { all, get } = render(<InventoryCandidates inventory={ok(makeResult(cands()))} />);
    click(get("inventory-sort-price"));
    expect(get("inventory-sort-price").getAttribute("aria-pressed")).toBe("true");
    expect(vinOrder(all)).toEqual(["VINBBBBBBBBBBBBB2", "VINAAAAAAAAAAAAA1", "VINCCCCCCCCCCCCC3"]);
  });

  it("nearest sorts ascending with the null-distance row last", () => {
    const { all, get } = render(<InventoryCandidates inventory={ok(makeResult(cands()))} />);
    click(get("inventory-sort-distance"));
    expect(vinOrder(all)).toEqual(["VINBBBBBBBBBBBBB2", "VINAAAAAAAAAAAAA1", "VINCCCCCCCCCCCCC3"]);
  });
});

// ---------------------------------------------------------------------------
// Curated filters (no-markup + max-price) + empty-state guard
// ---------------------------------------------------------------------------

describe("InventoryCandidates — curated filters", () => {
  it("no-markup drops rows carrying a labeled dealer markup (>0)", () => {
    const withMarkup = makeCandidate({ listing_id: "m", vin: "VIN-MARKUP-0000001", dealer_markup: 2500, recommended: false });
    const clean = makeCandidate({ listing_id: "c", vin: "VIN-CLEAN-00000002", dealer_markup: null, recommended: false });
    const { all, get } = render(
      <InventoryCandidates inventory={ok(makeResult([withMarkup, clean], { recommendedCount: 0 }))} />,
    );
    expect(all("inventory-candidate-row")).toHaveLength(2);
    click(get("inventory-filter-nomarkup"));
    expect(all("inventory-candidate-row")).toHaveLength(1);
    expect(get("inventory-candidate-vin").textContent).toBe("VIN-CLEAN-00000002");
    expect(get("inventory-filter-nomarkup").getAttribute("aria-pressed")).toBe("true");
  });

  it("no-markup KEEPS rows with dealer_markup 0 (scanned, none — never a flag)", () => {
    const zero = makeCandidate({ listing_id: "z", dealer_markup: 0, recommended: false });
    const { all, get } = render(
      <InventoryCandidates inventory={ok(makeResult([zero], { recommendedCount: 0 }))} />,
    );
    click(get("inventory-filter-nomarkup"));
    expect(all("inventory-candidate-row")).toHaveLength(1);
  });

  it("max-price filters out rows above the max and excludes null-price rows", () => {
    const cheap = makeCandidate({ listing_id: "cheap", vin: "VIN-CHEAP-00000001", listed_price: 30000, recommended: false });
    const pricey = makeCandidate({ listing_id: "pricey", vin: "VIN-PRICEY-0000002", listed_price: 60000, recommended: false });
    const noPrice = makeCandidate({ listing_id: "np", vin: "VIN-NOPRICE-000003", listed_price: null, recommended: false });
    const { all, get } = render(
      <InventoryCandidates inventory={ok(makeResult([cheap, pricey, noPrice], { recommendedCount: 0 }))} />,
    );
    expect(all("inventory-candidate-row")).toHaveLength(3);
    change(get("inventory-filter-maxprice") as HTMLInputElement, "40000");
    expect(all("inventory-candidate-vin").map((n) => n.textContent)).toEqual(["VIN-CHEAP-00000001"]);
  });

  it("no-markup composes with the Recommended/All scope toggle", () => {
    const recMarkup = makeCandidate({ listing_id: "rm", dealer_markup: 2500, recommended: true });
    const recClean = makeCandidate({ listing_id: "rc", dealer_markup: null, recommended: true });
    const allOnly = makeCandidate({ listing_id: "ao", dealer_markup: null, recommended: false });
    const { all, get } = render(
      <InventoryCandidates inventory={ok(makeResult([recMarkup, recClean, allOnly]))} />,
    );
    // Default Recommended → 2 recommended rows.
    expect(all("inventory-candidate-row")).toHaveLength(2);
    click(get("inventory-filter-nomarkup")); // drops recMarkup → 1.
    expect(all("inventory-candidate-row")).toHaveLength(1);
    click(get("inventory-filter-all")); // all minus markup → recClean + allOnly = 2.
    expect(all("inventory-candidate-row")).toHaveLength(2);
  });

  it("renders the inventory-filters-empty guard (no grid, no pager) when filters empty the set", () => {
    const pricey = makeCandidate({ listing_id: "p", listed_price: 99999, recommended: false });
    const { all, get, query } = render(
      <InventoryCandidates inventory={ok(makeResult([pricey], { recommendedCount: 0 }))} />,
    );
    change(get("inventory-filter-maxprice") as HTMLInputElement, "1000");
    expect(query("inventory-filters-empty")).not.toBeNull();
    expect(all("inventory-candidate-row")).toHaveLength(0);
    expect(query("canvas-pager")).toBeNull();
  });

  it("resets to page 1 when the sort changes", () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate({ listing_id: `lst-${i}`, recommended: true, listed_price: 10000 + i }),
    );
    const { all, get } = render(
      <InventoryCandidates inventory={ok(makeResult(candidates, { totalListings: 15 }))} />,
    );
    expect(all("inventory-candidate-row")).toHaveLength(12);
    click(get("canvas-pager-next"));
    expect(all("inventory-candidate-row")).toHaveLength(3);
    click(get("inventory-sort-price")); // new array identity → pager back to page 1.
    expect(all("inventory-candidate-row")).toHaveLength(12);
  });

  it("resets to page 1 when a curated filter toggles", () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate({ listing_id: `lst-${i}`, recommended: true, dealer_markup: null }),
    );
    const { all, get } = render(
      <InventoryCandidates inventory={ok(makeResult(candidates, { totalListings: 15 }))} />,
    );
    click(get("canvas-pager-next"));
    expect(all("inventory-candidate-row")).toHaveLength(3);
    click(get("inventory-filter-nomarkup")); // none have markup → still 15, new identity → page 1.
    expect(all("inventory-candidate-row")).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// Trim visible per row (explicit unknown, never silently dropped)
// ---------------------------------------------------------------------------

describe("InventoryCandidates — trim per row", () => {
  it("renders the trim value on the row", () => {
    const result = makeResult([makeCandidate({ trim: "Limited" })]);
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(get("inventory-candidate-trim").textContent).toContain("Limited");
  });

  it("renders an explicit 'trim —' when trim is null (never silently dropped)", () => {
    const result = makeResult([makeCandidate({ trim: null })]);
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);
    const el = get("inventory-candidate-trim");
    expect(el.textContent).toContain("trim");
    expect(el.textContent).toContain("—");
  });

  it("renders an explicit 'trim —' when trim is an empty string", () => {
    const result = makeResult([makeCandidate({ trim: "" })]);
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(get("inventory-candidate-trim").textContent).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// Trim filter (<select> over the loaded trims; composes with scope)
// ---------------------------------------------------------------------------

describe("InventoryCandidates — trim filter", () => {
  it("lists the distinct trims (case-insensitively deduped, first-seen casing, sorted) after All trims", () => {
    const rows = [
      makeCandidate({ listing_id: "a", trim: "SEL", recommended: false }),
      makeCandidate({ listing_id: "b", trim: "Limited", recommended: false }),
      makeCandidate({ listing_id: "c", trim: "limited", recommended: false }), // dup by case
    ];
    const { get } = render(
      <InventoryCandidates inventory={ok(makeResult(rows, { recommendedCount: 0 }))} />,
    );
    const select = get("inventory-filter-trim") as HTMLSelectElement;
    const opts = Array.from(select.options).map((o) => o.textContent);
    // Sorted, first-seen casing kept ("Limited" not "limited"), no "No trim listed".
    expect(opts).toEqual(["All trims", "Limited", "SEL"]);
    // Default value = All trims (empty).
    expect(select.value).toBe("");
  });

  it("offers 'No trim listed' only when a candidate has a null/empty trim", () => {
    const noNull = [makeCandidate({ listing_id: "a", trim: "Limited", recommended: false })];
    const { get, unmount } = render(
      <InventoryCandidates inventory={ok(makeResult(noNull, { recommendedCount: 0 }))} />,
    );
    let opts = Array.from((get("inventory-filter-trim") as HTMLSelectElement).options).map(
      (o) => o.textContent,
    );
    expect(opts).not.toContain("No trim listed");
    unmount();

    const withNull = [
      makeCandidate({ listing_id: "a", trim: "Limited", recommended: false }),
      makeCandidate({ listing_id: "b", trim: null, recommended: false }),
    ];
    const r2 = render(
      <InventoryCandidates inventory={ok(makeResult(withNull, { recommendedCount: 0 }))} />,
    );
    opts = Array.from((r2.get("inventory-filter-trim") as HTMLSelectElement).options).map(
      (o) => o.textContent,
    );
    expect(opts).toContain("No trim listed");
  });

  it("filters to the selected trim (case-insensitive) and composes with the scope toggle", () => {
    const recLimited = makeCandidate({ listing_id: "rl", vin: "VIN-RL-000000001", trim: "Limited", recommended: true });
    const recSel = makeCandidate({ listing_id: "rs", vin: "VIN-RS-000000002", trim: "SEL", recommended: true });
    const allLimited = makeCandidate({ listing_id: "al", vin: "VIN-AL-000000003", trim: "limited", recommended: false });
    const { all, get } = render(
      <InventoryCandidates inventory={ok(makeResult([recLimited, recSel, allLimited]))} />,
    );
    // Default Recommended → both recommended rows.
    expect(all("inventory-candidate-row")).toHaveLength(2);
    // Pick Limited → within Recommended, only recLimited.
    changeSelect(get("inventory-filter-trim") as HTMLSelectElement, "Limited");
    expect(all("inventory-candidate-vin").map((n) => n.textContent)).toEqual(["VIN-RL-000000001"]);
    // Switch scope to All → Limited across all (case-insensitive) = recLimited + allLimited.
    click(get("inventory-filter-all"));
    expect(all("inventory-candidate-vin").map((n) => n.textContent)).toEqual([
      "VIN-RL-000000001",
      "VIN-AL-000000003",
    ]);
  });

  it("filters to the 'No trim listed' bucket (null/empty trim only)", () => {
    const withTrim = makeCandidate({ listing_id: "t", vin: "VIN-T-0000000001", trim: "Limited", recommended: false });
    const nullTrim = makeCandidate({ listing_id: "n", vin: "VIN-N-0000000002", trim: null, recommended: false });
    const emptyTrim = makeCandidate({ listing_id: "e", vin: "VIN-E-0000000003", trim: "", recommended: false });
    const { all, get } = render(
      <InventoryCandidates
        inventory={ok(makeResult([withTrim, nullTrim, emptyTrim], { recommendedCount: 0 }))}
      />,
    );
    expect(all("inventory-candidate-row")).toHaveLength(3);
    changeSelect(get("inventory-filter-trim") as HTMLSelectElement, "\u0000");
    expect(all("inventory-candidate-vin").map((n) => n.textContent)).toEqual([
      "VIN-N-0000000002",
      "VIN-E-0000000003",
    ]);
  });

  it("shows the filters-empty guard when the trim filter matches nothing in scope", () => {
    const recSel = makeCandidate({ listing_id: "rs", trim: "SEL", recommended: true });
    const allLimited = makeCandidate({ listing_id: "al", trim: "Limited", recommended: false });
    const { all, get, query } = render(
      <InventoryCandidates inventory={ok(makeResult([recSel, allLimited]))} />,
    );
    // Default Recommended shows only recSel.
    expect(all("inventory-candidate-row")).toHaveLength(1);
    // Limited is a valid option (allLimited) but no recommended row has it → empty.
    changeSelect(get("inventory-filter-trim") as HTMLSelectElement, "Limited");
    expect(query("inventory-filters-empty")).not.toBeNull();
    expect(all("inventory-candidate-row")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Merged-count transparency note (same-VIN duplicates collapsed across sources)
// ---------------------------------------------------------------------------

describe("InventoryCandidates — merged-count note", () => {
  it("renders the merged note when sameVinCollapsed > 0", () => {
    const result = makeResult([makeCandidate()], { sameVinCollapsed: 3 });
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(get("inventory-merged-note").textContent).toContain(
      "3 duplicate listings merged across sources",
    );
  });

  it("uses the singular for exactly 1 merged listing", () => {
    const result = makeResult([makeCandidate()], { sameVinCollapsed: 1 });
    const { get } = render(<InventoryCandidates inventory={ok(result)} />);
    expect(get("inventory-merged-note").textContent).toContain(
      "1 duplicate listing merged across sources",
    );
  });

  it("omits the merged note when sameVinCollapsed is 0 or absent", () => {
    const zero = render(
      <InventoryCandidates inventory={ok(makeResult([makeCandidate()], { sameVinCollapsed: 0 }))} />,
    );
    expect(zero.query("inventory-merged-note")).toBeNull();
    zero.unmount();

    const absent = render(<InventoryCandidates inventory={ok(makeResult([makeCandidate()]))} />);
    expect(absent.query("inventory-merged-note")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loading / error states
// ---------------------------------------------------------------------------

describe("InventoryCandidates — loading / error", () => {
  it("renders a loading message", () => {
    const { container } = render(
      <InventoryCandidates inventory={{ kind: "loading" }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Loading inventory");
  });

  it("renders an error message in a role=alert element", () => {
    const { container } = render(
      <InventoryCandidates
        inventory={{ kind: "error", message: "network error", code: "fetch_failed" }}
      />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("network error");
  });
});
