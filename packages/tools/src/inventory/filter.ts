/**
 * Inventory filter pre-screen — the deterministic data behind the 3-rung
 * filter ladder the scan workflow walks per dealer:
 *
 *   rung i   `buildFilteredSrpUrl` — pure per-platform URL templates (zero
 *            interaction, preferred);
 *   rung ii  `FILTER_SELECTOR_MAP` — per-platform widget selectors driven
 *            through the browser session's allowlisted filter verbs
 *            (setFilterSelect / tickFilterCheckbox / clickFilterApply);
 *   rung iii fall back to the UNFILTERED SRP — the floor; a dealer can never
 *            do worse than the unfiltered scan.
 *
 * Mapped fields are make/model + condition=new + year where the platform
 * supports them — and NOTHING else:
 *   - trim NEVER goes into a URL or a widget (trim matching is
 *     `classifyMatchStatus`, deterministic code over captured rows);
 *   - price/budget params are EXCLUDED unconditionally — URL params and
 *     filter submissions land in dealer server logs, and the budget never
 *     leaves the machine.
 *
 * Everything here is v1-deterministic: a lookup table for exactly the four
 * fingerprinted platforms plus a passthrough default. No LLM is involved in
 * filtering.
 */

import type { DealerPlatform } from "../inventoryScout.js";

/** The narrow profile slice filtering may see. Budget/trim are structurally
 *  absent — they cannot be passed, let alone leaked. */
export interface FilterProfileSlice {
  make: string;
  model: string;
  year: number | null;
}

/** One platform's query-param template (rung i). `condition` is an extra
 *  fixed pair for platforms that need it spelled out; null when the canned
 *  new-inventory SRP path already encodes condition=new. */
interface SrpParamTemplate {
  makeParam: string;
  modelParam: string;
  /** null = platform has no reliable year param — year is left to rung ii
   *  widgets or code-side classification. */
  yearParam: string | null;
  conditionPair: readonly [param: string, value: string] | null;
}

/**
 * Per-platform URL templates. Param conventions per platform (the canned SRP
 * paths these apply to are all new-inventory pages, so condition=new is
 * path-encoded unless noted):
 *   - dealercom      → ?make=Hyundai&model=Tucson&year=2026
 *   - dealerinspire  → ?_dFR[make][0]=Hyundai&_dFR[model][0]=Tucson
 *                       &_dFR[year][0]=2026&_dFR[type][0]=New
 *                      (facet-refinement params; type=New spelled out because
 *                      the facet engine treats the path and facets separately)
 *   - dealeron_v1    → ?Make=Hyundai&Model=Tucson&Year=2026 (often a JS-only
 *                      skeleton SRP — rung ii is the expected workhorse here;
 *                      the template still goes first because rung i is free)
 *   - dealerfire     → ?make=Hyundai&model=Tucson&year=2026
 * These are best-known seeds: the live step-⑤ calibration measures each
 * platform's rung-i hit rate (a filtered URL that renders back the unfiltered
 * page demotes that dealer to rung ii at runtime, not here).
 */
const SRP_PARAM_TEMPLATES: Readonly<
  Record<Exclude<DealerPlatform, "default">, SrpParamTemplate>
> = {
  dealercom: {
    makeParam: "make",
    modelParam: "model",
    yearParam: "year",
    conditionPair: null,
  },
  dealerinspire: {
    makeParam: "_dFR[make][0]",
    modelParam: "_dFR[model][0]",
    yearParam: "_dFR[year][0]",
    conditionPair: ["_dFR[type][0]", "New"],
  },
  dealeron_v1: {
    makeParam: "Make",
    modelParam: "Model",
    yearParam: "Year",
    conditionPair: null,
  },
  dealerfire: {
    makeParam: "make",
    modelParam: "model",
    yearParam: "year",
    conditionPair: null,
  },
};

/**
 * Rung i: derive the platform's filtered SRP URL from the probed-live SRP URL
 * and the profile's make/model/year. Pure.
 *
 *   - "default" (or an unparseable srpUrl) → passthrough UNCHANGED: the
 *     workflow scans the unfiltered SRP exactly as before;
 *   - fingerprinted platform → the template's params are set on the SRP URL
 *     (overwriting any same-named param), everything else preserved.
 *
 * The caller must re-probe the returned URL for a fresh 200 and verify it did
 * not render back the unfiltered page before trusting it.
 */
export function buildFilteredSrpUrl(
  platform: DealerPlatform,
  srpUrl: string,
  profile: FilterProfileSlice,
): string {
  if (platform === "default") return srpUrl;
  let url: URL;
  try {
    url = new URL(srpUrl);
  } catch {
    return srpUrl; // not a parseable absolute URL — leave it to rung iii
  }
  const t = SRP_PARAM_TEMPLATES[platform];
  url.searchParams.set(t.makeParam, profile.make);
  url.searchParams.set(t.modelParam, profile.model);
  if (t.yearParam !== null && profile.year !== null) {
    url.searchParams.set(t.yearParam, String(profile.year));
  }
  if (t.conditionPair !== null) {
    url.searchParams.set(t.conditionPair[0], t.conditionPair[1]);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Rung ii: per-platform filter widget selector map (pure data).
// ---------------------------------------------------------------------------

/** Selectors for one platform's on-page filter widgets. All nullable: null
 *  means "this platform has no known widget for the field" and the workflow
 *  simply skips that field (or the whole rung when make/model are null). */
export interface PlatformFilterSelectors {
  /** Filter-rail container; when present the workflow scopes every widget
   *  lookup inside it (`${region} ${widget}`) — lead-capture CTAs live in the
   *  results grid, outside this region, so scoping is the cheap first fence
   *  before the verbs' own denylist/structure checks. */
  region: string | null;
  make: string | null;
  model: string | null;
  /** Year select where the platform exposes one (condition=new is the canned
   *  SRP path on every fingerprinted platform — no condition widget needed). */
  year: string | null;
  /** Apply/Update-Results button, or null = auto-apply platform (facet change
   *  re-queries on its own; the workflow just settles and re-reads page.url()
   *  as the canonical filtered URL). */
  applyButton: string | null;
}

/**
 * The 4-fingerprint selector table. SEED VALUES: name-based selects are the
 * cross-site convention on these platforms, and the fingerprinted majors are
 * auto-apply facet engines (no Apply button), but each entry is expected to
 * be calibrated against live step-⑤ runs — a missing/wrong selector is safe
 * by construction (the verb fails loudly and the workflow falls back to the
 * unfiltered SRP, rung iii).
 *
 * "default" is deliberately ABSENT: an unfingerprinted platform has no
 * entry → the workflow goes straight to rung iii.
 */
export const FILTER_SELECTOR_MAP: Readonly<
  Partial<Record<DealerPlatform, PlatformFilterSelectors>>
> = {
  dealercom: {
    region: ".facets, [data-widget-name='inventory-listing-facets']",
    make: "select[name='make' i]",
    model: "select[name='model' i]",
    year: "select[name='year' i]",
    applyButton: null,
  },
  dealerinspire: {
    region: ".facet-list, #facets",
    make: "select[name='make' i]",
    model: "select[name='model' i]",
    year: null,
    applyButton: null,
  },
  dealeron_v1: {
    region: ".search-facets, #search-refine",
    make: "select[name='make' i]",
    model: "select[name='model' i]",
    year: "select[name='year' i]",
    applyButton: null,
  },
  dealerfire: {
    region: ".inventory-filters, #refine-search",
    make: "select[name='make' i]",
    model: "select[name='model' i]",
    year: "select[name='year' i]",
    applyButton: null,
  },
};
