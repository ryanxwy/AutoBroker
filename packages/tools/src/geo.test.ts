/**
 * Unit tests for `isUsDealer` — the single decision point for US-only
 * enforcement. Both the geosearch upsert path and every browser-touching
 * skill route through it.
 */

import { describe, expect, it } from "vitest";
import { isUsDealer } from "./geo.js";

describe("TestCountryExplicit", () => {
  it("test_us_returns_true", () => {
    expect(isUsDealer({ country: "US" })).toBe(true);
  });

  it("test_us_case_insensitive", () => {
    expect(isUsDealer({ country: "us" })).toBe(true);
    expect(isUsDealer({ country: " Us " })).toBe(true);
  });

  it("test_ca_returns_false", () => {
    expect(isUsDealer({ country: "CA" })).toBe(false);
  });

  it("test_mx_returns_false", () => {
    expect(isUsDealer({ country: "MX" })).toBe(false);
  });

  it("test_explicit_country_overrides_us_signals", () => {
    // A .ca TLD + Canadian province don't matter if country is
    // explicitly 'US' (e.g. a Hawaii dealer with a weird URL).
    expect(
      isUsDealer({
        country: "US",
        website: "https://example.ca",
        state: "BC",
      }),
    ).toBe(true);
  });

  it("test_explicit_country_overrides_non_us_signals", () => {
    // And the converse: a .com TLD doesn't save a row whose
    // country was set to CA by the upsert.
    expect(isUsDealer({ country: "CA", website: "https://example.com" })).toBe(
      false,
    );
  });

  it("test_empty_country_falls_through", () => {
    // Empty string should not be treated as authoritative — fall
    // through to the other signals.
    expect(isUsDealer({ country: "", website: "https://x.com" })).toBe(true);
    expect(isUsDealer({ country: "   ", website: "https://x.ca" })).toBe(false);
  });
});

describe("TestWebsiteTLD", () => {
  it("test_dotca_returns_false", () => {
    expect(isUsDealer({ country: null, website: "https://example.ca" })).toBe(
      false,
    );
  });

  it("test_dotca_with_path_returns_false", () => {
    expect(
      isUsDealer({
        country: null,
        website: "https://example.ca/inventory",
      }),
    ).toBe(false);
  });

  it("test_dotmx_returns_false", () => {
    expect(isUsDealer({ country: null, website: "https://example.mx" })).toBe(
      false,
    );
  });

  it("test_dotcom_returns_true", () => {
    expect(isUsDealer({ country: null, website: "https://example.com" })).toBe(
      true,
    );
  });

  it("test_bare_hostname_no_scheme", () => {
    // Real DB rows often skip the scheme.
    expect(isUsDealer({ country: null, website: "example.ca" })).toBe(false);
    expect(isUsDealer({ country: null, website: "example.com" })).toBe(true);
  });

  it("test_missing_website_falls_through", () => {
    // No website + no other signals → default-trust true.
    expect(isUsDealer({ country: null, website: null })).toBe(true);
  });

  it("test_empty_website_falls_through", () => {
    expect(isUsDealer({ country: null, website: "" })).toBe(true);
    expect(isUsDealer({ country: null, website: "   " })).toBe(true);
  });
});

describe("TestStateCode", () => {
  it("test_canadian_province_returns_false", () => {
    for (const province of ["BC", "AB", "ON", "QC", "NS"]) {
      expect(isUsDealer({ country: null, state: province }), province).toBe(
        false,
      );
    }
  });

  it("test_us_state_returns_true", () => {
    for (const state of ["WA", "TX", "FL", "DC", "PR"]) {
      expect(isUsDealer({ country: null, state }), state).toBe(true);
    }
  });

  it("test_california_state_is_us_not_canada", () => {
    // 'CA' is the California state code (US), NOT the ISO country
    // code for Canada — the helper looks it up against the US
    // state allowlist and resolves it correctly.
    expect(isUsDealer({ country: null, state: "CA" })).toBe(true);
  });

  it("test_state_case_insensitive", () => {
    expect(isUsDealer({ country: null, state: "bc" })).toBe(false);
    expect(isUsDealer({ country: null, state: "wa" })).toBe(true);
  });
});

describe("TestPostalCode", () => {
  it("test_canadian_postal_returns_false", () => {
    // A1A 1A1 with the space.
    expect(isUsDealer({ country: null, postal_code: "V5T 0H8" })).toBe(false);
  });

  it("test_canadian_postal_no_space_returns_false", () => {
    expect(isUsDealer({ country: null, postal_code: "V5T0H8" })).toBe(false);
  });

  it("test_canadian_postal_hyphen_returns_false", () => {
    expect(isUsDealer({ country: null, postal_code: "V5T-0H8" })).toBe(false);
  });

  it("test_us_zip_returns_true", () => {
    expect(isUsDealer({ country: null, postal_code: "98011" })).toBe(true);
  });

  it("test_us_zip_plus_four_returns_true", () => {
    // Default-trust: 9-digit ZIPs don't match Canadian shape, so
    // they fall through to the true default.
    expect(isUsDealer({ country: null, postal_code: "98011-1234" })).toBe(
      true,
    );
  });

  it("test_empty_postal_falls_through", () => {
    expect(isUsDealer({ country: null, postal_code: "" })).toBe(true);
    expect(isUsDealer({ country: null, postal_code: null })).toBe(true);
  });
});

describe("TestDefaults", () => {
  it("test_all_none_returns_true", () => {
    // Conservative default — see the module doc comment.
    expect(isUsDealer()).toBe(true);
  });

  it("test_no_arguments_returns_true", () => {
    expect(
      isUsDealer({ country: null, website: null, state: null, postal_code: null }),
    ).toBe(true);
  });
});

// Rule 5 — unambiguous Canadian city tokens in `name` or `city`.
describe("TestNameCityHeuristic", () => {
  it("test_name_chilliwack_returns_false", () => {
    // End-of-name token, no other CA signal.
    expect(
      isUsDealer({
        country: null,
        website: "https://bannisterkia.com/",
        name: "Bannister Kia Chilliwack",
      }),
    ).toBe(false);
  });

  it("test_name_chilliwack_at_start", () => {
    expect(
      isUsDealer({
        country: null,
        website: "https://chilliwackford.com/",
        name: "Chilliwack Ford",
      }),
    ).toBe(false);
  });

  it("test_name_coquitlam_returns_false", () => {
    expect(
      isUsDealer({ country: null, name: "Jim Pattison Subaru Coquitlam" }),
    ).toBe(false);
  });

  it("test_name_abbotsford_returns_false", () => {
    expect(isUsDealer({ country: null, name: "Murray Kia Abbotsford" })).toBe(
      false,
    );
  });

  it("test_name_langley_mid_returns_false", () => {
    // Token in the middle, surrounded by spaces.
    expect(isUsDealer({ country: null, name: "Go Langley Subaru" })).toBe(
      false,
    );
  });

  it("test_name_surrey_returns_false", () => {
    expect(isUsDealer({ country: null, name: "Applewood Kia Surrey" })).toBe(
      false,
    );
  });

  it("test_city_column_returns_false", () => {
    // `city` filled (rare today but supported).
    expect(isUsDealer({ country: null, city: "Coquitlam" })).toBe(false);
  });

  it("test_city_case_insensitive", () => {
    expect(isUsDealer({ country: null, name: "chilliwack auto" })).toBe(false);
    expect(isUsDealer({ country: null, city: "CHILLIWACK" })).toBe(false);
  });

  it("test_ambiguous_vancouver_does_not_trigger", () => {
    // Vancouver collides with Vancouver WA — must NOT trigger CA
    // via the name heuristic alone. Default-trust true.
    expect(
      isUsDealer({ country: null, name: "Kendall Ford of Vancouver" }),
    ).toBe(true);
  });

  it("test_ambiguous_richmond_does_not_trigger", () => {
    // Richmond is a major US city (VA, KY, IN, ...).
    expect(isUsDealer({ country: null, name: "Go Richmond Subaru" })).toBe(
      true,
    );
  });

  it("test_ambiguous_victoria_does_not_trigger", () => {
    // Victoria collides with Victoria TX (Mike Shaw Kia, etc.).
    expect(
      isUsDealer({ country: null, name: "Jim Pattison Subaru Victoria" }),
    ).toBe(true);
  });

  it("test_token_inside_word_does_not_trigger", () => {
    // Word-boundary guard: `Anglerfish` contains `angler` not
    // `langley` — but constructed adversarial cases like
    // `Slangleyfish` must not falsely match `Langley`.
    expect(isUsDealer({ country: null, name: "Slangleyfish Motors" })).toBe(
      true,
    );
    // `Surreyville` should not match `Surrey`.
    expect(isUsDealer({ country: null, name: "Surreyville Auto" })).toBe(true);
  });

  it("test_token_with_comma_matches", () => {
    // `Toronto, ON` shape that may appear in scraped names.
    expect(
      isUsDealer({ country: null, name: "Acme Subaru of Toronto, ON" }),
    ).toBe(false);
  });

  it("test_explicit_us_country_overrides_name_heuristic", () => {
    // If a human marked the row 'US', the name heuristic must not
    // override (e.g. a US dealer named after a Canadian acquisition).
    expect(isUsDealer({ country: "US", name: "Bannister Kia Chilliwack" })).toBe(
      true,
    );
  });
});

// Rule 5 — unambiguous Mexican border-city tokens / trailing ", Mexico" word.
describe("TestMexicoHeuristic", () => {
  it("test_name_tijuana_returns_false", () => {
    // The live San Diego case: a Mexican border dealer with a .com site and no
    // country/state — caught only by the name token.
    expect(
      isUsDealer({
        country: null,
        website: "https://hyundaipremiertijuana.com",
        name: "Hyundai Premier Tijuana",
      }),
    ).toBe(false);
  });

  it("test_address_mexico_country_word_returns_false", () => {
    // Name carries no city, but the address ends in the country word.
    expect(
      isUsDealer({
        country: null,
        name: "Hyundai Premier",
        address: "Blvd. Insurgentes 1810, Tijuana, B.C., México",
      }),
    ).toBe(false);
  });

  it("test_multiword_border_city_in_name", () => {
    expect(isUsDealer({ country: null, name: "Toyota Ciudad Juarez" })).toBe(false);
  });

  it("test_nuevo_laredo_returns_false_but_laredo_tx_stays_us", () => {
    // "Nuevo Laredo" (MX) is unambiguous; bare "Laredo" (Laredo TX) must NOT match.
    expect(isUsDealer({ country: null, name: "Honda Nuevo Laredo" })).toBe(false);
    expect(isUsDealer({ country: null, name: "Laredo Toyota", state: "TX" })).toBe(true);
  });

  it("test_new_mexico_address_stays_us", () => {
    // "New Mexico" must NOT trip the country-word check (token before "Mexico"
    // is "New", not a comma).
    expect(
      isUsDealer({ country: null, address: "1 New Mexico Ave, Las Cruces, NM 88001" }),
    ).toBe(true);
  });

  it("test_mexico_missouri_town_stays_us", () => {
    // Mexico, MO is a real US town; its address ends in the US state/ZIP, not
    // ", Mexico", and bare "Mexico" is not a city token.
    expect(
      isUsDealer({ country: null, name: "Mexico Motors", address: "123 Main St, Mexico, MO 65265" }),
    ).toBe(true);
  });

  it("test_nogales_az_stays_us", () => {
    // Bare "Nogales" is omitted from the token list (Nogales AZ is US).
    expect(isUsDealer({ country: null, name: "Nogales Ford", state: "AZ" })).toBe(true);
  });

  it("test_token_inside_word_does_not_trigger", () => {
    // Word-boundary guard: "Tijuanaesque Motors" must not match "Tijuana".
    expect(isUsDealer({ country: null, name: "Tijuanaesque Motors" })).toBe(true);
  });

  it("test_us_dealer_with_mexican_street_name_stays_us", () => {
    // City tokens are NOT scanned in the free-form address: a US dealer on a
    // Spanish-named street (Ensenada Dr, Matamoros St — real US streets) must
    // not be dropped. Only name/city tokens + the anchored country word apply.
    expect(
      isUsDealer({ country: null, name: "San Diego Hyundai", address: "1234 Ensenada Dr, San Diego, CA 92101" }),
    ).toBe(true);
    expect(
      isUsDealer({ country: null, name: "Alamo Toyota", address: "501 Matamoros St, San Antonio, TX 78207" }),
    ).toBe(true);
  });

  it("test_explicit_us_country_overrides_mexican_name", () => {
    expect(isUsDealer({ country: "US", name: "Hyundai Premier Tijuana" })).toBe(true);
  });
});

describe("TestCombinedSignals", () => {
  it("test_canadian_dealer_full_signals", () => {
    // A realistic Canadian Kia dealer: .ca TLD, BC state, V-prefix
    // postal. All three signals point the same way.
    expect(
      isUsDealer({
        country: null,
        website: "https://kiavancouver.ca",
        state: "BC",
        postal_code: "V5T 0H8",
      }),
    ).toBe(false);
  });

  it("test_us_dealer_sparse_signals", () => {
    // Most existing rows have empty state + postal — they should
    // ride the .com signal + default-trust through to true.
    expect(
      isUsDealer({
        country: null,
        website: "https://seattlehyundai.com",
        state: null,
        postal_code: null,
      }),
    ).toBe(true);
  });
});
