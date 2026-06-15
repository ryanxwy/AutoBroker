/**
 * buildDigestView — the LIVE re-aggregation the `GET /api/digest` route
 * delegates to. The digest page is a live projection (zero stored rows, zero
 * migration): every page load re-aggregates from the product DB through
 * `generateDigest` and shapes a plain JSON the UI renders directly.
 *
 * The route NEVER opens the product DB — it calls down into this tools function
 * (the SQLite-ownership wall). `profileId` pins one search; null/absent
 * enumerates every active profile. A zero-active world returns `empty: true`
 * with the `_NO_ACTIVE_SEARCHES` state, so the page renders the empty card.
 *
 * BUDGET: this view carries NO budget number — it is shaped from the
 * budget-free `DigestPayload`. OTD quote amounts (dealer prices) ARE included;
 * the buyer's private ceiling is never read.
 */

import type { Db } from "@autobroker/db";

import { getDb } from "../db.js";
import { assertNoBudget } from "../validators.js";
import { digestHeadline } from "./renderDigest.js";
import {
  generateDigest,
  NO_ACTIVE_SEARCHES,
  type FreshnessMix,
  type NextAction,
} from "./generateDigest.js";
import type { FreshnessBucket } from "./freshness.js";

/** One quote row in the view (OTD + freshness chip; no budget). */
export interface DigestViewQuoteRow {
  quoteId: string;
  dealerId: string;
  dealerName: string;
  otdTotal: number | null;
  financingMode: string;
  freshness: FreshnessBucket;
  /** True for the lowest-OTD row in the profile (the highlighted best). */
  isBest: boolean;
}

/** One profile section in the view. */
export interface DigestViewProfile {
  searchProfileId: string;
  vehicle: string;
  dealerCount: number;
  boundDealerCount: number;
  threadCount: number;
  needsResponseCount: number;
  unansweredQuestionCount: number;
  quotes: DigestViewQuoteRow[];
  totalQuotes: number;
  bestOtd: number | null;
  freshnessMix: FreshnessMix;
}

/** The plain JSON the UI renders. `empty` flags the no-active-searches state. */
export interface DigestView {
  empty: boolean;
  /** `_NO_ACTIVE_SEARCHES` when empty, else "ok". */
  state: typeof NO_ACTIVE_SEARCHES | "ok";
  /** ISO timestamp the view was generated at (digest-generated-at). */
  generatedAt: string;
  /** The one-line headline (no budget). */
  headline: string;
  profiles: DigestViewProfile[];
  nextActions: NextAction[];
  /** Lowest OTD across all summarized profiles, or null. */
  overallBestOtd: number | null;
}

export interface BuildDigestViewArgs {
  /** Pin one profile, or null/absent → all active. */
  profileId?: string | null;
  /** Epoch-ms "now" (freshness + generatedAt). */
  nowMs: number;
}

/** Re-aggregate the live digest view for the route. */
export function buildDigestView(db: Db, args: BuildDigestViewArgs): DigestView {
  const handle = db ?? getDb();
  const payload = generateDigest(handle, {
    profileIds: args.profileId != null ? [args.profileId] : null,
    nowMs: args.nowMs,
  });

  const generatedAt = new Date(args.nowMs).toISOString();
  const headline = digestHeadline(payload);
  // Defense-in-depth, symmetric with the workflow's notify step: the live
  // projection's headline must never carry a budget figure either (the page
  // ships it verbatim). Fail loud if a budget phrase ever leaks in.
  assertNoBudget(headline);

  if (payload.state === NO_ACTIVE_SEARCHES || payload.profiles.length === 0) {
    return {
      empty: true,
      state: NO_ACTIVE_SEARCHES,
      generatedAt,
      headline,
      profiles: [],
      nextActions: [],
      overallBestOtd: null,
    };
  }

  const profiles: DigestViewProfile[] = payload.profiles.map((g) => {
    // Highlight only the FIRST best-OTD row (offers are OTD-ascending, so the
    // first row matching bestOtd is the canonical best; ties don't double-mark).
    let bestMarked = false;
    return {
      searchProfileId: g.searchProfileId,
      vehicle: g.vehicle,
      dealerCount: g.dealerCount,
      boundDealerCount: g.boundDealerCount,
      threadCount: g.threadCount,
      needsResponseCount: g.needsResponseCount,
      unansweredQuestionCount: g.unansweredQuestionCount,
      quotes: g.offers.map((o) => {
        const isBest = !bestMarked && g.bestOtd !== null && o.otdTotal === g.bestOtd;
        if (isBest) bestMarked = true;
        return {
          quoteId: o.quoteId,
          dealerId: o.dealerId,
          dealerName: o.dealerName,
          otdTotal: o.otdTotal,
          financingMode: o.financingMode,
          freshness: o.freshness,
          isBest,
        };
      }),
      totalQuotes: g.totalQuotes,
      bestOtd: g.bestOtd,
      freshnessMix: g.freshnessMix,
    };
  });

  return {
    empty: false,
    state: "ok",
    generatedAt,
    headline,
    profiles,
    nextActions: payload.nextActions,
    overallBestOtd: payload.overallBestOtd,
  };
}
