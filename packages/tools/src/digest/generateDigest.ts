/**
 * generateDigest — the ONE consolidated read that aggregates every upstream
 * skill's output rows into a typed, render-ready digest payload. Zero LLM, zero
 * writes: pure read aggregation via raw prepared statements (the established
 * tools query pattern — `db.$client.prepare(...).all(...)`, never drizzle-orm
 * `select()`).
 *
 * SCOPE: multi-profile by design. `profileIds` pins an explicit set; null
 * enumerates EVERY active profile (`search_profiles.status = 'active'`). Zero
 * active profiles → a payload whose `state` is the exact sentinel string
 * `_NO_ACTIVE_SEARCHES` and whose `profiles` list is empty (the caller renders
 * the empty state and the workflow records a graceful skip).
 *
 * BUDGET RED-LINE: the payload carries NO budget figure — `search_profiles`
 * is read for identity/scope only, never `budget_max`. OTD quote amounts ARE
 * carried (those are dealer-quoted prices, not the buyer's private ceiling),
 * but the renderer is what passes through `assertNoBudget`; this reader's job
 * is to never surface budget in the first place.
 *
 * OTD source: `dealer_quotes.otd_total` (REAL) — the PRIMARY quote store, NOT
 * the legacy `offers.otd_estimate` thin wrapper. Quotes are grouped per
 * `dealer_quotes.search_profile_id`, sorted OTD-ascending (best/lowest first),
 * and trimmed to `offersLimit`. Rows with a null `otd_total` sort last (they
 * are unpriced) and do not count as the "best".
 */

import type { Db } from "@autobroker/db";

import { getDb } from "../db.js";
import { bucketFreshness, type FreshnessBucket } from "./freshness.js";

/** The exact sentinel a zero-active-profile aggregation carries. */
export const NO_ACTIVE_SEARCHES = "_NO_ACTIVE_SEARCHES" as const;

/** Default count of offers surfaced per profile (best-first, OTD-ascending). */
export const DEFAULT_OFFERS_LIMIT = 10;

/** One OTD-sorted quote row in a profile's offers section. */
export interface DigestOffer {
  quoteId: string;
  dealerId: string;
  dealerName: string;
  /** The out-the-door total (`dealer_quotes.otd_total`); null = unpriced. */
  otdTotal: number | null;
  financingMode: string;
  /** Freshness of the listing this quote targets (`source_listing_id`), if any. */
  freshness: FreshnessBucket;
}

/** The per-profile freshness tally over that profile's inventory listings. */
export interface FreshnessMix {
  fresh: number;
  stale: number;
  missing: number;
}

/** One global Next-Action line, derived deterministically from counts. */
export interface NextAction {
  /** Stable kind for testid/ordering; the label is the human line. */
  kind: "needs_response" | "unanswered_question";
  profileId: string;
  vehicle: string;
  count: number;
  label: string;
}

/** One active profile's full digest group. */
export interface DigestProfileGroup {
  searchProfileId: string;
  vehicle: string;
  // --- dealer status ---------------------------------------------------------
  dealerCount: number;
  /** Dealers whose binding status is `bound` (a committed lead target). */
  boundDealerCount: number;
  // --- thread status ---------------------------------------------------------
  threadCount: number;
  needsResponseCount: number;
  unansweredQuestionCount: number;
  // --- offers ---------------------------------------------------------------
  /** OTD-ascending (best first), trimmed to `offersLimit`. May be empty. */
  offers: DigestOffer[];
  /** Total quotes for the profile BEFORE the offersLimit trim. */
  totalQuotes: number;
  /** The lowest (best) non-null OTD across the profile's quotes, or null. */
  bestOtd: number | null;
  // --- inventory freshness ---------------------------------------------------
  freshnessMix: FreshnessMix;
}

/** The full multi-profile digest payload (render-ready). */
export interface DigestPayload {
  /** `_NO_ACTIVE_SEARCHES` when zero active profiles resolved; else "ok". */
  state: typeof NO_ACTIVE_SEARCHES | "ok";
  /** Epoch-ms the aggregation reads "now" as (freshness + headline). */
  generatedAtMs: number;
  /** The "new since" window, when a since_hours filter was supplied. */
  sinceHours: number | null;
  profiles: DigestProfileGroup[];
  /** Global, deterministically derived action list (needs-response + questions). */
  nextActions: NextAction[];
  /** The lowest OTD across ALL summarized profiles, or null. */
  overallBestOtd: number | null;
}

export interface GenerateDigestArgs {
  /** Pin an explicit profile set; null → every active profile. */
  profileIds?: string[] | null;
  /** Epoch-ms "now" (freshness window + headline). REQUIRED for determinism. */
  nowMs: number;
  /** Optional "new since" window in hours (reserved for window counters). */
  sinceHours?: number | null;
  /** Offers surfaced per profile (best-first). Default DEFAULT_OFFERS_LIMIT. */
  offersLimit?: number;
}

// ---------------------------------------------------------------------------
// raw prepared statements (the tools query pattern — never drizzle-orm select)
// ---------------------------------------------------------------------------

const SELECT_ACTIVE_PROFILES =
  "SELECT search_profile_id, year, make, model, trim FROM search_profiles " +
  "WHERE status = 'active' OR status IS NULL ORDER BY rowid DESC";

const SELECT_PROFILE_BY_ID =
  "SELECT search_profile_id, year, make, model, trim FROM search_profiles WHERE search_profile_id = ?";

const SELECT_DEALER_COUNTS =
  "SELECT COUNT(*) AS total, " +
  "SUM(CASE WHEN status = 'bound' THEN 1 ELSE 0 END) AS bound " +
  "FROM profile_dealers WHERE search_profile_id = ?";

const SELECT_THREAD_COUNT = "SELECT COUNT(*) AS total FROM threads WHERE search_profile_id = ?";

// needs_response over the CURRENT analysis only (partial UNIQUE WHERE is_current=1
// — NEVER max(analysis_version)).
const SELECT_NEEDS_RESPONSE =
  "SELECT COUNT(*) AS n FROM message_analysis " +
  "WHERE search_profile_id = ? AND is_current = 1 AND needs_response = 1";

const SELECT_UNANSWERED_QUESTIONS =
  "SELECT COUNT(*) AS n FROM message_questions " +
  "WHERE search_profile_id = ? AND status = 'needs_user_input'";

// Quotes for the profile, joined to the dealer name and (optionally) to the
// targeted listing's last_seen_at for the freshness chip. otd_total ascending,
// NULLs last (unpriced quotes sort to the bottom and never win "best").
const SELECT_QUOTES =
  "SELECT q.quote_id AS quote_id, q.dealer_id AS dealer_id, " +
  "COALESCE(d.name, '(unknown dealer)') AS dealer_name, " +
  "q.otd_total AS otd_total, q.financing_mode AS financing_mode, " +
  "il.last_seen_at AS last_seen_at " +
  "FROM dealer_quotes q " +
  "LEFT JOIN dealers d ON d.dealer_id = q.dealer_id " +
  "LEFT JOIN inventory_listings il ON il.listing_id = q.source_listing_id " +
  "WHERE q.search_profile_id = ? " +
  "ORDER BY (q.otd_total IS NULL), q.otd_total ASC, q.quote_id ASC";

const SELECT_LISTING_FRESHNESS =
  "SELECT last_seen_at FROM inventory_listings WHERE search_profile_id = ?";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ProfileRow {
  search_profile_id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
}

function vehicleLabel(row: ProfileRow): string {
  return [row.year, row.make, row.model, row.trim]
    .filter((p): p is string | number => p !== null && p !== undefined && p !== "")
    .join(" ")
    .trim();
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function intOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// the aggregator
// ---------------------------------------------------------------------------

/**
 * Aggregate the digest payload across the resolved active profiles. Pure read;
 * `nowMs` drives every freshness decision so the same DB state always yields
 * the same payload.
 */
export function generateDigest(db: Db, args: GenerateDigestArgs): DigestPayload {
  const client = (db ?? getDb()).$client;
  const offersLimit = args.offersLimit ?? DEFAULT_OFFERS_LIMIT;
  const sinceHours = args.sinceHours ?? null;

  // Resolve the scope: explicit ids (filtered to those that exist) or all active.
  let profileRows: ProfileRow[];
  if (args.profileIds != null) {
    const stmt = client.prepare(SELECT_PROFILE_BY_ID);
    profileRows = args.profileIds
      .map((id) => stmt.get(id) as ProfileRow | undefined)
      .filter((r): r is ProfileRow => r !== undefined);
  } else {
    profileRows = client.prepare(SELECT_ACTIVE_PROFILES).all() as ProfileRow[];
  }

  if (profileRows.length === 0) {
    return {
      state: NO_ACTIVE_SEARCHES,
      generatedAtMs: args.nowMs,
      sinceHours,
      profiles: [],
      nextActions: [],
      overallBestOtd: null,
    };
  }

  const groups: DigestProfileGroup[] = [];
  const nextActions: NextAction[] = [];
  let overallBestOtd: number | null = null;

  for (const row of profileRows) {
    const profileId = row.search_profile_id;
    const vehicle = vehicleLabel(row);

    const dealerCounts = client.prepare(SELECT_DEALER_COUNTS).get(profileId) as {
      total: unknown;
      bound: unknown;
    };
    const threadRow = client.prepare(SELECT_THREAD_COUNT).get(profileId) as { total: unknown };
    const needsRow = client.prepare(SELECT_NEEDS_RESPONSE).get(profileId) as { n: unknown };
    const questionRow = client.prepare(SELECT_UNANSWERED_QUESTIONS).get(profileId) as { n: unknown };

    const needsResponseCount = intOf(needsRow.n);
    const unansweredQuestionCount = intOf(questionRow.n);

    // Quotes → OTD-ascending offers, trimmed; best = lowest non-null OTD.
    const quoteRows = client.prepare(SELECT_QUOTES).all(profileId) as Array<{
      quote_id: string;
      dealer_id: string;
      dealer_name: string;
      otd_total: unknown;
      financing_mode: string;
      last_seen_at: unknown;
    }>;
    const allOffers: DigestOffer[] = quoteRows.map((q) => ({
      quoteId: q.quote_id,
      dealerId: q.dealer_id,
      dealerName: q.dealer_name,
      otdTotal: numOrNull(q.otd_total),
      financingMode: q.financing_mode,
      freshness: bucketFreshness(numOrNull(q.last_seen_at), args.nowMs),
    }));
    const offers = allOffers.slice(0, offersLimit);
    const bestOtd = allOffers.reduce<number | null>((best, o) => {
      if (o.otdTotal === null) return best;
      return best === null || o.otdTotal < best ? o.otdTotal : best;
    }, null);
    if (bestOtd !== null && (overallBestOtd === null || bestOtd < overallBestOtd)) {
      overallBestOtd = bestOtd;
    }

    // Inventory freshness mix over the profile's listings.
    const listingRows = client.prepare(SELECT_LISTING_FRESHNESS).all(profileId) as Array<{
      last_seen_at: unknown;
    }>;
    const freshnessMix: FreshnessMix = { fresh: 0, stale: 0, missing: 0 };
    for (const l of listingRows) {
      freshnessMix[bucketFreshness(numOrNull(l.last_seen_at), args.nowMs)] += 1;
    }

    groups.push({
      searchProfileId: profileId,
      vehicle,
      dealerCount: intOf(dealerCounts.total),
      boundDealerCount: intOf(dealerCounts.bound),
      threadCount: intOf(threadRow.total),
      needsResponseCount,
      unansweredQuestionCount,
      offers,
      totalQuotes: allOffers.length,
      bestOtd,
      freshnessMix,
    });

    // Deterministic Next Actions: one line per non-zero count.
    if (needsResponseCount > 0) {
      nextActions.push({
        kind: "needs_response",
        profileId,
        vehicle,
        count: needsResponseCount,
        label: `${vehicle}: ${needsResponseCount} dealer reply(ies) need a response.`,
      });
    }
    if (unansweredQuestionCount > 0) {
      nextActions.push({
        kind: "unanswered_question",
        profileId,
        vehicle,
        count: unansweredQuestionCount,
        label: `${vehicle}: ${unansweredQuestionCount} dealer question(s) await your input.`,
      });
    }
  }

  return {
    state: "ok",
    generatedAtMs: args.nowMs,
    sinceHours,
    profiles: groups,
    nextActions,
    overallBestOtd,
  };
}
