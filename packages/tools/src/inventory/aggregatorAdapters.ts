/**
 * aggregatorAdapters — the static, positive-allowlist registry of new-car
 * AGGREGATOR shopping sites the read-only aggregator scan searches, one SRP page
 * load per site. Each adapter is a compile-time constant: its robots posture, its
 * pure `buildSrpUrl` template, and a SELF-CONTAINED `collect` function run inside
 * the page via page.evaluate. Adding or removing a site is a deliberate code
 * change here — never widened from anything observed at runtime (the
 * TRUSTED_TRIM_HOSTS positive-allowlist stance).
 *
 * Registry ORDER is the cross-site dedup priority: [cars.com, visor.vin, edmunds].
 * iSeeCars is intentionally absent (its search path renders used cars for a
 * new-inventory request and carries no per-tile seller channel, so no adapter
 * lands for it).
 *
 * `robotsDisallowed` is a hard-coded per-adapter constant (recorded downstream,
 * never derived from a live robots fetch — a literal-prefix robots matcher cannot
 * see a wildcard SRP rule and would report false): cars.com and Edmunds Disallow
 * their SRP paths for generic crawlers (`true`); visor.vin's robots.txt reads
 * "Allow: /" (`false`, read in-browser 2026-07-09).
 */

/**
 * The closed profile slice a filter submission may ever see. Budget, trim, email,
 * and phone are STRUCTURALLY ABSENT — they cannot be passed here, let alone leaked:
 * every filter submission lands in a third-party aggregator's server logs. `zip` is
 * the one deliberate location disclosure the feature genuinely needs to search near
 * the buyer; it is the only widening over an on-dealer-site filter slice, named here.
 */
export interface AggregatorFilterSlice {
  make: string;
  model: string;
  year: number;
  zip: string;
  radiusMiles: number;
}

/**
 * What one adapter's in-page `collect` returns — a two-arm discriminated union:
 *   - `kind: "cards"` (cars.com, Edmunds): a card+scalar-per-tile LLM-extraction feed.
 *     `cards[]`: one {text, href} per real vehicle tile, index-aligned with `scalars`.
 *     `text` is the flattened tile copy the extractor reads; `href` is the tile's
 *     own vehicle-detail URL (absolute), or "" when the tile exposes none.
 *     `scalars[]`: the deterministic per-tile facts read straight from the site's
 *     embedded state (never the LLM): the tile's VIN and, where the site carries it
 *     in structured data, the dealer name. Joined to extracted rows post-emit.
 *     `appliedLocation`: the most precise applied-search-location signal the page
 *     exposes (a ZIP when available, else a human-readable location line), or null.
 *     The workflow compares it to the requested ZIP to catch a site that silently
 *     ignored the location and searched a different metro.
 *   - `kind: "rows"` (visor.vin): a pre-structured, deterministic row feed — no LLM
 *     extraction step reads these. `probe` records how the in-page react-query cache
 *     walk went (each step is guarded; a false flag pinpoints where a drifted page
 *     stopped yielding data). `rows` are pruned page rows, untrusted until Zod
 *     validates them (see visorMap.ts). `challenge` records Cloudflare Turnstile
 *     markers seen on the page. `echo` is what the page's OWN listings query
 *     actually searched (zip/radius/year), read back for the location-echo gate.
 */
export interface AggregatorCollectedCards {
  kind: "cards";
  cards: { text: string; href: string }[];
  scalars: { vin: string; dealerName: string | null }[];
  appliedLocation: string | null;
}
export interface AggregatorCollectedRows {
  kind: "rows";
  probe: {
    routerFound: boolean;
    queryClientFound: boolean;
    listingsQueryFound: boolean;
    queryStatus: string | null;
    total: number | null;
  };
  /** Pruned page rows — untrusted until Zod (visorMap.ts) validates them. */
  rows: unknown[];
  challenge: { cfIframe: boolean; cfInput: boolean; interstitial: boolean };
  /** What the page's own listings query ACTUALLY searched (echo-gate input). */
  echo: { zip: string | null; radiusMiles: number | null; year: number | null } | null;
}
export type AggregatorCollected = AggregatorCollectedCards | AggregatorCollectedRows;

/** One aggregator site. `collect` MUST be a self-contained serializable function
 *  (it runs inside the page via page.evaluate; module-scope references do not
 *  exist after serialization). */
export interface AggregatorAdapter {
  siteId: "cars_com" | "edmunds" | "visor_vin";
  host: string;
  label: string;
  robotsDisallowed: boolean;
  /** Compile-time session posture: a `resolvePersistentProfileDir` key when this
   *  site needs a warmed, challenge-cleared browser profile to load reliably, else
   *  null. Per-site, not global — evidence-backed per adapter (see registry). */
  persistentProfileKey: string | null;
  buildSrpUrl(slice: AggregatorFilterSlice): string;
  collect: () => AggregatorCollected;
}

// ---------------------------------------------------------------------------
// Pure slug + URL builders (unit-testable outside the browser).
// ---------------------------------------------------------------------------

/** Cars.com slug: lowercase, every non-alphanumeric run collapsed to a single
 *  `_` (honda, cr_v, f_150, gt_r, grand_highlander). */
function carsComSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Cars.com `models[]` param value: `{makeSlug}-{modelSlug}` (e.g. "honda-cr_v"). */
export function slugifyCarsComModel(make: string, model: string): string {
  return `${carsComSlug(make)}-${carsComSlug(model)}`;
}

/** Build the Cars.com new-inventory SRP URL from the closed slice. Bracketed array
 *  params are percent-encoded (makes%5B%5D) as the site expects. Carries make,
 *  model, zip, radius, and an exact year window — never price/budget/trim. */
export function buildCarsComUrl(slice: AggregatorFilterSlice): string {
  const params = new URLSearchParams();
  params.set("stock_type", "new");
  params.append("makes[]", carsComSlug(slice.make));
  params.append("models[]", slugifyCarsComModel(slice.make, slice.model));
  params.set("zip", slice.zip);
  params.set("maximum_distance", String(slice.radiusMiles));
  params.set("year_min", String(slice.year));
  params.set("year_max", String(slice.year));
  return `https://www.cars.com/shopping/results/?${params.toString()}`;
}

/** Edmunds slug: lowercase, every non-alphanumeric run collapsed to a single `-`
 *  (honda, cr-v, f-150). */
function edmundsSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build the Edmunds new-inventory SRP URL from the closed slice. `model` is the
 *  `make|model` pipe form (percent-encoded %7C); there is no year param — year is
 *  post-filtered downstream. Never price/budget/trim. */
export function buildEdmundsUrl(slice: AggregatorFilterSlice): string {
  const make = edmundsSlug(slice.make);
  const model = edmundsSlug(slice.model);
  const params = new URLSearchParams();
  params.set("inventorytype", "new");
  params.set("make", make);
  params.set("model", `${make}|${model}`);
  params.set("radius", String(slice.radiusMiles));
  params.set("zip", slice.zip);
  return `https://www.edmunds.com/inventory/srp.html?${params.toString()}`;
}

/** visor.vin indexes the live-proven "Tucson Hybrid" vocabulary as the base
 * model plus `fuel_type=Hybrid`. This is intentionally narrow: no other
 * powertrain taxonomy is assumed without a captured visor result. */
function splitVisorModelFuelType(model: string): { model: string; fuelType: string | null } {
  const suffix = "Hybrid";
  if (!model.toLowerCase().endsWith(` ${suffix.toLowerCase()}`)) {
    return { model, fuelType: null };
  }
  const baseModel = model.slice(0, -suffix.length).trim();
  return baseModel === "" ? { model, fuelType: null } : { model: baseModel, fuelType: suffix };
}

/** Build the visor.vin new-inventory SRP URL from the closed slice, matching the
 *  site's OWN UI URL shape: the string-typed search params (`year`,
 *  `geo_origin_value`, `geo_distance_value`) are JSON-quoted literal strings (e.g.
 *  `year=%222026%22`) the way the site's own filter UI emits them.
 *  NO trim param, NO state param — trim never reaches a URL (existing red line);
 *  visor's own trim vocabulary is coarse and this dodges that risk entirely. */
export function buildVisorUrl(slice: AggregatorFilterSlice): string {
  const visorModel = splitVisorModelFuelType(slice.model);
  const params = new URLSearchParams();
  params.set("make", slice.make);
  params.set("model", visorModel.model);
  if (visorModel.fuelType !== null) params.set("fuel_type", visorModel.fuelType);
  params.set("car_type", "new");
  params.set("year", JSON.stringify(String(slice.year)));
  params.set("geo_origin_kind", "postal_code");
  params.set("geo_origin_value", JSON.stringify(slice.zip));
  params.set("geo_mode", "radius");
  params.set("geo_distance_value", JSON.stringify(String(slice.radiusMiles)));
  params.set("geo_distance_unit", "mi");
  return `https://visor.vin/search/listings?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Pure Cars.com JSON helpers (unit-tested). The cars.com collect() below inlines
// COPIES of these — keep the two in sync (page.evaluate serialization forbids a
// module-scope reference).
// ---------------------------------------------------------------------------

/** Flatten a Cars.com listing's nested `body` component tree into a single
 *  " · "-joined line of its visible text snippets (title, price, MSRP, dealer
 *  name, listing location, …). Walks only the `items` tree and reads each node's
 *  displayed text (`text_snippets[].text`, DatumIcon `name`/`value`, `label`),
 *  so off-screen popover/disclaimer prose never bleeds in. Deduped, order-preserving.
 *  Pure. */
export function flattenCarsComBody(listing: unknown): string {
  const acc: string[] = [];
  const seen = new Set<string>();
  const push = (s: unknown): void => {
    if (typeof s !== "string") return;
    const t = s.replace(/\s+/g, " ").trim();
    if (t === "" || seen.has(t)) return;
    seen.add(t);
    acc.push(t);
  };
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.text_snippets)) {
      for (const sn of rec.text_snippets) {
        if (sn !== null && typeof sn === "object") push((sn as Record<string, unknown>).text);
      }
    }
    push(rec.name);
    push(rec.value);
    push(rec.label);
    if (Array.isArray(rec.items)) for (const x of rec.items) walk(x);
  };
  const body =
    listing !== null && typeof listing === "object"
      ? (listing as Record<string, unknown>).body
      : undefined;
  walk(body);
  return acc.join(" · ");
}

/** The VIN for a Cars.com listing: the first 17-char VIN-charset run over the
 *  listing's serialized blob that is NOT all-digits (VINs live in a serialized
 *  analytics blob inside the listing; pure-digit runs are ids/timestamps). Null
 *  when none. Pure. */
export function extractVinFromListingBlob(listing: unknown): string | null {
  let blob: string;
  try {
    blob = JSON.stringify(listing);
  } catch {
    return null;
  }
  if (typeof blob !== "string") return null;
  const re = /[A-HJ-NPR-Z0-9]{17}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob)) !== null) {
    const c = m[0];
    if (!/^[0-9]{17}$/.test(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Self-contained in-page collectors (run via page.evaluate).
// ---------------------------------------------------------------------------

/** Cars.com collector: parse the embedded `CarsWeb.SearchController.index` JSON,
 *  emit one card per real vehicle listing under `.srp_results.results[]`
 *  (interleaved ad/native modules carry no `listing_id` and are skipped). Each
 *  card's VIN is appended to its text ("VIN: …") so the verbatim-provenance guard
 *  can see it, and carried as the aligned scalar. Cars.com puts the dealer name in
 *  the card text itself, so the scalar dealer name is null; the location is honored
 *  in probes, so `appliedLocation` is null. Self-contained. */
function collectCarsCom(): AggregatorCollected {
  const out: AggregatorCollectedCards = {
    kind: "cards",
    cards: [],
    scalars: [],
    appliedLocation: null,
  };
  const g = globalThis as {
    document?: { getElementById(id: string): { textContent: string | null } | null };
    location?: { origin?: string };
  };
  const doc = g.document;
  if (doc === undefined) return out;
  const el = doc.getElementById("CarsWeb.SearchController.index");
  if (el === null) return out;
  let data: unknown;
  try {
    data = JSON.parse(el.textContent ?? "null");
  } catch {
    return out;
  }
  const dataObj = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const srp =
    dataObj !== null && dataObj.srp_results !== null && typeof dataObj.srp_results === "object"
      ? (dataObj.srp_results as Record<string, unknown>)
      : null;
  const results = srp !== null && Array.isArray(srp.results) ? srp.results : [];
  const origin = g.location?.origin ?? "https://www.cars.com";

  // Inline copies of flattenCarsComBody / extractVinFromListingBlob — MUST stay
  // in sync with the exported pure twins (serialization forbids referencing them).
  const flattenCarsComBody = (listing: unknown): string => {
    const acc: string[] = [];
    const seen = new Set<string>();
    const push = (s: unknown): void => {
      if (typeof s !== "string") return;
      const t = s.replace(/\s+/g, " ").trim();
      if (t === "" || seen.has(t)) return;
      seen.add(t);
      acc.push(t);
    };
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const x of node) walk(x);
        return;
      }
      const rec = node as Record<string, unknown>;
      if (Array.isArray(rec.text_snippets)) {
        for (const sn of rec.text_snippets) {
          if (sn !== null && typeof sn === "object") push((sn as Record<string, unknown>).text);
        }
      }
      push(rec.name);
      push(rec.value);
      push(rec.label);
      if (Array.isArray(rec.items)) for (const x of rec.items) walk(x);
    };
    const body =
      listing !== null && typeof listing === "object"
        ? (listing as Record<string, unknown>).body
        : undefined;
    walk(body);
    return acc.join(" · ");
  };
  const extractVinFromListingBlob = (listing: unknown): string | null => {
    let blob: string;
    try {
      blob = JSON.stringify(listing);
    } catch {
      return null;
    }
    if (typeof blob !== "string") return null;
    const re = /[A-HJ-NPR-Z0-9]{17}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blob)) !== null) {
      const c = m[0];
      if (!/^[0-9]{17}$/.test(c)) return c;
    }
    return null;
  };

  for (const raw of results) {
    if (raw === null || typeof raw !== "object") continue;
    const L = raw as Record<string, unknown>;
    const listingId = typeof L.listing_id === "string" ? L.listing_id : "";
    if (listingId === "") continue; // interleaved ad/native module, not a vehicle
    const href = `${origin}/vehicledetail/${listingId}/`;
    const vin = extractVinFromListingBlob(L);
    let text = flattenCarsComBody(L);
    if (vin !== null) text = `${text} · VIN: ${vin}`;
    out.cards.push({ text, href });
    out.scalars.push({ vin: vin ?? "", dealerName: null });
  }
  return out;
}

/** Edmunds collector: read the embedded `window.EDM.preloadedState` inventory
 *  results, build one card per entry from its own structured fields (title, color,
 *  price, MSRP, dealer, location, distance, VIN), and carry the deterministic
 *  {vin, dealerName} scalar (the dealer name is the site's structured value, never
 *  the LLM). Href is the entry's VDP anchor found in the DOM by VIN. `appliedLocation`
 *  is the resolved search ZIP the page actually used (fallback: the page heading),
 *  so the workflow can fail the site when it ignored the requested location.
 *  Self-contained. */
function collectEdmunds(): AggregatorCollected {
  const out: AggregatorCollectedCards = {
    kind: "cards",
    cards: [],
    scalars: [],
    appliedLocation: null,
  };
  const g = globalThis as {
    document?: {
      querySelector(
        sel: string,
      ): { getAttribute(name: string): string | null; textContent: string | null } | null;
    };
    location?: { origin?: string };
    EDM?: { preloadedState?: unknown };
  };
  const doc = g.document;
  const origin = g.location?.origin ?? "https://www.edmunds.com";
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const num = (v: unknown): number | null =>
    typeof v === "number" && isFinite(v) ? v : null;
  const groupNum = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  const st = asObj(g.EDM?.preloadedState);
  const inv = st ? asObj(st.inventory) : null;
  const sr = inv ? asObj(inv.searchResults) : null;
  const invs = sr ? asObj(sr.inventories) : null;
  const results = invs !== null && Array.isArray(invs.results) ? invs.results : [];

  for (const raw of results) {
    const e = asObj(raw);
    if (e === null) continue;
    const vin = str(e.vin) ?? "";
    const dealerInfo = asObj(e.dealerInfo);
    const dealerName = dealerInfo ? str(dealerInfo.name) : null;
    const si = asObj(asObj(e.vehicleInfo)?.styleInfo);
    const prices = asObj(e.prices);
    const addr = dealerInfo ? asObj(dealerInfo.address) : null;
    const exterior = asObj(asObj(asObj(e.vehicleInfo)?.vehicleColors)?.exterior);
    const dist = dealerInfo ? num(dealerInfo.distance) : null;

    const parts: string[] = [];
    if (si) {
      const title = ["New", si.year, si.make, si.model, si.trim]
        .filter((x) => x !== undefined && x !== null && x !== "")
        .join(" ");
      if (title.trim() !== "New") parts.push(title);
    }
    const color = exterior ? str(exterior.name) : null;
    if (color !== null) parts.push(color);
    const displayPrice = prices ? num(prices.displayPrice) : null;
    if (displayPrice !== null) parts.push(`Price $${groupNum(displayPrice)}`);
    const dealerMsrp = prices ? num(prices.dealerMsrp) : null;
    if (dealerMsrp !== null) parts.push(`MSRP $${groupNum(dealerMsrp)}`);
    if (dealerName !== null) parts.push(dealerName);
    const cityState = addr
      ? [str(addr.city), str(addr.stateCode)].filter((x): x is string => x !== null).join(", ")
      : "";
    if (cityState !== "") parts.push(cityState);
    if (dist !== null) parts.push(`${Math.round(dist)} mi`);
    if (e.inTransit === true) parts.push("In transit");
    if (vin !== "") parts.push(`VIN: ${vin}`);

    let href = "";
    const domA = vin !== "" && doc !== undefined ? doc.querySelector(`a[href*="${vin}"]`) : null;
    if (domA !== null && domA !== undefined) {
      const rawHref = domA.getAttribute("href") ?? "";
      if (rawHref !== "") {
        href = rawHref.startsWith("http")
          ? rawHref
          : origin + (rawHref.startsWith("/") ? rawHref : `/${rawHref}`);
      }
    }
    out.cards.push({ text: parts.join(" · "), href });
    out.scalars.push({ vin, dealerName });
  }

  const loc = st ? asObj(st.visitor) : null;
  const locObj = loc ? asObj(loc.location) : null;
  const appliedZip = locObj ? str(locObj.zipCode) : null;
  if (appliedZip !== null) {
    out.appliedLocation = appliedZip;
  } else if (doc !== undefined) {
    const h1 = doc.querySelector("h1");
    out.appliedLocation =
      h1 !== null && h1.textContent !== null ? h1.textContent.replace(/\s+/g, " ").trim() : null;
  }
  return out;
}

/** visor.vin collector: reads the TanStack-Start react-query cache the SSR page
 *  hydrates — `window.__TSR_ROUTER__.options.context.queryClient`'s query whose
 *  `queryKey[0] === "listings"` — the deterministic source (DOM tiles carry no
 *  dealer name and link only to visor's own VDP, never the dealer's site). Every
 *  probe step is individually guarded (missing/renamed field → a false/null
 *  probe flag, never a throw) and the whole walk sits behind a try/catch as a
 *  final backstop against page drift. Challenge markers detect a Cloudflare
 *  Turnstile interstitial; `echo` reports what the page's own listings query
 *  actually searched, for the location-echo gate. Self-contained. */
function collectVisor(): AggregatorCollected {
  const g = globalThis as {
    document?: { title?: string; querySelector(sel: string): unknown };
  };
  const doc = g.document;
  const cfIframe =
    doc !== undefined &&
    doc.querySelector('iframe[src*="challenges.cloudflare.com"]') !== null;
  const cfInput =
    doc !== undefined && doc.querySelector('input[name="cf-turnstile-response"]') !== null;
  const interstitial =
    doc !== undefined && typeof doc.title === "string" && /^just a moment/i.test(doc.title);
  const challenge = { cfIframe, cfInput, interstitial };

  const asObj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const stripQuotes = (s: string): string =>
    s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;

  let routerFound = false;
  let queryClientFound = false;
  let listingsQueryFound = false;
  let queryStatus: string | null = null;
  let total: number | null = null;
  const rows: unknown[] = [];
  let echo: { zip: string | null; radiusMiles: number | null; year: number | null } | null = null;

  try {
    const w = globalThis as Record<string, unknown>;
    const router = asObj(w.__TSR_ROUTER__);
    routerFound = router !== null;
    const options = router !== null ? asObj(router.options) : null;
    const context = options !== null ? asObj(options.context) : null;
    const queryClient = context !== null ? asObj(context.queryClient) : null;
    const cache =
      queryClient !== null && typeof queryClient.getQueryCache === "function"
        ? asObj((queryClient.getQueryCache as () => unknown)())
        : null;
    queryClientFound = cache !== null;
    const allRaw =
      cache !== null && typeof cache.getAll === "function"
        ? (cache.getAll as () => unknown)()
        : [];
    const all = Array.isArray(allRaw) ? allRaw : [];
    const listingsQuery = asObj(
      all.find((x) => {
        const rec = asObj(x);
        return rec !== null && Array.isArray(rec.queryKey) && rec.queryKey[0] === "listings";
      }),
    );
    listingsQueryFound = listingsQuery !== null;

    const state = listingsQuery !== null ? asObj(listingsQuery.state) : null;
    queryStatus = state !== null && typeof state.status === "string" ? state.status : null;
    const data = state !== null ? asObj(state.data) : null;
    const pages = data !== null && Array.isArray(data.pages) ? data.pages : [];
    const firstPage = asObj(pages[0]);
    total = firstPage !== null && typeof firstPage.total === "number" ? firstPage.total : null;

    for (const page of pages) {
      const pageObj = asObj(page);
      const pageRows = pageObj !== null && Array.isArray(pageObj.rows) ? pageObj.rows : [];
      for (const r of pageRows) {
        const rec = asObj(r);
        if (rec === null) continue;
        rows.push({
          vin: rec.vin,
          year: rec.year,
          make: rec.make,
          model: rec.model,
          fuelType: rec.fuelType,
          trim: rec.trim,
          price: rec.price,
          miles: rec.miles,
          exteriorColor: rec.exteriorColor,
          state: rec.state,
          city: rec.city,
          latitude: rec.latitude,
          longitude: rec.longitude,
          dealerName: rec.dealerName,
          dealerId: rec.dealerId,
          stockNumber: rec.stockNumber,
          vdpUrl: rec.vdpUrl,
          inventoryType: rec.inventoryType,
        });
      }
    }

    const queryKey =
      listingsQuery !== null && Array.isArray(listingsQuery.queryKey) ? listingsQuery.queryKey : [];
    const keyArg = asObj(queryKey[1]);
    if (keyArg !== null) {
      const zipRaw = keyArg.geo_origin_zipcode ?? keyArg.geo_origin_value;
      const zip = zipRaw === null || zipRaw === undefined ? null : stripQuotes(String(zipRaw));
      const radiusRaw = keyArg.geo_distance_value ?? keyArg.geo_value;
      const radiusNum =
        radiusRaw === null || radiusRaw === undefined ? NaN : Number(stripQuotes(String(radiusRaw)));
      const yearRaw = keyArg.year;
      const yearNum =
        yearRaw === null || yearRaw === undefined ? NaN : Number(stripQuotes(String(yearRaw)));
      echo = {
        zip,
        radiusMiles: Number.isNaN(radiusNum) ? null : radiusNum,
        year: Number.isNaN(yearNum) ? null : yearNum,
      };
    }
  } catch {
    // Page drift mid-walk: fall back to whatever was already resolved above —
    // the probe flags and outcome mapping downstream classify this honestly.
  }

  return {
    kind: "rows",
    probe: { routerFound, queryClientFound, listingsQueryFound, queryStatus, total },
    rows,
    challenge,
    echo,
  };
}

// ---------------------------------------------------------------------------
// The registry. Order IS the cross-site dedup priority.
// ---------------------------------------------------------------------------

export const AGGREGATOR_ADAPTERS: readonly AggregatorAdapter[] = [
  {
    siteId: "cars_com",
    host: "www.cars.com",
    label: "Cars.com",
    robotsDisallowed: true,
    // Loads reliably on fresh headed profiles (2026-07-09 probes); no met case
    // for a warmed profile.
    persistentProfileKey: null,
    buildSrpUrl: buildCarsComUrl,
    collect: collectCarsCom,
  },
  {
    siteId: "visor_vin",
    host: "visor.vin",
    label: "visor.vin",
    robotsDisallowed: false, // robots.txt reads "Allow: /" — 2026-07-09 in-browser read
    // freeway data plane requires a challenge-cleared session; the human passes
    // Turnstile once in this profile and scans reuse it.
    persistentProfileKey: "aggregator/visor_vin",
    buildSrpUrl: buildVisorUrl,
    collect: collectVisor,
  },
  {
    siteId: "edmunds",
    host: "www.edmunds.com",
    label: "Edmunds",
    robotsDisallowed: true,
    // Akamai bm_* cookies persist the bot verdict across runs — a warmed profile
    // makes Edmunds strictly worse (2026-07-09 probe).
    persistentProfileKey: null,
    buildSrpUrl: buildEdmundsUrl,
    collect: collectEdmunds,
  },
];
