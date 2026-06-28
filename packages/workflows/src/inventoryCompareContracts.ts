/**
 * inventory_compare contracts — the typed input/output and the typed STOP
 * vocabulary the inventoryCompare workflow and the server descriptor share.
 * Skill-local, single-use (only the workflow file and its tests import them),
 * kept out of the shared core layer like the other skills' contracts; core owns
 * only ROW shapes.
 *
 * PROFILE RESOLUTION — read-only / infer-ok. inventory_compare is a re-runnable
 * read: a single active profile is INFERRED (the resolver's exactly-1 branch),
 * a supplied pin wins, zero active STOPs pointing at intake, and 2+ active STOPs
 * asking by car name. There is NO pick-suspend — a STOP is terminal.
 *
 * ZERO-LLM: the whole rank (read profile, read listings, score, render) is
 * deterministic; there is no emit schema, no #1244 surface, no suspend point.
 *
 * Listings ≠ quotes: the output is a list of public-website inventory
 * candidates, NOT negotiated out-the-door quotes — the rail labels them
 * "Inventory candidates", never "quotes" / "offers", and carries no budget.
 *
 * Dependency wall: imports zod only (no @autobroker/core type is needed — the
 * candidate shape is flat primitives).
 */

import { z } from "zod";

/** The stable workflow id (registration + the server descriptor). */
export const INVENTORY_COMPARE_WORKFLOW_ID = "inventory_compare" as const;

// ---------------------------------------------------------------------------
// workflow input / output
// ---------------------------------------------------------------------------

/** The workflow input (the server descriptor builds this from the start body).
 *  The profile pin is the ONLY input; null → 1/0/2+ three-branch resolution. */
export const InventoryCompareInputSchema = z.object({
  /** Explicit profile pin, or null → three-branch resolution over active rows. */
  search_profile_id: z.string().nullable(),
});
export type InventoryCompareInput = z.infer<typeof InventoryCompareInputSchema>;

/**
 * One ranked inventory candidate — flat, all-required-with-explicit-null. `vin`
 * is the FULL 17-char string (display invariant; never tail-only). `stock_number`
 * null → the rail renders an em-dash. `inventory_status` / `dealer_id` are NOT
 * NULL columns. `match_status` is recomputed at rank time, never persisted.
 */
export const RankedCandidateSchema = z
  .object({
    listing_id: z.string(),
    vin: z.string().nullable(),
    stock_number: z.string().nullable(),
    year: z.number().nullable(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    trim: z.string().nullable(),
    exterior_color: z.string().nullable(),
    interior_color: z.string().nullable(),
    /** Public VDP href (or null) — the card's "View listing" click-through target. */
    listing_url: z.string().nullable(),
    listed_price: z.number().nullable(),
    msrp: z.number().nullable(),
    /** Dealer's own LABELED market adjustment (markup) in dollars, or null. */
    dealer_markup: z.number().nullable(),
    /** Dealer add-on line items, parsed from pricing_breakdown_json; [] when none. */
    add_ons: z.array(z.object({ label: z.string(), amount: z.number() })),
    /** Sum of the add-on amounts in dollars, or null. */
    addons_total: z.number().nullable(),
    /** A LABELED dealer discount (off MSRP) in dollars, or null — recovered by the
     *  folded LLM price-block read (the deterministic harvest omits it). */
    dealer_discount: z.number().nullable(),
    /** A short verbatim manufacturer-incentive phrase, or null. Same provenance. */
    incentives_text: z.string().nullable(),
    /** true when the price was hidden behind a "Get your price" CTA. */
    price_gated: z.boolean(),
    /** true ⇔ a price-stack region was actually read; false = "no breakdown captured". */
    breakdown_parsed: z.boolean(),
    inventory_status: z.string(),
    dealer_id: z.string(),
    dealer_name: z.string().nullable(),
    distance_miles: z.number().nullable(),
    score: z.number(),
    reasons: z.array(z.string()),
    match_status: z.enum(["exact", "near", "mismatch", "unknown"]),
    /** true ⇔ match exact/near AND inventory in_stock/in_transit AND score >= 0.6.
     *  The SINGLE source of the recommended predicate (set by the ranker; never
     *  re-derived downstream). */
    recommended: z.boolean(),
  })
  .strict();
export type RankedCandidate = z.infer<typeof RankedCandidateSchema>;

/**
 * One color-config cross-check advisory row: a buyer's loose preferred color the
 * ranker's EXACT colorAxis won't match, plus the REAL stocked names to offer.
 * Assist-not-autofill — the buyer taps a suggestion to add it; nothing is
 * auto-written. Empty when every preferred color already matches a stocked name
 * exactly (or nothing overlaps).
 */
export const ColorCrossCheckItemSchema = z
  .object({
    requested: z.string(),
    suggestions: z.array(z.string()),
  })
  .strict();
export type ColorCrossCheckItem = z.infer<typeof ColorCrossCheckItemSchema>;

/**
 * The workflow output — a SINGLE object (no union, no suspend): the ranked
 * candidates plus the header tallies, the profile-resolution provenance, and
 * the deterministic terminal summary. An empty rail is a VALID success
 * (candidates: [], totalListings: 0) — never an error.
 */
export const InventoryCompareOutputSchema = z
  .object({
    outcome: z.literal("ranked"),
    /** Profile-resolution provenance (pinned vs inferred-newest). */
    resolution: z.enum(["pinned", "inferred_newest"]),
    search_profile_id: z.string(),
    /** The newest last_seen_at over the candidates (ISO string), or null. */
    scannedAtMax: z.string().nullable(),
    /** Candidate count (post hard-filter). */
    totalListings: z.number().int(),
    /** Candidates satisfying the recommended predicate (match exact/near AND
     *  inventory in_stock/in_transit AND score >= 0.6). */
    recommendedCount: z.number().int(),
    candidates: z.array(RankedCandidateSchema),
    /** Color config cross-check advisory — loose preferred colors the EXACT
     *  colorAxis won't match, with the real stocked names to offer (assist-only,
     *  never auto-written). [] when nothing is actionable. */
    colorCrossCheck: z.array(ColorCrossCheckItemSchema).default([]),
    /** The deterministic terminal sentence (no budget number anywhere). */
    summary: z.string(),
  })
  .strict();
export type InventoryCompareOutput = z.infer<typeof InventoryCompareOutputSchema>;

// ---------------------------------------------------------------------------
// typed STOP codes (read-only three-branch: 0 active / 2+ active)
// ---------------------------------------------------------------------------

/** The three-branch STOP codes (members of the UI PROFILE_STOP_CODES set). */
export type InventoryCompareStopCode = "no_active_profile" | "multiple_active_profiles";

/** Typed STOP from the resolve step. The message is the user-facing wording —
 *  the server surfaces it verbatim on the run's error frame. */
export class InventoryCompareStopError extends Error {
  readonly code: InventoryCompareStopCode;
  constructor(code: InventoryCompareStopCode, message: string) {
    super(message);
    this.name = "InventoryCompareStopError";
    this.code = code;
  }
}
