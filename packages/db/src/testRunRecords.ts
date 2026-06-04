/**
 * test_run_records — the net-new cost/time + harness-result ledger.
 *
 * PROVENANCE (currentTruth "测试分层 L1–L5" + "成本/时间度量";
 *   risks "成本账本静默 $0/缺失 usage 骗趋势"; ANCHORS.html cost_and_time anchor):
 *
 *   Every harness run lands one row here. Cost is the APPLICATION's own job:
 *   usage tokens × a self-managed pricing table → USD (AI SDK #3932 is wontfix,
 *   the SDK will not compute cost). The keystone rule:
 *
 *     MISSING usage is recorded as explicit NULL + pricing_source='unavailable'
 *     + a fail/flag reason — it is NEVER silently rounded to $0.
 *
 *   Known real gaps the NULL-not-$0 rule protects against:
 *     - token counts dropped by the coordinator normalizer (only
 *       cost_usd/duration_ms/num_turns reach the `done` event);
 *     - Mode-A terminal output dropped;
 *     - Codex cost hard-coded 0.0.
 *   The Claude SDK lane already lands real cost_usd/duration_ms on `done`.
 *
 *   We store the RAW token fields + a pricing snapshot (pricing_source +
 *   price_* columns) so a run re-priced later still reproduces, and so a $0
 *   from "genuinely free" is distinguishable from $0 from "usage unavailable".
 *   Naming aligns with OTel GenAI (gen_ai.usage.input_tokens).
 *
 * This table is fully owned by the TS repo (no legacy equivalent) so it does NOT
 * come from `drizzle-kit pull` — it is hand-authored and migrated forward.
 */

import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";

/**
 * STUB shape — finalize columns/indexes in Phase 0 alongside the evaluator's
 * cost_and_time anchor and harness/export_daily.ts (the daily JSON consumed by
 * ../../../AutoBroker-dev-plan/ts-rebuild/tools/new-day.sh).
 */
export const testRunRecords = sqliteTable("test_run_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  // ── identity / run window ──────────────────────────────────────────────
  runId: text("run_id").notNull(),
  skill: text("skill").notNull(),
  createdAt: text("created_at").notNull(), // ISO-8601, YYYY-MM-DD-derived bucket.

  // ── test taxonomy (TEST_LAYERS.html) ─────────────────────────────────────
  layer: text("layer").notNull(), // 'L1' | 'L2' | 'L3' | 'L4' | 'L5'
  provider: text("provider").notNull(), // 'deepseek' (default) | 'anthropic' | 'openai'
  modelAlias: text("model_alias").notNull(), // e.g. 'deepseek-v4-flash'

  // ── cost / time (NULLable on purpose; NEVER coerce to 0) ───────────────
  costUsd: real("cost_usd"), // NULL when usage unavailable.
  latencyMs: integer("latency_ms"), // a.k.a. duration_ms.
  inputTokens: integer("input_tokens"), // raw; gen_ai.usage.input_tokens.
  outputTokens: integer("output_tokens"), // raw; gen_ai.usage.output_tokens.

  // ── pricing snapshot (so re-priced runs reproduce) ─────────────────────
  pricingSource: text("pricing_source").notNull(), // 'unavailable' when usage missing — the anti-silent-$0 flag.
  priceInputPerMtok: real("price_input_per_mtok"), // snapshot of the rate at record time.
  priceOutputPerMtok: real("price_output_per_mtok"),

  // ── versioning + verdict ───────────────────────────────────────────────
  promptVersion: text("prompt_version"), // SKILL.md / prompt hash.
  schemaVersion: text("schema_version"), // Zod contract version for the skill.
  failReason: text("fail_reason"), // NULL on GREEN; set on anchor RED or usage-missing flag.
});

// TODO(phase-0): index on (skill, createdAt) and (layer, provider) for the
// daily export; a `cost_and_time` evaluator helper that writes a row with
// pricing_source='unavailable' + failReason='usage_missing' when the `done`
// event carries no usage, rather than dropping the row or writing 0.
