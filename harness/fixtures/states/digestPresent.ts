/**
 * digestPresent — the RENDERING digest world for the daily_digest (O0) UI lane.
 *
 * Seeds ONE active search profile with a full upstream output set, so the
 * `/digest` page projects every section non-vacuously AND a `/daily_digest`
 * slash run has real rows to aggregate (and a watermark to advance):
 *
 *   - 1 active search_profiles row (Hyundai Tucson Hybrid) — the page's
 *     digest-section-profile + the slash run's resolved scope.
 *   - 2 dealers + 2 profile_dealers ('bound') — the dealers section's tallies.
 *   - 2 dealer_quotes with DISTINCT otd_total ($31,500 vs $33,995) — so the
 *     lowest-OTD ("best") row is unambiguous: $31,500 is the best. Two
 *     digest-quote-row entries render; digest-best-otd shows $31,500.
 *   - 1 inbound thread + message + CURRENT message_analysis (is_current=1,
 *     needs_response=1) — the needs-response callout (one thread awaiting a
 *     reply) + the needs_response Next Action line.
 *   - 1 message_questions (status='needs_user_input') — the open-question
 *     callout + the unanswered_question Next Action line.
 *   - 3 inventory_listings with a MIX of last_seen_at relative to "now":
 *       fresh   (seen just now, age ~0 ≤ 24h),
 *       stale   (seen 3 days ago, > 24h and ≤ 7d),
 *       missing (seen 10 days ago, > 7d),
 *     so the freshness mix is exactly { fresh:1, stale:1, missing:1 }.
 *
 * FRESHNESS / "now": the digest page route reads `Date.now()` at render time,
 * and this seed runs (via POST /__e2e/apply-fixture) moments before the page
 * loads — so the last_seen_at offsets below, anchored to the seed-time
 * Date.now(), land in the intended buckets at render time (the few-second gap
 * is far inside the 24h fresh window). The classifier (bucketFreshness) is
 * deterministic given nowMs; we only need each row on the correct side of the
 * 24h / 7d edges, not an exact instant.
 *
 * BUDGET: nothing here is a budget figure. OTD totals are dealer-quoted prices
 * (explicitly allowed on the digest); the buyer's private ceiling is never
 * seeded or read.
 *
 * Addresses / emails are generic placeholders — no real account string appears.
 *
 * Dependency wall: harness layer (imports the @autobroker/tools Db type only;
 * writes through db.$client.prepare(...).run(...), mirroring the other states).
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
const PROFILE_ID = "digest-present-tucson-1";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Insert one dealer + bind it to the profile ('bound'). */
function bindDealer(db: Db, id: string, name: string, distance: number): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO dealers (dealer_id, name, address, city, state, postal_code, distance_miles, country) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'US')",
  ).run(id, name, `${distance} mi away, Tucson, AZ`, "Tucson", "AZ", "85704", distance);
  c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
  ).run(PROFILE_ID, id);
}

/** Insert one OTD-bearing dealer_quote (finance mode) for the profile. The
 *  digest reads otd_total directly; the NOT NULL companion columns (message_id,
 *  source_gmail_message_id, financing_mode) carry deterministic synthetic ids —
 *  none of them is FK-enforced on dealer_quotes. */
function insertQuote(
  db: Db,
  quoteId: string,
  dealerId: string,
  otdTotal: number,
  sourceListingId: string | null,
): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes " +
        "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, " +
        "otd_total, financing_mode, source_listing_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'finance', ?)",
    )
    .run(quoteId, dealerId, `${quoteId}-msg`, `${quoteId}-gmsg`, PROFILE_ID, otdTotal, sourceListingId);
}

/** Insert one inventory_listing with an explicit last_seen_at (epoch-ms). */
function insertListing(
  db: Db,
  listingId: string,
  dealerId: string,
  lastSeenAtMs: number,
): void {
  db.$client
    .prepare(
      "INSERT INTO inventory_listings " +
        "(listing_id, search_profile_id, dealer_id, inventory_status, match_status, " +
        "raw_listing_json, first_seen_at, last_seen_at, observed_at) " +
        "VALUES (?, ?, ?, 'in_stock', 'matched', '{}', ?, ?, ?)",
    )
    .run(listingId, PROFILE_ID, dealerId, lastSeenAtMs, lastSeenAtMs, lastSeenAtMs);
}

export const digestPresent: FixtureState = {
  id: "digest_present",
  seed: (db: Db) => {
    const c = db.$client;
    const now = Date.now();

    // --- the active search the digest scopes to ----------------------------
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      PROFILE_ID,
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "SEL",
      50,
      "Tucson, AZ 85704",
      "Tucson",
      "AZ",
      "85704",
      32.3349,
      -110.9762,
      "finance",
      "fake",
      "acct-harness-1",
      "Hyundai",
      "Tucson, AZ 85704",
      "active",
    );

    // --- two bound dealers --------------------------------------------------
    bindDealer(db, "digest-jim-click", "Jim Click Hyundai", 4.2);
    bindDealer(db, "digest-precision", "Precision Hyundai", 6.8);

    // --- a thread + message so the needs-response analysis hangs off a real
    //     message (message_analysis.message_id is FK-enforced to messages, and
    //     messages.thread_id FK-enforced to threads). The thread also lifts the
    //     dealers section's thread tally to 1. ----------------------------------
    c.prepare(
      "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) " +
        "VALUES (?, ?, ?, 'replied', ?)",
    ).run("digest-thread-1", "digest-jim-click", "Re: 2026 Tucson Hybrid SEL availability", PROFILE_ID);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, sender, subject, body_text, search_profile_id) " +
        "VALUES (?, ?, 'inbound', ?, ?, ?, ?)",
    ).run(
      "digest-msg-1",
      "digest-thread-1",
      "sales@example-dealer.com",
      "Re: 2026 Tucson Hybrid SEL availability",
      "We have one in stock — happy to send numbers. When can you come in?",
      PROFILE_ID,
    );

    // --- the CURRENT analysis that needs a response -------------------------
    c.prepare(
      "INSERT INTO message_analysis " +
        "(analysis_id, message_id, analysis_version, is_current, intent, needs_response, search_profile_id) " +
        "VALUES (?, ?, 1, 1, 'quote', 1, ?)",
    ).run("digest-analysis-1", "digest-msg-1", PROFILE_ID);

    // --- the open question awaiting the user's input ------------------------
    c.prepare(
      "INSERT INTO message_questions " +
        "(question_id, analysis_id, question_type, question_text, status, search_profile_id) " +
        "VALUES (?, ?, 'logistics', ?, 'needs_user_input', ?)",
    ).run(
      "digest-question-1",
      "digest-analysis-1",
      "Are you financing or paying cash?",
      PROFILE_ID,
    );

    // --- two quotes with DISTINCT OTD totals — $31,500 is the unambiguous
    //     best (lowest). Each targets one of the fresh/stale listings so the
    //     row's freshness chip resolves to a real bucket. -----------------------
    insertQuote(db, "digest-quote-best", "digest-jim-click", 31_500, "digest-listing-fresh");
    insertQuote(db, "digest-quote-other", "digest-precision", 33_995, "digest-listing-stale");

    // --- three listings spanning the freshness buckets ----------------------
    //     fresh: seen now (age ~0 ≤ 24h)
    insertListing(db, "digest-listing-fresh", "digest-jim-click", now);
    //     stale: seen 3 days ago (> 24h, ≤ 7d)
    insertListing(db, "digest-listing-stale", "digest-precision", now - 3 * DAY_MS);
    //     missing: seen 10 days ago (> 7d)
    insertListing(db, "digest-listing-missing", "digest-jim-click", now - 10 * DAY_MS);
  },
};
