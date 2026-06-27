/**
 * quotes/audit — the deterministic 10-check quote audit. Pure, side-effect-free:
 * it takes a quote, the peer-quote list, the manufacturer-incentive slice, and
 * the active profile, and returns a flat `AuditFinding[]`. No DB, no LLM.
 *
 * Each check emits zero, one, or many findings with a stable `code`. Severity is
 * derived from the code by {@link classifyAuditSeverity} (the surfacing
 * authority), so a check never picks its own severity. All money is float
 * dollars. Empty peer sets skip the median checks silently; brands without
 * incentive entries raise no MISSING_REBATE.
 */

import type { AuditFinding } from "@autobroker/core";

import { DOC_FEE_HIGH_REFERENCE_USD, STATE_DOC_FEE_CAP, validateOfferMath } from "../calc.js";

// --------------------------------------------------------------------------- //
// Local row shapes (float-dollar projections; not the core Zod schema)        //
// --------------------------------------------------------------------------- //

/** A `{name?, amount?}` line-item dict carried in a quote's `*_json` array. */
export interface NamedAmount {
  name?: unknown;
  amount?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

/** The float-dollar field subset the 10 checks read off a dealer quote. */
export interface AuditQuote {
  selling_price: number | null;
  dealer_fee: number | null;
  doc_fee: number | null;
  sales_tax: number | null;
  dmv_fees: number | null;
  title_fee: number | null;
  registration_fee: number | null;
  license_fee: number | null;
  other_fees_json: NamedAmount[];
  add_ons_json: NamedAmount[];
  rebates_json: NamedAmount[];
  otd_total: number | null;
  confidence: number | null;
  extraction_method: string | null;
  financing_mode: string;
  finance_apr: number | null;
  lease_money_factor: number | null;
}

/** A peer quote — the same readable shape as the quote under audit. */
export type AuditPeer = AuditQuote;

/** One manufacturer-incentive row in the (make,model,zip) slice. */
export interface AuditIncentive {
  make: string;
  eligibility: string;
  type: string;
  amount: number | null;
}

/** The active-profile fields the checks read. */
export interface AuditProfile {
  state: string | null;
  make: string | null;
  model: string | null;
  postal_code: string | null;
  financing_preference: string | null;
  current_brand_owner: number;
  military_first_responder: number;
}

// --------------------------------------------------------------------------- //
// Constants                                                                   //
// --------------------------------------------------------------------------- //

const ADD_ON_KEYWORDS = [
  "Pro Pack",
  "Etch",
  "Nitrogen",
  "ProtectionPlus",
  "Theftguard",
  "appearance",
  "fabric",
  "prep",
] as const;

const MATH_TOLERANCE_USD = 1.0;
const APR_MARKUP_PCT = 1.5;
const MF_MARKUP_MULTIPLIER = 2.0;
const DEALER_FEE_OUTLIER_MULTIPLIER = 2.0;
const LOW_CONFIDENCE_THRESHOLD = 0.6;
// A manufacturer rebate larger than this fraction of the quote's own price is
// implausible for that vehicle — almost always a cross-model contamination in
// the incentive slice (e.g. an EV's $7,500 cash mis-attributed to a $31k
// compact SUV). The audit must not advise the buyer to demand it.
const REBATE_PLAUSIBILITY_PCT = 0.2;

// --------------------------------------------------------------------------- //
// Severity classifier — the surfacing authority                              //
// --------------------------------------------------------------------------- //

const BLOCK_CODES: ReadonlySet<string> = new Set(["UNSAFE_SALVAGE", "UNSAFE_RECALL", "UNSAFE_FLOOD"]);
const WARN_CODES: ReadonlySet<string> = new Set([
  "MATH_SANITY",
  "DOC_FEE_CAP",
  "DOC_FEE_UNCAPPED",
  "APR_MARKUP",
  "MF_MARKUP",
  "DEALER_FEE_OUTLIER",
  "MISSING_REBATE",
  "MODE_MISMATCH",
]);

/**
 * Map a finding code to its surfaced severity. Safety codes block; the fixed
 * financial warn-set + any `ADD_ON_*` warn; everything else (unknown codes,
 * MISSING_BREAKDOWN, LOW_CONFIDENCE) is info.
 */
export function classifyAuditSeverity(code: string): AuditFinding["severity"] {
  if (BLOCK_CODES.has(code)) return "block";
  if (WARN_CODES.has(code)) return "warn";
  if (code.startsWith("ADD_ON_")) return "warn";
  return "info";
}

/** Build a finding, deriving severity from the code. */
function finding(code: string, text: string, suggestion: string): AuditFinding {
  return { code, severity: classifyAuditSeverity(code), text, suggestion };
}

// --------------------------------------------------------------------------- //
// Helpers                                                                     //
// --------------------------------------------------------------------------- //

/** Normalize an add-on name to its `ADD_ON_<NAME>` code (non-alnum stripped). */
export function normalizeAddOnCode(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  return cleaned ? `ADD_ON_${cleaned}` : "ADD_ON_UNNAMED";
}

/** Median of a numeric list (even length = mean of the two middles); [] → null. */
export function medianOrNone(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Sum the numeric `amount` keys across a list of dicts; non-dicts/non-numeric → 0. */
export function sumNamedAmounts(items: readonly NamedAmount[] | null | undefined): number {
  if (!items) return 0;
  let total = 0;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const amt = (item as NamedAmount).amount;
    if (typeof amt === "number" && Number.isFinite(amt)) total += amt;
  }
  return total;
}

/** Peer finance APRs (finance-mode peers with a populated APR). */
export function peerFinanceAprs(peers: readonly AuditPeer[]): number[] {
  return peers
    .filter((p) => p.financing_mode === "finance" && p.finance_apr !== null)
    .map((p) => p.finance_apr as number);
}

/** Peer lease money factors (lease-mode peers with a populated MF). */
export function peerLeaseMfs(peers: readonly AuditPeer[]): number[] {
  return peers
    .filter((p) => p.financing_mode === "lease" && p.lease_money_factor !== null)
    .map((p) => p.lease_money_factor as number);
}

/** Per-peer (dealer_fee + Σ other-fee amounts); peers with neither contribute nothing. */
export function peerDealerPlusOther(peers: readonly AuditPeer[]): number[] {
  const out: number[] = [];
  for (const p of peers) {
    const hasOther = p.other_fees_json !== null && p.other_fees_json.length > 0;
    if (p.dealer_fee === null && !hasOther) continue;
    out.push((p.dealer_fee ?? 0) + sumNamedAmounts(p.other_fees_json));
  }
  return out;
}

/** The set of incentive `eligibility` values the profile qualifies for. */
export function profileEligibilityKinds(profile: AuditProfile): Set<string> {
  const kinds = new Set<string>(["all"]);
  if (profile.current_brand_owner) kinds.add("current_brand_owner");
  if (profile.military_first_responder) kinds.add("military_first_responder");
  const pref = (profile.financing_preference ?? "").toLowerCase();
  if (pref === "lease" || pref === "undecided") kinds.add("lease_only");
  return kinds;
}

/** Format a money value with thousands separators and 2 decimal places. */
function money2(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a money value with thousands separators, 2dp, and an explicit sign. */
function moneySigned2(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${money2(Math.abs(value))}`;
}

/** Format a whole-dollar money value with thousands separators (no decimals). */
function money0(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

// --------------------------------------------------------------------------- //
// Individual checks                                                           //
// --------------------------------------------------------------------------- //

function checkMathSanity(quote: AuditQuote): AuditFinding | null {
  // Without an extracted sales-tax amount you cannot reconcile an out-the-door
  // total: dealers routinely bundle tax into one combined "Title, tax & license
  // (TT&L)" line that does not map cleanly to sales_tax, so a null here means
  // "unknown tax", not "$0 tax". Treating it as 0 (as validateOfferMath does)
  // makes well-formed quotes whose math IS correct report a bogus multi-thousand
  // -dollar "doesn't reconcile" delta — and biases the buyer toward the least
  // transparent dealer. The incompleteness is already surfaced by
  // MISSING_BREAKDOWN, so skip MATH_SANITY (not_checked) when tax is absent and
  // only fire it when all of selling price, tax, and OTD are present and still
  // diverge — a real arithmetic error.
  if (quote.sales_tax === null) return null;

  const fees: (number | NamedAmount)[] = [];
  for (const f of [
    quote.dealer_fee,
    quote.doc_fee,
    quote.dmv_fees,
    quote.title_fee,
    quote.registration_fee,
    quote.license_fee,
  ]) {
    if (f !== null) fees.push(f);
  }
  if (quote.other_fees_json !== null && quote.other_fees_json.length > 0) {
    fees.push(...quote.other_fees_json);
  }

  const result = validateOfferMath({
    sellingPrice: quote.selling_price,
    fees,
    taxAmount: quote.sales_tax,
    statedOtd: quote.otd_total,
    tolerance: MATH_TOLERANCE_USD,
  });
  if (result.status !== "fail") return null;
  const delta = result.delta ?? 0;
  return finding(
    "MATH_SANITY",
    `Quote arithmetic doesn't reconcile: computed OTD $${money2(result.computedOtd ?? 0)} vs stated $${money2(result.statedOtd ?? 0)} (delta $${moneySigned2(delta)}).`,
    "Ask dealer for an itemized breakdown — selling price + each fee + tax — and confirm the OTD total matches.",
  );
}

function checkDocFeeCap(quote: AuditQuote, profileState: string | null): AuditFinding | null {
  if (quote.doc_fee === null || !profileState) return null;
  const stateKey = profileState.toUpperCase();
  const cap = STATE_DOC_FEE_CAP[stateKey];

  // Statutorily capped state: flag a fee over the cap (a likely overcharge).
  if (typeof cap === "number") {
    if (quote.doc_fee <= cap) return null;
    return finding(
      "DOC_FEE_CAP",
      `Doc fee $${money2(quote.doc_fee)} exceeds ${stateKey} statutory cap of $${money2(cap)}.`,
      `Ask dealer to bring doc fee within the ${stateKey} cap of $${money2(cap)}.`,
    );
  }

  // Explicitly uncapped state (cap === null): no statute to cite, but a high doc
  // fee is still a negotiation target. An ABSENT key (cap === undefined) means
  // "unknown state" — stay silent.
  if (cap === null && quote.doc_fee > DOC_FEE_HIGH_REFERENCE_USD) {
    return finding(
      "DOC_FEE_UNCAPPED",
      `Doc fee $${money2(quote.doc_fee)} is high — ${stateKey} has no statutory doc-fee cap, so it is set by the dealer.`,
      `Ask dealer to reduce the $${money2(quote.doc_fee)} doc fee; ${stateKey} doesn't cap it, so it's negotiable.`,
    );
  }
  return null;
}

function checkAprMarkup(quote: AuditQuote, peers: readonly AuditPeer[]): AuditFinding | null {
  if (quote.financing_mode !== "finance" || quote.finance_apr === null) return null;
  const median = medianOrNone(peerFinanceAprs(peers));
  if (median === null) return null;
  const threshold = median + APR_MARKUP_PCT;
  if (quote.finance_apr <= threshold) return null;
  return finding(
    "APR_MARKUP",
    `Finance APR ${quote.finance_apr.toFixed(2)}% is ${signedFixed(quote.finance_apr - median, 2)} pp above the peer median ${median.toFixed(2)}%.`,
    `Ask dealer to match the buy rate or push them toward the peer median (~${median.toFixed(2)}%).`,
  );
}

function checkMfMarkup(quote: AuditQuote, peers: readonly AuditPeer[]): AuditFinding | null {
  if (quote.financing_mode !== "lease" || quote.lease_money_factor === null) return null;
  const median = medianOrNone(peerLeaseMfs(peers));
  if (median === null || median <= 0) return null;
  if (quote.lease_money_factor <= median * MF_MARKUP_MULTIPLIER) return null;
  return finding(
    "MF_MARKUP",
    `Lease money factor ${quote.lease_money_factor.toFixed(5)} is more than 2× the peer median ${median.toFixed(5)}.`,
    "Ask dealer for the buy-rate money factor; this quote is marked up vs other dealers in your search.",
  );
}

function checkDealerFeeOutlier(quote: AuditQuote, peers: readonly AuditPeer[]): AuditFinding | null {
  const hasOther = quote.other_fees_json !== null && quote.other_fees_json.length > 0;
  if (quote.dealer_fee === null && !hasOther) return null;
  const quoteTotal = (quote.dealer_fee ?? 0) + sumNamedAmounts(quote.other_fees_json);
  const median = medianOrNone(peerDealerPlusOther(peers));
  if (median === null || median <= 0) return null;
  if (quoteTotal <= median * DEALER_FEE_OUTLIER_MULTIPLIER) return null;
  return finding(
    "DEALER_FEE_OUTLIER",
    `Dealer + other fees total $${money2(quoteTotal)}, more than 2× the peer median $${money2(median)}.`,
    "Ask dealer to itemize and waive the non-statutory dealer fees; peer dealers in your search are charging far less.",
  );
}

function checkMissingRebate(
  quote: AuditQuote,
  incentives: readonly AuditIncentive[],
  profile: AuditProfile,
): AuditFinding[] {
  if (incentives.length === 0) return [];
  const profileMake = (profile.make ?? "").toLowerCase();
  if (!profileMake) return [];

  const eligibleKinds = profileEligibilityKinds(profile);
  const appliedStrings: string[] = [];
  for (const r of quote.rebates_json ?? []) {
    if (typeof r !== "object" || r === null) continue;
    appliedStrings.push(String((r as NamedAmount).type ?? "").toLowerCase());
    appliedStrings.push(String((r as NamedAmount).name ?? "").toLowerCase());
  }

  // A manufacturer publishes many customer_cash (etc.) variants for one make —
  // different ZIP/term/trim slices — but they are mutually EXCLUSIVE, not
  // stackable: a buyer applies at most one rebate per type. Emitting one finding
  // per incentive row over-states the missed savings (e.g. "10 rebates not
  // applied" summing to ~$38k). Collapse to the single best (highest) unapplied
  // amount per rebate TYPE, and note how many variants exist.
  // Anchor on this quote's own price so the plausibility ceiling scales with the
  // vehicle (20% of a $31k SUV = $6.2k; 20% of a $60k EV = $12k). When neither
  // price is known the guard fails open — a no-price quote is already flagged
  // MISSING_BREAKDOWN, and we never silently drop a rebate on a weak signal.
  const rebatePriceAnchor = quote.selling_price ?? quote.otd_total;
  const bestByType = new Map<string, { amount: number; count: number }>();
  for (const inc of incentives) {
    if ((inc.make ?? "").toLowerCase() !== profileMake) continue;
    const incEligibility = (inc.eligibility ?? "").toLowerCase();
    if (!eligibleKinds.has(incEligibility)) continue;
    const incType = (inc.type ?? "").toLowerCase();
    if (incType && appliedStrings.some((s) => s && s.includes(incType))) continue;
    const amount = inc.amount ?? 0;
    if (rebatePriceAnchor !== null && amount > rebatePriceAnchor * REBATE_PLAUSIBILITY_PCT) {
      continue;
    }
    const prev = bestByType.get(incType);
    if (prev === undefined) bestByType.set(incType, { amount, count: 1 });
    else bestByType.set(incType, { amount: Math.max(prev.amount, amount), count: prev.count + 1 });
  }

  const flags: AuditFinding[] = [];
  for (const [incType, { amount, count }] of bestByType) {
    const variantNote = count > 1 ? ` (best of ${count} ${incType} offers — not stackable)` : "";
    flags.push(
      finding(
        "MISSING_REBATE",
        `Quote does not apply the $${money0(amount)} ${incType} rebate${variantNote}.`,
        `Ask dealer to apply the $${money0(amount)} ${incType} rebate — confirm eligibility documentation if required.`,
      ),
    );
  }
  return flags;
}

function checkAddOns(quote: AuditQuote): AuditFinding[] {
  const matches = new Map<string, { name: string; amount: number }>();
  for (const source of [quote.other_fees_json, quote.add_ons_json]) {
    if (!source || source.length === 0) continue;
    for (const item of source) {
      if (typeof item !== "object" || item === null) continue;
      const rawName = (item as NamedAmount).name;
      if (typeof rawName !== "string" || rawName.trim() === "") continue;
      const amt = (item as NamedAmount).amount;
      const amount = typeof amt === "number" && Number.isFinite(amt) ? amt : 0;
      const lowered = rawName.toLowerCase();
      for (const kw of ADD_ON_KEYWORDS) {
        if (lowered.includes(kw.toLowerCase())) {
          const code = normalizeAddOnCode(rawName);
          if (!matches.has(code)) matches.set(code, { name: rawName, amount });
          break;
        }
      }
    }
  }

  const flags: AuditFinding[] = [];
  for (const [code, { name, amount }] of matches) {
    const amtStr = amount > 0 ? ` ($${money0(amount)})` : "";
    flags.push(
      finding(
        code,
        `Quote includes likely dealer add-on "${name}"${amtStr} — common negotiation target.`,
        `Ask dealer to remove ${name}${amtStr}; these products are typically optional and high-margin.`,
      ),
    );
  }
  return flags;
}

function checkModeMismatch(quote: AuditQuote, profile: AuditProfile): AuditFinding | null {
  const pref = (profile.financing_preference ?? "").toLowerCase();
  if (pref === "" || pref === "undecided") return null;
  if (quote.financing_mode === pref) return null;
  return finding(
    "MODE_MISMATCH",
    `Quote financing mode is '${quote.financing_mode}' but profile prefers '${pref}'.`,
    `Ask dealer for a ${pref} quote, or switch the profile preference if you've changed plans.`,
  );
}

function checkLowConfidence(quote: AuditQuote): AuditFinding | null {
  if (quote.extraction_method === "ocr") {
    return finding(
      "LOW_CONFIDENCE",
      "Extracted via OCR fallback — fidelity lower than native vision.",
      "Re-extract with a different model or ask dealer for a clarified text quote.",
    );
  }
  if (quote.confidence !== null && quote.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return finding(
      "LOW_CONFIDENCE",
      `Extraction confidence is low (${quote.confidence.toFixed(2)}); some fields may be inaccurate.`,
      "Re-extract with a different model or ask dealer for a clarified text quote.",
    );
  }
  return null;
}

function checkMissingBreakdown(quote: AuditQuote): AuditFinding | null {
  if (quote.otd_total === null) return null;
  if (quote.selling_price !== null && quote.doc_fee !== null && quote.sales_tax !== null) return null;
  return finding(
    "MISSING_BREAKDOWN",
    "Quote has OTD total but missing line-item breakdown (selling price, doc fee, or sales tax).",
    "Ask dealer for itemized OTD: selling price + each fee + tax breakdown.",
  );
}

/** Fixed-decimal value with an explicit leading sign. */
function signedFixed(value: number, digits: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

// --------------------------------------------------------------------------- //
// Dispatcher                                                                  //
// --------------------------------------------------------------------------- //

/**
 * Run all 10 audit checks against `quote` and return the firing findings in
 * dispatcher order. Empty peers/incentives are supported (median checks skip,
 * no MISSING_REBATE).
 */
export function auditQuote(
  quote: AuditQuote,
  peerQuotes: readonly AuditPeer[],
  incentives: readonly AuditIncentive[],
  profile: AuditProfile,
): AuditFinding[] {
  const flags: AuditFinding[] = [];
  const push = (f: AuditFinding | null): void => {
    if (f !== null) flags.push(f);
  };

  push(checkMathSanity(quote));
  push(checkDocFeeCap(quote, profile.state));
  push(checkAprMarkup(quote, peerQuotes));
  push(checkMfMarkup(quote, peerQuotes));
  push(checkDealerFeeOutlier(quote, peerQuotes));
  flags.push(...checkMissingRebate(quote, incentives, profile));
  flags.push(...checkAddOns(quote));
  push(checkModeMismatch(quote, profile));
  push(checkLowConfidence(quote));
  push(checkMissingBreakdown(quote));

  return flags;
}
