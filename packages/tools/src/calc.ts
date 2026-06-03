/**
 * calc — PURE deterministic offer math. No SQLite, no network, no LLM. These are
 * the hard arithmetic checks the model is never trusted to do.
 *
 * Parity targets from the legacy Python `validate_offer_math`:
 *   - reconcile the quote line items to the out-the-door total within ±$1
 *     (penny rounding tolerance; anything wider is a discrepancy flag);
 *   - enforce the per-state documentation-fee cap (STATE_DOC_FEE_CAP).
 */

/** Tolerance for reconciling line items against the stated total. */
export const OFFER_MATH_TOLERANCE_USD = 1.0;

/** Per-state documentation-fee caps (USD). Some states are uncapped (null).
 *  TODO(phase-4): port the full table from Python parity. */
export const STATE_DOC_FEE_CAP: Readonly<Record<string, number | null>> = {
  // CA: 85, FL: null (uncapped), TX: 150, ...
  // TODO(phase-4): complete the table from the legacy constant.
};

export interface OfferLineItems {
  /** Negotiated selling price before fees/taxes. */
  sellingPrice: number;
  docFee: number;
  taxes: number;
  otherFees: number;
}

export interface OfferMathResult {
  ok: boolean;
  /** Signed difference (computed - stated), in USD. */
  deltaUsd: number;
  flags: string[];
}

/**
 * Reconcile line items to the dealer-stated out-the-door total within ±$1, and
 * check the doc fee against the state cap. Pure; returns flags, never throws.
 * TODO(phase-4): finalize the exact summation order to match Python rounding.
 */
export function validateOfferMath(
  items: OfferLineItems,
  statedOutTheDoor: number,
  stateCode: string,
): OfferMathResult {
  const computed =
    items.sellingPrice + items.docFee + items.taxes + items.otherFees;
  const deltaUsd = computed - statedOutTheDoor;
  const flags: string[] = [];

  if (Math.abs(deltaUsd) > OFFER_MATH_TOLERANCE_USD) {
    flags.push("OTD_TOTAL_MISMATCH");
  }

  const cap = STATE_DOC_FEE_CAP[stateCode];
  if (cap != null && items.docFee > cap) {
    flags.push("DOC_FEE_OVER_CAP");
  }

  return { ok: flags.length === 0, deltaUsd, flags };
}
