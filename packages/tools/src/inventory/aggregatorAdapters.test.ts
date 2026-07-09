/**
 * aggregatorAdapters tests — the pure URL/slug builders + JSON helpers, plus the
 * self-contained in-page collectors driven through stubbed page globals (no real
 * network, no real browser). Fixtures are hand-shaped like the live probe
 * evidence, never real multi-hundred-KB dumps.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGGREGATOR_ADAPTERS,
  buildCarsComUrl,
  buildEdmundsUrl,
  buildVisorUrl,
  extractVinFromListingBlob,
  flattenCarsComBody,
  slugifyCarsComModel,
  type AggregatorFilterSlice,
} from "./aggregatorAdapters.js";

const SLICE: AggregatorFilterSlice = {
  make: "Honda",
  model: "CR-V",
  year: 2026,
  zip: "92617",
  radiusMiles: 50,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("URL builders", () => {
  it("Cars.com SRP URL snapshot (encoded array brackets, exact year window)", () => {
    expect(buildCarsComUrl(SLICE)).toBe(
      "https://www.cars.com/shopping/results/?stock_type=new&makes%5B%5D=honda" +
        "&models%5B%5D=honda-cr_v&zip=92617&maximum_distance=50&year_min=2026&year_max=2026",
    );
  });

  it("Edmunds SRP URL snapshot (pipe-encoded make|model, no year param)", () => {
    expect(buildEdmundsUrl(SLICE)).toBe(
      "https://www.edmunds.com/inventory/srp.html?inventorytype=new&make=honda" +
        "&model=honda%7Ccr-v&radius=50&zip=92617",
    );
  });

  it("neither built URL carries a price/budget/trim-shaped param (inv #9)", () => {
    const forbidden = /price|budget|trim|list_price/i;
    expect(forbidden.test(buildCarsComUrl(SLICE))).toBe(false);
    expect(forbidden.test(buildEdmundsUrl(SLICE))).toBe(false);
    expect(forbidden.test(buildVisorUrl(SLICE))).toBe(false);
  });

  it("visor.vin SRP URL snapshot (JSON-quoted year/zip/radius, no trim/state param)", () => {
    expect(
      buildVisorUrl({ make: "Toyota", model: "RAV4", year: 2026, zip: "98052", radiusMiles: 50 }),
    ).toBe(
      "https://visor.vin/search/listings?make=Toyota&model=RAV4&car_type=new" +
        "&year=%222026%22&geo_origin_kind=postal_code&geo_origin_value=%2298052%22" +
        "&geo_mode=radius&geo_distance_value=%2250%22&geo_distance_unit=mi",
    );
  });
});

describe("slugifyCarsComModel edge cases", () => {
  it("collapses each non-alphanumeric run to a single underscore", () => {
    expect(slugifyCarsComModel("Ford", "F-150")).toBe("ford-f_150");
    expect(slugifyCarsComModel("Nissan", "GT-R")).toBe("nissan-gt_r");
    expect(slugifyCarsComModel("Toyota", "Grand Highlander")).toBe("toyota-grand_highlander");
    expect(slugifyCarsComModel("Hyundai", "Santa Fe")).toBe("hyundai-santa_fe");
  });

  it("flows through into the built Cars.com model param", () => {
    const url = buildCarsComUrl({ ...SLICE, make: "Ford", model: "F-150" });
    expect(url).toContain("models%5B%5D=ford-f_150");
    expect(url).toContain("makes%5B%5D=ford");
  });
});

// A Cars.com listing shaped like the live probe: a nested body component tree
// (Text nodes with text_snippets, a DatumIcon name/value, a nested Stack) plus a
// serialized analytics blob where the VIN lives. The monthly-payment node hides
// its legal disclaimer in a popover that the flattener must NOT surface.
const carsComListing = {
  listing_id: "bcd58544-bf2d-4d66-8aea-2cd8c053c8e8",
  __typename: "SrpVehicleCard",
  body: {
    items: [
      { __typename: "Text", text_snippets: [{ text: "$35,943" }] },
      { __typename: "DatumIcon", name: "Price drop", value: "$1.1K" },
      { __typename: "Text", text_snippets: [{ text: "MSRP $37,305" }] },
      {
        __typename: "Stack",
        items: [
          { __typename: "Text", text_snippets: [{ text: "New 2026 Honda CR-V EX-L 2WD" }] },
          { __typename: "Text", text_snippets: [{ text: "Diamond Valley Honda" }] },
          { label: "$624", popover: { disclaimer: { text: "Estimated payments are calculated…" } } },
          { __typename: "Text", text_snippets: [{ text: "Hemet, CA (48 mi)" }] },
        ],
      },
    ],
  },
  analytics: { context: '{"vin":"2HKRS3H7XTH339070","listPrice":35943}' },
};

describe("flattenCarsComBody", () => {
  it("joins the visible body text snippets in order, deduped", () => {
    expect(flattenCarsComBody(carsComListing)).toBe(
      "$35,943 · Price drop · $1.1K · MSRP $37,305 · New 2026 Honda CR-V EX-L 2WD" +
        " · Diamond Valley Honda · $624 · Hemet, CA (48 mi)",
    );
  });

  it("never surfaces off-screen popover/disclaimer prose", () => {
    expect(flattenCarsComBody(carsComListing)).not.toContain("Estimated payments");
  });

  it("is null-safe on a shapeless listing", () => {
    expect(flattenCarsComBody(null)).toBe("");
    expect(flattenCarsComBody({})).toBe("");
  });
});

describe("extractVinFromListingBlob", () => {
  it("returns the first non-all-digit 17-char run (the VIN in the analytics blob)", () => {
    expect(extractVinFromListingBlob(carsComListing)).toBe("2HKRS3H7XTH339070");
  });

  it("returns null when no VIN-shaped run exists", () => {
    expect(extractVinFromListingBlob({ body: { items: [] }, id: "12345" })).toBeNull();
  });

  it("skips a pure-digit 17-char run (ids/timestamps are not VINs)", () => {
    expect(extractVinFromListingBlob({ tracker: "12345678901234567" })).toBeNull();
  });
});

describe("AGGREGATOR_ADAPTERS registry", () => {
  it("orders the adapters [cars_com, visor_vin, edmunds] (dedup priority) and excludes iSeeCars", () => {
    expect(AGGREGATOR_ADAPTERS.map((a) => a.siteId)).toEqual(["cars_com", "visor_vin", "edmunds"]);
  });

  it("marks cars.com and Edmunds robots-disallowed, visor.vin robots-allowed (compile-time constant)", () => {
    expect(AGGREGATOR_ADAPTERS.find((a) => a.siteId === "cars_com")!.robotsDisallowed).toBe(true);
    expect(AGGREGATOR_ADAPTERS.find((a) => a.siteId === "edmunds")!.robotsDisallowed).toBe(true);
    expect(AGGREGATOR_ADAPTERS.find((a) => a.siteId === "visor_vin")!.robotsDisallowed).toBe(false);
  });

  it("only visor_vin carries a persistentProfileKey (session posture per-site)", () => {
    expect(AGGREGATOR_ADAPTERS.find((a) => a.siteId === "cars_com")!.persistentProfileKey).toBeNull();
    expect(AGGREGATOR_ADAPTERS.find((a) => a.siteId === "edmunds")!.persistentProfileKey).toBeNull();
    expect(AGGREGATOR_ADAPTERS.find((a) => a.siteId === "visor_vin")!.persistentProfileKey).toBe(
      "aggregator/visor_vin",
    );
  });
});

describe("cars_com collect() (self-contained, stubbed page)", () => {
  it("emits one card per vehicle, skips interleaved ad modules, appends the VIN", () => {
    const secondVehicle = {
      ...carsComListing,
      listing_id: "b28275ff-2fd9-4653-a28b-8c1164002c46",
      analytics: { context: '{"vin":"2HKRS4H73TH468161"}' },
    };
    const adUnit = { __typename: "AdUnitModule", ad_id: "listing-10" }; // no listing_id
    const scriptJson = JSON.stringify({
      srp_results: { results: [carsComListing, adUnit, secondVehicle] },
    });
    vi.stubGlobal("location", { origin: "https://www.cars.com" });
    vi.stubGlobal("document", {
      getElementById: (id: string) =>
        id === "CarsWeb.SearchController.index" ? { textContent: scriptJson } : null,
    });

    const collected = AGGREGATOR_ADAPTERS.find((a) => a.siteId === "cars_com")!.collect();
    if (collected.kind !== "cards") throw new Error("expected kind: cards");

    expect(collected.cards).toHaveLength(2); // ad module dropped
    expect(collected.scalars).toEqual([
      { vin: "2HKRS3H7XTH339070", dealerName: null },
      { vin: "2HKRS4H73TH468161", dealerName: null },
    ]);
    expect(collected.cards[0]!.href).toBe(
      "https://www.cars.com/vehicledetail/bcd58544-bf2d-4d66-8aea-2cd8c053c8e8/",
    );
    expect(collected.cards[0]!.text).toContain("VIN: 2HKRS3H7XTH339070");
    expect(collected.appliedLocation).toBeNull();
  });
});

describe("edmunds collect() (self-contained, stubbed page)", () => {
  const edmundsState = {
    visitor: { location: { zipCode: "98021" } },
    inventory: {
      searchResults: {
        inventories: {
          results: [
            {
              vin: "5J6RS6H91TL027406",
              inTransit: false,
              dealerInfo: {
                name: "Lynnwood Honda",
                distance: 5.417,
                address: { city: "Edmonds", stateCode: "WA" },
              },
              prices: { displayPrice: 44000, dealerMsrp: 44000 },
              vehicleInfo: {
                styleInfo: { make: "Honda", model: "CR-V", trim: "Sport Touring Hybrid", year: 2026 },
                vehicleColors: { exterior: { name: "Meteorite Gray Metallic" } },
              },
            },
            {
              vin: "7FARS6H93TE138987",
              inTransit: true,
              dealerInfo: { name: "Norm Reeves Honda", distance: 9.2, address: { city: "Irvine", stateCode: "CA" } },
              prices: { displayPrice: 44455, dealerMsrp: 44455 },
              vehicleInfo: {
                styleInfo: { make: "Honda", model: "CR-V", trim: "Sport Touring Hybrid", year: 2026 },
                vehicleColors: { exterior: { name: "Radiant Red Metallic" } },
              },
            },
          ],
        },
      },
    },
  };
  const fakeDoc = {
    querySelector: (sel: string) => {
      const m = /a\[href\*="([A-HJ-NPR-Z0-9]{17})"\]/.exec(sel);
      if (m !== null) {
        return {
          getAttribute: (n: string) =>
            n === "href" ? `/honda/cr-v/2026/vin/${m[1]}/?radius=50` : null,
          textContent: null,
        };
      }
      if (sel === "h1") return { getAttribute: () => null, textContent: "Near Bothell, WA" };
      return null;
    },
  };

  it("maps each entry to a {vin, dealerName} scalar and a VDP href from the DOM", () => {
    vi.stubGlobal("location", { origin: "https://www.edmunds.com" });
    vi.stubGlobal("document", fakeDoc);
    vi.stubGlobal("EDM", { preloadedState: edmundsState });

    const collected = AGGREGATOR_ADAPTERS.find((a) => a.siteId === "edmunds")!.collect();
    if (collected.kind !== "cards") throw new Error("expected kind: cards");

    expect(collected.scalars).toEqual([
      { vin: "5J6RS6H91TL027406", dealerName: "Lynnwood Honda" },
      { vin: "7FARS6H93TE138987", dealerName: "Norm Reeves Honda" },
    ]);
    expect(collected.cards[0]!.href).toBe(
      "https://www.edmunds.com/honda/cr-v/2026/vin/5J6RS6H91TL027406/?radius=50",
    );
    expect(collected.cards[0]!.text).toContain("New 2026 Honda CR-V Sport Touring Hybrid");
    expect(collected.cards[0]!.text).toContain("Meteorite Gray Metallic");
    expect(collected.cards[0]!.text).toContain("Price $44,000");
    expect(collected.cards[0]!.text).toContain("Edmonds, WA");
    expect(collected.cards[1]!.text).toContain("In transit");
  });

  it("returns the applied search ZIP so the workflow can catch an ignored location", () => {
    vi.stubGlobal("location", { origin: "https://www.edmunds.com" });
    vi.stubGlobal("document", fakeDoc);
    vi.stubGlobal("EDM", { preloadedState: edmundsState });

    const collected = AGGREGATOR_ADAPTERS.find((a) => a.siteId === "edmunds")!.collect();
    if (collected.kind !== "cards") throw new Error("expected kind: cards");
    expect(collected.appliedLocation).toBe("98021");
  });

  it("falls back to the page heading when no applied ZIP is present", () => {
    vi.stubGlobal("location", { origin: "https://www.edmunds.com" });
    vi.stubGlobal("document", fakeDoc);
    vi.stubGlobal("EDM", {
      preloadedState: { ...edmundsState, visitor: {} },
    });

    const collected = AGGREGATOR_ADAPTERS.find((a) => a.siteId === "edmunds")!.collect();
    if (collected.kind !== "cards") throw new Error("expected kind: cards");
    expect(collected.appliedLocation).toBe("Near Bothell, WA");
  });

  it("degrades to empty output when preloadedState is absent", () => {
    vi.stubGlobal("location", { origin: "https://www.edmunds.com" });
    vi.stubGlobal("document", fakeDoc);
    vi.stubGlobal("EDM", {});

    const collected = AGGREGATOR_ADAPTERS.find((a) => a.siteId === "edmunds")!.collect();
    if (collected.kind !== "cards") throw new Error("expected kind: cards");
    expect(collected.cards).toEqual([]);
    expect(collected.scalars).toEqual([]);
    expect(collected.appliedLocation).toBe("Near Bothell, WA");
  });
});

describe("visor_vin collect() (self-contained, stubbed page)", () => {
  const visorRow = {
    vin: "2T36CRAV9TC331812",
    year: 2026,
    make: "Toyota",
    model: "RAV4",
    trim: "XLE",
    price: 45799,
    dealerName: "Swickard Toyota",
    vdpUrl: "https://www.swickardtoyota.com/auto/new-2026-toyota-rav4/123",
  };

  function stubRouter(a: { queryKey: unknown[]; status?: string; pages?: unknown[] }): void {
    const listingsQuery = {
      queryKey: a.queryKey,
      state: { status: a.status ?? "success", data: { pages: a.pages ?? [] } },
    };
    vi.stubGlobal("__TSR_ROUTER__", {
      options: {
        context: {
          queryClient: {
            getQueryCache: () => ({ getAll: () => [listingsQuery] }),
          },
        },
      },
    });
  }

  it("walks the query cache: returns rows, probe flags, total, and the location echo", () => {
    stubRouter({
      queryKey: [
        "listings",
        { geo_origin_zipcode: "98052", geo_distance_value: "50", year: "2026" },
      ],
      pages: [{ rows: [visorRow], total: 124 }],
    });
    vi.stubGlobal("document", { title: "RAV4 for sale", querySelector: () => null });

    const collected = AGGREGATOR_ADAPTERS.find((a) => a.siteId === "visor_vin")!.collect();
    if (collected.kind !== "rows") throw new Error("expected kind: rows");

    expect(collected.probe).toEqual({
      routerFound: true,
      queryClientFound: true,
      listingsQueryFound: true,
      queryStatus: "success",
      total: 124,
    });
    expect(collected.rows).toHaveLength(1);
    expect((collected.rows[0] as { vin: string }).vin).toBe("2T36CRAV9TC331812");
    expect(collected.challenge).toEqual({ cfIframe: false, cfInput: false, interstitial: false });
    expect(collected.echo).toEqual({ zip: "98052", radiusMiles: 50, year: 2026 });
  });

  it("strips JSON-quoted echo values (the site's own UI param shape)", () => {
    stubRouter({
      queryKey: ["listings", { geo_origin_value: '"98052"', geo_value: '"50"', year: '"2026"' }],
      pages: [],
    });
    vi.stubGlobal("document", { title: "", querySelector: () => null });

    const collected = AGGREGATOR_ADAPTERS.find((a) => a.siteId === "visor_vin")!.collect();
    if (collected.kind !== "rows") throw new Error("expected kind: rows");
    expect(collected.echo).toEqual({ zip: "98052", radiusMiles: 50, year: 2026 });
  });

  it("detects a Turnstile challenge wall and reports honest false/null probe flags", () => {
    vi.stubGlobal("document", {
      title: "Just a moment...",
      querySelector: (sel: string) =>
        sel.includes("challenges.cloudflare.com") || sel.includes("cf-turnstile-response") ? {} : null,
    });
    // No __TSR_ROUTER__ global stubbed — a walled page never hydrates the cache.

    const collected = AGGREGATOR_ADAPTERS.find((a) => a.siteId === "visor_vin")!.collect();
    if (collected.kind !== "rows") throw new Error("expected kind: rows");
    expect(collected.probe).toEqual({
      routerFound: false,
      queryClientFound: false,
      listingsQueryFound: false,
      queryStatus: null,
      total: null,
    });
    expect(collected.rows).toEqual([]);
    expect(collected.challenge).toEqual({ cfIframe: true, cfInput: true, interstitial: true });
    expect(collected.echo).toBeNull();
  });
});
