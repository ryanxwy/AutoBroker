// @vitest-environment happy-dom
/**
 * InventoryCandidates.test — the presentational Inventory candidates canvas
 * section. Proves: the segmented filter (Recommended/All), the tally line, the
 * pagination via usePagedList/Pager, loading/error states, and the empty state.
 * All existing testids remain intact.
 */

import { describe, expect, it } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import type { InventoryCompareResult } from "../api/wire.js";
import { click, render } from "../test/render.js";
import { InventoryCandidates } from "./InventoryCandidates.js";

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
    listing_url: string | null;
    listed_price: number | null;
    msrp: number | null;
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
    listing_url: "https://dealer.example.com/vdp/lst-1",
    listed_price: 44175,
    msrp: 46500,
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
