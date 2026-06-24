/**
 * quotes/compare — the deterministic quote-compare ranker. Reads one profile's
 * dealer_quotes (LEFT-JOINed to the LATEST audit row per quote and to the dealer
 * display name), gates by the profile's financing_preference, and ranks each
 * mode bucket by out-the-door total (NULL sorts LAST, stable on ties). ZERO-LLM,
 * read-only: no INSERT/UPDATE/DELETE.
 *
 * Latest-audit-per-quote is a correlated subquery ordered (audited_at DESC,
 * audit_id DESC) LIMIT 1 — NOT MAX(audit_id). The two-key ORDER BY is the
 * same-timestamp tiebreak: when two audit rows share an audited_at (e.g. two
 * passes pinned to one timestamp), audit_id DESC picks the most-recently-written
 * one, and the LIMIT-1 subquery joins exactly one audit per quote (no row dupe).
 *
 * GATING (financing_preference):
 *   - "cash" OR profile-not-found / NULL preference → BOTH lists empty.
 *   - "finance" → finance bucket only (lease empty).
 *   - "lease"   → lease bucket only (finance empty).
 *   - "undecided" / any unrecognized non-cash value → BOTH buckets.
 * Only finance/lease-mode quotes ever enter a bucket; cash/unspecified-mode rows
 * are dropped from both.
 *
 * SQLITE INVARIANT: only packages/tools (and db beneath it) touch the product
 * DB. Raw better-sqlite3 statements via db.$client — NO drizzle-orm import.
 */

import type { Db } from "@autobroker/db";

import {
  attributeOtdDelta,
  homeStateTaxRate,
  normalizeQuoteTax,
  type OtdComponents,
} from "./crossState.js";
import { flagCodesFromJson } from "./flags.js";

/**
 * One ranked compare row. `rank` is 1-indexed within its mode bucket;
 * `dealer_name` is COALESCE(dealers.name, dealer_id); `otd_total` null sorts
 * last; `apr_or_mf` is the preformatted display string (`"7.9%"` finance /
 * `"MF 0.00125"` lease / `""` neither); `audit_flag_summary` is ALWAYS a list
 * (the decoded `code`s of the latest audit, empty when no/unparsable audit).
 */
export interface QuoteRanking {
  rank: number;
  quote_id: string;
  dealer_id: string;
  dealer_name: string;
  otd_total: number | null;
  apr_or_mf: string;
  down_or_das: number | null;
  monthly: number | null;
  audit_flag_summary: string[];
  financing_mode: string;
  /** Tax re-computed at the buyer's HOME-state rate (sales/use tax follows the
   *  registration state, not the dealer's). null when un-normalizable (unknown
   *  state / missing selling price). The cross-state apples-to-apples tax. */
  normalized_tax: number | null;
  /** otd_total with the dealer-stated tax swapped for {@link normalized_tax}
   *  (everything else held). null when un-normalizable. The honest cross-state
   *  drive-off cost to THIS buyer. */
  normalized_otd: number | null;
  /** Why this row's normalized OTD differs from the bucket's best (lowest
   *  normalized OTD) — decomposed into sale-price / doc-fee / tax / incentive /
   *  other. null for the baseline row itself and for un-normalizable rows. */
  attribution: OtdAttributionRow | null;
}

/** The signed decomposition of a row's normalized-OTD gap to the bucket baseline.
 *  The five component deltas reconcile to `otd_delta` to the cent (2-dp;
 *  `other_delta` is the reconciling residual). Negative = cheaper than baseline. */
export interface OtdAttributionRow {
  /** The quote_id of the baseline (lowest normalized OTD in the bucket). */
  baseline_quote_id: string;
  otd_delta: number;
  sale_price_delta: number;
  doc_fee_delta: number;
  tax_delta: number;
  incentive_delta: number;
  other_delta: number;
}

/** Ranked compare output, grouped by financing mode. Both lists are ALWAYS
 *  present — the empty off-mode side is the contract (no caller branches on
 *  null). `financingPreference` is the loaded profile preference (null when the
 *  profile is missing or the column is NULL). */
export interface CompareResult {
  financingPreference: string | null;
  finance: QuoteRanking[];
  lease: QuoteRanking[];
  /** Cash quotes ranked by OTD. Populated for a cash-preference buyer (whose
   *  quotes are all OTD totals, not payments). Empty for finance/lease/undecided,
   *  where cash quotes already ride along as off-mode rows inside the finance view. */
  cash: QuoteRanking[];
  /** The buyer's home (registration) state — the rate source for cross-state tax
   *  normalization. null when the profile carries no state. */
  homeState: string | null;
  /** The home-state sales/use tax rate applied to every quote (fraction, e.g.
   *  0.0725). null when the state is unknown / missing (no normalization). */
  homeStateTaxRate: number | null;
}

// ---------------------------------------------------------------------------
// coercion helpers (raw SQLite rows are loose snake_case dicts)
// ---------------------------------------------------------------------------

/** Coerce a DB value to a finite number, or null. */
function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a DB value to a string, or "" (the empty-default the ranker uses for
 *  dealer_id / financing_mode fallbacks). */
function asStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

// ---------------------------------------------------------------------------
// per-row formatting (mode-conditional — matches the bucket the row sits in)
// ---------------------------------------------------------------------------

/** Render finance_apr (one decimal, `"7.9%"`) or lease_money_factor (five
 *  decimals, `"MF 0.00125"`), or `""` when the mode's rate column is null /
 *  the mode is neither finance nor lease. */
function formatAprOrMf(row: Record<string, unknown>): string {
  const mode = row["financing_mode"];
  if (mode === "finance") {
    const apr = asNumber(row["finance_apr"]);
    return apr === null ? "" : `${apr.toFixed(1)}%`;
  }
  if (mode === "lease") {
    const mf = asNumber(row["lease_money_factor"]);
    return mf === null ? "" : `MF ${mf.toFixed(5)}`;
  }
  return "";
}

/** Down payment (finance) or due-at-signing (lease), or null off-mode. */
function downOrDas(row: Record<string, unknown>): number | null {
  const mode = row["financing_mode"];
  if (mode === "finance") return asNumber(row["finance_down_payment"]);
  if (mode === "lease") return asNumber(row["lease_due_at_signing"]);
  return null;
}

/** Monthly payment (finance or lease), or null off-mode. */
function monthly(row: Record<string, unknown>): number | null {
  const mode = row["financing_mode"];
  if (mode === "finance") return asNumber(row["finance_monthly_payment"]);
  if (mode === "lease") return asNumber(row["lease_monthly_payment"]);
  return null;
}

/** The otd sort key: NULL sorts LAST (kind 1), present sorts by value (kind 0).
 *  Returned as a [kind, value] tuple — compared kind-then-value. */
function otdSortKey(row: Record<string, unknown>): [number, number] {
  const otd = asNumber(row["otd_total"]);
  return otd === null ? [1, 0] : [0, otd];
}

// ---------------------------------------------------------------------------
// SQL — the correlated latest-audit subquery (NOT MAX(audit_id))
// ---------------------------------------------------------------------------

const RANK_SQL =
  "SELECT " +
  "  dq.quote_id            AS quote_id, " +
  "  dq.dealer_id           AS dealer_id, " +
  "  dq.financing_mode      AS financing_mode, " +
  "  dq.otd_total           AS otd_total, " +
  "  dq.finance_apr         AS finance_apr, " +
  "  dq.finance_down_payment AS finance_down_payment, " +
  "  dq.finance_monthly_payment AS finance_monthly_payment, " +
  "  dq.lease_money_factor  AS lease_money_factor, " +
  "  dq.lease_due_at_signing AS lease_due_at_signing, " +
  "  dq.lease_monthly_payment AS lease_monthly_payment, " +
  "  dq.selling_price       AS selling_price, " +
  "  dq.doc_fee             AS doc_fee, " +
  "  dq.sales_tax           AS sales_tax, " +
  "  dq.rebates_json        AS rebates_json, " +
  "  COALESCE(d.name, dq.dealer_id) AS dealer_name, " +
  "  qa.flags_json          AS flags_json " +
  "FROM dealer_quotes dq " +
  "LEFT JOIN dealers d ON d.dealer_id = dq.dealer_id " +
  "LEFT JOIN quote_audits qa " +
  "  ON qa.audit_id = ( " +
  "    SELECT qa2.audit_id " +
  "    FROM quote_audits qa2 " +
  "    WHERE qa2.dealer_quote_id = dq.quote_id " +
  "    ORDER BY qa2.audited_at DESC, qa2.audit_id DESC " +
  "    LIMIT 1 " +
  "  ) " +
  "WHERE dq.search_profile_id = ?";

const PROFILE_SQL =
  "SELECT financing_preference, state FROM search_profiles WHERE search_profile_id = ?";

// ---------------------------------------------------------------------------
// preference load + per-mode ranking
// ---------------------------------------------------------------------------

/** The buyer context the ranker needs: the financing preference (gates the
 *  buckets) and the home state (sets the cross-state tax rate). */
interface BuyerContext {
  /** Profile-not-found → null; a NULL column → null; else the string value.
   *  (Both null cases gate to empty.) */
  preference: string | null;
  /** Home (registration) state, or null when absent. */
  state: string | null;
}

/** Load the profile's financing_preference + home state in one read. */
function loadBuyerContext(db: Db, profileId: string): BuyerContext {
  const row = db.$client.prepare(PROFILE_SQL).get(profileId) as
    | { financing_preference?: unknown; state?: unknown }
    | undefined;
  if (row === undefined) return { preference: null, state: null };
  const pref = row.financing_preference;
  const st = row.state;
  return {
    preference: pref === null || pref === undefined ? null : String(pref),
    state: st === null || st === undefined || st === "" ? null : String(st),
  };
}

/** Sum the numeric `amount` values across a quote's rebates_json (a JSON array of
 *  `{amount}` dicts). Unparsable / empty → 0. The incentive component total. */
function sumRebatesJson(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  let total = 0;
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const amt = (item as { amount?: unknown }).amount;
    if (typeof amt === "number" && Number.isFinite(amt)) total += amt;
  }
  return total;
}

/** Sort (stable, otd ASC with NULL last) + project mode-filtered rows into
 *  rankings, then layer on the cross-state normalized fields + OTD attribution.
 *  The RAW-otd sort (and thus `rank`) is unchanged — the normalized fields are
 *  ADDITIVE. The sort is stable: ties on otd_total keep query order (no
 *  quote_id tiebreak), so rank numbering is deterministic across re-runs. */
function rankOneMode(rows: Record<string, unknown>[], homeState: string | null): QuoteRanking[] {
  // Decorate-sort-undecorate keeps the sort stable in V8 (Array.prototype.sort
  // is stable, but comparing on the precomputed key avoids recomputation and
  // any subtle compare asymmetry).
  const ordered = rows
    .map((row, index) => ({ row, index, key: otdSortKey(row) }))
    .sort((a, b) => {
      if (a.key[0] !== b.key[0]) return a.key[0] - b.key[0];
      if (a.key[1] !== b.key[1]) return a.key[1] - b.key[1];
      return a.index - b.index; // stable tiebreak — preserve query order
    });

  // Project each row + capture its home-state-normalized OTD components.
  const ranked = ordered.map(({ row }, idx) => {
    const sellingPrice = asNumber(row["selling_price"]);
    const norm = normalizeQuoteTax({
      homeState,
      sellingPrice,
      statedTax: asNumber(row["sales_tax"]),
      statedOtd: asNumber(row["otd_total"]),
    });
    const components: OtdComponents = {
      sellingPrice,
      docFee: asNumber(row["doc_fee"]),
      tax: norm.normalizedTax,
      incentives: sumRebatesJson(row["rebates_json"]),
      otd: norm.normalizedOtd,
    };
    const ranking: QuoteRanking = {
      rank: idx + 1,
      quote_id: asStringOrEmpty(row["quote_id"]),
      dealer_id: asStringOrEmpty(row["dealer_id"]),
      dealer_name: asStringOrEmpty(row["dealer_name"] ?? row["dealer_id"]),
      otd_total: asNumber(row["otd_total"]),
      apr_or_mf: formatAprOrMf(row),
      down_or_das: downOrDas(row),
      monthly: monthly(row),
      audit_flag_summary: flagCodesFromJson(row["flags_json"]),
      financing_mode: asStringOrEmpty(row["financing_mode"]),
      normalized_tax: norm.normalizedTax,
      normalized_otd: norm.normalizedOtd,
      attribution: null,
    };
    return { ranking, components };
  });

  // The attribution baseline is the LOWEST normalized OTD in the bucket — the
  // honest apples-to-apples best for THIS buyer (which can differ from the raw-OTD
  // rank-1 when dealers sit in different-tax states). First minimum wins ties.
  let baseline: { ranking: QuoteRanking; components: OtdComponents } | null = null;
  for (const r of ranked) {
    if (r.components.otd === null) continue;
    if (baseline === null || r.components.otd < baseline.components.otd!) baseline = r;
  }

  // Decompose each non-baseline row's normalized-OTD gap to the baseline.
  if (baseline !== null) {
    for (const r of ranked) {
      if (r === baseline || r.components.otd === null) continue;
      const a = attributeOtdDelta(baseline.components, r.components);
      if (a !== null) {
        r.ranking.attribution = {
          baseline_quote_id: baseline.ranking.quote_id,
          otd_delta: a.otdDelta,
          sale_price_delta: a.salePriceDelta,
          doc_fee_delta: a.docFeeDelta,
          tax_delta: a.taxDelta,
          incentive_delta: a.incentiveDelta,
          other_delta: a.otherDelta,
        };
      }
    }
  }

  return ranked.map((r) => r.ranking);
}

/**
 * Rank one profile's dealer quotes into mode buckets. Reads the profile's
 * financing_preference + every quote (joined to the latest audit + the dealer
 * name), gates per the preference, and ranks each surviving bucket by OTD (NULL
 * last, stable). Both lists are always present; the off-mode side is empty.
 * Read-only.
 */
export function rankQuotesForProfile(db: Db, profileId: string): CompareResult {
  const { preference, state: homeState } = loadBuyerContext(db, profileId);
  const homeRate = homeStateTaxRate(homeState);

  // Missing-profile / NULL preference: nothing to rank against.
  if (preference === null) {
    return {
      financingPreference: preference,
      finance: [],
      lease: [],
      cash: [],
      homeState,
      homeStateTaxRate: homeRate,
    };
  }

  const rows = db.$client.prepare(RANK_SQL).all(profileId) as Record<string, unknown>[];

  const financeRows: Record<string, unknown>[] = [];
  const leaseRows: Record<string, unknown>[] = [];
  const cashRows: Record<string, unknown>[] = [];
  for (const row of rows) {
    const mode = row["financing_mode"];
    // A quote's OTD total is the drive-off price — mode-agnostic. So a quote the
    // dealer left 'unspecified', or one that quotes an OTD while labeled 'cash',
    // is still comparable to a finance deal and belongs in the finance view; an
    // 'unspecified' quote is comparable to a lease too. Only the OPPOSITE explicit
    // mode is excluded (a lease payment is not an OTD total, and vice-versa). This
    // keeps "compare all my quotes" honest instead of hiding off-mode OTD quotes
    // behind a label — the live 巡检 saw 3 of 4 real dealer quotes vanish here.
    if (mode === "finance" || mode === "unspecified" || mode === "cash") financeRows.push(row);
    if (mode === "lease" || mode === "unspecified") leaseRows.push(row);
    // Cash bucket: cash + unspecified quotes are OTD-comparable for a cash buyer.
    if (mode === "cash" || mode === "unspecified") cashRows.push(row);
  }

  if (preference === "cash") {
    // A cash buyer's quotes are OTD totals — rank them so "compare my quotes"
    // returns a best pick instead of an empty result (the live 巡检 saw a cash
    // buyer get "Compared 0" while the same data ranked fine for lease/finance).
    return {
      financingPreference: preference,
      finance: [],
      lease: [],
      cash: rankOneMode(cashRows, homeState),
      homeState,
      homeStateTaxRate: homeRate,
    };
  }
  if (preference === "finance") {
    return {
      financingPreference: preference,
      finance: rankOneMode(financeRows, homeState),
      lease: [],
      cash: [],
      homeState,
      homeStateTaxRate: homeRate,
    };
  }
  if (preference === "lease") {
    return {
      financingPreference: preference,
      finance: [],
      lease: rankOneMode(leaseRows, homeState),
      cash: [],
      homeState,
      homeStateTaxRate: homeRate,
    };
  }
  // undecided (or any other unrecognized non-cash value) → finance + lease (cash
  // already surfaces inside finance as an off-mode row).
  return {
    financingPreference: preference,
    finance: rankOneMode(financeRows, homeState),
    lease: rankOneMode(leaseRows, homeState),
    cash: [],
    homeState,
    homeStateTaxRate: homeRate,
  };
}
