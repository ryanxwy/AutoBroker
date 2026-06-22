/**
 * L1 unit tests — the deterministic inventory ranker (parity contract).
 *
 * Pure-function tests, no DB. Freezes the four-axis scoring math (trim / price /
 * color / distance), the hard pre-scoring filters (drop ordered, drop
 * over-budget), the median fallback for a missing MSRP, the match-tier-then-
 * descending-score sort with a listing_id ASC tiebreak, and the rank-time
 * match_status recompute.
 */

import { describe, expect, it } from "vitest";
import {
  COLOR_WEIGHT,
  DISTANCE_WEIGHT,
  PRICE_WEIGHT,
  TRIM_WEIGHT,
  type ProfileMatchCtx,
  applyFilters,
  rankListings,
  scoreListing,
  selectTopListingsForDealer,
} from "./inventory_rank.js";

// ---------------------------------------------------------------------------
// Shared fixtures (mirror the parity _ctx / _listing factories).
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<ProfileMatchCtx> = {}): ProfileMatchCtx {
  return {
    profile_year: 2026,
    profile_make: "Hyundai",
    profile_model: "Tucson",
    profile_trim: "Limited",
    acceptable_trims: ["XRT", "N Line"],
    preferred_exterior_colors: ["Shimmering Silver", "Black"],
    search_radius_miles: 25,
    budget_max: 50000.0,
    ...overrides,
  };
}

function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listing_id: "lst_aaa",
    search_profile_id: "p1",
    dealer_id: "d1",
    vin: "KM8JBCAE3RU000001",
    year: 2026,
    make: "Hyundai",
    model: "Tucson",
    trim: "Limited",
    exterior_color: "Shimmering Silver",
    interior_color: "Black",
    msrp: 46500.0,
    listed_price: 44175.0,
    inventory_status: "in_stock",
    match_status: "exact",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Weight sum
// ---------------------------------------------------------------------------

describe("weights", () => {
  it("sum to exactly 1.0", () => {
    expect(TRIM_WEIGHT + PRICE_WEIGHT + COLOR_WEIGHT + DISTANCE_WEIGHT).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Trim axis
// ---------------------------------------------------------------------------

describe("trim axis", () => {
  it("exact trim → trim_exact chip", () => {
    const r = scoreListing(ctx(), listing({ trim: "Limited" }), 0.0);
    expect(r.reasons).toContain("trim_exact");
  });

  it("acceptable trim → trim_acceptable chip", () => {
    const r = scoreListing(ctx(), listing({ trim: "XRT" }), 0.0);
    expect(r.reasons).toContain("trim_acceptable");
  });

  it("off trim → trim_off chip", () => {
    const r = scoreListing(ctx(), listing({ trim: "SE" }), 0.0);
    expect(r.reasons).toContain("trim_off");
  });

  it("is case-insensitive on the exact match", () => {
    const r = scoreListing(ctx(), listing({ trim: "limited" }), 0.0);
    expect(r.reasons).toContain("trim_exact");
  });

  it("always emits exactly one of the three trim chips", () => {
    const r = scoreListing(ctx(), listing({ trim: "SE" }), 0.0);
    const trimChips = r.reasons.filter((c) =>
      ["trim_exact", "trim_acceptable", "trim_off"].includes(c),
    );
    expect(trimChips).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Price axis
// ---------------------------------------------------------------------------

describe("price axis", () => {
  it("listed under MSRP → under-MSRP chip", () => {
    const r = scoreListing(ctx(), listing({ msrp: 50000.0, listed_price: 47500.0 }), 0.0);
    expect(r.reasons.some((c) => c.includes("under MSRP"))).toBe(true);
  });

  it("listed == MSRP → partial price score, no discount chip", () => {
    const r = scoreListing(ctx(), listing({ msrp: 50000.0, listed_price: 50000.0 }), 0.0);
    expect(r.score).toBeLessThan(1.0);
    expect(r.reasons.some((c) => c.includes("under MSRP"))).toBe(false);
  });

  it("listed far over MSRP → price axis clipped, score < 1.0", () => {
    const r = scoreListing(ctx(), listing({ msrp: 40000.0, listed_price: 60000.0 }), 0.0);
    expect(r.score).toBeLessThan(1.0);
  });

  it("listed_price null → price_missing chip", () => {
    const r = scoreListing(ctx(), listing({ listed_price: null }), 0.0);
    expect(r.reasons).toContain("price_missing");
  });

  it("missing MSRP falls back to the batch median (via rankListings)", () => {
    const rows = [
      listing({ listing_id: "lst_a", msrp: null, listed_price: 40000.0 }),
      listing({ listing_id: "lst_b", msrp: null, listed_price: 42000.0 }),
      listing({ listing_id: "lst_c", msrp: null, listed_price: 44000.0 }),
    ];
    const result = rankListings(ctx(), rows, { d1: 0.0 });
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.score).toBeGreaterThanOrEqual(0.0);
      expect(r.score).toBeLessThanOrEqual(1.0);
    }
  });
});

// ---------------------------------------------------------------------------
// Color axis
// ---------------------------------------------------------------------------

describe("color axis", () => {
  it("preferred color → preferred_color chip", () => {
    const r = scoreListing(ctx(), listing({ exterior_color: "Shimmering Silver" }), 0.0);
    expect(r.reasons).toContain("preferred_color");
  });

  it("'No preference' sentinel → neutral, never preferred", () => {
    const r = scoreListing(
      ctx({ preferred_exterior_colors: ["No preference"] }),
      listing({ exterior_color: "Atomic Tangerine" }),
      0.0,
    );
    expect(r.reasons).not.toContain("preferred_color");
  });

  it("non-preferred color → low, never preferred", () => {
    const r = scoreListing(ctx(), listing({ exterior_color: "Atomic Tangerine" }), 0.0);
    expect(r.reasons).not.toContain("preferred_color");
  });
});

// ---------------------------------------------------------------------------
// Distance axis (never emits a chip)
// ---------------------------------------------------------------------------

describe("distance axis", () => {
  it("near scores higher than far", () => {
    const near = scoreListing(ctx({ search_radius_miles: 25 }), listing(), 0.0);
    const far = scoreListing(ctx({ search_radius_miles: 25 }), listing(), 25.0);
    expect(near.score).toBeGreaterThan(far.score);
  });

  it("far (beyond radius) → score < 1.0", () => {
    const r = scoreListing(ctx({ search_radius_miles: 25 }), listing(), 100.0);
    expect(r.score).toBeLessThan(1.0);
  });

  it("null distance → neutral (0 < score < 1)", () => {
    const r = scoreListing(ctx(), listing(), null);
    expect(r.score).toBeGreaterThan(0.0);
    expect(r.score).toBeLessThan(1.0);
  });

  it("never contributes a reason chip", () => {
    const r = scoreListing(ctx(), listing(), 0.0);
    const distanceChips = r.reasons.filter((c) => c.toLowerCase().includes("distance"));
    expect(distanceChips).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined + match_status recompute
// ---------------------------------------------------------------------------

describe("combined score", () => {
  it("a perfect listing scores ~1.0", () => {
    const r = scoreListing(
      ctx(),
      listing({
        trim: "Limited",
        msrp: 46500.0,
        listed_price: 46500.0 * 0.95,
        exterior_color: "Shimmering Silver",
      }),
      0.0,
    );
    expect(r.score).toBeCloseTo(1.0, 9);
  });

  it("recomputes match_status at rank time (off-trim full-identity → near)", () => {
    const r = scoreListing(ctx(), listing({ trim: "SE" }), 10.0);
    expect(r.match_status).toBe("near");
  });
});

// ---------------------------------------------------------------------------
// applyFilters (hard filters, BEFORE scoring)
// ---------------------------------------------------------------------------

describe("applyFilters", () => {
  it("drops ordered listings (null/'' kept)", () => {
    const rows = [
      listing({ listing_id: "a", inventory_status: "in_stock" }),
      listing({ listing_id: "b", inventory_status: "ordered" }),
      listing({ listing_id: "c", inventory_status: "in_transit" }),
      listing({ listing_id: "d", inventory_status: "unknown" }),
    ];
    const kept = new Set(applyFilters(rows, ctx()).map((r) => r["listing_id"]));
    expect(kept).toEqual(new Set(["a", "c", "d"]));
  });

  it("drops over-budget (strict >, == cap kept)", () => {
    const rows = [
      listing({ listing_id: "cheap", listed_price: 38000.0 }),
      listing({ listing_id: "at_cap", listed_price: 44000.0 }), // 1.10 * 40000
      listing({ listing_id: "too_pricy", listed_price: 45000.0 }),
    ];
    const kept = new Set(applyFilters(rows, ctx({ budget_max: 40000.0 })).map((r) => r["listing_id"]));
    expect(kept.has("too_pricy")).toBe(false);
    expect(kept.has("cheap")).toBe(true);
    expect(kept.has("at_cap")).toBe(true);
  });

  it("budget null → keep all", () => {
    const rows = [
      listing({ listing_id: "a", listed_price: 100000.0 }),
      listing({ listing_id: "b", listed_price: 200000.0 }),
    ];
    expect(applyFilters(rows, ctx({ budget_max: null }))).toHaveLength(2);
  });

  it("NULL listed_price passes the budget filter", () => {
    const rows = [listing({ listing_id: "no_price", listed_price: null })];
    expect(applyFilters(rows, ctx({ budget_max: 40000.0 }))).toHaveLength(1);
  });

  it("returns a new array (input not mutated)", () => {
    const rows = [listing({ listing_id: "a" })];
    const out = applyFilters(rows, ctx());
    expect(out).not.toBe(rows);
  });
});

// ---------------------------------------------------------------------------
// rankListings (filter → median → score → sort)
// ---------------------------------------------------------------------------

describe("rankListings", () => {
  it("orders descending by score", () => {
    const good = listing({
      listing_id: "lst_good",
      dealer_id: "d1",
      trim: "Limited",
      exterior_color: "Shimmering Silver",
      msrp: 46500.0,
      listed_price: 44175.0,
    });
    const meh = listing({
      listing_id: "lst_meh",
      dealer_id: "d2",
      trim: "SE",
      exterior_color: "Atomic Tangerine",
      msrp: 46500.0,
      listed_price: 46500.0,
    });
    const result = rankListings(ctx(), [meh, good], { d1: 0.0, d2: 30.0 });
    expect(result[0]!.listing_id).toBe("lst_good");
    expect(result[1]!.listing_id).toBe("lst_meh");
    expect(result[0]!.score).toBeGreaterThanOrEqual(result[1]!.score);
  });

  it("ranks an on-model near-match above a nearer, cheaper off-model mismatch", () => {
    // The on-model car (Tucson, off-trim → near) is far and at MSRP, so its
    // four-axis SCORE is low. The off-model car (Santa Fe → mismatch) is at the
    // door and cheap with a preferred color, so it OUTSCORES the near-match.
    // The match-tier primary sort must still surface the on-model car first —
    // a buyer who searched a Tucson must not see a Santa Fe ranked above it.
    const onModelNear = listing({
      listing_id: "lst_tucson_se",
      dealer_id: "d_far",
      model: "Tucson",
      trim: "SE", // off-trim, not in acceptable → near (model matches, trim off)
      exterior_color: "Atomic Tangerine", // non-preferred
      msrp: 40000.0,
      listed_price: 40000.0, // at MSRP → weak price axis
    });
    const offModelMismatch = listing({
      listing_id: "lst_santafe",
      dealer_id: "d_near",
      model: "Santa Fe", // different model → mismatch
      trim: "Limited",
      exterior_color: "Shimmering Silver", // preferred
      msrp: 40000.0,
      listed_price: 36000.0, // cheap → strong price axis
    });
    const result = rankListings(ctx(), [offModelMismatch, onModelNear], {
      d_far: 25.0, // at radius → distance score 0
      d_near: 0.0, // at the door → distance score 1
    });
    expect(result[0]!.match_status).toBe("near");
    expect(result[0]!.listing_id).toBe("lst_tucson_se");
    expect(result[1]!.match_status).toBe("mismatch");
    // The mismatch genuinely scores higher; only the tier keeps it second.
    expect(result[1]!.score).toBeGreaterThan(result[0]!.score);
  });

  it("breaks ties by listing_id ASC (stable)", () => {
    const rows = [
      listing({ listing_id: "lst_zzz", dealer_id: "d1" }),
      listing({ listing_id: "lst_aaa", dealer_id: "d1" }),
      listing({ listing_id: "lst_mmm", dealer_id: "d1" }),
    ];
    const result = rankListings(ctx(), rows, { d1: 5.0 });
    expect(result.map((r) => r.listing_id)).toEqual(["lst_aaa", "lst_mmm", "lst_zzz"]);
  });

  it("applies hard filters before scoring", () => {
    const rows = [
      listing({ listing_id: "kept", inventory_status: "in_stock" }),
      listing({ listing_id: "dropped", inventory_status: "ordered" }),
    ];
    const result = rankListings(ctx(), rows, { d1: 0.0 });
    expect(new Set(result.map((r) => r.listing_id))).toEqual(new Set(["kept"]));
  });

  it("maps dealer distance via dealer_id, neutral when dealer is absent", () => {
    const withDealer = listing({ listing_id: "lst_with", dealer_id: "d1" });
    const noDealer = listing({ listing_id: "lst_no", dealer_id: null });
    const result = rankListings(ctx(), [withDealer, noDealer], { d1: 0.0 });
    // Both score validly; absent dealer falls to the neutral distance branch.
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.score).toBeGreaterThan(0.0);
      expect(r.score).toBeLessThanOrEqual(1.0);
    }
  });
});

// ---------------------------------------------------------------------------
// selectTopListingsForDealer (per-dealer record cap for inventory_site_scan)
// ---------------------------------------------------------------------------

/** Minimal ClassifiedListingRow-like helper for the cap tests. */
function capRow(
  id: string,
  matchStatus: string,
  inventoryStatus: string,
  listed_price: number | null = 40000,
): { listing: Record<string, unknown>; matchStatus: string } {
  return {
    listing: {
      listing_id: id,
      year: 2026,
      make: "Hyundai",
      model: "Tucson",
      trim: "Limited",
      exterior_color: "Shimmering Silver",
      msrp: 46500,
      listed_price,
      inventory_status: inventoryStatus,
    },
    matchStatus,
  };
}

describe("selectTopListingsForDealer", () => {
  it("keeps all rows when count <= cap", () => {
    const rows = [capRow("a", "exact", "in_stock"), capRow("b", "near", "in_transit")];
    const { kept, dropped } = selectTopListingsForDealer(ctx(), rows, 20);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("slices to exactly cap when count > cap", () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      capRow(`id_${String(i).padStart(2, "0")}`, "exact", "in_stock"),
    );
    const { kept, dropped } = selectTopListingsForDealer(ctx(), rows, 20);
    expect(kept).toHaveLength(20);
    expect(dropped).toBe(5);
  });

  it("prefers in_stock/in_transit over ordered/unknown", () => {
    // Mix of available (in_stock, in_transit) and non-available (ordered, unknown)
    const rows = [
      capRow("ord", "exact", "ordered"),
      capRow("unk", "exact", "unknown"),
      capRow("stk", "exact", "in_stock"),
      capRow("trs", "exact", "in_transit"),
    ];
    const { kept, dropped } = selectTopListingsForDealer(ctx(), rows, 2);
    const ids = kept.map((r) => r.listing["listing_id"] as string);
    expect(ids).toContain("stk");
    expect(ids).toContain("trs");
    expect(ids).not.toContain("ord");
    expect(ids).not.toContain("unk");
    expect(dropped).toBe(2);
  });

  it("fills remaining slots with non-available when fewer than cap are available", () => {
    // Only 1 in_stock, cap=3 → the 2 non-available ones should fill in.
    const rows = [
      capRow("stk", "exact", "in_stock"),
      capRow("unk1", "exact", "unknown"),
      capRow("unk2", "near", "unknown"),
    ];
    const { kept, dropped } = selectTopListingsForDealer(ctx(), rows, 3);
    expect(kept).toHaveLength(3);
    expect(dropped).toBe(0);
  });

  it("ranks exact above near above mismatch above unknown within same availability tier", () => {
    const rows = [
      capRow("unk", "unknown", "in_stock"),
      capRow("mis", "mismatch", "in_stock"),
      capRow("nea", "near", "in_stock"),
      capRow("exa", "exact", "in_stock"),
    ];
    const { kept } = selectTopListingsForDealer(ctx(), rows, 4);
    const ids = kept.map((r) => r.listing["listing_id"] as string);
    expect(ids[0]).toBe("exa");
    expect(ids[1]).toBe("nea");
    expect(ids[2]).toBe("mis");
    expect(ids[3]).toBe("unk");
  });

  it("breaks ties by listing_id ASC (stable tiebreak)", () => {
    // All identical except id — same match, same availability, same price
    const rows = [
      capRow("zzz", "exact", "in_stock"),
      capRow("aaa", "exact", "in_stock"),
      capRow("mmm", "exact", "in_stock"),
    ];
    const { kept } = selectTopListingsForDealer(ctx(), rows, 2);
    expect(kept[0]!.listing["listing_id"]).toBe("aaa");
    expect(kept[1]!.listing["listing_id"]).toBe("mmm");
  });

  it("higher score ranks before lower score within same tier", () => {
    // Same match/availability; preferred color → higher score
    const goodColor = capRow("good", "exact", "in_stock");
    const badColor = capRow("bad_zzz", "exact", "in_stock");
    // Override color on goodColor to preferred, badColor to non-preferred
    goodColor.listing["exterior_color"] = "Shimmering Silver"; // preferred in ctx()
    badColor.listing["exterior_color"] = "Atomic Tangerine"; // non-preferred
    const { kept } = selectTopListingsForDealer(ctx(), [badColor, goodColor], 1);
    expect(kept[0]!.listing["listing_id"]).toBe("good");
  });

  it("availability preferred > match tier: in_stock mismatch ranks above unknown ordered", () => {
    // in_stock mismatch is tier (availTier=0, matchTier=2)
    // unknown ordered is tier (availTier=1, matchTier=3) — should lose on availability
    const rows = [
      capRow("mis_stk", "mismatch", "in_stock"),
      capRow("unk_ord", "unknown", "ordered"),
    ];
    const { kept } = selectTopListingsForDealer(ctx(), rows, 1);
    expect(kept[0]!.listing["listing_id"]).toBe("mis_stk");
  });

  it("extracted InventoryListing shape (price key, no listed_price/msrp) — cheaper listing wins cap", () => {
    // Regression: scoreListing previously read only listing["listed_price"],
    // which is absent on freshly-extracted rows (InventoryListing uses "price").
    // With the fix, the price axis reads listed_price ?? price, so the cheaper
    // car actually wins instead of both falling to the neutral 0.5 fallback and
    // breaking ties on listing_id.
    const cheaper = {
      listing: {
        listing_id: "ext_cheap",
        year: 2026,
        make: "Hyundai",
        model: "Tucson",
        trim: "Limited",
        exterior_color: "Shimmering Silver",
        interior_color: null,
        price: 39000, // extracted shape: "price", no "listed_price", no "msrp"
        inventory_status: "in_stock",
        listing_url: "https://dealer.example/v/1",
        vin: null,
        stock_number: null,
      },
      matchStatus: "exact",
    };
    const pricier = {
      listing: {
        listing_id: "ext_pricey", // lexically after "ext_cheap" → would win tiebreak if neutral
        year: 2026,
        make: "Hyundai",
        model: "Tucson",
        trim: "Limited",
        exterior_color: "Shimmering Silver",
        interior_color: null,
        price: 45000, // same shape, higher price
        inventory_status: "in_stock",
        listing_url: "https://dealer.example/v/2",
        vin: null,
        stock_number: null,
      },
      matchStatus: "exact",
    };
    // Cap=1 forces a drop; cheaper must win on price axis, not on id tiebreak.
    const { kept, dropped } = selectTopListingsForDealer(ctx(), [pricier, cheaper], 1);
    expect(dropped).toBe(1);
    expect(kept[0]!.listing["listing_id"]).toBe("ext_cheap");
  });

  it("color preference breaks score tie — preferred-color listing kept over off-color listing", () => {
    // Both exact match, both in_stock, identical price/trim. The only difference
    // is exterior_color. With a preferred-color ctx the color axis gives the
    // preferred-color listing score 1.0 vs 0.2 for the off-color one, so the
    // preferred-color listing must survive the cap drop.
    const preferred = {
      listing: {
        listing_id: "pref_color",
        year: 2026,
        make: "Hyundai",
        model: "Tucson",
        trim: "Limited",
        exterior_color: "Shimmering Silver", // in ctx() preferred_exterior_colors
        msrp: 46500,
        listed_price: 44000,
        inventory_status: "in_stock",
      },
      matchStatus: "exact",
    };
    const offColor = {
      listing: {
        listing_id: "off_color_zzz", // lexically after "pref_color" → loses tiebreak too
        year: 2026,
        make: "Hyundai",
        model: "Tucson",
        trim: "Limited",
        exterior_color: "Atomic Tangerine", // not in preferred list
        msrp: 46500,
        listed_price: 44000,
        inventory_status: "in_stock",
      },
      matchStatus: "exact",
    };
    // Cap=1 forces a drop; preferred-color listing must be kept.
    const { kept, dropped } = selectTopListingsForDealer(ctx(), [offColor, preferred], 1);
    expect(dropped).toBe(1);
    expect(kept[0]!.listing["listing_id"]).toBe("pref_color");
  });
});
