/**
 * inventoryPriceHarvest — deterministic, label-anchored price harvest from a
 * rendered Vehicle-Detail-Page (VDP) text snapshot. Pure, regex-only, NO LLM.
 *
 * Why this exists: `inventory_site_scan`'s LLM extraction reads only the
 * search-results page (SRP) card snapshot, where many dealers gate the price
 * behind a "Get Instant Price" CTA — so `price` comes back null even though the
 * VDP (which the scan ALREADY loads, to harvest the VIN) shows MSRP and the
 * selling price openly. This harvest runs over that same already-fetched VDP
 * snapshot (no extra page load, no extra LLM call), so the captured number
 * never reaches a model — it stays pure deterministic text parsing, preserving
 * the "VDPs never reach an LLM" invariant.
 *
 * Generalization (not over-fit to any one dealer/platform): the four major
 * dealer platforms (DealerOn, DealerFire, DealerInspire, Dealer.com) all render
 * a dealer-CHOSEN "price stack" with dealer-chosen label text. So this anchors
 * on the LABEL VOCABULARY, never on platform identity or positional offsets,
 * and rejects the numbers that are NOT the cash price ($/mo payments, APR,
 * down-payment, fee-only, discounts/savings, strikethrough "was" prices).
 */

/** MSRP-family labels (the sticker price; most reliably open even when the
 *  selling price is gated). Case-insensitive substring anchors. */
const MSRP_LABELS: readonly string[] = [
  "manufacturer's suggested retail price",
  "manufacturer suggested retail price",
  "msrp",
  "sticker price",
  "retail price",
  // Dealer.com (DDC) "Transparent Pricing" stack: the sticker line is labeled
  // "Total SRP" (no "MSRP" word on the page at all).
  "total srp",
];

/** Selling/cash-price labels in PRIORITY order (earliest = strongest signal of
 *  the as-shown cash price). On multiple matches the earliest-ranked label
 *  wins; on a tie the LAST document occurrence wins (bottom of the price stack,
 *  after discounts/incentives). */
const SELLING_LABELS: readonly string[] = [
  "cash purchase price",
  "purchase price",
  "cash price",
  "sale price",
  "selling price",
  "internet sale price",
  "internet price",
  "our best price",
  "our price",
  "dealer sale price",
  "dealer price",
  "your price",
  "special price",
  "e-price",
  "eprice",
  "net price",
  "price after savings",
  "final price",
  "best price",
  // Dealer.com (DDC) "Transparent Pricing" stack: the as-shown post-adjustment
  // cash price is labeled "Transparent Price" (followed by a "No Hidden Fees"
  // caption — see NEGATED_FEE_RE, which keeps that caption from tripping the
  // fee pitfall on the adjacent amount). Ranked last so a stronger explicit
  // label (sale/internet/your price) still wins on a mixed page.
  "transparent price",
];

/** Phrases that mean the price is legitimately WITHHELD behind a CTA — a null
 *  price here is correct behavior, not a scan failure. */
const GATED_SIGNALS: readonly string[] = [
  "get instant price",
  "get your price",
  "get e-price",
  "get eprice",
  "see final price",
  "see price",
  "unlock price",
  "unlock savings",
  "unlock pricing",
  "unlock your price",
  "click for price",
  "call for price",
  "call for pricing",
  "please call for price",
  "please call",
  "contact us for price",
  "contact dealer for price",
  "contact for price",
  "price available upon request",
  "price upon request",
  "request a price",
  "request quote",
  "sign in for price",
];

/** Tokens that LABEL the number they PRECEDE — when one sits just before the
 *  `$`, the amount is a fee / discount-savings delta / down payment / trade-in /
 *  strikethrough "was" price, never the vehicle's cash price. Checked ONLY in
 *  the window BEFORE the `$` so a fee/savings line that follows a real price
 *  (e.g. "Purchase Price $38,018 You Save $1,127") cannot poison that price. */
const PREFIX_PITFALLS: readonly string[] = [
  "fee",
  "doc",
  "destination",
  "freight",
  "save",
  "saving",
  "discount",
  "rebate",
  "trade",
  "lease",
  "was ",
  "down",
  "payment",
  "due at signing",
];

/** Tokens that QUALIFY the number they immediately FOLLOW — a monthly payment
 *  or APR. Checked ONLY in the window AFTER the `$`, and that window stops at
 *  the next `$` so a qualifier belonging to a LATER amount cannot reach back.
 *  (Down-payment / due-at-signing words LABEL the amount they precede, so they
 *  live in PREFIX_PITFALLS, never here — else a "$X down" estimator line after a
 *  real price would null it.) */
const SUFFIX_PITFALLS: readonly string[] = [
  "/mo",
  "/month",
  "per month",
  "a month",
  "monthly",
  "apr",
  "%",
];

/** Plausible vehicle-price band — rejects fee-sized and obviously-wrong numbers. */
const MIN_PRICE = 5_000;
const MAX_PRICE = 250_000;

/** How far after a label a $-amount may sit and still belong to it. */
const LABEL_TO_PRICE_WINDOW = 40;

/** Dealer.com's "No Hidden Fees" transparency caption sits between the
 *  "Transparent Price" label and its amount. It contains the substring "fee" but
 *  is the OPPOSITE of a fee charge — strip it from the before-window before the
 *  prefix-pitfall scan so it cannot reject the adjacent transparent price.
 *  Narrow on purpose: only the negated slogan is removed; a real "Doc Fee" /
 *  "Dealer Fee" line is untouched and still rejects its amount. */
const NEGATED_FEE_RE = /no\s+hidden\s+fees?/g;

/** Window BEFORE a $-amount scanned for label (prefix) pitfalls. */
const PITFALL_BEFORE = 20;
/** Window AFTER a $-amount scanned for qualifier (suffix) pitfalls. */
const PITFALL_AFTER = 16;

export interface HarvestedPrice {
  /** The as-shown selling/cash price, or null when none resolves. */
  listedPrice: number | null;
  /** The MSRP/sticker price, or null. */
  msrp: number | null;
  /** True when the page shows a price-withheld CTA and no selling price
   *  resolved — a CORRECT null, not a capture failure. */
  priceGated: boolean;
}

/** Currency token: `$` then 4–8 leading digits with optional thousands commas,
 *  optional cents. Capturing group 1 is the digits (commas included). */
const CURRENCY_RE = /\$\s?([0-9][0-9,]{2,8})(?:\.\d{2})?/g;

/** Parse a `$12,345`-style token's digits into a number, or null. */
function parseAmount(digits: string): number | null {
  const n = Number(digits.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** True when a $-amount is a non-cash-price number: a label pitfall sits just
 *  BEFORE it (fee/savings/discount/down/was) or a qualifier pitfall sits just
 *  AFTER it (/mo/apr/%). The two windows are asymmetric on purpose — a pitfall
 *  word labels the number ADJACENT to it, not one across the stack, so a
 *  trailing "You Save $X" line never poisons the price it follows. */
function hasPitfall(haystackLc: string, amountStart: number, amountLen: number): boolean {
  // Before-window: back PITFALL_BEFORE chars, but not past a PRIOR `$` (a label
  // before that `$` belongs to that earlier amount, not this one).
  let beforeFrom = Math.max(0, amountStart - PITFALL_BEFORE);
  const prevDollar = haystackLc.lastIndexOf("$", amountStart - 1);
  if (prevDollar >= beforeFrom) beforeFrom = prevDollar + 1;
  // Strip the "No Hidden Fees" transparency slogan so its "fee" substring does
  // not falsely reject a Dealer.com "Transparent Price" amount.
  const before = haystackLc.slice(beforeFrom, amountStart).replace(NEGATED_FEE_RE, " ");

  // After-window: a true qualifier (/mo, apr, %) attaches IMMEDIATELY to the
  // amount (only whitespace between), so check the LEADING token, not the whole
  // window. A "$34,995 0% APR" financing line introduces its OWN number ("0")
  // first, so it does not start with a qualifier and cannot poison this price.
  const afterStart = amountStart + amountLen;
  const afterAdjacent = haystackLc
    .slice(afterStart, Math.min(haystackLc.length, afterStart + PITFALL_AFTER))
    .replace(/^\s+/, "");

  return (
    PREFIX_PITFALLS.some((t) => before.includes(t)) ||
    SUFFIX_PITFALLS.some((t) => afterAdjacent.startsWith(t))
  );
}

/**
 * Find the first plausible cash $-amount that sits within LABEL_TO_PRICE_WINDOW
 * chars after `label`'s occurrence, rejecting pitfall-context numbers and
 * out-of-band amounts. Returns the LAST qualifying occurrence of the label
 * (bottom of a repeated stack) and its amount, or null.
 */
function priceForLabel(textLc: string, label: string): { amount: number; at: number } | null {
  let best: { amount: number; at: number } | null = null;
  let from = 0;
  for (;;) {
    const labelAt = textLc.indexOf(label, from);
    if (labelAt === -1) break;
    from = labelAt + label.length;
    const windowStart = labelAt + label.length;
    const window = textLc.slice(windowStart, windowStart + LABEL_TO_PRICE_WINDOW);
    CURRENCY_RE.lastIndex = 0;
    const m = CURRENCY_RE.exec(window);
    if (m !== null) {
      const amount = parseAmount(m[1]!);
      const absStart = windowStart + m.index;
      if (
        amount !== null &&
        amount >= MIN_PRICE &&
        amount <= MAX_PRICE &&
        !hasPitfall(textLc, absStart, m[0].length)
      ) {
        // Keep the LAST qualifying label occurrence (stacks render the final
        // post-discount price lower in the document).
        best = { amount, at: labelAt };
      }
    }
  }
  return best;
}

/**
 * Harvest MSRP + selling price from a rendered VDP text snapshot. Deterministic,
 * fails CLOSED to null on any gate or ambiguity, never invents a price from an
 * unlabeled number.
 */
export function harvestPriceFromSnapshot(snapshotText: string): HarvestedPrice {
  const textLc = snapshotText.toLowerCase();

  // MSRP: first matching label family.
  let msrp: number | null = null;
  for (const label of MSRP_LABELS) {
    const hit = priceForLabel(textLc, label);
    if (hit !== null) {
      msrp = hit.amount;
      break;
    }
  }

  // Selling price: earliest-ranked label wins; ties already resolved to the
  // bottom-of-stack occurrence inside priceForLabel.
  let listedPrice: number | null = null;
  for (const label of SELLING_LABELS) {
    const hit = priceForLabel(textLc, label);
    if (hit !== null) {
      listedPrice = hit.amount;
      break;
    }
  }

  // A selling price above MSRP is suspect — drop to null rather than guess.
  if (listedPrice !== null && msrp !== null && listedPrice > msrp) {
    listedPrice = null;
  }

  const gatedSignalPresent = GATED_SIGNALS.some((s) => textLc.includes(s));
  const priceGated = listedPrice === null && gatedSignalPresent;

  return { listedPrice, msrp, priceGated };
}
