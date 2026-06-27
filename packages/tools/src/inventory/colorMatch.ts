/**
 * colorMatch — deterministic, grounded exterior-color matching against the REAL
 * stocked color names a scan harvested. Pure, no LLM, no I/O. Sibling to
 * trimMatch.ts.
 *
 * Why: the ranker's colorAxis is EXACT (case-insensitive) string equality, so a
 * buyer's loose preference ("red") never matches a dealer's real stocked name
 * ("Radiant Red Metallic II") — matching cars score the low color axis and can
 * rank below the recommend floor. This module reconciles a loose preference to
 * the real stocked names so the buyer can ADD the canonical name (then colorAxis
 * fires exactly). Matching is WHOLE-TOKEN (word-boundary) only: "red" overlaps
 * "Radiant Red Metallic II" (the whole word "red" is a token) but NOT "Predator"
 * or "Bluestone" (substring, not a token).
 */

/**
 * Lower-case, trim, and collapse internal whitespace. Strips nothing semantic —
 * every word is kept (descriptors like "metallic"/"pearl" carry meaning for a
 * buyer who typed them).
 */
export function normalizeColor(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Split a color into its lower-cased word tokens (runs of letters/digits); any
 * non-alphanumeric (space, hyphen, slash, punctuation) is a boundary. So
 * "Radiant Red Metallic II" → ["radiant","red","metallic","ii"] and "Bluestone"
 * → ["bluestone"] (ONE token — "blue" is not in it).
 */
function colorTokens(raw: string): string[] {
  return normalizeColor(raw)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * True when every token of `requested` appears as a WHOLE token of `candidate` —
 * a directional subset (the loose pref ⊆ the canonical name), mirroring
 * trimSubsetMatch. So "red" ⊆ "Radiant Red Metallic II" → true, but "blue" ⊄
 * "Bluestone" (substring, not a token) and "red" ⊄ "Predator". An empty
 * `requested` → false.
 */
export function colorTokenMatch(requested: string, candidate: string): boolean {
  const req = colorTokens(requested);
  if (req.length === 0) return false;
  const cand = new Set(colorTokens(candidate));
  return req.every((t) => cand.has(t));
}

export interface ColorAvailability {
  /** The requested (loose) color, verbatim. */
  requested: string;
  /** True when at least one stocked color whole-token-overlaps the request — i.e.
   *  the loose color IS represented in stock under some canonical name(s). */
  matched: boolean;
  /** The real stocked color names that whole-token-overlap the request (the
   *  canonical names to offer). Empty when nothing overlaps (or no inventory). */
  suggestions: string[];
}

/**
 * Classify each requested exterior color against the REAL distinct colors a scan
 * stocked. For each requested color: `matched` iff some stocked color
 * whole-token-overlaps it; `suggestions` = the overlapping stocked names (the
 * canonical names to offer). Pure. Blank requests are skipped; empty inputs yield
 * [] (or a `matched:false` row with no suggestions).
 */
export function classifyColorAvailability(
  requestedColors: readonly string[],
  inventoryColors: readonly string[],
): ColorAvailability[] {
  const distinct = [
    ...new Set(inventoryColors.filter((c) => c != null && c.trim() !== "")),
  ];
  const out: ColorAvailability[] = [];
  for (const requested of requestedColors) {
    if (requested == null || requested.trim() === "") continue;
    const suggestions = distinct.filter((c) => colorTokenMatch(requested, c));
    out.push({ requested, matched: suggestions.length > 0, suggestions });
  }
  return out;
}
