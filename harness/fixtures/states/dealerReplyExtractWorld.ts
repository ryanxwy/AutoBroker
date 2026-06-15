/**
 * dealerReplyExtractWorld — the "quotes extracted, one extraction failed" world
 * for the dealer_reply_extract UI surfaces. The dealer_reply_extract skill WRITES
 * dealer_quotes rows (the raw extraction output) and flips
 * messages.quote_extraction_status to 'succeeded'/'failed'. This world stages the
 * after-state both surfaces read:
 *
 *   - The "Extracted quotes" Canvas section (/api/profiles/:id/quotes →
 *     listProfileQuoteRows) renders the raw per-quote rows across ALL financing
 *     modes — INCLUDING a CASH quote (the ranked /quote-compare finance/lease
 *     buckets would omit it; the raw section proves it shows).
 *   - The Threads section renders the per-thread message-extract-failed badge for
 *     the thread whose message carries quote_extraction_status='failed'.
 *
 * WHAT THIS SEEDS:
 *   - 1 active Tucson Hyundai search_profiles row (so the Canvas projects the
 *     active profile card + its sections).
 *   - 2 bound dealers (the quote + thread display names).
 *   - 3 dealer_quotes across modes: finance, lease, cash (each with a
 *     'succeeded'-extraction source message; the cash one is the load-bearing
 *     mode the compare buckets omit).
 *   - 2 threads + their messages: one message 'succeeded', one 'failed' (the
 *     extract-failed-badge thread).
 *
 * USED BY: dealer_reply_extract.ui_quotes.func.toml — a runless kind="ui" render
 * step (Δ=0 by construction; the read surfaces reach no side effect).
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

const PROFILE_ID = "dre-tucson-1";
const DEALER_A = "dre-dealer-alpha";
const DEALER_B = "dre-dealer-bravo";

/** Insert a 'succeeded'-extraction message (the CHECK requires a non-null intent
 *  when status is 'succeeded'). */
function insertSucceededMessage(c: Db["$client"], messageId: string): void {
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, " +
      "search_profile_id, quote_extraction_status, quote_extraction_intent) " +
      "VALUES (?, NULL, NULL, 'inbound', ?, 'succeeded', 'quote')",
  ).run(messageId, PROFILE_ID);
}

/** Insert one raw dealer_quote (the raw extraction projection's input). */
function insertQuote(
  c: Db["$client"],
  quoteId: string,
  dealerId: string,
  mode: "finance" | "lease" | "cash",
  otdTotal: number,
  receivedAt: string,
): void {
  const messageId = `dre-qm-${quoteId}`;
  insertSucceededMessage(c, messageId);
  c.prepare(
    "INSERT INTO dealer_quotes " +
      "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, " +
      " otd_total, selling_price, vin, quote_format, intent, extractor_provider, extraction_method, quote_received_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'KM8J3CA46PU000001', 'otd', 'quote', 'deepseek', 'ocr', ?)",
  ).run(quoteId, dealerId, messageId, `dre-gmsg-${quoteId}`, PROFILE_ID, mode, otdTotal, otdTotal, receivedAt);
}

export const dealerReplyExtractWorld: FixtureState = {
  id: "dealer_reply_extract_world",
  seed: (db: Db) => {
    const c = db.$client;

    // The active profile → the Canvas projects the active card + its sections.
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, location_query, city, " +
        "state, postal_code, financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', 'Limited', 25, ?, 'Irvine', 'CA', '92614', " +
        "'undecided', 'fake', 'acct-harness-1', 'Hyundai', ?, 'active')",
    ).run(PROFILE_ID, "Irvine, CA 92614", "Irvine, CA 92614");

    const insertDealer = c.prepare(
      "INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, ?, 5.0, 'US')",
    );
    const bind = c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    );
    for (const [id, name] of [
      [DEALER_A, "Alpha Hyundai"],
      [DEALER_B, "Bravo Hyundai"],
    ] as const) {
      insertDealer.run(id, name);
      bind.run(PROFILE_ID, id);
    }

    // 3 raw quotes across modes — INCLUDING a CASH quote (the mode the ranked
    // compare buckets omit; the raw section proves it shows).
    insertQuote(c, "dre-finance", DEALER_A, "finance", 44540, "2026-06-10T10:00:00.000Z");
    insertQuote(c, "dre-lease", DEALER_B, "lease", 38000, "2026-06-11T10:00:00.000Z");
    insertQuote(c, "dre-cash", DEALER_A, "cash", 39500, "2026-06-12T10:00:00.000Z");

    // 2 threads + their messages: one 'succeeded', one 'failed' (the
    // extract-failed-badge thread). The badge EXISTS subquery is thread-scoped +
    // profile-scoped, so only the failed thread lights the badge.
    c.prepare(
      "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, 'quoted', ?)",
    ).run("dre-thread-ok", DEALER_A, "Re: 2026 Tucson Limited quote", PROFILE_ID);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, search_profile_id, " +
        "quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, 'dre-thread-ok', 'inbound', ?, 'succeeded', 'quote')",
    ).run("dre-tm-ok", PROFILE_ID);

    c.prepare(
      "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, 'replied', ?)",
    ).run("dre-thread-fail", DEALER_B, "Re: Tucson availability", PROFILE_ID);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, search_profile_id, " +
        "quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, 'dre-thread-fail', 'inbound', ?, 'failed', NULL)",
    ).run("dre-tm-fail", PROFILE_ID);
  },
};
