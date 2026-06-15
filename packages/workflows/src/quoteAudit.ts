/**
 * quote_audit — the deterministic 10-check quote audit skill. ONE flat linear
 * Mastra `createWorkflow`: 4 named steps chained with `.then()`, ZERO suspend
 * steps and ZERO LLM calls. The whole run is read-then-record: resolve the
 * profile, read the candidate quotes + the peer set + the incentive slice, run
 * the pure 10-check audit per quote, UPSERT each result into quote_audits, and
 * render a per-quote summary rail. A failure (no profile / ambiguous) is a typed
 * thrown STOP — never a silent partial success.
 *
 * STEP MAP:
 *   0 resolveProfile — typed three-branch profile resolution via the tools
 *                      resolver (pinned → run; exactly-1 active → inferred-newest,
 *                      LOGGED, run; 0 active → typed STOP pointing at
 *                      /search_profile_intake; 2+ → typed STOP asking by vehicle
 *                      name). Read-only / infer-ok: there is NO pick-suspend — a
 *                      STOP is terminal.
 *   1 loadQuotes     — read the candidate set (single-quote mode via getQuote, OR
 *                      the recent/unaudited batch via listQuotesForProfile), the
 *                      peer set (listPeerQuotes), the (make,model,zip) incentive
 *                      slice (listIncentivesSlice), and the profile row mapped to
 *                      the AuditProfile shape (state/make/model/zip/financing/
 *                      eligibility). No write, no network.
 *   2 runAudit       — per candidate quote: auditQuote(quote, peers, incentives,
 *                      profile) → the firing AuditFinding[]. Pure, zero-LLM.
 *                      (An LLM-assisted add-on tagging pass is DEFERRED — see the
 *                      addOnTag seam note below; nothing here calls a model.)
 *   3 persistAudits  — UPSERT one quote_audits row per audited quote (idempotent
 *                      on (dealer_quote_id, audit_pass_version) — a same-pass
 *                      re-run UPDATEs in place, never a duplicate). audit_pass_
 *                      version = DEFAULT_AUDIT_PASS_VERSION, audited_at = ISO now.
 *   4 confirm        — pure, ZERO-LLM: assemble the single output object + the
 *                      deterministic terminal sentence. Zero audited quotes is a
 *                      VALID success.
 *
 * Quotes ≠ budget: the per-quote rail carries OTD totals + finding text, NEVER a
 * budget number. The terminal summary names an audited count + a flagged count.
 *
 * ADD-ON TAGGING SEAM (DEFERRED, zero-LLM today): the pure checkAddOns keyword
 * scan in the tools audit already emits ADD_ON_<NAME> findings deterministically.
 * A future model-assisted pass that recognizes novel add-on product names would
 * slot in as a step "2b addOnTag" between runAudit and persistAudits — it is
 * intentionally NOT built here (D2 is strictly deterministic); this comment is
 * the only marker of where it would land.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/tools (the
 * resolver + the audit checks + the read helpers + the idempotent writer + getDb
 * — the ONLY DB/side-effect path), and this skill's contracts. NO
 * @autobroker/model (zero-LLM), NO harness, NO browser.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { AuditFindingSchema } from "@autobroker/core";
import {
  auditQuote as auditQuoteImpl,
  getDb,
  getQuote as getQuoteImpl,
  listIncentivesSlice as listIncentivesSliceImpl,
  listPeerQuotes as listPeerQuotesImpl,
  listQuotesForProfile as listQuotesForProfileImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
  upsertAudit as upsertAuditImpl,
  DEFAULT_AUDIT_PASS_VERSION,
  type AuditIncentive,
  type AuditProfile,
  type AuditQuoteWithId,
} from "@autobroker/tools";

import {
  QuoteAuditInputSchema,
  QuoteAuditOutputSchema,
  QuoteAuditRowSchema,
  QuoteAuditStopError,
  QUOTE_AUDIT_WORKFLOW_ID,
} from "./quoteAuditContracts.js";

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the sibling skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL step chain against
 * deterministic stubs and an isolated tmp DB, WITHOUT a vitest module mock —
 * the same holder-over-factory rationale as the sibling skills' seams.
 */
export interface QuoteAuditWorkflowDeps {
  /** The typed three-branch profile resolver (tools layer). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** Read one quote by id (single-quote mode). */
  getQuote: typeof getQuoteImpl;
  /** Read the profile's candidate quote set (the recent batch). */
  listQuotesForProfile: typeof listQuotesForProfileImpl;
  /** Read the profile's full peer-quote set (the median-check basis). */
  listPeerQuotes: typeof listPeerQuotesImpl;
  /** Read the (make,model,zip)-exact incentive slice. */
  listIncentivesSlice: typeof listIncentivesSliceImpl;
  /** The pure 10-check audit. */
  auditQuote: typeof auditQuoteImpl;
  /** The idempotent audit-row writer. */
  upsertAudit: typeof upsertAuditImpl;
  /** The DB accessor the read/write steps go through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: QuoteAuditWorkflowDeps = {
  resolveProfile: resolveActiveProfileImpl,
  getQuote: getQuoteImpl,
  listQuotesForProfile: listQuotesForProfileImpl,
  listPeerQuotes: listPeerQuotesImpl,
  listIncentivesSlice: listIncentivesSliceImpl,
  auditQuote: auditQuoteImpl,
  upsertAudit: upsertAuditImpl,
  getDb,
};

let injectedDeps: QuoteAuditWorkflowDeps | undefined;

/** The deps the steps use: injected (tests) or the real wiring (production). */
function deps(): QuoteAuditWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/**
 * TEST-ONLY seam. Refused outside a test runner (same guard rule as the sibling
 * seams): a production caller must never redirect the resolver or the DB
 * read/write path. Pass a partial; unspecified collaborators keep their real
 * implementation.
 */
export function __setQuoteAuditDepsForTests(partial: Partial<QuoteAuditWorkflowDeps>): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setQuoteAuditDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetQuoteAuditDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

/** The AuditProfile shape carried in state (flat plain-JSON for the snapshot). */
const AuditProfileStateSchema = z.object({
  state: z.string().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  postal_code: z.string().nullable(),
  financing_preference: z.string().nullable(),
  current_brand_owner: z.number().int(),
  military_first_responder: z.number().int(),
});

/** One loaded quote carried in state: its id + the audit-readable float fields. */
const LoadedQuoteSchema = z.object({
  quote_id: z.string(),
  selling_price: z.number().nullable(),
  dealer_fee: z.number().nullable(),
  doc_fee: z.number().nullable(),
  sales_tax: z.number().nullable(),
  dmv_fees: z.number().nullable(),
  title_fee: z.number().nullable(),
  registration_fee: z.number().nullable(),
  license_fee: z.number().nullable(),
  other_fees_json: z.array(z.record(z.string(), z.unknown())),
  add_ons_json: z.array(z.record(z.string(), z.unknown())),
  rebates_json: z.array(z.record(z.string(), z.unknown())),
  otd_total: z.number().nullable(),
  confidence: z.number().nullable(),
  extraction_method: z.string().nullable(),
  financing_mode: z.string(),
  finance_apr: z.number().nullable(),
  lease_money_factor: z.number().nullable(),
});

const IncentiveStateSchema = z.object({
  make: z.string(),
  eligibility: z.string(),
  type: z.string(),
  amount: z.number().nullable(),
});

/** A dealer-name lookup for the audited quotes (quote_id → dealer display name). */
const DealerNameMapSchema = z.record(z.string(), z.string());

/**
 * The accumulating state threaded through the 4 steps. Flat plain-JSON (Mastra
 * snapshots it): the resolved profile + provenance, then the loaded inputs, then
 * the per-quote findings.
 */
const QuoteAuditStateSchema = z.object({
  searchProfileId: z.string(),
  /** pinned vs inferred-newest — the resolution provenance, always recorded. */
  resolution: z.enum(["pinned", "inferred_newest"]),
  /** Single-quote target, or null (recent batch). Carried for the load step. */
  quoteId: z.string().nullable(),
  /** The AuditProfile fields (after load); null until then. */
  profile: AuditProfileStateSchema.nullable(),
  /** The candidate quotes to audit (after load). */
  candidates: z.array(LoadedQuoteSchema),
  /** The peer set for the median checks (after load). */
  peers: z.array(LoadedQuoteSchema),
  /** The incentive slice for MISSING_REBATE (after load). */
  incentives: z.array(IncentiveStateSchema),
  /** quote_id → dealer display name (after load). */
  dealerNames: DealerNameMapSchema,
  /** quote_id → otd_total (after load; null when the quote carries none). */
  otdByQuote: z.record(z.string(), z.number().nullable()),
  /** Per-quote findings (after audit); keyed by quote_id. */
  findingsByQuote: z.record(z.string(), z.array(AuditFindingSchema)),
});
type QuoteAuditState = z.infer<typeof QuoteAuditStateSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): QuoteAuditState {
  return QuoteAuditStateSchema.parse(inputData);
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

/** Coerce an int-bool column (0/1, possibly null) to a plain number. */
function intBool(value: unknown): number {
  return value ? 1 : 0;
}

/** Map a raw search_profiles row to the AuditProfile shape the checks read. */
function rowToAuditProfile(row: Record<string, unknown>): AuditProfile {
  const str = (key: string): string | null =>
    typeof row[key] === "string" && row[key] !== "" ? (row[key] as string) : null;
  return {
    state: str("state"),
    make: str("make"),
    model: str("model"),
    postal_code: str("postal_code"),
    financing_preference: str("financing_preference"),
    current_brand_owner: intBool(row["current_brand_owner"]),
    military_first_responder: intBool(row["military_first_responder"]),
  };
}

/** The float-dollar audit shape the checks consume (drop the carried id). */
function toAuditQuote(q: z.infer<typeof LoadedQuoteSchema>): AuditQuoteWithId {
  return q as AuditQuoteWithId;
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (typed three-branch; read-only / infer-ok)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: QuoteAuditInputSchema,
  outputSchema: QuoteAuditStateSchema,
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
      throw new QuoteAuditStopError(
        "no_active_profile",
        "No active search profile found — quote_audit needs one to know which " +
          "dealer quotes to audit. Run /search_profile_intake to create a profile, " +
          "then re-run /quote_audit.",
      );
    }
    if (resolved.kind === "ambiguous") {
      const labels = resolved.candidates.map((p) => vehicleLabel(p)).join(" | ");
      throw new QuoteAuditStopError(
        "multiple_active_profiles",
        `Multiple active search profiles found (${labels}). Tell me which vehicle ` +
          "to audit quotes for by re-running /quote_audit with that profile's " +
          "search_profile_id.",
      );
    }

    // pinned | inferred_newest — the run proceeds, provenance recorded in state.
    return {
      searchProfileId: resolved.profile.id,
      resolution: resolved.kind,
      quoteId: inputData.quote_id,
      profile: null,
      candidates: [],
      peers: [],
      incentives: [],
      dealerNames: {},
      otdByQuote: {},
      findingsByQuote: {},
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — loadQuotes (tools reads; the ONLY DB read)
// ---------------------------------------------------------------------------

const SELECT_PROFILE = "SELECT * FROM search_profiles WHERE search_profile_id = ?";
const SELECT_DEALER_NAME =
  "SELECT COALESCE(d.name, dq.dealer_id) AS dealer_name FROM dealer_quotes dq " +
  "LEFT JOIN dealers d ON d.dealer_id = dq.dealer_id WHERE dq.quote_id = ?";

const loadQuotesStep = createStep({
  id: "loadQuotes",
  inputSchema: QuoteAuditStateSchema,
  outputSchema: QuoteAuditStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);

    return withDb((db) => {
      const profileRow = db.$client.prepare(SELECT_PROFILE).get(state.searchProfileId) as
        | Record<string, unknown>
        | undefined;
      const auditProfile: AuditProfile =
        profileRow !== undefined
          ? rowToAuditProfile(profileRow)
          : {
              state: null,
              make: null,
              model: null,
              postal_code: null,
              financing_preference: null,
              current_brand_owner: 0,
              military_first_responder: 0,
            };

      // Single-quote mode: just the named quote (still profile-scoped peers +
      // incentives below). Batch mode: the recent/unaudited slice for this pass.
      let candidates: AuditQuoteWithId[];
      if (state.quoteId !== null) {
        const one = deps().getQuote(db, state.quoteId);
        candidates = one !== null ? [one] : [];
      } else {
        candidates = deps().listQuotesForProfile(db, state.searchProfileId, {
          recent: true,
          passVersion: DEFAULT_AUDIT_PASS_VERSION,
        });
      }

      const peers = deps().listPeerQuotes(db, state.searchProfileId);

      const incentives: AuditIncentive[] =
        auditProfile.make !== null &&
        auditProfile.model !== null &&
        auditProfile.postal_code !== null
          ? deps().listIncentivesSlice(
              db,
              auditProfile.make,
              auditProfile.model,
              auditProfile.postal_code,
            )
          : [];

      // Dealer display name + otd_total per audited quote (for the output rail).
      const dealerNames: Record<string, string> = {};
      const otdByQuote: Record<string, number | null> = {};
      const nameStmt = db.$client.prepare(SELECT_DEALER_NAME);
      for (const q of candidates) {
        const nameRow = nameStmt.get(q.quote_id) as { dealer_name?: unknown } | undefined;
        dealerNames[q.quote_id] =
          typeof nameRow?.dealer_name === "string" ? nameRow.dealer_name : q.quote_id;
        otdByQuote[q.quote_id] = q.otd_total;
      }

      return {
        ...state,
        profile: auditProfile,
        candidates,
        peers,
        incentives,
        dealerNames,
        otdByQuote,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// step 2 — runAudit (pure 10-check per quote; ZERO-LLM)
// ---------------------------------------------------------------------------

const runAuditStep = createStep({
  id: "runAudit",
  inputSchema: QuoteAuditStateSchema,
  outputSchema: QuoteAuditStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.profile === null) {
      throw new Error("quote_audit: profile not loaded before runAudit (contract breach)");
    }
    const profile = state.profile;
    const peers = state.peers.map(toAuditQuote);

    const findingsByQuote: Record<string, z.infer<typeof AuditFindingSchema>[]> = {};
    for (const q of state.candidates) {
      findingsByQuote[q.quote_id] = deps().auditQuote(
        toAuditQuote(q),
        peers,
        state.incentives,
        profile,
      );
    }

    return { ...state, findingsByQuote };
  },
});

// ---------------------------------------------------------------------------
// step 3 — persistAudits (idempotent UPSERT per quote)
// ---------------------------------------------------------------------------

const persistAuditsStep = createStep({
  id: "persistAudits",
  inputSchema: QuoteAuditStateSchema,
  outputSchema: QuoteAuditStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const auditedAt = new Date().toISOString();

    withDb((db) => {
      for (const q of state.candidates) {
        deps().upsertAudit(db, {
          dealer_quote_id: q.quote_id,
          search_profile_id: state.searchProfileId,
          flags: state.findingsByQuote[q.quote_id] ?? [],
          audit_pass_version: DEFAULT_AUDIT_PASS_VERSION,
          audited_at: auditedAt,
        });
      }
    });

    return state;
  },
});

// ---------------------------------------------------------------------------
// step 4 — confirm (pure, ZERO-LLM — the single output + the terminal sentence)
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: QuoteAuditStateSchema,
  outputSchema: QuoteAuditOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);

    const perQuote: z.infer<typeof QuoteAuditRowSchema>[] = [];
    const flagCounts = { info: 0, warn: 0, block: 0 };
    let flagged = 0;
    let bestOtd: { dealerName: string; otdTotal: number } | null = null;

    for (const q of state.candidates) {
      const flags = state.findingsByQuote[q.quote_id] ?? [];
      const dealerName = state.dealerNames[q.quote_id] ?? q.quote_id;
      const otdTotal = state.otdByQuote[q.quote_id] ?? null;

      if (flags.length > 0) flagged += 1;
      for (const f of flags) flagCounts[f.severity] += 1;

      if (otdTotal !== null && (bestOtd === null || otdTotal < bestOtd.otdTotal)) {
        bestOtd = { dealerName, otdTotal };
      }

      perQuote.push({ quote_id: q.quote_id, dealer_name: dealerName, otd_total: otdTotal, flags });
    }

    const audited = state.candidates.length;
    // The deterministic terminal sentence — audited + flagged counts, plus the
    // best OTD when one exists. NEVER a budget number.
    let summary = `Audited ${audited} quotes. ${flagged} flagged.`;
    if (bestOtd !== null) {
      summary += ` Best OTD: ${bestOtd.dealerName} ($${bestOtd.otdTotal.toLocaleString("en-US")}).`;
    }

    return {
      outcome: "audited" as const,
      resolution: state.resolution,
      search_profile_id: state.searchProfileId,
      audited,
      flagged,
      flagCounts,
      bestOtd,
      perQuote,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (4 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const quoteAuditWorkflow = createWorkflow({
  id: QUOTE_AUDIT_WORKFLOW_ID,
  inputSchema: QuoteAuditInputSchema,
  outputSchema: QuoteAuditOutputSchema,
})
  .then(resolveProfileStep)
  .then(loadQuotesStep)
  .then(runAuditStep)
  .then(persistAuditsStep)
  .then(confirmStep)
  .commit();

export { QUOTE_AUDIT_WORKFLOW_ID };
