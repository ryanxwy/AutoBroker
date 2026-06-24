/**
 * calc — PURE deterministic offer math. No SQLite, no network, no LLM. These are
 * the hard arithmetic checks the model is never trusted to do.
 *
 * `validateOfferMath` recomputes the out-the-door total from the selling price +
 * fees + tax and compares it to the dealer-stated total within a $1 tolerance
 * (penny-rounding noise). `STATE_DOC_FEE_CAP` carries the per-state documentation
 * fee caps. All money is float DOLLARS (no cents). The quote audit's MATH_SANITY
 * and DOC_FEE_CAP checks consume both.
 */

/** Tolerance for reconciling line items against the stated total (USD). */
export const OFFER_MATH_TOLERANCE_USD = 1.0;

/**
 * Per-state documentation-fee caps (USD), the maintained source of truth for the
 * audit's DOC_FEE_CAP / DOC_FEE_UNCAPPED checks. A numeric value is the statutory
 * cap; an explicit `null` means the state has no statutory cap (present-but-
 * uncapped — a high fee there is flagged DOC_FEE_UNCAPPED against
 * {@link DOC_FEE_HIGH_REFERENCE_USD} instead); an ABSENT key means "unknown"
 * (no finding either way).
 *
 * Caps change over time and are set by statute or negotiated maxima — this is a
 * data-driven table to extend/correct, NOT logic hardcoded forever. Sanity
 * reference data, not authoritative law; maintained as-of 2026-06.
 */
export const STATE_DOC_FEE_CAP: Readonly<Record<string, number | null>> = {
  // Statutorily capped states (value = cap, USD).
  CA: 85,
  NY: 175,
  WA: 200,
  MN: 125,
  MI: 260,
  OH: 250,
  MD: 500,
  // No statutory cap (present-but-uncapped — DOC_FEE_UNCAPPED applies above the
  // high reference).
  OR: null,
  TX: null,
  FL: null,
  GA: null,
  AZ: null,
  NV: null,
  CO: null,
  IL: null,
  VA: null,
  NJ: null,
  PA: null,
  MA: null,
  TN: null,
  NC: null,
};

/**
 * The "high doc fee" reference (USD) for a state with NO statutory cap. A doc fee
 * above this in an uncapped state is surfaced as DOC_FEE_UNCAPPED — a negotiation
 * target, not a legal violation. Sanity reference (uncapped-state doc fees of
 * $500+ are common and negotiable), maintained alongside {@link STATE_DOC_FEE_CAP}.
 */
export const DOC_FEE_HIGH_REFERENCE_USD = 500;

/** A fee is either a raw number or a `{name?, amount?}` line-item dict. */
export type FeeItem = number | { amount?: unknown; [key: string]: unknown };

export interface OfferMathInput {
  /** Negotiated selling price before fees/taxes; null/undefined → not_checked. */
  sellingPrice: number | null | undefined;
  /** Fee line items (numbers or {amount} dicts). Missing/non-numeric → 0. */
  fees?: readonly FeeItem[] | null;
  /** Total tax; null/undefined treated as 0. */
  taxAmount?: number | null;
  /** Dealer-stated out-the-door total; null/undefined → not_checked. */
  statedOtd: number | null | undefined;
  /** Reconciliation tolerance (USD); defaults to $1.00. */
  tolerance?: number;
}

export type MathStatus = "pass" | "fail" | "not_checked";

export interface MathCheck {
  /** Recomputed OTD (rounded 2dp), or null when not_checked. */
  computedOtd: number | null;
  /** Echo of the stated OTD, or null when stated was absent. */
  statedOtd: number | null;
  /** Signed (computed - stated), rounded 2dp; null when not_checked. */
  delta: number | null;
  tolerance: number;
  status: MathStatus;
}

/** Round to 2 decimal places (penny resolution) for the delta/total compare. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Coerce a raw value to a finite number, or null. Empty string → null. */
function coerceAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Sum a list of fees (numbers or {amount} dicts); missing/non-numeric → 0. */
function sumFees(fees: readonly FeeItem[] | null | undefined): number {
  if (!fees) return 0;
  let total = 0;
  for (const fee of fees) {
    const amt =
      typeof fee === "object" && fee !== null ? coerceAmount(fee.amount) : coerceAmount(fee);
    if (amt !== null) total += amt;
  }
  return total;
}

/**
 * Recompute `selling + Σfees + (tax || 0)` and compare to `stated_otd`.
 *
 * Returns `status:"not_checked"` (delta null) when selling price OR stated OTD is
 * null/undefined. Otherwise the delta is rounded to 2dp before the compare;
 * `pass` iff `|delta| <= tolerance`, else `fail`. Pure; never throws.
 */
export function validateOfferMath(input: OfferMathInput): MathCheck {
  const tolerance = input.tolerance ?? OFFER_MATH_TOLERANCE_USD;
  const { sellingPrice, statedOtd } = input;

  if (sellingPrice === null || sellingPrice === undefined || statedOtd === null || statedOtd === undefined) {
    return {
      computedOtd: null,
      statedOtd: statedOtd ?? null,
      delta: null,
      tolerance,
      status: "not_checked",
    };
  }

  const computed = sellingPrice + sumFees(input.fees) + (input.taxAmount ?? 0);
  const delta = round2(computed - statedOtd);
  const status: MathStatus = Math.abs(delta) <= tolerance ? "pass" : "fail";
  return {
    computedOtd: round2(computed),
    statedOtd,
    delta,
    tolerance,
    status,
  };
}
