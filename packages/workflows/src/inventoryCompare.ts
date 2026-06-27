/**
 * inventory_compare — the deterministic inventory ranker skill. ONE flat linear
 * Mastra `createWorkflow`: 3 named steps chained with `.then()`, ZERO suspend
 * steps and ZERO LLM calls. The whole run is a read: resolve the profile, read
 * its live listings, score them against the profile, and render a ranked rail.
 * A failure (no profile / ambiguous) is a typed thrown STOP — never a silent
 * partial success.
 *
 * STEP MAP:
 *   0 resolveProfile — typed three-branch profile resolution via the tools
 *                      resolver (pinned → run; exactly-1 active → inferred-newest,
 *                      LOGGED, run; 0 active → typed STOP pointing at
 *                      /search_profile_intake; 2+ → typed STOP asking by vehicle
 *                      name). Read-only / infer-ok: there is NO pick-suspend — a
 *                      STOP is terminal.
 *   1 computeRanking — the deterministic rank: tools rankInventoryForProfile
 *                      reads the profile row + its live listings (joined to
 *                      dealers for the distance axis), runs the pure four-axis
 *                      ranker (hard filters BEFORE scoring), and returns the flat
 *                      candidates + header tallies. No write, no network.
 *   2 render         — pure, ZERO-LLM: assemble the single output object + the
 *                      deterministic terminal sentence. An empty rail is a VALID
 *                      success.
 *
 * Listings ≠ quotes: the candidates are public-website inventory, NOT negotiated
 * out-the-door quotes. The terminal summary names a candidate count + a
 * recommended count; it NEVER includes a budget number.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/tools (the
 * resolver + the ranking glue + getDb — the ONLY DB/side-effect path), and this
 * skill's contracts. NO @autobroker/model (zero-LLM), NO harness, NO browser.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  classifyTrimAvailability,
  getDb,
  rankInventoryForProfile as rankInventoryForProfileImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
} from "@autobroker/tools";

import {
  ColorCrossCheckItemSchema,
  InventoryCompareInputSchema,
  InventoryCompareOutputSchema,
  InventoryCompareStopError,
  RankedCandidateSchema,
  INVENTORY_COMPARE_WORKFLOW_ID,
} from "./inventoryCompareContracts.js";

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the sibling skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL step chain against
 * deterministic stubs and an isolated tmp DB, WITHOUT a vitest module mock —
 * the same holder-over-factory rationale as the sibling skills' seams.
 */
export interface InventoryCompareWorkflowDeps {
  /** The typed three-branch profile resolver (tools layer). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** The profile-scoped ranking glue (tools layer, the ONLY DB read). */
  rankInventory: typeof rankInventoryForProfileImpl;
  /** The DB accessor the resolve/rank steps read through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: InventoryCompareWorkflowDeps = {
  resolveProfile: resolveActiveProfileImpl,
  rankInventory: rankInventoryForProfileImpl,
  getDb,
};

let injectedDeps: InventoryCompareWorkflowDeps | undefined;

/** The deps the steps use: injected (tests) or the real wiring (production). */
function deps(): InventoryCompareWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/**
 * TEST-ONLY seam. Refused outside a test runner (same guard rule as the sibling
 * seams): a production caller must never redirect the resolver or the DB read
 * path. Pass a partial; unspecified collaborators keep their real implementation.
 */
export function __setInventoryCompareDepsForTests(
  partial: Partial<InventoryCompareWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setInventoryCompareDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetInventoryCompareDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

/**
 * The accumulating state threaded through the 3 steps. Flat plain-JSON (Mastra
 * snapshots it): the resolved profile + provenance, then the ranking output.
 */
const InventoryCompareStateSchema = z.object({
  searchProfileId: z.string(),
  /** The profile's requested trim — grounded post-scan against the real in-stock
   *  trims to flag a trim no dealer actually carries (the authoritative trim
   *  check; intake can't ground because no inventory exists yet at intake). */
  profileTrim: z.string().nullable(),
  /** pinned vs inferred-newest — the resolution provenance, always recorded. */
  resolution: z.enum(["pinned", "inferred_newest"]),
  /** Ranked candidates (after step 1); null until then. */
  candidates: z.array(RankedCandidateSchema).nullable(),
  scannedAtMax: z.string().nullable(),
  totalListings: z.number().int(),
  recommendedCount: z.number().int(),
  /** Scan provenance (from dealer_inventory_sources): dealers a site_scan
   *  reached vs blocked. Lets the empty-state distinguish scanned-0 from never-scanned. */
  sourcesScanned: z.number().int(),
  sourcesBlocked: z.number().int(),
  /** Distinct trims over ALL the profile's live listings (UNFILTERED — before
   *  the budget/availability hard-filter), the ground-truth set for the trim
   *  cross-check. */
  allInventoryTrims: z.array(z.string()),
  /** Color config cross-check advisory — loose preferred colors the EXACT
   *  colorAxis won't match, with the real stocked names to offer (assist-only;
   *  surfaced on the result, mirroring the trim grounding surfacing). */
  colorCrossCheck: z.array(ColorCrossCheckItemSchema),
});
type InventoryCompareState = z.infer<typeof InventoryCompareStateSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): InventoryCompareState {
  return InventoryCompareStateSchema.parse(inputData);
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
  inputSchema: InventoryCompareInputSchema,
  outputSchema: InventoryCompareStateSchema,
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
      throw new InventoryCompareStopError(
        "no_active_profile",
        "No active search profile found — inventory_compare needs one to know what " +
          "to rank listings against. Run /search_profile_intake to create a profile, " +
          "then re-run /inventory_compare.",
      );
    }
    if (resolved.kind === "ambiguous") {
      const labels = resolved.candidates.map((p) => vehicleLabel(p)).join(" | ");
      throw new InventoryCompareStopError(
        "multiple_active_profiles",
        `Multiple active search profiles found (${labels}). Tell me which vehicle ` +
          "to rank inventory for by re-running /inventory_compare with that " +
          "profile's search_profile_id.",
      );
    }

    // pinned | inferred_newest — the run proceeds, provenance recorded in state.
    return {
      searchProfileId: resolved.profile.id,
      profileTrim: resolved.profile.trim ?? null,
      resolution: resolved.kind,
      candidates: null,
      scannedAtMax: null,
      totalListings: 0,
      recommendedCount: 0,
      sourcesScanned: 0,
      sourcesBlocked: 0,
      allInventoryTrims: [],
      colorCrossCheck: [],
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — computeRanking (tools read + pure ranker; the ONLY DB read)
// ---------------------------------------------------------------------------

const computeRankingStep = createStep({
  id: "computeRanking",
  inputSchema: InventoryCompareStateSchema,
  outputSchema: InventoryCompareStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const ranked = withDb((db) => deps().rankInventory(db, state.searchProfileId));
    return {
      ...state,
      candidates: ranked.candidates,
      scannedAtMax: ranked.scannedAtMax,
      totalListings: ranked.totalListings,
      recommendedCount: ranked.recommendedCount,
      sourcesScanned: ranked.sourcesScanned,
      sourcesBlocked: ranked.sourcesBlocked,
      allInventoryTrims: ranked.allInventoryTrims,
      colorCrossCheck: ranked.colorCrossCheck,
    };
  },
});

// ---------------------------------------------------------------------------
// step 2 — render (pure, ZERO-LLM — the single output + the terminal sentence)
// ---------------------------------------------------------------------------

const renderStep = createStep({
  id: "render",
  inputSchema: InventoryCompareStateSchema,
  outputSchema: InventoryCompareOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const candidates = state.candidates ?? [];

    // The deterministic terminal sentence — candidate count + recommended count,
    // NEVER a budget number. With nothing scanned yet, a bare "Listed 0" reads as
    // a dead end (the live 巡检 hit this when a buyer asked "what's in stock?" and
    // the router chose compare over a scan), so point to the next step in plain
    // words — no slash command, no jargon.
    const baseSummary =
      state.totalListings === 0
        ? state.sourcesScanned > 0
          ? // A scan ran but matched nothing — say so, don't tell them to scan again.
            `Your last scan of ${state.sourcesScanned} dealer site(s) found no matching ` +
            `vehicles in stock` +
            (state.sourcesBlocked > 0
              ? ` (${state.sourcesBlocked} site(s) blocked automated scanning)`
              : "") +
            ". Try widening the trim, or check back later."
          : "No inventory to compare yet — no dealer sites have been scanned. " +
            "Scan the dealers' inventory to see what they have in stock."
        : `Listed ${state.totalListings} inventory candidates ` +
          `(recommended: ${state.recommendedCount}).`;

    // Post-scan trim grounding — the AUTHORITATIVE trim check (intake can't
    // ground: no inventory exists yet at intake). Compare the requested trim
    // against ALL scanned trims (the UNFILTERED set, so a trim a dealer stocks
    // only over-budget / on-order still counts — never a false "no dealer carries
    // it"), token-normalized ("LX" matches "LX CVT", "EX-L" matches "EX-L
    // Hybrid"); when truly absent, name the closest real trims. Gate on any
    // scanned trim (not just the budget-filtered candidates) so the note never
    // fires while a matching trim sits in the unfiltered set.
    let trimNote = "";
    if (
      state.totalListings > 0 &&
      state.profileTrim !== null &&
      state.profileTrim.trim() !== ""
    ) {
      const avail = classifyTrimAvailability(state.profileTrim, state.allInventoryTrims);
      if (!avail.matched) {
        trimNote =
          ` No in-stock car matches the "${state.profileTrim}" trim` +
          (avail.suggestions.length > 0
            ? ` — closest in stock: ${avail.suggestions.join(", ")}.`
            : ".");
      }
    }
    const summary = baseSummary + trimNote;

    return {
      outcome: "ranked" as const,
      resolution: state.resolution,
      search_profile_id: state.searchProfileId,
      scannedAtMax: state.scannedAtMax,
      totalListings: state.totalListings,
      recommendedCount: state.recommendedCount,
      candidates,
      colorCrossCheck: state.colorCrossCheck,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (3 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const inventoryCompareWorkflow = createWorkflow({
  id: INVENTORY_COMPARE_WORKFLOW_ID,
  inputSchema: InventoryCompareInputSchema,
  outputSchema: InventoryCompareOutputSchema,
})
  .then(resolveProfileStep)
  .then(computeRankingStep)
  .then(renderStep)
  .commit();

export { INVENTORY_COMPARE_WORKFLOW_ID };
