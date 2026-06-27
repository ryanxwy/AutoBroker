import { describe, expect, it } from "vitest";

import { harvestBreakdownFromSnapshot } from "./inventoryBreakdownHarvest.js";

describe("harvestBreakdownFromSnapshot — labeled dealer markup", () => {
  it("captures a LABELED market-adjustment / ADM line with an adjacent positive $", () => {
    expect(harvestBreakdownFromSnapshot("Market Adjustment $3,000").dealerMarkup).toBe(3000);
    expect(harvestBreakdownFromSnapshot("Additional Dealer Markup: $2,500").dealerMarkup).toBe(2500);
    expect(harvestBreakdownFromSnapshot("ADM $1,995").dealerMarkup).toBe(1995);
    expect(harvestBreakdownFromSnapshot("Market Value Adjustment $1,500").dealerMarkup).toBe(1500);
    expect(harvestBreakdownFromSnapshot("Adjusted Market Value $4,000").dealerMarkup).toBe(4000);
    expect(harvestBreakdownFromSnapshot("ADP $2,000").dealerMarkup).toBe(2000);
    expect(
      harvestBreakdownFromSnapshot("Additional Dealer Profit of $1,200").dealerMarkup,
    ).toBe(1200);
  });

  it("is case-insensitive on the markup anchor", () => {
    expect(harvestBreakdownFromSnapshot("market adjustment $3,000").dealerMarkup).toBe(3000);
  });

  it("returns null when a markup label has NO adjacent $ amount", () => {
    expect(
      harvestBreakdownFromSnapshot(
        "This dealership may add a market adjustment on certain high-demand models; ask for details.",
      ).dealerMarkup,
    ).toBeNull();
    expect(
      harvestBreakdownFromSnapshot(
        "Market Value Adjustment applies to select trims. Final pricing varies.",
      ).dealerMarkup,
    ).toBeNull();
  });

  it("does NOT infer markup from a selling>MSRP delta (no labeled adjacent $)", () => {
    // The $44,000 selling price exceeds the $40,000 MSRP, but with no LABELED
    // markup line we must NOT fabricate a markup number.
    const r = harvestBreakdownFromSnapshot(
      "No market adjustment on this vehicle. MSRP $40,000 Sale Price $44,000",
    );
    expect(r.dealerMarkup).toBeNull();
    expect(r.breakdownParsed).toBe(true);
  });

  it("ambiguous two-region snapshot (similar-vehicles block) does not fabricate markup", () => {
    const r = harvestBreakdownFromSnapshot(
      "NEW 2026 Toyota RAV4 XLE MSRP $36,200 Our Price $34,995. " +
        "Similar vehicles you may like: 2026 Toyota RAV4 Limited MSRP $42,000 Our Price $44,000",
    );
    expect(r.dealerMarkup).toBeNull();
    expect(r.addOns).toEqual([]);
    expect(r.breakdownParsed).toBe(true);
  });

  it("rejects an out-of-band markup amount", () => {
    expect(harvestBreakdownFromSnapshot("Market Adjustment $0").dealerMarkup).toBeNull();
    expect(harvestBreakdownFromSnapshot("Market Adjustment $90").dealerMarkup).toBeNull(); // < $100
    expect(harvestBreakdownFromSnapshot("Market Adjustment $75,000").dealerMarkup).toBeNull(); // > $50k
  });
});

describe("harvestBreakdownFromSnapshot — dealer add-ons", () => {
  it("detects add-on aliases with correct amounts, including sub-$100 items", () => {
    const r = harvestBreakdownFromSnapshot(
      "Dealer Add-Ons: Nitrogen Filled Tires $299, VIN Etch $199, " +
        "Wheel Locks $50, Nitrogen $90, Zaktek Paint Protection $1,295",
    );
    const amounts = r.addOns.map((a) => a.amount).sort((x, y) => x - y);
    expect(amounts).toEqual([50, 90, 199, 299, 1295]);
    expect(r.addonsTotal).toBe(1933);
    expect(r.breakdownParsed).toBe(true);
  });

  it("detects anti-theft brand aliases (VTR / Phantom Footprint / Theft Code)", () => {
    expect(harvestBreakdownFromSnapshot("VTR $399").addOns).toContainEqual({
      label: "anti-theft",
      amount: 399,
    });
    expect(harvestBreakdownFromSnapshot("Phantom Footprint $299").addOns).toContainEqual({
      label: "anti-theft",
      amount: 299,
    });
  });

  it("captures the '$X Label' order, not just 'Label $X'", () => {
    expect(harvestBreakdownFromSnapshot("$90 Nitrogen").addOns).toContainEqual({
      label: "nitrogen",
      amount: 90,
    });
  });

  it("dedups identical (label, amount) add-ons", () => {
    const r = harvestBreakdownFromSnapshot("Nitrogen $90 ... Nitrogen $90");
    expect(r.addOns).toEqual([{ label: "nitrogen", amount: 90 }]);
    expect(r.addonsTotal).toBe(90);
  });

  it("rejects out-of-band add-on amounts", () => {
    expect(harvestBreakdownFromSnapshot("Nitrogen $10").addOns).toEqual([]); // < $25
    expect(harvestBreakdownFromSnapshot("Paint Protection $5,000").addOns).toEqual([]); // > $3,000
  });
});

describe("harvestBreakdownFromSnapshot — negation / context guards", () => {
  it("does NOT count an add-on the page says is free / included / no charge", () => {
    expect(
      harvestBreakdownFromSnapshot("Nitrogen Filled Tires $90 included at no charge").addOns,
    ).toEqual([]);
    expect(harvestBreakdownFromSnapshot("Free VIN Etch $199 with purchase").addOns).toEqual([]);
    expect(harvestBreakdownFromSnapshot("Wheel Locks $50 complimentary").addOns).toEqual([]);
  });

  it("does NOT count a 'no nitrogen charge' disclaimer", () => {
    expect(harvestBreakdownFromSnapshot("no nitrogen charge on any vehicle").addOns).toEqual([]);
  });

  it("does NOT count a 'Shop Accessories' nav link", () => {
    expect(harvestBreakdownFromSnapshot("Shop Accessories $299 Nitrogen tires").addOns).toEqual([]);
    expect(harvestBreakdownFromSnapshot("Explore Protection Plans $999").addOns).toEqual([]);
  });

  it("does NOT count the CFPB 'GAP not required' financing disclaimer", () => {
    const r = harvestBreakdownFromSnapshot(
      "GAP not required to obtain financing $1,800 — optional product",
    );
    expect(r.addOns).toEqual([]);
  });

  it("does NOT count a '$0' add-on", () => {
    expect(harvestBreakdownFromSnapshot("$0 Theft Deterrent").addOns).toEqual([]);
    expect(harvestBreakdownFromSnapshot("Pinstripe $0").addOns).toEqual([]);
  });
});

describe("harvestBreakdownFromSnapshot — bundle / fee / government exclusions", () => {
  it("does NOT double-count a bundle TOTAL when its components are itemized", () => {
    const r = harvestBreakdownFromSnapshot(
      "Protection Package $1,800 — Paint Protection $800, Fabric Protection $500, VIN Etch $500",
    );
    expect(r.addOns).toHaveLength(3);
    expect(r.addOns.every((a) => a.amount !== 1800)).toBe(true);
    expect(r.addonsTotal).toBe(1800); // 800 + 500 + 500, not + the 1800 bundle total
  });

  it("keeps a standalone bundle when there are no itemized components", () => {
    const r = harvestBreakdownFromSnapshot("Appearance Package $1,200");
    expect(r.addOns).toEqual([{ label: "appearance package", amount: 1200 }]);
    expect(r.addonsTotal).toBe(1200);
  });

  it("keeps BOTH a bundle and an UNRELATED smaller add-on (components don't reconstruct the total)", () => {
    // The lone $99 nitrogen line is NOT a component of the $1,295 Appearance
    // Package; their sum (1394) is well below the bundle, so neither is dropped.
    const r = harvestBreakdownFromSnapshot("Appearance Package $1,295 Nitrogen $99");
    expect(r.addOns).toContainEqual({ label: "appearance package", amount: 1295 });
    expect(r.addOns).toContainEqual({ label: "nitrogen", amount: 99 });
    expect(r.addonsTotal).toBe(1394); // 1295 + 99 — the bundle is NOT over-dropped
  });

  it("excludes government charges and the manufacturer destination/doc fees", () => {
    const r = harvestBreakdownFromSnapshot(
      "MSRP $40,000 Sales Tax $2,400 Title Fee $85 Registration $350 " +
        "Destination $1,395 Doc Fee $899 Selling Price $38,500",
    );
    expect(r.dealerMarkup).toBeNull();
    expect(r.addOns).toEqual([]);
    expect(r.addonsTotal).toBeNull();
    expect(r.breakdownParsed).toBe(true);
  });

  it("keeps a real add-on adjacent to (but distinct from) a fee line", () => {
    // "Nitrogen $90" must survive even though "Doc Fee $899" follows it.
    const r = harvestBreakdownFromSnapshot("Nitrogen $90 Doc Fee $899");
    expect(r.addOns).toEqual([{ label: "nitrogen", amount: 90 }]);
    expect(r.addonsTotal).toBe(90);
  });
});

describe("harvestBreakdownFromSnapshot — breakdownParsed heuristic", () => {
  it("is true for a clean price stack with no markup / add-ons", () => {
    const r = harvestBreakdownFromSnapshot(
      "2025 Honda Accord EX-L MSRP $33,990 Selling Price $32,400",
    );
    expect(r.dealerMarkup).toBeNull();
    expect(r.addOns).toEqual([]);
    expect(r.addonsTotal).toBeNull();
    expect(r.breakdownParsed).toBe(true);
  });

  it("is false for garbage / empty text with no pricing region", () => {
    for (const garbage of ["", "2026 Mazda CX-5 Jet Black Mica 24/30 MPG 5 seats"]) {
      const r = harvestBreakdownFromSnapshot(garbage);
      expect(r).toEqual({
        dealerMarkup: null,
        addOns: [],
        addonsTotal: null,
        breakdownParsed: false,
      });
    }
  });
});
