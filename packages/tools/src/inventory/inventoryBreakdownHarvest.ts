/**
 * inventoryBreakdownHarvest — deterministic, label-anchored harvest of the
 * DEALER price-breakdown items from a rendered VDP text snapshot: the dealer's
 * own LABELED market adjustment (markup) and dealer add-on line items (the junk
 * buyers hate). Pure, regex-only, NO LLM, NO I/O. Fails CLOSED to null/[]/false
 * on any ambiguity — it NEVER invents a number.
 *
 * Sibling to inventoryPriceHarvest (which captures MSRP + selling price). This
 * mirrors that module's discipline — label-vocab anchors, a tight currency
 * window, a plausible band, fail-closed-to-null — but has its OWN regex, band,
 * and guards. In particular it does NOT reuse the price module's hasPitfall: its
 * doc/fee/destination prefixes would reject the very add-on numbers this module
 * must capture (a $90 nitrogen line, a $50 wheel-lock line).
 *
 * Two hard correctness rules baked in:
 *   1. dealerMarkup is LABELED-ONLY. Markup is asserted ONLY when the dealer
 *      wrote "Market Adjustment / ADM / Additional Dealer Markup / ADP / Adjusted
 *      Market Value / Additional Dealer Profit" with a positive $ IMMEDIATELY
 *      adjacent. The selling>MSRP delta is NOT used — it fabricates numbers
 *      (cross-region snapshot mismatch; Total MSRP = base+options+destination is
 *      not reconstructable from a flat snapshot).
 *   2. Government charges (tax/title/registration/license/DMV/doc fee/e-filing)
 *      and the manufacturer destination/freight are EXCLUDED — they are fees,
 *      not dealer junk add-ons (the OTD fee stack/cap is quote_audit's domain).
 */

export interface HarvestedBreakdown {
  /** LABELED market-adjustment / ADM markup with an adjacent positive $, ONLY.
   *  null on no label, no adjacent $, negation, or out-of-band amount. */
  dealerMarkup: number | null;
  /** Dealer add-on line items (physical / F&I junk), deduped by (label, amount). */
  addOns: { label: string; amount: number }[];
  /** Sum of addOns.amount, or null when addOns is empty. */
  addonsTotal: number | null;
  /** True iff a recognizable pricing region was found at all — lets the UI
   *  distinguish "couldn't read a breakdown" (false) from "read one, found no
   *  markup/add-ons" (true). Conservative: keys off a price label, a recorded
   *  markup/add-on, or a vehicle-scale $ amount — never trivially true. */
  breakdownParsed: boolean;
}

/** Currency token allowing 2-DIGIT amounts (so "$90", "$50" are caught — the key
 *  difference from inventoryPriceHarvest, whose 4-digit-minimum regex would skip
 *  small add-ons). `$` then 1–9 leading digits with optional thousands commas,
 *  optional cents. Capturing group 1 is the digits (commas included). */
const CURRENCY_RE = /\$\s?([0-9][0-9,]{0,8})(?:\.\d{2})?/g;

/** LABELED dealer-markup anchors (lowercased; text is lowercased before match). */
const MARKUP_ANCHORS: readonly RegExp[] = [
  /market\s*(?:value\s*)?adjustment/g,
  /adjusted\s+market\s+value/g,
  /additional\s+dealer\s+mark[- ]?up/g,
  /additional\s+dealer\s+profit/g,
  /\badm\b/g,
  /\badp\b/g,
];

/** Add-on label vocabulary (research-07). Each maps a regex to a canonical label.
 *  `bundle` marks a package TOTAL line that must be dropped when its components
 *  are separately itemized. First match in this order wins for a given window;
 *  bundle anchors lead so a "Protection Package" total is tagged before any
 *  component-style match could fire. */
const ADDON_ANCHORS: readonly { re: RegExp; label: string; bundle: boolean }[] = [
  { re: /appearance\s+package/, label: "appearance package", bundle: true },
  { re: /protection\s+package/, label: "protection package", bundle: true },
  // tire / wheel
  { re: /\bnitrogen\b|\bn2\b/, label: "nitrogen", bundle: false },
  { re: /wheel\s*locks?/, label: "wheel lock", bundle: false },
  // anti-theft / etch (huge alias surface)
  { re: /\bvin\s*etch(?:ing)?\b|\bwindow\s*etch(?:ing)?\b/, label: "vin etch", bundle: false },
  {
    re: /\bvtr\b|phantom\s+footprint|theft\s+code|courtesy\s+guard|anti-?theft|theft\s+deterrent/,
    label: "anti-theft",
    bundle: false,
  },
  // paint / fabric / surface protection + brand aliases
  {
    re: /paint\s+protection|fabric\s+protection|ceramic\s+coating|interior\s+protection|paint\s+sealant|clear\s*bra|undercoat(?:ing)?|rustproof(?:ing)?/,
    label: "protection",
    bundle: false,
  },
  {
    re: /\bzaktek\b|\bxzilon\b|\bpermaplate\b|zurich\s+shield|\bcilajet\b/,
    label: "protection",
    bundle: false,
  },
  // cosmetic / accessory
  { re: /pinstrip(?:e|ing)/, label: "pinstripe", bundle: false },
  { re: /mud\s*flaps?|splash\s*guards?|mud\s*guards?/, label: "mud flaps", bundle: false },
  { re: /door[- ]?edge\s*guards?/, label: "door edge guard", bundle: false },
  // tracking
  { re: /\bgps\b|\blojack\b|\btracker\b|elo-?gps/, label: "gps", bundle: false },
  // dealer overhead masquerading as a line item (junk per research-07)
  {
    re: /dealer\s+prep|pre[- ]?delivery|\bpdi\b|vehicle\s+prep|reconditioning/,
    label: "dealer prep",
    bundle: false,
  },
];

/** Government + manufacturer charges that are NOT dealer junk add-ons (fees are
 *  quote_audit's domain). An exclusion adjacent to a $ disqualifies it as an
 *  add-on. Non-global → stateless `.test()`. */
const EXCLUSION_RE =
  /\btax\b|\btitle\b|\bregistration\b|\blicense\b|\bdmv\b|\bdoc\b|\bdocumentation\b|\bdocument\s+preparation\b|e-?filing|electronic\s+filing|\bdestination\b|\bfreight\b/;

/** Disclaimer / nav-menu / "no charge" context that means a labeled item is NOT
 *  actually being charged here. Mandatory false-positive defense. Non-global. */
const NEGATION_RE =
  /\bno\b|\bfree\b|\bincluded\b|\bcomplimentary\b|\bwaived\b|not\s+required|\bavailable\b|\bshop\b|\bexplore\b|optional\s+at|\$0(?!\d)/;

/** Price-region labels — used only to decide breakdownParsed. Non-global. */
const PRICE_LABEL_RE =
  /\bmsrp\b|sticker\s+price|retail\s+price|selling\s+price|sale\s+price|purchase\s+price|cash\s+price|internet\s+price|\bour\s+price\b|your\s+price|best\s+price|e-?price|net\s+price|final\s+price|manufacturer'?s?\s+suggested\s+retail|market\s*(?:value\s*)?adjustment/;

/** Plausible LABELED-markup band — rejects $0 / fee-sized and absurd amounts. */
const MARKUP_MIN = 100;
const MARKUP_MAX = 50_000;
/** How far after a markup anchor a $ may sit and still be ITS amount — tight, so
 *  an unrelated nearby price (e.g. a trailing MSRP) is never grabbed as markup. */
const MARKUP_WINDOW_AFTER = 14;
/** Window before a markup anchor scanned for a negation ("no market adjustment"). */
const MARKUP_NEG_BEFORE = 15;

/** Plausible dealer-add-on band — the vehicle band (5k–250k) is WRONG here; junk
 *  add-ons run ~$25 (wheel locks) to ~$3,000 (loaded protection packages). */
const ADDON_MIN = 25;
const ADDON_MAX = 3_000;
/** How far from a $ an add-on label may sit and still own it. Cross-item bleed is
 *  prevented by also bounding each window at the neighbouring $ amount. */
const ADDON_WINDOW = 40;

/** Vehicle-scale $ band — a number this big is a price-context signal even with
 *  no nearby label (for breakdownParsed only). */
const VEHICLE_MIN = 1_000;
const VEHICLE_MAX = 250_000;

interface AmountHit {
  amount: number;
  start: number;
  end: number;
}

/** Parse a `$12,345`-style token's digits into a number, or null. */
function parseAmount(digits: string): number | null {
  const n = Number(digits.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Collect every currency amount (position + value) from the lowercased text. */
function collectAmounts(textLc: string): AmountHit[] {
  const hits: AmountHit[] = [];
  CURRENCY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CURRENCY_RE.exec(textLc)) !== null) {
    const amount = parseAmount(m[1]!);
    if (amount !== null) hits.push({ amount, start: m.index, end: m.index + m[0].length });
  }
  return hits;
}

/** Find the canonical add-on for a window, or null. First anchor in vocab order. */
function matchAddon(window: string): { label: string; bundle: boolean } | null {
  for (const a of ADDON_ANCHORS) {
    if (a.re.test(window)) return { label: a.label, bundle: a.bundle };
  }
  return null;
}

/**
 * LABELED-ONLY markup: the FIRST markup anchor with a positive in-band $ sitting
 * immediately after it, and no negation around it. Returns null otherwise — we
 * never infer markup from a price delta.
 */
function findMarkup(textLc: string): number | null {
  for (const re of MARKUP_ANCHORS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(textLc)) !== null) {
      const anchorStart = m.index;
      const anchorEnd = m.index + m[0].length;
      const window = textLc.slice(anchorEnd, anchorEnd + MARKUP_WINDOW_AFTER);
      CURRENCY_RE.lastIndex = 0;
      const cm = CURRENCY_RE.exec(window);
      if (cm === null) continue;
      const amount = parseAmount(cm[1]!);
      if (amount === null || amount < MARKUP_MIN || amount > MARKUP_MAX) continue;
      const amountEnd = anchorEnd + cm.index + cm[0].length;
      const negWindow = textLc.slice(Math.max(0, anchorStart - MARKUP_NEG_BEFORE), amountEnd);
      if (NEGATION_RE.test(negWindow)) continue;
      return amount;
    }
  }
  return null;
}

/**
 * Harvest dealer add-ons. Each $ amount is classified by the label IMMEDIATELY
 * adjacent to it — preferring the "Label $X" form (window before the amount),
 * falling back to "$X Label" (window after) only when the before-window is
 * uninformative. Both windows are bounded by the neighbouring $ so one item's
 * label can never reach across to a sibling's amount (e.g. the "Doc Fee" after a
 * "Nitrogen $90" line belongs to the NEXT amount, not to the nitrogen).
 */
function findAddOns(textLc: string, amounts: AmountHit[]): { label: string; amount: number }[] {
  const collected: { label: string; amount: number; bundle: boolean }[] = [];

  for (let i = 0; i < amounts.length; i++) {
    const a = amounts[i]!;
    if (a.amount < ADDON_MIN || a.amount > ADDON_MAX) continue;

    const lowerBound = i > 0 ? amounts[i - 1]!.end : 0;
    const upperBound = i < amounts.length - 1 ? amounts[i + 1]!.start : textLc.length;
    const before = textLc.slice(Math.max(lowerBound, a.start - ADDON_WINDOW), a.start);
    const after = textLc.slice(a.end, Math.min(upperBound, a.end + ADDON_WINDOW));
    const negated = NEGATION_RE.test(before) || NEGATION_RE.test(after);

    // "Label $X": classify by the preceding label (the dominant line-item form).
    if (EXCLUSION_RE.test(before)) continue; // a fee / gov / destination line
    const beforeHit = matchAddon(before);
    if (beforeHit !== null) {
      if (negated) continue;
      collected.push({ label: beforeHit.label, amount: a.amount, bundle: beforeHit.bundle });
      continue;
    }

    // "$X Label": only consulted when the before-window held no label at all.
    if (EXCLUSION_RE.test(after)) continue;
    const afterHit = matchAddon(after);
    if (afterHit !== null) {
      if (negated) continue;
      collected.push({ label: afterHit.label, amount: a.amount, bundle: afterHit.bundle });
    }
  }

  // Drop a bundle TOTAL only when its components are actually itemized — i.e. the
  // separately-listed NON-bundle add-ons reconstruct the total (their sum >= the
  // bundle's own amount). A standalone bundle, OR one sitting beside only smaller
  // UNRELATED add-ons whose sum stays below it, is KEPT (it is not a double-count).
  const itemizedTotal = collected
    .filter((c) => !c.bundle)
    .reduce((sum, c) => sum + c.amount, 0);
  const kept = collected.filter((c) => !c.bundle || itemizedTotal < c.amount);

  // Dedup by (label, amount).
  const seen = new Set<string>();
  const out: { label: string; amount: number }[] = [];
  for (const c of kept) {
    const key = `${c.label}|${c.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: c.label, amount: c.amount });
  }
  return out;
}

/**
 * Harvest the dealer price-breakdown (labeled markup + add-on line items) from a
 * rendered VDP text snapshot. Deterministic, pure, fail-closed.
 */
export function harvestBreakdownFromSnapshot(snapshotText: string): HarvestedBreakdown {
  const textLc = snapshotText.toLowerCase();
  const amounts = collectAmounts(textLc);

  const dealerMarkup = findMarkup(textLc);
  const addOns = findAddOns(textLc, amounts);
  const addonsTotal =
    addOns.length > 0 ? addOns.reduce((sum, a) => sum + a.amount, 0) : null;

  const vehicleScale = amounts.some((a) => a.amount >= VEHICLE_MIN && a.amount <= VEHICLE_MAX);
  const breakdownParsed =
    dealerMarkup !== null || addOns.length > 0 || PRICE_LABEL_RE.test(textLc) || vehicleScale;

  return { dealerMarkup, addOns, addonsTotal, breakdownParsed };
}
