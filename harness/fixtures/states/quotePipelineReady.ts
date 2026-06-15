/**
 * quotePipelineReady — the world the O1 (quote_pipeline) ORCHESTRATOR func cases
 * drive against. It is the moment after replies have already been extracted into
 * dealer_quotes: a pinnable active search whose pipeline has audit + compare work
 * to do, but NO un-extracted replies (extract is satisfied) and a FRESH incentive
 * cache (scrape is satisfied) — so a /quote_pipeline run fans out ONLY the two
 * zero-LLM children (audit + compare) and lands `ok`, without needing a live LLM
 * (reply_extract) or an OEM first-encounter suspend (incentive_scrape).
 *
 * WHAT THIS SEEDS:
 *   - 1 search_profiles row (status='active', account=acct-harness-1, brand=make)
 *     — PINNABLE through the Searches popover (quote_pipeline is pin_required, so
 *     the launch threads the pin as search_profile_id).
 *   - 1 dealer (country='US') + 1 profile_dealers binding ('bound') — the targeted
 *     listing's dealer.
 *   - 2 dealer_quotes with DISTINCT otd_total and NO quote_audits rows → detect
 *     fires `audit` (≥1 unaudited quote) and `compare` (≥2 quotes). The audit
 *     child writes quote_audits rows; the compare child is a pure read.
 *   - 1 FRESH manufacturer_incentives row for the profile's (make, model, zip) at
 *     scraped_at = NOW (ISO-8601) → detect's 7-day cache gate reports the slice
 *     fresh, so `scrape` does NOT fire (no OEM first-encounter suspend in the
 *     deterministic lane).
 *   - NO pending messages → detect does NOT fire `extract` (the only live-LLM
 *     child) — so the functional lane never needs a model.
 *   - 1 inventory_listings row WITH a vin + stock_number + an inbound thread and
 *     message on the SAME dealer for the profile → the targeted-VIN sub-path
 *     (target_listing_id) resolves the listing + its inbound thread, builds the
 *     VIN-specific OTD ask, and reaches the SEND suspend.
 *
 * BUDGET: nothing here is a budget figure. OTD totals are dealer-quoted prices
 * (explicitly allowed); the buyer's private ceiling is never seeded or read.
 *
 * Addresses / emails are generic placeholders — no real account string appears.
 *
 * Dependency wall: harness layer (imports the @autobroker/tools Db type only;
 * writes through db.$client.prepare(...).run(...), mirroring the other states).
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
export const QUOTE_PIPELINE_PROFILE_ID = "qp-ready-tucson-1";

/** The targeted-VIN listing id (carries a VIN — the OTD ask needs one). */
export const QUOTE_PIPELINE_LISTING_ID = "qp-listing-1";

/** The targeted listing's VIN (the OTD ask splices it). */
export const QUOTE_PIPELINE_VIN = "5NMJBCAE0RH000001";

export const quotePipelineReady: FixtureState = {
  id: "quote_pipeline_ready",
  seed: (db: Db) => {
    const c = db.$client;
    const nowIso = new Date().toISOString();

    // --- the active, pinnable search ---------------------------------------
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "follow_up_email, financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      QUOTE_PIPELINE_PROFILE_ID,
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
      "jordan.buyer@example.com",
      "finance",
      "fake",
      "acct-harness-1",
      "Hyundai",
      "Tucson, AZ 85704",
      "active",
    );

    // --- one bound US dealer (the targeted listing's dealer) ---------------
    c.prepare(
      "INSERT INTO dealers (dealer_id, name, address, city, state, postal_code, distance_miles, country) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'US')",
    ).run("qp-jim-click", "Jim Click Hyundai", "4.2 mi away, Tucson, AZ", "Tucson", "AZ", "85704", 4.2);
    c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    ).run(QUOTE_PIPELINE_PROFILE_ID, "qp-jim-click");

    // --- two unaudited dealer_quotes → detect fires audit + compare --------
    //     each references a REAL 'succeeded'-extraction message (the audit's
    //     recent-batch join requires m.quote_extraction_status = 'succeeded'; the
    //     CHECK constraint requires a non-null intent when status is 'succeeded').
    //     succeeded (not pending) so detect does NOT fire `extract` either.
    const insertQuoteMessage = c.prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, " +
        "search_profile_id, quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, NULL, NULL, 'inbound', ?, 'succeeded', 'quote')",
    );
    const insertQuote = c.prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
        "search_profile_id, selling_price, doc_fee, sales_tax, otd_total, financing_mode, quote_received_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'finance', NULL)",
    );
    insertQuoteMessage.run("qp-q1-msg", QUOTE_PIPELINE_PROFILE_ID);
    insertQuoteMessage.run("qp-q2-msg", QUOTE_PIPELINE_PROFILE_ID);
    insertQuote.run("qp-quote-1", "qp-jim-click", "qp-q1-msg", "qp-q1-gmsg", QUOTE_PIPELINE_PROFILE_ID, 29_000, 80, 2_420, 31_500);
    insertQuote.run("qp-quote-2", "qp-jim-click", "qp-q2-msg", "qp-q2-gmsg", QUOTE_PIPELINE_PROFILE_ID, 31_200, 80, 2_715, 33_995);

    // --- a FRESH incentive row → detect does NOT fire scrape ---------------
    //     scraped_at = NOW (ISO-8601), the (make, model, zip) slice key matches
    //     the profile, so the 7-day cache gate reads the slice as fresh.
    c.prepare(
      "INSERT INTO manufacturer_incentives (make, model, zip, type, amount, eligibility, scraped_at, scrape_source_url) " +
        "VALUES (?, ?, ?, 'customer_cash', ?, 'all', ?, ?)",
    ).run("Hyundai", "Tucson Hybrid", "85704", 1000, nowIso, "https://www.hyundaiusa.com/us/en/offers");

    // --- the targeted-VIN listing + its inbound thread/message -------------
    //     resolveTargetedListing needs the listing row + an inbound message on a
    //     profile-matched thread for the listing's dealer.
    c.prepare(
      "INSERT INTO inventory_listings " +
        "(listing_id, search_profile_id, dealer_id, year, make, model, trim, vin, stock_number, " +
        "inventory_status, match_status, raw_listing_json, first_seen_at, last_seen_at, observed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock', 'matched', '{}', ?, ?, ?)",
    ).run(
      QUOTE_PIPELINE_LISTING_ID,
      QUOTE_PIPELINE_PROFILE_ID,
      "qp-jim-click",
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "SEL",
      QUOTE_PIPELINE_VIN,
      "STK-7421",
      Date.now(),
      Date.now(),
      Date.now(),
    );
    c.prepare(
      "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id, updated_at) " +
        "VALUES (?, ?, ?, 'replied', ?, ?)",
    ).run("qp-thread-1", "qp-jim-click", "Re: 2026 Tucson Hybrid SEL", QUOTE_PIPELINE_PROFILE_ID, Date.now());
    //     succeeded extraction (not pending) so detect does NOT fire `extract`;
    //     the CHECK constraint requires a non-null intent at 'succeeded'.
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, sender, subject, body_text, " +
        "search_profile_id, gmail_message_id, received_at, quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, 'succeeded', 'quote')",
    ).run(
      "qp-inbound-1",
      "qp-thread-1",
      "sales@example-dealer.com",
      "Re: 2026 Tucson Hybrid SEL",
      "We have one in stock — happy to send numbers.",
      QUOTE_PIPELINE_PROFILE_ID,
      "gmail-qp-inbound-1",
      Date.now(),
    );
  },
};
