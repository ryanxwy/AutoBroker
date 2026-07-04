/**
 * trimMatch — deterministic, grounded trim matching against REAL dealer-stocked
 * trim strings. Pure, no LLM, no I/O.
 *
 * Why: the intake trim-verify used to ask the LLM whether a {year}{make}{model}
 * "truly offers" a trim from its (stale) training knowledge, which false-rejected
 * valid current-year trims. The authoritative ground truth is the trim strings
 * the scan actually scraped off dealer sites (e.g. "LX", "SE CVT"). This module
 * matches a buyer's requested trim against that real set, tolerant of the
 * powertrain/transmission noise dealers append, while keeping genuinely distinct
 * trims (EX vs EX-L) apart.
 */

/** Powertrain / transmission / drivetrain / body tokens that are NOT part of the
 *  marketing trim identity — dropped before matching so "LX" matches "LX CVT"
 *  and "EX-L" matches "EX-L Hybrid". */
const NOISE_TOKENS: ReadonlySet<string> = new Set([
  "cvt",
  "at",
  "mt",
  "awd",
  "fwd",
  "rwd",
  "2wd",
  "4wd",
  "4motion",
  "hybrid",
  "phev",
  "turbo",
  "sedan",
  "coupe",
  "hatchback",
  "wagon",
  "suv",
  "4dr",
  "2dr",
  "i-4",
  "i4",
  "v6",
  "v8",
]);

/** Token shapes that are engine displacement / size noise (1.5t, 2.0l, 3.5). */
const NOISE_PATTERNS: readonly RegExp[] = [/^\d\.\d[tl]?$/, /^\d{3,4}cc$/];

/**
 * Normalize a trim string into its core identity tokens. Lower-cases, keeps
 * HYPHENS inside a token (so "EX-L" stays one token, distinct from "EX"),
 * splits on whitespace, and drops powertrain/transmission/body noise tokens.
 */
export function normalizeTrim(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9.\- ]/g, " ") // keep letters/digits/dot/hyphen; rest → space
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(
      (t) => t.length > 0 && !NOISE_TOKENS.has(t) && !NOISE_PATTERNS.some((p) => p.test(t)),
    );
}

/**
 * True when every core token of `requested` is present in `candidate` — so
 * "LX" matches "LX CVT" / "1.5T LX", and "EX-L" matches "EX-L Hybrid", but "EX"
 * does NOT match "EX-L" (distinct token). Empty `requested` → false.
 */
export function trimSubsetMatch(requested: string, candidate: string): boolean {
  const req = normalizeTrim(requested);
  if (req.length === 0) return false;
  const cand = new Set(normalizeTrim(candidate));
  return req.every((t) => cand.has(t));
}

export interface TrimAvailability {
  /** True when the requested trim matches at least one in-stock trim. */
  matched: boolean;
  /** When matched: the verbatim in-stock trims that matched (≤3). When not
   *  matched: the nearest in-stock trims by token overlap, for "did you mean".
   *  Empty only when there is no inventory at all. */
  suggestions: string[];
}

/**
 * Classify a requested trim against the REAL distinct trims found in dealer
 * inventory. The authoritative, grounded check: matched iff the requested trim
 * is a token-subset of any in-stock trim; otherwise the nearest in-stock trims
 * are returned as suggestions.
 */
export function classifyTrimAvailability(
  requestedTrim: string | null,
  inventoryTrims: readonly string[],
): TrimAvailability {
  const distinct = [...new Set(inventoryTrims.filter((t) => t != null && t.trim().length > 0))];
  if (distinct.length === 0) return { matched: false, suggestions: [] };
  if (requestedTrim === null || requestedTrim.trim() === "") {
    return { matched: false, suggestions: distinct.slice(0, 3) };
  }
  const matches = distinct.filter((t) => trimSubsetMatch(requestedTrim, t));
  if (matches.length > 0) return { matched: true, suggestions: matches.slice(0, 3) };
  // No match → rank the in-stock trims by token overlap with the request.
  const reqTokens = new Set(normalizeTrim(requestedTrim));
  const ranked = distinct
    .map((t) => ({ t, overlap: normalizeTrim(t).filter((x) => reqTokens.has(x)).length }))
    .sort((a, b) => b.overlap - a.overlap)
    .map((x) => x.t);
  return { matched: false, suggestions: ranked.slice(0, 3) };
}

/**
 * Re-split a model/trim pair at the profile-model token boundary when the
 * extraction drifted the boundary into the trim.
 *
 * SRP tile titles run model and trim together ("TUCSON Hybrid Limited AWD"), and
 * the extraction's split of that character stream varies: the same page has
 * yielded {model:"TUCSON Hybrid", trim:"Limited"} on one run and {model:"Tucson",
 * trim:"Hybrid Limited"} on the next — the second shape fails the exact-model
 * comparison and silently zeroes a lot full of real matches. When the extracted
 * model differs from the profile's but the CONCATENATED model+trim token stream
 * starts with the profile model's tokens, re-split at the profile-model boundary.
 * This only re-partitions the tokens the page already carried — it never invents
 * or reorders text — and rows whose tokens genuinely diverge pass through
 * unchanged.
 *
 * One ASYMMETRIC guard: a re-split may pull a powertrain word (Hybrid / Electric /
 * Plug-in / PHEV / EV) INTO the model, but never OUT of it. "Tucson Hybrid"
 * against a "Tucson" profile is a DIFFERENT MODEL, not a trim variant — shortening
 * it to {model:"Tucson", trim:"Hybrid …"} would upgrade a genuine model mismatch
 * to a near match (and trimSubsetMatch treats "hybrid" as a noise token, so the
 * mis-split could even pass a trim-subset keep). Such rows pass through unchanged
 * and classify as the mismatch they are.
 */
const POWERTRAIN_TOKENS = new Set(["hybrid", "electric", "plug-in", "phev", "ev"]);

export function resegmentModelTrim(
  profileModel: string,
  model: string | null,
  trim: string | null,
): { model: string | null; trim: string | null } {
  if (model === null || model === "") return { model, trim };
  const profileTokens = profileModel.toLowerCase().split(/\s+/).filter((t) => t !== "");
  if (profileTokens.length === 0) return { model, trim };
  if (model.trim().toLowerCase() === profileModel.trim().toLowerCase()) return { model, trim };
  const combined = `${model} ${trim ?? ""}`.trim();
  const combinedTokens = combined.split(/\s+/).filter((t) => t !== "");
  if (combinedTokens.length < profileTokens.length) return { model, trim };
  for (let i = 0; i < profileTokens.length; i += 1) {
    if (combinedTokens[i]!.toLowerCase() !== profileTokens[i]) return { model, trim };
  }
  // The asymmetric powertrain guard: any ORIGINAL model token that this re-split
  // would move out into the trim must not be a powertrain word.
  const modelTokens = model.split(/\s+/).filter((t) => t !== "");
  for (let i = profileTokens.length; i < modelTokens.length; i += 1) {
    if (POWERTRAIN_TOKENS.has(modelTokens[i]!.toLowerCase())) return { model, trim };
  }
  const newModel = combinedTokens.slice(0, profileTokens.length).join(" ");
  const rest = combinedTokens.slice(profileTokens.length).join(" ");
  return { model: newModel, trim: rest === "" ? null : rest };
}
