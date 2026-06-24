/**
 * quotes/crossState — PURE deterministic cross-state OTD math. No SQLite, no
 * network, no LLM. The honest apples-to-apples layer for comparing dealer quotes
 * that may sit in DIFFERENT states.
 *
 * THE TAX INVARIANT. Sales/use tax follows the buyer's HOME (registration) state,
 * NOT the dealer's purchase state: when you buy out of state and register at home,
 * you owe your home state's use tax (the dealer collects it, or you pay it at the
 * DMV). So every quote in a portfolio comparison must be taxed at the buyer's
 * home-state rate — two dealers in different states quoting the same vehicle to
 * the same buyer then compute IDENTICAL tax. Comparing raw dealer-stated OTDs
 * across state lines is dishonest: a dealer in a no-tax state looks thousands
 * cheaper on paper, but the buyer pays home-state tax regardless. Widening the
 * search wins on price + doc fee + regional incentives, NOT on tax.
 *
 * THE TAXABLE BASE is the selling price. Trade-in credits and rebate taxability
 * vary by state and are not modeled here (a sanity normalization, not a tax
 * engine); local/county surtaxes are likewise folded into one representative
 * state-level rate. All money is float DOLLARS.
 */

/** Round to 2 decimal places (penny resolution). */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Coerce to a finite number, or null (empty string → null). */
function asNum(raw: number | null | undefined): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Representative per-state sales/use tax rate (fraction; `0.0725` = 7.25%) applied
 * to the selling price as the buyer's HOME-state rate. A no-sales-tax state is an
 * explicit `0` (OR/MT/NH/DE/AK). An absent key = unknown state → no normalization
 * (the normalized fields fall to null). Where a state levies a dedicated motor-
 * vehicle rate distinct from its general sales tax (e.g. VA 4.15%, NC 3% highway
 * use), that vehicle rate is used. Local/county surtaxes are NOT modeled.
 *
 * Sanity reference data, not authoritative law; rates change — maintained as-of
 * 2026-06. Extend/correct this table as the maintained source of truth.
 */
export const STATE_SALES_TAX_RATE: Readonly<Record<string, number>> = {
  AL: 0.02, // dedicated automotive rate
  AK: 0, // no statewide sales tax
  AZ: 0.056,
  AR: 0.065,
  CA: 0.0725,
  CO: 0.029,
  CT: 0.0635,
  DE: 0, // no sales tax
  FL: 0.06,
  GA: 0.04,
  HI: 0.04,
  ID: 0.06,
  IL: 0.0625,
  IN: 0.07,
  IA: 0.05, // one-time registration fee in lieu of sales tax
  KS: 0.065,
  KY: 0.06,
  LA: 0.0445,
  ME: 0.055,
  MD: 0.06,
  MA: 0.0625,
  MI: 0.06,
  MN: 0.06875,
  MS: 0.05, // dedicated automotive rate
  MO: 0.04225,
  MT: 0, // no sales tax
  NE: 0.055,
  NV: 0.0685,
  NH: 0, // no sales tax
  NJ: 0.06625,
  NM: 0.04, // motor vehicle excise
  NY: 0.04,
  NC: 0.03, // highway use tax
  ND: 0.05,
  OH: 0.0575,
  OK: 0.0125, // excise on top of a small sales component
  OR: 0, // no sales tax (a small dealer use/privilege tax exists, not modeled)
  PA: 0.06,
  RI: 0.07,
  SC: 0.05, // capped infrastructure maintenance fee
  SD: 0.04, // motor vehicle excise
  TN: 0.07,
  TX: 0.0625,
  UT: 0.0485,
  VT: 0.06, // purchase & use tax
  VA: 0.0415, // motor vehicle sales/use tax
  WA: 0.065,
  WV: 0.06, // titling privilege tax
  WI: 0.05,
  WY: 0.04,
  DC: 0.06,
};

/**
 * The buyer's home-state tax rate, case-insensitive. `null` for an unknown /
 * missing / empty state (no normalization possible).
 */
export function homeStateTaxRate(state: string | null | undefined): number | null {
  if (state === null || state === undefined || state === "") return null;
  const rate = STATE_SALES_TAX_RATE[state.toUpperCase()];
  return rate === undefined ? null : rate;
}

// --------------------------------------------------------------------------- //
// tax normalization                                                           //
// --------------------------------------------------------------------------- //

export interface TaxNormalizationInput {
  /** The buyer's home (registration) state — the SOLE input that sets the rate. */
  homeState: string | null | undefined;
  /** Negotiated selling price (the taxable base). null → cannot normalize. */
  sellingPrice: number | null | undefined;
  /** The dealer-STATED tax to be swapped out. null → normalized OTD null. */
  statedTax: number | null | undefined;
  /** The dealer-STATED out-the-door total. null → normalized OTD null. */
  statedOtd: number | null | undefined;
}

export interface TaxNormalization {
  /** The resolved home-state rate (null when the state is unknown). */
  homeStateRate: number | null;
  /** `homeStateRate * sellingPrice`, rounded 2dp; null when un-normalizable. */
  normalizedTax: number | null;
  /** `statedOtd - statedTax + normalizedTax` (swap the tax component, hold the
   *  rest), rounded 2dp; null when any input needed for the swap is null. */
  normalizedOtd: number | null;
}

/**
 * Re-tax a dealer quote at the buyer's home-state rate. The dealer's own state is
 * irrelevant — only the buyer's home state sets the rate, so two quotes for the
 * same vehicle at the same selling price normalize to identical tax regardless of
 * where the dealers sit. Pure; never throws.
 */
export function normalizeQuoteTax(input: TaxNormalizationInput): TaxNormalization {
  const homeStateRate = homeStateTaxRate(input.homeState);
  const sellingPrice = asNum(input.sellingPrice);
  const statedTax = asNum(input.statedTax);
  const statedOtd = asNum(input.statedOtd);

  if (homeStateRate === null || sellingPrice === null) {
    return { homeStateRate, normalizedTax: null, normalizedOtd: null };
  }

  const normalizedTax = round2(homeStateRate * sellingPrice);
  const normalizedOtd =
    statedOtd === null || statedTax === null
      ? null
      : round2(statedOtd - statedTax + normalizedTax);

  return { homeStateRate, normalizedTax, normalizedOtd };
}

// --------------------------------------------------------------------------- //
// OTD-delta attribution                                                       //
// --------------------------------------------------------------------------- //

/** The component view of one quote's OTD (normalized tax). Any field may be null
 *  (missing extraction); the delta math coerces a null component delta to 0 and
 *  lets the residual `otherDelta` absorb it. `otd` null → not attributable. */
export interface OtdComponents {
  sellingPrice: number | null;
  docFee: number | null;
  /** The NORMALIZED (home-state) tax, not the dealer-stated tax. */
  tax: number | null;
  /** Total incentives/rebates applied (positive — REDUCES the OTD). */
  incentives: number | null;
  /** The NORMALIZED out-the-door total (home-state tax swapped in). */
  otd: number | null;
}

/**
 * The signed decomposition of `candidate.otd - baseline.otd` into the components
 * that drive it. The four named deltas plus the reconciling `otherDelta` residual
 * reconcile to `otdDelta` to the cent (2-dp) — every term is rounded to the cent
 * (float dollars, like the rest of the calc layer), so the five re-add to
 * `otdDelta` within rounding, not bit-exactly. The residual captures
 * dealer/DMV/title/etc. fees not carried as named components, plus penny rounding.
 * Sign convention: a NEGATIVE delta means the candidate is cheaper on that
 * component. `incentiveDelta` is the incentive's CONTRIBUTION to the OTD (more
 * rebate → lower OTD → negative).
 */
export interface OtdAttribution {
  otdDelta: number;
  salePriceDelta: number;
  docFeeDelta: number;
  taxDelta: number;
  incentiveDelta: number;
  otherDelta: number;
}

/** A null-coercing component delta (null → treated as 0 for the difference). */
function delta(candidate: number | null, baseline: number | null): number {
  return (asNum(candidate) ?? 0) - (asNum(baseline) ?? 0);
}

/**
 * Decompose why `candidate`'s OTD differs from `baseline`'s. Returns null when
 * either OTD is unknown (nothing to attribute). Pure; never throws. The residual
 * is computed last so the components always reconcile to `otdDelta`.
 */
export function attributeOtdDelta(
  baseline: OtdComponents,
  candidate: OtdComponents,
): OtdAttribution | null {
  const baseOtd = asNum(baseline.otd);
  const candOtd = asNum(candidate.otd);
  if (baseOtd === null || candOtd === null) return null;

  const otdDelta = round2(candOtd - baseOtd);
  const salePriceDelta = round2(delta(candidate.sellingPrice, baseline.sellingPrice));
  const docFeeDelta = round2(delta(candidate.docFee, baseline.docFee));
  const taxDelta = round2(delta(candidate.tax, baseline.tax));
  // A rebate REDUCES the OTD, so its contribution is the NEGATED incentive delta.
  const incentiveDelta = round2(-delta(candidate.incentives, baseline.incentives));
  const otherDelta = round2(
    otdDelta - (salePriceDelta + docFeeDelta + taxDelta + incentiveDelta),
  );

  return { otdDelta, salePriceDelta, docFeeDelta, taxDelta, incentiveDelta, otherDelta };
}
