/**
 * L1 unit tests — the inventory_link_scan pure core.
 *
 * classifySkipUrl: every rule, the first-hit-wins evaluation ORDER, the
 * host-normalization quirks (case, www., subdomains), and the keep pins —
 * notably the query-bearing root URL ("/?model=cr-v" is an inventory link,
 * not a bare homepage) and the empty/unparseable best-effort keep.
 *
 * filterForProfile: exact|near accepted; mismatch/unknown rejected with the
 * typed reason; order preserved.
 */

import { describe, expect, it } from "vitest";

import { classifySkipUrl, filterForProfile } from "./linkScanPure.js";

describe("classifySkipUrl — the 5 junk rules", () => {
  it("rule 1 unsubscribe: path substrings unsubscribe / opt-out / optout", () => {
    expect(classifySkipUrl("https://crm.example.com/email/unsubscribe?id=1")).toBe("unsubscribe");
    expect(classifySkipUrl("https://dealer.com/Opt-Out")).toBe("unsubscribe");
    expect(classifySkipUrl("https://dealer.com/preferences/OPTOUT/now")).toBe("unsubscribe");
    // "unsubscribe" in the QUERY only is not a path hit.
    expect(classifySkipUrl("https://dealer.com/inventory?from=unsubscribe_footer")).toBeNull();
  });

  it("rule 2 google_services: google.com /maps paths + the maps.app.goo.gl short host", () => {
    expect(classifySkipUrl("https://www.google.com/maps/place/Tustin+Hyundai")).toBe(
      "google_services",
    );
    expect(classifySkipUrl("https://google.com/maps?q=dealer")).toBe("google_services");
    expect(classifySkipUrl("https://maps.google.com/maps/dir/a/b")).toBe("google_services");
    expect(classifySkipUrl("https://maps.app.goo.gl/AbCdEf")).toBe("google_services");
    // a google host WITHOUT a maps path is not this rule (and is kept).
    expect(classifySkipUrl("https://www.google.com/search?q=tucson")).toBeNull();
  });

  it("rule 3 social_media: the four hosts, own domain or any subdomain", () => {
    expect(classifySkipUrl("https://www.facebook.com/TustinHyundai")).toBe("social_media");
    expect(classifySkipUrl("https://m.facebook.com/TustinHyundai")).toBe("social_media");
    expect(classifySkipUrl("https://instagram.com/dealer")).toBe("social_media");
    expect(classifySkipUrl("https://twitter.com/dealer/status/1")).toBe("social_media");
    expect(classifySkipUrl("https://www.youtube.com/watch?v=abc")).toBe("social_media");
    // a dealer page that merely MENTIONS a social host in the path is kept.
    expect(classifySkipUrl("https://dealer.com/facebook.com-promo")).toBeNull();
  });

  it("rule 4 crm_tracking: the CRM hosts + the vin.<x>.net tracking pattern", () => {
    expect(classifySkipUrl("https://podium.com/r/abc123")).toBe("crm_tracking");
    expect(classifySkipUrl("https://links.podium.com/r/abc123")).toBe("crm_tracking");
    expect(classifySkipUrl("https://www.edealerhub.com/t/xyz")).toBe("crm_tracking");
    expect(classifySkipUrl("https://carleadsup.com/c/1")).toBe("crm_tracking");
    expect(classifySkipUrl("https://vin.dealertrack.net/track/1")).toBe("crm_tracking");
    expect(classifySkipUrl("https://click.vin.solutions.net/x")).toBe("crm_tracking");
    // vin-something but not the vin.<x>.net shape → kept.
    expect(classifySkipUrl("https://vinsolutions.com/page")).toBeNull();
  });

  it("rule 5 bare_homepage: empty or '/' path with NO query", () => {
    expect(classifySkipUrl("https://www.tustinhyundai.com")).toBe("bare_homepage");
    expect(classifySkipUrl("https://www.tustinhyundai.com/")).toBe("bare_homepage");
    // THE keep pin: a root URL WITH a query is an inventory link — kept.
    expect(classifySkipUrl("https://dealer.com/?model=cr-v")).toBeNull();
    // any real path is kept.
    expect(classifySkipUrl("https://dealer.com/new-inventory/index.htm")).toBeNull();
  });

  it("evaluation order is first-hit-wins (1→5)", () => {
    // unsubscribe beats social_media on a facebook unsubscribe path.
    expect(classifySkipUrl("https://www.facebook.com/unsubscribe")).toBe("unsubscribe");
    // unsubscribe beats crm_tracking on a podium opt-out path.
    expect(classifySkipUrl("https://podium.com/opt-out/123")).toBe("unsubscribe");
    // google_services beats bare_homepage is moot (maps needs a path), but a
    // bare social homepage is social_media, not bare_homepage (3 before 5).
    expect(classifySkipUrl("https://facebook.com/")).toBe("social_media");
    // a bare CRM homepage is crm_tracking, not bare_homepage (4 before 5).
    expect(classifySkipUrl("https://podium.com/")).toBe("crm_tracking");
  });

  it("host normalization: case-insensitive, leading www. stripped, scheme upgraded view", () => {
    expect(classifySkipUrl("HTTPS://WWW.FACEBOOK.COM/Dealer")).toBe("social_media");
    expect(classifySkipUrl("https://WwW.tustinhyundai.com/")).toBe("bare_homepage");
  });

  it("empty / unparseable input → null (keep, best-effort)", () => {
    expect(classifySkipUrl("")).toBeNull();
    expect(classifySkipUrl("   ")).toBeNull();
    expect(classifySkipUrl("not a url at all")).toBeNull();
    // scheme-less host-less fragments only have path rules to match.
    expect(classifySkipUrl("dealer.com/unsubscribe")).toBe("unsubscribe");
  });
});

describe("filterForProfile — accept exact|near, reject with typed reasons", () => {
  const r = (matchStatus: "exact" | "near" | "mismatch" | "unknown", id: number) => ({
    matchStatus,
    id,
  });

  it("accepts exact and near; rejects mismatch/unknown with the right reason", () => {
    const rows = [r("exact", 1), r("near", 2), r("mismatch", 3), r("unknown", 4)];
    const result = filterForProfile(rows);
    expect(result.accepted.map((x) => x.id)).toEqual([1, 2]);
    expect(result.rejected).toEqual([
      { row: rows[2], reason: "trim_or_year_mismatch" },
      { row: rows[3], reason: "identity_missing" },
    ]);
  });

  it("empty input → empty result", () => {
    expect(filterForProfile([])).toEqual({ accepted: [], rejected: [] });
  });
});
