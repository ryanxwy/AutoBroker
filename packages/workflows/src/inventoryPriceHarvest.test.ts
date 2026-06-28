import { describe, expect, it } from "vitest";

import { harvestPriceFromSnapshot } from "./inventoryPriceHarvest.js";

describe("harvestPriceFromSnapshot", () => {
  it("captures the bottom-of-stack selling price + MSRP (Sill-TerHar / DealerFire shape)", () => {
    // The exact live 2026-06-22 case: a DealerFire price stack the SRP gated.
    const snap =
      "NEW 2026 MAZDA CX-5 2.5 S PREMIUM AWD SPORT UTILITY 2.5L " +
      "VIN JM3KMDHAXT0191889 Stock M12704 " +
      "MSRP $39,145 Dealer Discount -$2,026 Dealer Fee $899 " +
      "Purchase Price $38,018 Loyalty Offer: Get $750 Get Instant Price";
    const r = harvestPriceFromSnapshot(snap);
    expect(r.msrp).toBe(39145);
    expect(r.listedPrice).toBe(38018);
    expect(r.priceGated).toBe(false); // a real selling price resolved
  });

  it("generalizes to a different brand/label: Internet Price + Sale Price stack (DealerInspire)", () => {
    const snap =
      "2025 Honda Accord EX-L MSRP $33,990 Sale Price $32,400 Internet Price $31,750";
    const r = harvestPriceFromSnapshot(snap);
    expect(r.msrp).toBe(33990);
    // Sale Price ranks above Internet Price -> $32,400 wins.
    expect(r.listedPrice).toBe(32400);
  });

  it("generalizes: DealerOn 'Our Best Price' stack", () => {
    const snap = "2026 Toyota RAV4 XLE MSRP $36,200 Our Best Price $34,995";
    const r = harvestPriceFromSnapshot(snap);
    expect(r.listedPrice).toBe(34995);
    expect(r.msrp).toBe(36200);
  });

  it("generalizes: 'ePrice' label (Dealer.com)", () => {
    const snap = "2026 Hyundai Tucson SEL Retail Price $32,100 ePrice $30,480";
    const r = harvestPriceFromSnapshot(snap);
    expect(r.listedPrice).toBe(30480);
    expect(r.msrp).toBe(32100);
  });

  it("captures the Dealer.com 'Transparent Pricing' stack (Total SRP + Transparent Price)", () => {
    // The exact live innerText layout from a real Dealer.com (DDC) Toyota VDP
    // (toyotaofmtpleasant.com): newline-separated labels/values, no "MSRP" word,
    // and a "No Hidden Fees" caption between the "Transparent Price" label and
    // its amount (its "Fees" substring must NOT reject the price).
    const snap =
      "Total SRP\n$38,663\nDocumentary Fee\n$225\nDealer Installed Accessories\n$798\n" +
      "Dealer Adjustment\n-$2,455\nTransparent Price\nNo Hidden Fees\n$37,231\n" +
      "Price excludes required taxes, tag and title fees.";
    const r = harvestPriceFromSnapshot(snap);
    expect(r.msrp).toBe(38663);
    expect(r.listedPrice).toBe(37231);
    expect(r.priceGated).toBe(false);
  });

  it("captures a second DDC value shape (Total SRP + Transparent Price, sibling VDP)", () => {
    const snap =
      "Total SRP\n$36,233\nDocumentary Fee\n$225\nTransparent Price\nNo Hidden Fees\n$35,030";
    const r = harvestPriceFromSnapshot(snap);
    expect(r.msrp).toBe(36233);
    expect(r.listedPrice).toBe(35030);
  });

  it("still rejects a REAL fee line — the 'No Hidden Fees' strip is narrow", () => {
    // A genuine (in-band) dealer-fee amount must still be rejected; only the
    // negated slogan is exempted.
    expect(harvestPriceFromSnapshot("Dealer Fee $6,500").listedPrice).toBeNull();
  });

  it("marks priceGated and keeps MSRP when the selling price is behind a CTA", () => {
    const snap = "2026 Mazda CX-5 Preferred MSRP $32,750 Get Instant Price";
    const r = harvestPriceFromSnapshot(snap);
    expect(r.msrp).toBe(32750);
    expect(r.listedPrice).toBeNull();
    expect(r.priceGated).toBe(true);
  });

  it("returns all-null + priceGated when nothing but a gate CTA is present", () => {
    const snap = "2026 Mazda CX-5 Carbon Turbo Call for Price";
    const r = harvestPriceFromSnapshot(snap);
    expect(r.listedPrice).toBeNull();
    expect(r.msrp).toBeNull();
    expect(r.priceGated).toBe(true);
  });

  it("rejects monthly payments, APR, down payments, fees, savings, and strikethrough", () => {
    const pitfalls = [
      "Lease for $389/mo for 36 months",
      "Finance at 2.9% APR",
      "$2,500 due at signing",
      "$3,000 down payment",
      "Doc Fee $899 Destination $1,395",
      "You Save $3,000 Dealer Discount -$2,026",
      "Was $42,000 Now check details",
    ];
    for (const p of pitfalls) {
      const r = harvestPriceFromSnapshot(p);
      expect(r.listedPrice).toBeNull();
    }
  });

  it("rejects out-of-band amounts (too low / too high) even with a valid label", () => {
    expect(harvestPriceFromSnapshot("Sale Price $3,200").listedPrice).toBeNull();
    expect(harvestPriceFromSnapshot("Sale Price $310,000").listedPrice).toBeNull();
  });

  it("drops a selling price above MSRP rather than guessing", () => {
    const r = harvestPriceFromSnapshot("MSRP $30,000 Sale Price $35,000");
    expect(r.msrp).toBe(30000);
    expect(r.listedPrice).toBeNull();
  });

  it("returns all-null on a snapshot with no labeled price", () => {
    const r = harvestPriceFromSnapshot("2026 Mazda CX-5 Jet Black Mica 24/30 MPG 5 seats");
    expect(r).toEqual({ listedPrice: null, msrp: null, priceGated: false });
  });

  it("keeps MSRP only when a selling label is present but its number is a pitfall", () => {
    // 'Sale Price' label but the only nearby number is a monthly payment.
    const r = harvestPriceFromSnapshot("MSRP $40,000 Sale Price as low as $499/mo");
    expect(r.msrp).toBe(40000);
    expect(r.listedPrice).toBeNull();
  });

  it("a trailing 'You Save' line does NOT poison the preceding selling price (next-line pitfall)", () => {
    // Regression: a fee/savings line rendered AFTER the price must not null it.
    const snap =
      "MSRP $39,145 Dealer Discount -$2,026 Purchase Price $38,018 " +
      "You Save $1,127 Get Instant Price";
    const r = harvestPriceFromSnapshot(snap);
    expect(r.msrp).toBe(39145);
    expect(r.listedPrice).toBe(38018);
    expect(r.priceGated).toBe(false);
  });

  it("does NOT capture a 'savings of $X' discount delta as the price", () => {
    const r = harvestPriceFromSnapshot("Your Price savings of $6,500 today");
    expect(r.listedPrice).toBeNull();
  });

  it("a trailing down-payment / due-at-signing line does NOT poison the price", () => {
    // Regression (bug 3): down/due-at-signing label the NEXT amount, not this one.
    expect(harvestPriceFromSnapshot("Sale Price $34,995 $3,000 down").listedPrice).toBe(34995);
    expect(harvestPriceFromSnapshot("Sale Price $34,995 Down Payment $3,000").listedPrice).toBe(
      34995,
    );
    expect(
      harvestPriceFromSnapshot("Purchase Price $38,018 $2,999 due at signing").listedPrice,
    ).toBe(38018);
  });

  it("a trailing '0% APR' financing line does NOT poison the price (own-number-first)", () => {
    expect(harvestPriceFromSnapshot("Sale Price $34,995 0% APR for 60 months").listedPrice).toBe(
      34995,
    );
    // but an immediately-adjacent /mo IS still a rejected monthly payment
    expect(harvestPriceFromSnapshot("Sale Price $34,995/mo").listedPrice).toBeNull();
  });

  it("is case-insensitive on labels", () => {
    const r = harvestPriceFromSnapshot("msrp $28,500 purchase price $27,100");
    expect(r.msrp).toBe(28500);
    expect(r.listedPrice).toBe(27100);
  });
});
