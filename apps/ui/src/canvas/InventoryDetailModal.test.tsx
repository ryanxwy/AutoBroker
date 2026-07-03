// @vitest-environment happy-dom
/**
 * InventoryDetailModal.test — the read-only inventory detail surface, focused on
 * the HONEST price breakdown: the LABELED dealer-markup red row, the add-on
 * amber/red severity split, the three add-on coverage states (couldn't-read vs
 * none-detected vs the itemized list), the interior-color row, the availability
 * reframe ("unknown" → "not confirmed by scan"), the static rebate caveat, and
 * the price-gated note. The modal portals to document.body, so its nodes are
 * queried off the document, not a render container. All pre-existing testids
 * (modal/title/match-status/close) stay intact.
 */

import { describe, expect, it } from "vitest";

import { render } from "../test/render.js";
import type { InventoryCandidate } from "./InventoryCandidates.js";
import { InventoryDetailModal } from "./InventoryDetailModal.js";

/** The detail modal portals to document.body — query it off the document. */
const doc = (testId: string): HTMLElement | null =>
  document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

function makeRow(overrides: Partial<InventoryCandidate> = {}): InventoryCandidate {
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
    dealer_name: "Jim Click Hyundai",
    distance_miles: 4.2,
    source_type: null,
    source_host: null,
    reasons: [],
    match_status: "exact",
    recommended: true,
    ...overrides,
  };
}

function open(row: InventoryCandidate): () => void {
  const r = render(<InventoryDetailModal row={row} onClose={() => {}} />);
  return () => r.unmount();
}

// ---------------------------------------------------------------------------
// Pre-existing structure preserved
// ---------------------------------------------------------------------------

describe("InventoryDetailModal — existing structure", () => {
  it("keeps the modal, title, match-status chip, close button, VIN + selling price", () => {
    const close = open(makeRow());
    expect(doc("inventory-detail-modal")).not.toBeNull();
    expect(doc("inventory-detail-title")!.textContent).toContain("Hyundai");
    expect(doc("inventory-detail-match-status")!.textContent).toBe("exact");
    expect(doc("inventory-detail-close")).not.toBeNull();
    const modal = doc("inventory-detail-modal")!;
    expect(modal.textContent).toContain("KM8JBCAE3RU000042"); // full VIN
    expect(modal.textContent).toContain("$44,175"); // selling price (= listed_price)
    close();
  });

  it("renders an inert modal (no dialog) when row is null", () => {
    const r = render(<InventoryDetailModal row={null} onClose={() => {}} />);
    expect(doc("inventory-detail-modal")).toBeNull();
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Labeled dealer markup (RED)
// ---------------------------------------------------------------------------

describe("InventoryDetailModal — labeled markup", () => {
  it("renders a RED labeled markup row with explicit '+$' text when dealer_markup > 0", () => {
    const close = open(makeRow({ dealer_markup: 3000 }));
    const markup = doc("inventory-detail-markup");
    expect(markup).not.toBeNull();
    expect(markup!.textContent).toBe("+$3,000");
    // Color is reinforced (RED) but the text carries the meaning.
    expect(markup!.className).toContain("breakdown-flag-red");
    close();
  });

  it("omits the markup row when dealer_markup is 0 (scanned, none)", () => {
    const close = open(makeRow({ dealer_markup: 0 }));
    expect(doc("inventory-detail-markup")).toBeNull();
    close();
  });

  it("omits the markup row when dealer_markup is null", () => {
    const close = open(makeRow({ dealer_markup: null }));
    expect(doc("inventory-detail-markup")).toBeNull();
    close();
  });

  it("renders the markup row even with NO listed price and NO MSRP (price-gated VDP)", () => {
    const close = open(makeRow({ dealer_markup: 2500, listed_price: null, msrp: null }));
    const markup = doc("inventory-detail-markup");
    expect(markup).not.toBeNull();
    expect(markup!.textContent).toBe("+$2,500");
    close();
  });
});

// ---------------------------------------------------------------------------
// Folded LLM price-block read: dealer discount + incentives text
// ---------------------------------------------------------------------------

describe("InventoryDetailModal — folded price-block (discount / incentives)", () => {
  it("renders a 'Dealer discount' row with '−$' text when dealer_discount > 0", () => {
    const close = open(makeRow({ dealer_discount: 1500 }));
    const discount = doc("inventory-detail-discount");
    expect(discount).not.toBeNull();
    expect(discount!.textContent).toBe("−$1,500");
    close();
  });

  it("omits the discount row when dealer_discount is 0 or null", () => {
    const close = open(makeRow({ dealer_discount: 0 }));
    expect(doc("inventory-detail-discount")).toBeNull();
    close();
    const close2 = open(makeRow({ dealer_discount: null }));
    expect(doc("inventory-detail-discount")).toBeNull();
    close2();
  });

  it("renders the incentives note verbatim when incentives_text is present, omits it when null/blank", () => {
    const close = open(makeRow({ incentives_text: "$500 military rebate" }));
    const note = doc("inventory-detail-incentives");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("$500 military rebate");
    close();
    const close2 = open(makeRow({ incentives_text: "   " }));
    expect(doc("inventory-detail-incentives")).toBeNull();
    close2();
  });

  it("shows the price-breakdown section for a discount/incentive even with no price or MSRP", () => {
    const close = open(
      makeRow({ listed_price: null, msrp: null, dealer_discount: 2000, incentives_text: null }),
    );
    expect(doc("inventory-detail-discount")).not.toBeNull();
    close();
  });

  it("PARTIAL RECOVERY (breakdown_parsed=false + a preserved markup + a recovered discount): stays honest", () => {
    // The augment-record state: the add-on region couldn't be read (breakdown_parsed
    // false) but a markup was preserved and a discount recovered. The modal must
    // NOT claim "no add-ons detected", must keep the couldn't-read note, show the
    // discount, AND not call the SHOWN markup "unknown".
    const close = open(
      makeRow({ breakdown_parsed: false, dealer_markup: 2000, dealer_discount: 1500 }),
    );
    expect(doc("inventory-detail-no-addons")).toBeNull(); // never the confident "no add-ons" claim
    const unknown = doc("inventory-detail-breakdown-unknown");
    expect(unknown).not.toBeNull(); // the honest couldn't-read note persists
    expect(unknown!.textContent).toContain("add-ons UNKNOWN");
    expect(unknown!.textContent).not.toContain("markup and add-ons"); // markup is shown → not "unknown"
    expect(doc("inventory-detail-markup")).not.toBeNull(); // the preserved markup is shown
    expect(doc("inventory-detail-discount")).not.toBeNull(); // the recovered discount is shown
    close();
  });
});

// ---------------------------------------------------------------------------
// Add-on coverage states + amber/red severity
// ---------------------------------------------------------------------------

describe("InventoryDetailModal — add-on coverage states", () => {
  it("breakdown_parsed=false → a conspicuous (non-muted) couldn't-read note, no list", () => {
    const close = open(makeRow({ breakdown_parsed: false }));
    const note = doc("inventory-detail-breakdown-unknown");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("UNKNOWN");
    expect(note!.className).not.toContain("muted"); // conspicuous, not muted
    expect(doc("inventory-detail-no-addons")).toBeNull();
    expect(doc("inventory-detail-addons")).toBeNull();
    close();
  });

  it("breakdown_parsed=true + no add-ons → 'No dealer add-ons detected.' (distinct state)", () => {
    const close = open(makeRow({ breakdown_parsed: true, add_ons: [], addons_total: null }));
    expect(doc("inventory-detail-no-addons")).not.toBeNull();
    expect(doc("inventory-detail-breakdown-unknown")).toBeNull();
    expect(doc("inventory-detail-addons")).toBeNull();
    close();
  });

  it("a small add-on total (< $2k) renders the list AMBER with each item + total", () => {
    const close = open(
      makeRow({
        breakdown_parsed: true,
        add_ons: [
          { label: "Nitrogen tire fill", amount: 299 },
          { label: "Window etch", amount: 199 },
        ],
        addons_total: 498,
      }),
    );
    const block = doc("inventory-detail-addons");
    expect(block).not.toBeNull();
    expect(block!.className).toContain("sev-amber");
    expect(block!.className).not.toContain("sev-red");
    expect(document.body.querySelectorAll('[data-testid="inventory-detail-addon"]')).toHaveLength(2);
    expect(block!.textContent).toContain("Nitrogen tire fill");
    expect(doc("inventory-detail-addons-total")!.textContent).toContain("$498");
    // The "couldn't read" / "none detected" notes do NOT also appear.
    expect(doc("inventory-detail-breakdown-unknown")).toBeNull();
    expect(doc("inventory-detail-no-addons")).toBeNull();
    close();
  });

  it("a heavy add-on total (>= $2k) escalates the list to RED", () => {
    const close = open(
      makeRow({
        breakdown_parsed: true,
        add_ons: [{ label: "Protection package", amount: 2200 }],
        addons_total: 2200,
      }),
    );
    const block = doc("inventory-detail-addons");
    expect(block).not.toBeNull();
    expect(block!.className).toContain("sev-red");
    expect(block!.className).not.toContain("sev-amber");
    close();
  });
});

// ---------------------------------------------------------------------------
// Interior color, availability reframe, rebate caveat, price gated
// ---------------------------------------------------------------------------

describe("InventoryDetailModal — interior color / availability / caveat / gated", () => {
  it("renders the interior color row when present, omits it when null", () => {
    const close = open(makeRow({ interior_color: "Black Leather" }));
    expect(doc("inventory-detail-interior-color")!.textContent).toBe("Black Leather");
    close();

    const close2 = open(makeRow({ interior_color: null }));
    expect(doc("inventory-detail-interior-color")).toBeNull();
    close2();
  });

  it("reframes an 'unknown' status to 'not confirmed by scan' (not the bare word)", () => {
    const close = open(makeRow({ inventory_status: "unknown" }));
    const av = doc("inventory-detail-availability");
    expect(av).not.toBeNull();
    expect(av!.textContent).toBe("not confirmed by scan");
    expect(av!.textContent).not.toBe("unknown");
    close();
  });

  it("keeps in_stock / in_transit / ordered statuses verbatim", () => {
    for (const status of ["in_stock", "in_transit", "ordered"]) {
      const close = open(makeRow({ inventory_status: status }));
      expect(doc("inventory-detail-availability")!.textContent).toBe(status);
      close();
    }
  });

  it("always shows the static rebate caveat (when a price is shown) and it is NOT muted", () => {
    const close = open(makeRow());
    const caveat = doc("inventory-detail-rebate-caveat");
    expect(caveat).not.toBeNull();
    expect(caveat!.textContent).toContain("rebates");
    expect(caveat!.className).not.toContain("muted"); // WCAG AA: full --ink contrast
    close();
  });

  it("renders the price-gated note only when price_gated is true", () => {
    const close = open(makeRow({ price_gated: true }));
    expect(doc("inventory-detail-price-gated")).not.toBeNull();
    close();

    const close2 = open(makeRow({ price_gated: false }));
    expect(doc("inventory-detail-price-gated")).toBeNull();
    close2();
  });
});

// ---------------------------------------------------------------------------
// "Found on" provenance row (aggregator rows only)
// ---------------------------------------------------------------------------

describe("InventoryDetailModal — Found-on provenance row", () => {
  it("renders the Found-on row with the host for an aggregator_srp row", () => {
    const close = open(makeRow({ source_type: "aggregator_srp", source_host: "www.cars.com" }));
    const foundOn = doc("inventory-detail-found-on");
    expect(foundOn).not.toBeNull();
    expect(foundOn!.textContent).toBe("www.cars.com");
    close();
  });

  it("omits the Found-on row for a dealer-site row (source_type null)", () => {
    const close = open(makeRow({ source_type: null, source_host: null }));
    expect(doc("inventory-detail-found-on")).toBeNull();
    close();
  });

  it("omits the Found-on row when source_host is null despite an aggregator type", () => {
    const close = open(makeRow({ source_type: "aggregator_srp", source_host: null }));
    expect(doc("inventory-detail-found-on")).toBeNull();
    close();
  });
});
