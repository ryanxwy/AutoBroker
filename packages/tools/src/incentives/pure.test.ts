/**
 * L1 unit tests — the incentive_scrape deterministic core. Freezes:
 *   - the aggregator / non-US-domain rejection table, item by item;
 *   - the 7-day cache gate's edges (day-6 fresh, day-8 stale, exact-boundary
 *     inclusive, URL-change forces re-scrape, empty/corrupt markers scrape);
 *   - the 5-class cash whitelist (keep / drop / passthrough semantics);
 *   - program-identity merge (newer scraped_at wins);
 *   - dual-source cross-verify (consistent / discrepancy / disjoint);
 *   - the {zip}/{model} template substitution (encoding + unresolved throw);
 *   - the US-zip shape gate;
 *   - every seed-table candidate passes its own gates (the table stays
 *     honest by construction).
 */

import { describe, expect, it } from "vitest";

import type { Incentive } from "@autobroker/core";

import { validateSourceUrl } from "../ssrf.js";
import {
  cacheGateDecision,
  CASH_INCENTIVE_TYPES,
  classifyOemHost,
  crossVerifyIncentives,
  filterCashTypes,
  INCENTIVE_CACHE_TTL_DAYS,
  isLikelyUsZip,
  mergeScrapeResults,
  normalizeIncentiveBrand,
  OEM_SEED_SOURCES,
  substituteOemUrlTemplate,
} from "./pure.js";

function row(overrides: Partial<Incentive> = {}): Incentive {
  return { type: "customer_cash", amount: 1500, expires: "2026-07-06", eligibility: "all", ...overrides };
}

describe("classifyOemHost", () => {
  it("passes a national OEM domain", () => {
    expect(classifyOemHost("https://www.hyundaiusa.com/us/en/offers")).toEqual({ ok: true });
  });

  it("rejects every aggregator host exactly", () => {
    for (const host of ["kbb.com", "edmunds.com", "cars.com", "cargurus.com", "truecar.com", "autoblog.com"]) {
      expect(classifyOemHost(`https://${host}/incentives`)).toEqual({
        ok: false,
        reason: "aggregator_host",
      });
    }
  });

  it("rejects aggregator subdomains (suffix match)", () => {
    expect(classifyOemHost("https://www.edmunds.com/deals/")).toEqual({
      ok: false,
      reason: "aggregator_host",
    });
    // …but not lookalike hosts that merely END with the same letters.
    expect(classifyOemHost("https://notcars.com/specials")).toEqual({ ok: true });
  });

  it("rejects non-US TLDs (.ca and nested ccTLDs)", () => {
    expect(classifyOemHost("https://www.hyundaicanada.ca/offers")).toEqual({
      ok: false,
      reason: "non_us_oem_domain",
    });
    expect(classifyOemHost("https://www.ford.co.uk/offers")).toEqual({
      ok: false,
      reason: "non_us_oem_domain",
    });
  });

  it("passes a regional US dealer-chain domain", () => {
    expect(classifyOemHost("https://incentives.example-dealers.com/current")).toEqual({ ok: true });
  });

  it("fails closed on malformed / non-http(s) URLs", () => {
    expect(classifyOemHost("not a url")).toEqual({ ok: false, reason: "malformed_url" });
    expect(classifyOemHost("ftp://hyundaiusa.com/offers")).toEqual({
      ok: false,
      reason: "malformed_url",
    });
  });
});

describe("cacheGateDecision (7-day + same-URL)", () => {
  const URL_A = "https://www.hyundaiusa.com/us/en/offers?zip=92614&model=Tucson%20Hybrid";
  const NOW = "2026-06-12T12:00:00.000Z";
  const daysAgo = (days: number): string =>
    new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();

  it("day-6 fresh + same URL → skip", () => {
    expect(
      cacheGateDecision({ latestScrapedAt: daysAgo(6), latestSourceUrl: URL_A }, URL_A, NOW),
    ).toBe("skip");
  });

  it("day-8 stale → scrape (even with the same URL)", () => {
    expect(
      cacheGateDecision({ latestScrapedAt: daysAgo(8), latestSourceUrl: URL_A }, URL_A, NOW),
    ).toBe("scrape");
  });

  it("exactly 7 days old is still fresh (boundary inclusive)", () => {
    expect(
      cacheGateDecision(
        { latestScrapedAt: daysAgo(INCENTIVE_CACHE_TTL_DAYS), latestSourceUrl: URL_A },
        URL_A,
        NOW,
      ),
    ).toBe("skip");
  });

  it("a changed URL forces a re-scrape inside the window", () => {
    expect(
      cacheGateDecision(
        { latestScrapedAt: daysAgo(1), latestSourceUrl: URL_A },
        "https://www.hyundaiusa.com/us/en/offers?zip=90001&model=Tucson%20Hybrid",
        NOW,
      ),
    ).toBe("scrape");
  });

  it("never-scraped / corrupt markers scrape (fail open to a refresh)", () => {
    expect(cacheGateDecision({ latestScrapedAt: null, latestSourceUrl: null }, URL_A, NOW)).toBe(
      "scrape",
    );
    expect(
      cacheGateDecision({ latestScrapedAt: "not-a-date", latestSourceUrl: URL_A }, URL_A, NOW),
    ).toBe("scrape");
  });
});

describe("filterCashTypes (the 5-class whitelist)", () => {
  it("keeps a cash row", () => {
    const { kept, dropped } = filterCashTypes([row({ type: "customer_cash" })]);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it("drops an 'other' row and counts it", () => {
    const { kept, dropped } = filterCashTypes([row({ type: "other" })]);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it("keeps all five cash classes", () => {
    const rows = [...CASH_INCENTIVE_TYPES].map((t) => row({ type: t as Incentive["type"] }));
    const { kept, dropped } = filterCashTypes(rows);
    expect(kept).toHaveLength(5);
    expect(dropped).toBe(0);
  });

  it("an all-other page is a legal empty result (0 kept, all counted)", () => {
    const { kept, dropped } = filterCashTypes([row({ type: "other" }), row({ type: "other" }), row({ type: "other" })]);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(3);
  });

  it("passes expires through untouched (null stays null — never inferred)", () => {
    const { kept } = filterCashTypes([row({ type: "loyalty", expires: null })]);
    expect(kept[0]!.expires).toBeNull();
  });
});

describe("mergeScrapeResults (program-identity dedupe)", () => {
  it("dedupes identical programs, newer scraped_at wins", () => {
    const older = { incentive: row({ eligibility: "all" }), scrapedAt: "2026-06-10T00:00:00Z" };
    const newer = {
      incentive: row({ eligibility: "current_brand_owner" }),
      scrapedAt: "2026-06-12T00:00:00Z",
    };
    const merged = mergeScrapeResults([older, newer]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.eligibility).toBe("current_brand_owner");
  });

  it("different identities (amount or expires differ) both survive", () => {
    const a = { incentive: row({ amount: 1500 }), scrapedAt: "2026-06-12T00:00:00Z" };
    const b = { incentive: row({ amount: 2000 }), scrapedAt: "2026-06-12T00:00:00Z" };
    expect(mergeScrapeResults([a, b])).toHaveLength(2);
  });
});

describe("crossVerifyIncentives (the dual-source reconciliation)", () => {
  it("identity agreement on both sides → consistent (confidence boost)", () => {
    const result = crossVerifyIncentives([row()], [row()]);
    expect(result.matched).toBe(1);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.consistent).toBe(true);
  });

  it("same type, different amount → a source_discrepancy, not consistent", () => {
    const result = crossVerifyIncentives([row({ amount: 1500 })], [row({ amount: 2500 })]);
    expect(result.matched).toBe(0);
    expect(result.discrepancies).toEqual([
      {
        type: "customer_cash",
        primaryAmount: 1500,
        primaryExpires: "2026-07-06",
        secondaryAmount: 2500,
        secondaryExpires: "2026-07-06",
      },
    ]);
    expect(result.consistent).toBe(false);
  });

  it("disjoint program types are neither matches nor discrepancies", () => {
    const result = crossVerifyIncentives([row({ type: "loyalty" })], [row({ type: "military" })]);
    expect(result.matched).toBe(0);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.consistent).toBe(false); // nothing verified — no boost either
  });
});

describe("substituteOemUrlTemplate", () => {
  it("fills {zip} and {model} URI-encoded", () => {
    expect(
      substituteOemUrlTemplate("https://x.com/offers?zip={zip}&model={model}", {
        zip: "92614",
        model: "Tucson Hybrid",
      }),
    ).toBe("https://x.com/offers?zip=92614&model=Tucson%20Hybrid");
  });

  it("fills every occurrence", () => {
    expect(
      substituteOemUrlTemplate("https://x.com/{zip}/o?z={zip}", { zip: "92614", model: "T" }),
    ).toBe("https://x.com/92614/o?z=92614");
  });

  it("throws on an unresolved placeholder (a literal {x} is never navigated)", () => {
    expect(() =>
      substituteOemUrlTemplate("https://x.com/offers?vin={vin}", { zip: "92614", model: "T" }),
    ).toThrow(/unresolved placeholder \{vin\}/);
  });
});

describe("isLikelyUsZip", () => {
  it.each([
    ["92614", true],
    ["92614-1234", true],
    [" 92614 ", true],
    ["9261", false],
    ["K1A 0B1", false], // Canadian postal shape
    ["", false],
    [null, false],
  ])("%j → %s", (zip, expected) => {
    expect(isLikelyUsZip(zip as string | null)).toBe(expected);
  });
});

describe("normalizeIncentiveBrand", () => {
  it("lowercases, trims and collapses whitespace", () => {
    expect(normalizeIncentiveBrand("  Hyundai ")).toBe("hyundai");
    expect(normalizeIncentiveBrand("Land   Rover")).toBe("land rover");
  });
  it("aliases the colloquial 'Chevy' to the canonical 'chevrolet' (A3)", () => {
    expect(normalizeIncentiveBrand("Chevy")).toBe("chevrolet");
    expect(normalizeIncentiveBrand("  chevy ")).toBe("chevrolet");
    // canonical key is a fixed point (only the colloquial alias maps)
    expect(normalizeIncentiveBrand("Chevrolet")).toBe("chevrolet");
  });
});

describe("OEM_SEED_SOURCES (the table stays honest by construction)", () => {
  it("every seed substitutes cleanly and passes the host gate + SSRF rules", async () => {
    for (const [brand, seed] of Object.entries(OEM_SEED_SOURCES)) {
      expect(brand).toBe(normalizeIncentiveBrand(brand)); // keys are normalized
      const url = substituteOemUrlTemplate(seed.urlTemplate, {
        zip: "92614",
        model: "Tucson Hybrid",
      });
      expect(classifyOemHost(url)).toEqual({ ok: true });
      // SSRF static rules (DNS stubbed public — the network is not under test).
      await expect(
        validateSourceUrl(url, { resolveHost: async () => ["93.184.216.34"] }),
      ).resolves.toBeUndefined();
    }
  });

  it("carries the Hyundai candidate the corpus profile needs", () => {
    expect(OEM_SEED_SOURCES["hyundai"]).toBeDefined();
  });
});
