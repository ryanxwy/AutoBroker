/**
 * Self-managed pricing table + usage→cost helper (Layer 2).
 *
 * WHY THIS EXISTS: the AI SDK reports token usage but NEVER a USD cost — that is
 * out of scope for the SDK and will not change (vercel/ai #3932, wontfix: "the
 * SDK reports tokens, not prices; pricing is provider/plan-specific"). So the
 * cost column in `test_run_records` is OURS to compute. We keep a small,
 * provider-published price table here and turn (promptTokens, completionTokens)
 * into a USD figure at ledger-write time.
 *
 * NULL-not-$0 (HARNESS_FRAMEWORK §"成本/时间度量"; harness.ts HarnessGenerateResult):
 * if the provider gives no usage tokens, or the model id is not in this table,
 * cost is `null` with pricingSource "unavailable" — we NEVER silently bill $0,
 * because $0 reads as "free" in the ledger and hides a missing-usage bug.
 *
 * SNAPSHOT-IN-THE-LEDGER (HARNESS_FRAMEWORK): the ledger row stores the computed
 * `cost_usd` and the `pricing_source` label (e.g. "deepseek-2026-06") at the time
 * the run happened. Re-pricing later (DeepSeek adjusts a rate) means bumping this
 * table + the PRICING_SOURCE label — it does NOT rewrite historical rows, whose
 * cost was already frozen against the then-current snapshot. That is why the raw
 * per-MTok constants live here as data, keyed by concrete model id.
 *
 * Layer note: pure arithmetic over plain numbers. No `ai` / `@ai-sdk/*` import is
 * needed (this is the price *table*, not a model call), so this file stays
 * framework-free even though it lives in Layer 2.
 */

/**
 * Ledger label for any cost_usd priced off THIS table snapshot. Bump this string
 * (and the rates below) when DeepSeek re-prices; historical rows keep their own
 * recorded label so a re-price never rewrites history.
 */
export const PRICING_SOURCE = "deepseek-2026-06" as const;

/**
 * Per-model raw rates, USD per 1,000,000 tokens, keyed by CONCRETE model id
 * (the same ids the registry binds: "deepseek-v4-flash", "deepseek-v4-pro").
 *
 * SOURCE — official DeepSeek API docs pricing page, fetched 2026-06-04:
 *   https://api-docs.deepseek.com/quick_start/pricing
 *   deepseek-v4-flash: cache-hit input $0.0028 / cache-miss input $0.14 / output $0.28 per 1M
 *   deepseek-v4-pro:   cache-hit input $0.003625 / cache-miss input $0.435 / output $0.87 per 1M
 *
 * CACHE-MISS IS THE M0 INPUT RATE (conservative, documented — NOT silent):
 * the AI SDK usage object does not split the prompt into cache-hit vs cache-miss
 * token counts at M0, so `computeCostUsd` prices ALL prompt tokens at the
 * cache-MISS rate. That is a deliberate OVERESTIMATE (cache-hit is ~50x cheaper
 * on flash). When/if the SDK surfaces a cache-hit token count, switch to
 * `cacheHitInputUsdPerMTok` for that slice. We keep the cache-hit rate in the
 * table now so that later switch is a code edit here, not a price re-discovery.
 */
export interface ModelRate {
  /** USD per 1M cache-MISS prompt tokens (the conservative M0 input rate). */
  inputUsdPerMTok: number;
  /** USD per 1M completion/output tokens. */
  outputUsdPerMTok: number;
  /** USD per 1M cache-HIT prompt tokens, when the provider lists the split.
   *  Recorded for the future cache-aware path; UNUSED by computeCostUsd at M0. */
  cacheHitInputUsdPerMTok: number;
}

/**
 * Table keyed by concrete model id. Only models with an OFFICIAL, verifiable
 * rate appear here; an unknown id falls through to "unavailable" (NULL cost),
 * never to an invented number.
 */
export const PRICING: Readonly<Record<string, ModelRate>> = {
  "deepseek-v4-flash": {
    inputUsdPerMTok: 0.14,
    outputUsdPerMTok: 0.28,
    cacheHitInputUsdPerMTok: 0.0028,
  },
  "deepseek-v4-pro": {
    inputUsdPerMTok: 0.435,
    outputUsdPerMTok: 0.87,
    cacheHitInputUsdPerMTok: 0.003625,
  },
} as const;

const TOKENS_PER_MTOK = 1_000_000;

/**
 * Turn token usage into a USD cost against the table snapshot.
 *
 * Returns `{ costUsd: null, pricingSource: "unavailable" }` when:
 *   - either token count is `null` (provider reported no usage), OR
 *   - the model id is not in PRICING (unknown / unpriced model).
 * Otherwise returns the computed cost and the PRICING_SOURCE snapshot label.
 *
 * NULL-not-$0: we never coerce a missing usage figure to a $0 cost (vercel/ai
 * #3932 — the SDK reports tokens, not prices). A null here is an honest "we
 * could not price this run", which the ledger renders distinctly from $0.
 *
 * Prompt tokens are priced at the cache-MISS rate at M0 (conservative; see the
 * PRICING comment). Completion tokens at the output rate.
 */
export function computeCostUsd(
  modelId: string,
  promptTokens: number | null,
  completionTokens: number | null,
): { costUsd: number | null; pricingSource: string } {
  if (promptTokens === null || completionTokens === null) {
    return { costUsd: null, pricingSource: "unavailable" };
  }
  const rate = PRICING[modelId];
  if (rate === undefined) {
    return { costUsd: null, pricingSource: "unavailable" };
  }
  const inputCost = (promptTokens / TOKENS_PER_MTOK) * rate.inputUsdPerMTok;
  const outputCost = (completionTokens / TOKENS_PER_MTOK) * rate.outputUsdPerMTok;
  return { costUsd: inputCost + outputCost, pricingSource: PRICING_SOURCE };
}
