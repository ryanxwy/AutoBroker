/**
 * geo — US-only geography classification. PURE: no SQLite, no network, no LLM.
 * Ported from the legacy Python implementation.
 *
 * AutoBroker operates only on US dealerships. `isUsDealer` is the single
 * decision point that browser-using skills consult before walking a dealer
 * site, submitting a lead form, or scraping incentives. The dealer_geosearch
 * upsert path also calls it so the data layer cannot carry non-US dealers
 * regardless of which skill discovered them.
 *
 * Order of precedence (first signal wins):
 *
 * 1. Explicit `country` — 'US' → true, any other non-empty value → false.
 *    Empty/whitespace-only country is not authoritative and falls through.
 * 2. Domain TLD on `website` — `.ca` / `.mx` / a small set of other non-US
 *    TLDs → false.
 * 3. Canadian-province state code → false; a clean US state code → true.
 * 4. Canadian postal-code format (`A1A 1A1`) → false.
 * 5. `city` or dealer `name` containing an unambiguous Canadian city token
 *    (e.g. Chilliwack, Coquitlam, Abbotsford) → false. The token list is
 *    hand-curated to avoid collisions with US cities that share the spelling
 *    (Vancouver WA, Richmond VA, Victoria TX are NOT on the list). This
 *    catches the long-tail of `.com` dealerships in BC/AB/ON whose other
 *    fields are sparse.
 * 6. Anything else (including all-null inputs) → true. This is the
 *    conservative default because the `country` column defaults to 'US' and
 *    we never want to silently drop a US dealer with sparse metadata.
 */

// Allowlist: 50 states + DC + 5 inhabited territories. The dealers.state
// column carries these as 2-letter codes when set.
const US_STATES: ReadonlySet<string> = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

// 13 Canadian provinces + territories.
const CANADIAN_PROVINCES: ReadonlySet<string> = new Set([
  "BC", "AB", "SK", "MB", "ON", "QC", "NB", "NS", "PE", "NL",
  "NT", "YT", "NU",
]);

// Non-US TLD suffixes we positively recognise. `.ca` / `.mx` cover the only
// neighbours AutoBroker has actually surfaced in the wild; the rest exist so
// a copy-pasted overseas dealer URL is also caught. Extend on demand —
// adding a TLD here is the cheap path to rejecting a new country at the
// data seam.
const NON_US_TLDS: ReadonlySet<string> = new Set([
  "ca", "mx", "au", "uk", "de", "fr", "it", "es", "jp", "kr", "cn",
]);

// Canadian postal-code shape: `A1A 1A1` (optional space). We accept any
// whitespace and an optional hyphen because real data is messy.
const CANADIAN_POSTAL_RE = /^[A-Z]\d[A-Z][\s-]?\d[A-Z]\d$/i;

// Unambiguous Canadian city tokens — present in dealer names or the `city`
// column. Curated to avoid collision with US cities of the same spelling:
// Vancouver (WA), Richmond (VA/KY/etc.), Victoria (TX), London (OH),
// Hamilton (OH/NJ), Cambridge (MA), Kingston (NY), Windsor (CT) are
// deliberately omitted. Order doesn't matter — we match the whole list each
// call.
const CANADIAN_CITY_TOKENS: readonly string[] = [
  // British Columbia
  "chilliwack", "coquitlam", "abbotsford", "burnaby", "langley",
  "surrey", "kelowna", "kamloops", "nanaimo", "squamish",
  "whistler",
  // Alberta
  "calgary", "edmonton", "lethbridge",
  // Saskatchewan
  "saskatoon", "regina",
  // Manitoba
  "winnipeg",
  // Ontario
  "toronto", "ottawa", "mississauga", "brampton", "etobicoke",
  "scarborough", "markham", "vaughan", "oakville",
  // Quebec
  "montreal", "laval",
  // Nova Scotia
  "halifax",
];

// Pattern matches a city token surrounded by non-letter boundaries so
// `Chilliwack` matches in `Bannister Kia Chilliwack` but `langley` does NOT
// match inside `Anglerfish Motors`. We build one alternation regex up-front
// because this is the hot path on the geosearch upsert. (No `g` flag — a
// sticky lastIndex would make repeated `.test()` calls stateful.)
const CANADIAN_CITY_RE = new RegExp(
  "(?:^|[^A-Za-z])(" +
    [...CANADIAN_CITY_TOKENS].sort().join("|") +
    ")(?:[^A-Za-z]|$)",
  "i",
);

/** Return true iff `text` contains an unambiguous Canadian city token. */
function containsCanadianCity(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  return CANADIAN_CITY_RE.test(text);
}

/**
 * Return the last DNS label of `website`'s hostname, lowercased.
 *
 * `null` when the URL has no parseable hostname.
 */
function websiteTld(website: string | null | undefined): string | null {
  if (!website) {
    return null;
  }
  let candidate = website.trim();
  if (!candidate) {
    return null;
  }
  // Tolerate bare hostnames (`examplemotors.ca`) without a scheme.
  if (!candidate.includes("://")) {
    candidate = "http://" + candidate;
  }
  let host: string;
  try {
    host = new URL(candidate).hostname;
  } catch {
    return null;
  }
  if (!host) {
    return null;
  }
  host = host.toLowerCase().replace(/\.+$/, "");
  if (!host.includes(".")) {
    return null;
  }
  return host.slice(host.lastIndexOf(".") + 1);
}

/** Inputs to `isUsDealer`; any field may be null/undefined. */
export interface IsUsDealerOptions {
  country?: string | null;
  website?: string | null;
  state?: string | null;
  postal_code?: string | null;
  name?: string | null;
  city?: string | null;
}

/**
 * Return true iff the dealer appears to be in the United States.
 *
 * See the module doc comment for the precedence rules. All six fields are
 * optional and any may be null.
 */
export function isUsDealer(options: IsUsDealerOptions = {}): boolean {
  const { country, website, state, postal_code, name, city } = options;

  // 1. Explicit country wins outright.
  if (country != null) {
    const normalized = country.trim().toUpperCase();
    if (normalized) {
      return normalized === "US";
    }
  }

  // 2. TLD on the website.
  const tld = websiteTld(website);
  if (tld !== null && NON_US_TLDS.has(tld)) {
    return false;
  }

  // 3. State code. NOTE: 'CA' here is the California state code (US), not
  //    the ISO country code for Canada — country-vs-state disambiguation
  //    already happened in rule 1.
  if (state != null) {
    const stateNorm = state.trim().toUpperCase();
    if (CANADIAN_PROVINCES.has(stateNorm)) {
      return false;
    }
    // If state is a clean US code we already know the answer; fall through
    // otherwise so signals 1-2 / 4-5 keep their precedence.
    if (US_STATES.has(stateNorm)) {
      return true;
    }
  }

  // 4. Canadian postal code shape.
  if (postal_code != null) {
    const pc = postal_code.trim();
    if (pc && CANADIAN_POSTAL_RE.test(pc)) {
      return false;
    }
  }

  // 5. Unambiguous Canadian city token in `city` or dealer `name`.
  //    Anything that doesn't match falls through to default-trust (rule 6).
  return !(containsCanadianCity(city) || containsCanadianCity(name));
}
