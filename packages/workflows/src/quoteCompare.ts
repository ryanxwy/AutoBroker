/**
 * quote_compare — the deterministic quote-compare ranker skill. ONE flat linear
 * Mastra `createWorkflow`: 3 named steps chained with `.then()`, ZERO suspend
 * steps and ZERO LLM calls. The whole run is a read: resolve the profile, read
 * its quotes (joined to the latest audit per quote + the dealer name), gate by
 * the profile's financing preference, rank each surviving bucket by OTD, and
 * render the side-by-side compare panel. A failure (no profile / ambiguous) is a
 * typed thrown STOP — never a silent partial success.
 *
 * STEP MAP:
 *   0 resolveProfile — typed three-branch profile resolution via the tools
 *                      resolver (pinned → run; exactly-1 active → inferred-newest,
 *                      LOGGED, run; 0 active → typed STOP pointing at
 *                      /search_profile_intake; 2+ → typed STOP asking by vehicle
 *                      name). Read-only / infer-ok: there is NO pick-suspend — a
 *                      STOP is terminal.
 *   1 rankQuotes     — the deterministic compare: tools rankQuotesForProfile
 *                      reads the profile preference + its quotes (LEFT-JOINed to
 *                      the LATEST audit row per quote + the dealer name), gates
 *                      per preference (cash/missing → both empty; finance/lease →
 *                      one bucket; undecided → both), and ranks each bucket by OTD
 *                      (NULL last, stable). No write, no network.
 *   2 confirm        — pure, ZERO-LLM: assemble the single output object + the
 *                      deterministic terminal sentence. Empty buckets are a VALID
 *                      success.
 *
 * No budget: the ranked rows carry OTD totals + rate + payment + audit flag
 * codes, NEVER a budget number. The terminal summary names a total + per-bucket
 * counts only.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/tools (the
 * resolver + the ranking glue + getDb — the ONLY DB/side-effect path), and this
 * skill's contracts. NO @autobroker/model (zero-LLM), NO harness, NO browser.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  getDb,
  rankQuotesForProfile as rankQuotesForProfileImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
} from "@autobroker/tools";

import {
  QuoteCompareInputSchema,
  QuoteCompareOutputSchema,
  QuoteCompareStopError,
  QuoteRankingSchema,
  QUOTE_COMPARE_WORKFLOW_ID,
} from "./quoteCompareContracts.js";

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the sibling skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL step chain against
 * deterministic stubs and an isolated tmp DB, WITHOUT a vitest module mock —
 * the same holder-over-factory rationale as the sibling skills' seams.
 */
export interface QuoteCompareWorkflowDeps {
  /** The typed three-branch profile resolver (tools layer). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** The profile-scoped compare ranker (tools layer, the ONLY DB read). */
  rankQuotes: typeof rankQuotesForProfileImpl;
  /** The DB accessor the resolve/rank steps read through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: QuoteCompareWorkflowDeps = {
  resolveProfile: resolveActiveProfileImpl,
  rankQuotes: rankQuotesForProfileImpl,
  getDb,
};

let injectedDeps: QuoteCompareWorkflowDeps | undefined;

/** The deps the steps use: injected (tests) or the real wiring (production). */
function deps(): QuoteCompareWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/**
 * TEST-ONLY seam. Refused outside a test runner (same guard rule as the sibling
 * seams): a production caller must never redirect the resolver or the DB read
 * path. Pass a partial; unspecified collaborators keep their real implementation.
 */
export function __setQuoteCompareDepsForTests(
  partial: Partial<QuoteCompareWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setQuoteCompareDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetQuoteCompareDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

/**
 * The accumulating state threaded through the 3 steps. Flat plain-JSON (Mastra
 * snapshots it): the resolved profile + provenance, then the ranked buckets.
 */
const QuoteCompareStateSchema = z.object({
  searchProfileId: z.string(),
  /** pinned vs inferred-newest — the resolution provenance, always recorded. */
  resolution: z.enum(["pinned", "inferred_newest"]),
  /** The loaded financing_preference (after step 1); null until then / when the
   *  profile carries no preference. */
  financingPreference: z.string().nullable(),
  /** Finance bucket (after step 1); null until then. */
  finance: z.array(QuoteRankingSchema).nullable(),
  /** Lease bucket (after step 1); null until then. */
  lease: z.array(QuoteRankingSchema).nullable(),
  /** Cash bucket (after step 1); null until then. */
  cash: z.array(QuoteRankingSchema).nullable(),
});
type QuoteCompareState = z.infer<typeof QuoteCompareStateSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): QuoteCompareState {
  return QuoteCompareStateSchema.parse(inputData);
}

/** Run `fn` against the SHARED tools-layer DB connection (one cached handle,
 *  released by tests via closeDb). */
function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  return fn(deps().getDb());
}

/** "2026 Hyundai Tucson SEL"-style label for ask-by-vehicle stops. */
function vehicleLabel(p: {
  year: number;
  make: string;
  model: string;
  trim: string | null;
}): string {
  return [p.year, p.make, p.model, p.trim].filter((x) => x !== null && x !== "").join(" ");
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (typed three-branch; read-only / infer-ok)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: QuoteCompareInputSchema,
  outputSchema: QuoteCompareStateSchema,
  execute: async ({ inputData }) => {
    // Three-branch resolution (profile-ASK rule). An inferred_newest pick is
    // LOGGED by the resolver's structured trace — never a silent pick.
    const resolved = withDb((db) =>
      deps().resolveProfile(
        db,
        inputData.search_profile_id !== null ? { threadPin: inputData.search_profile_id } : {},
      ),
    );

    if (resolved.kind === "none") {
      throw new QuoteCompareStopError(
        "no_active_profile",
        "No active search profile found — quote_compare needs one to know which " +
          "dealer quotes to rank. Run /search_profile_intake to create a profile, " +
          "then re-run /quote_compare.",
      );
    }
    if (resolved.kind === "ambiguous") {
      const labels = resolved.candidates.map((p) => vehicleLabel(p)).join(" | ");
      throw new QuoteCompareStopError(
        "multiple_active_profiles",
        `Multiple active search profiles found (${labels}). Tell me which vehicle ` +
          "to compare quotes for by re-running /quote_compare with that profile's " +
          "search_profile_id.",
      );
    }

    // pinned | inferred_newest — the run proceeds, provenance recorded in state.
    return {
      searchProfileId: resolved.profile.id,
      resolution: resolved.kind,
      financingPreference: null,
      finance: null,
      lease: null,
      cash: null,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — rankQuotes (tools read + pure ranker; the ONLY DB read)
// ---------------------------------------------------------------------------

const rankQuotesStep = createStep({
  id: "rankQuotes",
  inputSchema: QuoteCompareStateSchema,
  outputSchema: QuoteCompareStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const result = withDb((db) => deps().rankQuotes(db, state.searchProfileId));
    return {
      ...state,
      financingPreference: result.financingPreference,
      finance: result.finance,
      lease: result.lease,
      cash: result.cash,
    };
  },
});

// ---------------------------------------------------------------------------
// step 2 — confirm (pure, ZERO-LLM — the single output + the terminal sentence)
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: QuoteCompareStateSchema,
  outputSchema: QuoteCompareOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const finance = state.finance ?? [];
    const lease = state.lease ?? [];
    const cash = state.cash ?? [];
    const totalRanked = finance.length + lease.length + cash.length;

    // The deterministic terminal sentence — total + per-bucket counts, NEVER a
    // budget number.
    const summary =
      `Compared ${totalRanked} quotes ` +
      `(finance: ${finance.length}, lease: ${lease.length}, cash: ${cash.length}).`;

    return {
      outcome: "compared" as const,
      resolution: state.resolution,
      search_profile_id: state.searchProfileId,
      financingPreference: state.financingPreference,
      finance,
      lease,
      cash,
      totalRanked,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (3 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const quoteCompareWorkflow = createWorkflow({
  id: QUOTE_COMPARE_WORKFLOW_ID,
  inputSchema: QuoteCompareInputSchema,
  outputSchema: QuoteCompareOutputSchema,
})
  .then(resolveProfileStep)
  .then(rankQuotesStep)
  .then(confirmStep)
  .commit();

export { QUOTE_COMPARE_WORKFLOW_ID };
