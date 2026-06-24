/**
 * segment — a small, presentation-only heuristic that buckets a vehicle into a
 * market SEGMENT so the portfolio board can sit different-BRAND competitors
 * together (Accord vs Camry vs Mazda6 → "Midsize sedans"). There is no segment
 * field in the schema (the owner's use case is same-segment, different-brand
 * pipelines), so this maps the model token found in the vehicle label to a
 * segment. An unrecognized vehicle falls into "Other searches" (its own group)
 * rather than being mis-grouped.
 *
 * This is a deliberately small lookup, not a taxonomy — extend the map as new
 * models appear. Pure (no I/O); lives in the app/ui layer (a board concern).
 */

/** model token (lowercase, as it appears in a label) → segment label. */
const MODEL_SEGMENT: ReadonlyArray<readonly [string, string]> = [
  // Compact SUVs / crossovers
  ["rav4", "Compact SUVs"],
  ["cr-v", "Compact SUVs"],
  ["crv", "Compact SUVs"],
  ["tucson", "Compact SUVs"],
  ["cx-5", "Compact SUVs"],
  ["cx5", "Compact SUVs"],
  ["rogue", "Compact SUVs"],
  ["forester", "Compact SUVs"],
  ["sportage", "Compact SUVs"],
  ["escape", "Compact SUVs"],
  ["equinox", "Compact SUVs"],
  // Midsize sedans
  ["accord", "Midsize sedans"],
  ["camry", "Midsize sedans"],
  ["mazda6", "Midsize sedans"],
  ["altima", "Midsize sedans"],
  ["sonata", "Midsize sedans"],
  ["k5", "Midsize sedans"],
  ["malibu", "Midsize sedans"],
  // Compact cars
  ["civic", "Compact cars"],
  ["corolla", "Compact cars"],
  ["mazda3", "Compact cars"],
  ["sentra", "Compact cars"],
  ["elantra", "Compact cars"],
  ["jetta", "Compact cars"],
  // Full-size pickups
  ["f-150", "Full-size trucks"],
  ["f150", "Full-size trucks"],
  ["silverado", "Full-size trucks"],
  ["sierra", "Full-size trucks"],
  ["ram 1500", "Full-size trucks"],
  ["tundra", "Full-size trucks"],
];

/** The fallback bucket for an unrecognized model. */
export const OTHER_SEGMENT = "Other searches";

/** The market segment for a vehicle label (e.g. "2026 Toyota RAV4 XLE" →
 *  "Compact SUVs"). Case-insensitive substring match on the model token;
 *  unrecognized → OTHER_SEGMENT. */
export function segmentOf(vehicle: string): string {
  const hay = vehicle.toLowerCase();
  for (const [token, segment] of MODEL_SEGMENT) {
    if (hay.includes(token)) return segment;
  }
  return OTHER_SEGMENT;
}

/** A stable, testid-safe slug for a segment label ("Compact SUVs" →
 *  "compact-suvs"). */
export function segmentSlug(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
