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
 * NULL-not-$0 (cost-metering rule; see harness.ts HarnessGenerateResult):
 * if the provider gives no usage tokens, or the model id is not in this table,
 * cost is `null` with pricingSource "unavailable" — we NEVER silently bill $0,
 * because $0 reads as "free" in the ledger and hides a missing-usage bug.
 *
 * SNAPSHOT-IN-THE-LEDGER: the ledger row stores the computed
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
 * (and the rates below) when any provider re-prices; historical rows keep their
 * own recorded label so a re-price never rewrites history.
 *
 * NOTE: the "deepseek-" prefix is the original (DeepSeek-first) snapshot name; it
 * is the TABLE-VERSION label, not a provider filter — the 2026-06 snapshot now
 * also carries the official Anthropic + OpenAI rows below (added for the
 * cross-provider smoke, fetched 2026-06-05). It is kept verbatim because the
 * ledger snapshot semantics key off this exact string across the harness +
 * test_run_records; a rename is a deliberate table-version bump, not done here.
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
 * CACHE-MISS IS THE INPUT RATE TODAY (conservative, documented — NOT silent):
 * the AI SDK usage object does not currently split the prompt into cache-hit vs
 * cache-miss token counts, so `computeCostUsd` prices ALL prompt tokens at the
 * cache-MISS rate. That is a deliberate OVERESTIMATE (cache-hit is ~50x cheaper
 * on flash). When/if the SDK surfaces a cache-hit token count, switch to
 * `cacheHitInputUsdPerMTok` for that slice. We keep the cache-hit rate in the
 * table now so that later switch is a code edit here, not a price re-discovery.
 */
export interface ModelRate {
  /** USD per 1M cache-MISS prompt tokens (the conservative input rate). */
  inputUsdPerMTok: number;
  /** USD per 1M completion/output tokens. */
  outputUsdPerMTok: number;
  /** USD per 1M cache-HIT prompt tokens, when the provider lists the split.
   *  Recorded for the future cache-aware path; UNUSED by computeCostUsd today. */
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

  // Anthropic — official pricing page (fetched 2026-06-05,
  // platform.claude.com/docs/en/about-claude/pricing). Base input / output /
  // cache-hit (cache read = 0.1x base input). Keyed by the alias model ids the
  // registry binds (claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-8).
  "claude-haiku-4-5": {
    inputUsdPerMTok: 1.0,
    outputUsdPerMTok: 5.0,
    cacheHitInputUsdPerMTok: 0.1,
  },
  "claude-sonnet-4-6": {
    inputUsdPerMTok: 3.0,
    outputUsdPerMTok: 15.0,
    cacheHitInputUsdPerMTok: 0.3,
  },
  "claude-opus-4-8": {
    inputUsdPerMTok: 5.0,
    outputUsdPerMTok: 25.0,
    cacheHitInputUsdPerMTok: 0.5,
  },

  // OpenAI — official model docs (fetched 2026-06-05,
  // developers.openai.com/api/docs/models/{gpt-5.4-mini,gpt-5.4,gpt-5.5}).
  // input / output / cached-input. Keyed by the alias model ids the registry
  // binds (gpt-5.4-mini / gpt-5.4 / gpt-5.5).
  "gpt-5.4-mini": {
    inputUsdPerMTok: 0.75,
    outputUsdPerMTok: 4.5,
    cacheHitInputUsdPerMTok: 0.075,
  },
  "gpt-5.4": {
    inputUsdPerMTok: 2.5,
    outputUsdPerMTok: 15.0,
    cacheHitInputUsdPerMTok: 0.25,
  },
  "gpt-5.5": {
    inputUsdPerMTok: 5.0,
    outputUsdPerMTok: 30.0,
    cacheHitInputUsdPerMTok: 0.5,
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
 * Prompt tokens are priced at the cache-MISS rate (conservative; see the
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
