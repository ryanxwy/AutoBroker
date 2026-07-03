/**
 * negotiation_summary — the LLM read of a dealer's negotiation state for the
 * dealer-negotiation detail modal. NOT a Mastra workflow: a single advisory
 * projection function the app's read path calls. ONE LLM touch (a single
 * emit_result via harness.generate); ANY failure degrades to {summary:null} so
 * the modal keeps rendering its deterministic fields.
 *
 * FLOW:
 *   1. read the dealer's substantive reply BODIES through the tools layer
 *      (readDealerSubstantiveReplyBodies — DB stays in tools; this layer only
 *      generates). Budget already redacted there.
 *   2. SHORT-CIRCUIT: an empty body set → {summary:null} WITHOUT an LLM call.
 *   3. cache: an in-process LRU keyed by `profileId:dealerId:sig`, sig = a hash
 *      of the filtered reply body set (the set changes → a fresh generation; an
 *      unchanged set hits the cache). best_competing_otd is NOT in the key.
 *   4. generate: a SINGLE emit_result (flat .strict() schema). ONE try/catch wraps
 *      generate + the Zod re-validate + the assertNoBudget belt (assertNoBudget
 *      THROWS, so it lives INSIDE the try); ANY throw → {summary:null} + a voiced
 *      degrade trace span.
 *
 * Dependency wall: imports @autobroker/tools (the reply-body read + assertNoBudget
 * — the ONLY DB path) + this layer's harness facade + the skill-local contracts +
 * node:crypto (the sig hash). NEVER opens the product DB or calls a provider
 * directly.
 */

import { createHash } from "node:crypto";

import {
  assertNoBudget,
  readDealerSubstantiveReplyBodies as readDealerSubstantiveReplyBodiesImpl,
  type Db,
} from "@autobroker/tools";

import { harness, type HarnessLedgerContext } from "./harness.js";
import {
  NegotiationSummaryEmitSchema,
  buildNegotiationSummaryPrompt,
} from "./negotiationSummaryContracts.js";

// ---------------------------------------------------------------------------
// in-process LRU cache (no migration, no stored column)
// ---------------------------------------------------------------------------

/** Cap on the in-process summary cache (insertion-ordered Map = LRU). */
const SUMMARY_CACHE_MAX = 256;

/** key = `profileId:dealerId:sig` → the generated summary string. In-process
 *  only; a process restart re-generates. */
const summaryCache = new Map<string, string>();

/** Read + LRU-touch (re-insert moves the key to the most-recent end). */
function cacheGet(key: string): string | undefined {
  const value = summaryCache.get(key);
  if (value === undefined) return undefined;
  summaryCache.delete(key);
  summaryCache.set(key, value);
  return value;
}

/** Insert + evict the oldest entries past the cap. */
function cacheSet(key: string, value: string): void {
  summaryCache.delete(key);
  summaryCache.set(key, value);
  while (summaryCache.size > SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    summaryCache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/** The runtime collaborators this projection calls. Injectable so the unit test
 *  drives the REAL function (short-circuit, cache, fail-closed) against a stubbed
 *  harness + a fixed reply-body read, WITHOUT a module mock. */
export interface NegotiationSummaryDeps {
  /** The single emit_result structured-generation facade (the only LLM touch). */
  generate: typeof harness.generate;
  /** The dealer's substantive reply bodies (tools layer; the ONLY DB path). */
  readBodies: typeof readDealerSubstantiveReplyBodiesImpl;
}

const realDeps: NegotiationSummaryDeps = {
  generate: harness.generate,
  readBodies: readDealerSubstantiveReplyBodiesImpl,
};

let injectedDeps: NegotiationSummaryDeps | undefined;

function deps(): NegotiationSummaryDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner. */
export function __setNegotiationSummaryDepsForTests(
  partial: Partial<NegotiationSummaryDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setNegotiationSummaryDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring + clear the cache between test cases. */
export function __resetNegotiationSummaryDepsForTests(): void {
  injectedDeps = undefined;
  summaryCache.clear();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The ledger identity for the one test_run_records row this call writes. There
 *  is no Mastra runId here (not a workflow), so the run window is keyed by the
 *  profile + dealer it summarizes. */
function summaryLedger(profileId: string, dealerId: string): HarnessLedgerContext {
  return {
    runId: `negotiation_summary:${profileId}:${dealerId}`,
    skill: "negotiation_summary",
    layer: "L2",
    promptVersion: "p4-t8-v1",
    schemaVersion: "p4-t8-v1",
  };
}

/** Voice the degrade so the fallback is never silent (inv #12: every fallback
 *  must be voiced). The summary is advisory; ANY failure resolves to null. */
function traceDegrade(profileId: string, dealerId: string, reason: string): void {
  console.warn(
    JSON.stringify({ span: "negotiation_summary.degrade", profileId, dealerId, reason }),
  );
}

// ---------------------------------------------------------------------------
// the projection
// ---------------------------------------------------------------------------

/**
 * Get (cached) or generate the dealer's negotiation-state summary. Returns
 * {summary:null} on an empty input (no LLM call) or on ANY generation failure
 * (emit_result never fired, Zod-authority, budget-leak belt, transport) — never
 * throws into the caller.
 */
export async function getOrGenerateDealerNegotiationSummary(
  db: Db,
  args: { profileId: string; dealerId: string },
): Promise<{ summary: string | null }> {
  const bodies = deps().readBodies(db, { profileId: args.profileId, dealerId: args.dealerId });

  // SHORT-CIRCUIT — nothing substantive to summarize. No LLM call, no cache write.
  if (bodies.length === 0) return { summary: null };

  // sig = a content hash of the filtered, newest-first reply body set. The set
  // changes (a new reply, an edited body) → a new sig → a fresh generation; an
  // unchanged set hits the cache. best_competing_otd is NOT part of the key.
  const sig = createHash("sha256").update(bodies.join("")).digest("hex");
  const key = `${args.profileId}:${args.dealerId}:${sig}`;

  const cached = cacheGet(key);
  if (cached !== undefined) return { summary: cached };

  try {
    const result = await deps().generate(
      {
        useCase: "negotiation_summary",
        schema: NegotiationSummaryEmitSchema,
        prompt: buildNegotiationSummaryPrompt(bodies),
      },
      summaryLedger(args.profileId, args.dealerId),
    );
    // Zod re-validate (defense-in-depth) + the budget belt. assertNoBudget THROWS
    // on a leak, so it lives INSIDE the try — a leak degrades to null, never
    // surfaces, and is NEVER cached.
    const parsed = NegotiationSummaryEmitSchema.parse(result.object);
    assertNoBudget(parsed.summary);
    cacheSet(key, parsed.summary);
    return { summary: parsed.summary };
  } catch (err) {
    traceDegrade(args.profileId, args.dealerId, err instanceof Error ? err.name : "unknown");
    return { summary: null };
  }
}
