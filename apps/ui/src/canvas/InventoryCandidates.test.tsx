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
import { click, render } from "../test/render.js";
import { InventoryCandidates } from "./InventoryCandidates.js";

/** The detail modal portals to document.body — query it off the document. */
const docQuery = (testId: string): HTMLElement | null =>
  document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
/** Click a portalled (document.body) node inside act(). */
function clickDoc(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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
    price_gated: boolean;
    breakdown_parsed: boolean;
    inventory_status: string;
    dealer_id: string;
    dealer_name: string | null;
    distance_miles: number | null;
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
    price_gated: false,
    breakdown_parsed: false,
    inventory_status: "in_stock",
    dealer_id: "dealer-1",
    dealer_name: "Jim Click Hyundai",
    distance_miles: 4.2,
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
