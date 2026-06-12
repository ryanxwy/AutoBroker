/**
 * L1 unit tests — rung i of the inventory filter ladder: the per-platform
 * filtered-SRP URL templates, the passthrough default, and the hard exclusions
 * (trim and price/budget can never reach a URL).
 */

import { describe, expect, it } from "vitest";
import { buildFilteredSrpUrl, FILTER_SELECTOR_MAP } from "./filter.js";

const PROFILE = { make: "Hyundai", model: "Tucson", year: 2026 };

describe("buildFilteredSrpUrl — per-platform templates", () => {
  it("dealercom: plain make/model/year params on the SRP URL", () => {
    const url = new URL(
      buildFilteredSrpUrl("dealercom", "https://www.tustinhyundai.com/new-inventory/index.htm", PROFILE),
    );
    expect(url.pathname).toBe("/new-inventory/index.htm");
    expect(url.searchParams.get("make")).toBe("Hyundai");
    expect(url.searchParams.get("model")).toBe("Tucson");
    expect(url.searchParams.get("year")).toBe("2026");
  });

  it("dealerinspire: facet-refinement params incl. type=New", () => {
    const url = new URL(
      buildFilteredSrpUrl("dealerinspire", "https://dealer.example.com/new-vehicles/", PROFILE),
    );
    expect(url.searchParams.get("_dFR[make][0]")).toBe("Hyundai");
    expect(url.searchParams.get("_dFR[model][0]")).toBe("Tucson");
    expect(url.searchParams.get("_dFR[year][0]")).toBe("2026");
    expect(url.searchParams.get("_dFR[type][0]")).toBe("New");
  });

  it("dealeron_v1: capitalized Make/Model/Year params", () => {
    const url = new URL(
      buildFilteredSrpUrl("dealeron_v1", "https://dealer.example.com/new-vehicles/", PROFILE),
    );
    expect(url.searchParams.get("Make")).toBe("Hyundai");
    expect(url.searchParams.get("Model")).toBe("Tucson");
    expect(url.searchParams.get("Year")).toBe("2026");
  });

  it("dealerfire: plain make/model/year params", () => {
    const url = new URL(
      buildFilteredSrpUrl("dealerfire", "https://dealer.example.com/new-inventory.htm", PROFILE),
    );
    expect(url.searchParams.get("make")).toBe("Hyundai");
    expect(url.searchParams.get("model")).toBe("Tucson");
    expect(url.searchParams.get("year")).toBe("2026");
  });

  it("default: passthrough UNCHANGED (byte-for-byte)", () => {
    const srp = "https://dealer.example.com/new-inventory?already=there";
    expect(buildFilteredSrpUrl("default", srp, PROFILE)).toBe(srp);
  });

  it("unparseable SRP URL: passthrough unchanged (rung-iii floor catches it)", () => {
    expect(buildFilteredSrpUrl("dealercom", "not a url", PROFILE)).toBe("not a url");
  });

  it("null year: the year param is simply omitted", () => {
    const url = new URL(
      buildFilteredSrpUrl("dealercom", "https://d.example/new-inventory/index.htm", {
        make: "Hyundai",
        model: "Tucson",
        year: null,
      }),
    );
    expect(url.searchParams.has("year")).toBe(false);
    expect(url.searchParams.get("make")).toBe("Hyundai");
  });

  it("existing params are preserved; same-named params are overwritten once", () => {
    const url = new URL(
      buildFilteredSrpUrl("dealercom", "https://d.example/new-inventory/index.htm?sort=price&make=Kia", PROFILE),
    );
    expect(url.searchParams.get("sort")).toBe("price");
    expect(url.searchParams.getAll("make")).toEqual(["Hyundai"]);
  });

  it.each(["dealercom", "dealerinspire", "dealeron_v1", "dealerfire"] as const)(
    "%s: NO trim and NO price/budget params, ever",
    (platform) => {
      const out = buildFilteredSrpUrl(platform, "https://d.example/new-inventory/", PROFILE);
      expect(out).not.toMatch(/trim|price|budget|payment/i);
    },
  );
});

describe("FILTER_SELECTOR_MAP — rung ii data table", () => {
  it("covers exactly the four fingerprinted platforms (no default entry)", () => {
    expect(Object.keys(FILTER_SELECTOR_MAP).sort()).toEqual([
      "dealercom",
      "dealerfire",
      "dealerinspire",
      "dealeron_v1",
    ]);
    expect(FILTER_SELECTOR_MAP.default).toBeUndefined();
  });

  it("every entry names make+model widgets and never a price/trim widget", () => {
    for (const entry of Object.values(FILTER_SELECTOR_MAP)) {
      expect(entry.make).toBeTruthy();
      expect(entry.model).toBeTruthy();
      for (const sel of [entry.region, entry.make, entry.model, entry.year, entry.applyButton]) {
        if (sel !== null) expect(sel).not.toMatch(/price|budget|trim|payment/i);
      }
    }
  });
});
