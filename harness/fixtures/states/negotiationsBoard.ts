/**
 * negotiationsBoard — the per-dealer negotiation world the dealer-negotiation
 * cards func case (negotiations_board.func.toml) drives: a realistic two-dealer
 * board the buyer opens, then clicks the most-actionable card to read its detail
 * modal. It stages the after-state both the grid read (listProfileDealerNegotiations)
 * and the per-dealer detail read (readDealerNegotiationDetail) project:
 *
 *   - The grid shows ONE card per bound dealer (2 here), sorted most-actionable
 *     first. Alpha has an active thread (a derived negotiation_status) so it
 *     outranks Bravo (no thread → no status) and renders first.
 *   - Alpha's detail modal shows the contact (with a role), the deterministic
 *     status line, strategy + next steps, the competing-offer scalars (Bravo is
 *     cheaper — only the OTD scalar crosses, never Bravo's name), and exactly 3
 *     substantive inbound replies (an out-of-office auto-reply + a marketing blast
 *     are FILTERED by the T2 non-substantive predicate), newest-first.
 *
 * WHAT THIS SEEDS:
 *   - 1 active Tucson Hyundai search_profiles row (the Canvas projects it).
 *   - 2 bound dealers (Alpha + Bravo) via profile_dealers status='bound'.
 *   - 1 dealer_contacts row for Alpha WITH a role (the "who's contacting" row).
 *   - 1 thread for Alpha + 5 inbound messages on it with strictly-increasing
 *     received_at: 3 substantive replies, 1 out-of-office auto-reply, 1 marketing
 *     blast. The LATEST (received_at 5000) carries a unique marker so the
 *     newest-first DOM-order anchor can assert it is the FIRST reply row.
 *   - 2 dealer_quotes (finance, itemized): Alpha 44,000 OTD, Bravo 41,000 OTD —
 *     Bravo is the cheaper competing quote that drives Alpha's BATNA gap.
 *
 * USED BY: negotiations_board.func.toml — a single runless kind="ui" click-chain
 * step (open the Negotiations tab → click the top card → assert the board + modal;
 * Δ=0 by construction, a read-only projection reaches no side effect).
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

const PROFILE_ID = "neg-board-1";
const DEALER_A = "neg-dealer-alpha";
const DEALER_B = "neg-dealer-bravo";
const THREAD_A = "neg-thread-alpha";

/** The unique marker the newest reply carries — the DOM-order (newest-first)
 *  anchor asserts the FIRST reply row contains it. */
const NEWEST_REPLY_MARKER = "NEWEST-REPLY-MARKER-Z7Q";

/** Insert one inbound message on Alpha's thread (status 'pending' → intent NULL,
 *  per the messages CHECK constraint). received_at is epoch-ms (strictly
 *  increasing across the seed so newest-first is deterministic). */
function insertInbound(
  c: Db["$client"],
  args: {
    messageId: string;
    subject: string;
    body: string;
    receivedAt: number;
  },
): void {
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, search_profile_id, " +
      "sender_email, sender_name, subject, body_text, received_at, quote_extraction_status, quote_extraction_intent) " +
      "VALUES (?, ?, 'inbound', ?, 'dana@alphahyundai.com', 'Dana Sales', ?, ?, ?, 'pending', NULL)",
  ).run(args.messageId, THREAD_A, PROFILE_ID, args.subject, args.body, args.receivedAt);
}

/** Insert one itemized finance dealer_quote (selling_price + doc_fee make it the
 *  itemized, confidence-floored competing-OTD candidate the BATNA guard trusts). */
function insertQuote(
  c: Db["$client"],
  args: {
    quoteId: string;
    dealerId: string;
    messageId: string;
    otdTotal: number;
    sellingPrice: number;
    vin: string;
    receivedAt: number;
  },
): void {
  c.prepare(
    "INSERT INTO dealer_quotes " +
      "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, " +
      " otd_total, selling_price, dealer_discount, doc_fee, sales_tax, vin, quote_format, intent, " +
      " extractor_provider, extraction_method, quote_received_at) " +
      "VALUES (?, ?, ?, ?, ?, 'finance', ?, ?, 1500, 85, 3200, ?, 'otd', 'quote', 'deepseek', 'ocr', ?)",
  ).run(
    args.quoteId,
    args.dealerId,
    args.messageId,
    `neg-gmsg-${args.quoteId}`,
    PROFILE_ID,
    args.otdTotal,
    args.sellingPrice,
    args.vin,
    args.receivedAt,
  );
}

export const negotiationsBoard: FixtureState = {
  id: "negotiations_board",
  seed: (db: Db) => {
    const c = db.$client;

    // The active profile → the Canvas projects the active card + the Negotiations tab.
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, location_query, city, " +
        "state, postal_code, financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', 'Limited', 25, ?, 'Irvine', 'CA', '92614', " +
        "'finance', 'fake', 'acct-harness-1', 'Hyundai', ?, 'active')",
    ).run(PROFILE_ID, "Irvine, CA 92614", "Irvine, CA 92614");

    // 2 dealers, both bound to the profile → 2 grid cards.
    const insertDealer = c.prepare(
      "INSERT INTO dealers (dealer_id, name, city, state, distance_miles, country) VALUES (?, ?, ?, ?, ?, 'US')",
    );
    const bind = c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    );
    insertDealer.run(DEALER_A, "Alpha Hyundai", "Irvine", "CA", 5.0);
    insertDealer.run(DEALER_B, "Bravo Hyundai", "Tustin", "CA", 9.0);
    bind.run(PROFILE_ID, DEALER_A);
    bind.run(PROFILE_ID, DEALER_B);

    // Alpha's contact WITH a role → the modal's "who's contacting you" row.
    c.prepare(
      "INSERT INTO dealer_contacts (contact_id, dealer_id, email, display_name, normalized_email, role, " +
        "is_primary_reply_target, search_profile_id) " +
        "VALUES (?, ?, 'dana@alphahyundai.com', 'Dana Sales', 'dana@alphahyundai.com', 'sales manager', 1, ?)",
    ).run("neg-contact-alpha", DEALER_A, PROFILE_ID);

    // Alpha's thread (gives Alpha a derived negotiation_status → it outranks the
    // thread-less Bravo and renders as the FIRST, most-actionable card).
    c.prepare(
      "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, 'quoted', ?)",
    ).run(THREAD_A, DEALER_A, "Re: 2026 Tucson Limited quote", PROFILE_ID);

    // 5 inbound messages, strictly-increasing received_at. 3 substantive (a
    // quote-signal token keeps them past the T2 filter), 1 out-of-office
    // auto-reply, 1 marketing blast (both FILTERED). The newest substantive reply
    // (received_at 5000) carries the unique marker.
    insertInbound(c, {
      messageId: "neg-m-quote",
      subject: "Re: 2026 Tucson Limited quote",
      body: "Thanks for reaching out — your out-the-door quote is attached.",
      receivedAt: 1000,
    });
    insertInbound(c, {
      messageId: "neg-m-auto",
      subject: "Automatic reply: Out of office",
      body: "I am out of office until Monday and will respond when I return.",
      receivedAt: 2000,
    });
    insertInbound(c, {
      messageId: "neg-m-followup",
      subject: "Re: 2026 Tucson Limited quote",
      body: "Our selling price on this one is very competitive, happy to discuss.",
      receivedAt: 3000,
    });
    insertInbound(c, {
      messageId: "neg-m-ad",
      subject: "Year-end sales event",
      body: "Our sales event this weekend only — visit us! Unsubscribe to opt out.",
      receivedAt: 4000,
    });
    insertInbound(c, {
      messageId: "neg-m-latest",
      subject: "Best out-the-door price locked in",
      body: `Good news — your out-the-door price is locked in. ${NEWEST_REPLY_MARKER}`,
      receivedAt: 5000,
    });

    // Alpha's itemized finance quote (the current OTD: 44,000), sourced from the
    // first substantive reply.
    insertQuote(c, {
      quoteId: "neg-q-alpha",
      dealerId: DEALER_A,
      messageId: "neg-m-quote",
      otdTotal: 44000,
      sellingPrice: 41000,
      vin: "KM8J3CA46PU000001",
      receivedAt: 1000,
    });

    // Bravo's itemized finance quote — CHEAPER (41,000): the competing offer that
    // drives Alpha's BATNA gap. Its source message carries no thread (Bravo has no
    // thread → no negotiation_status → it sorts after Alpha), so it is never a
    // reply row.
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, search_profile_id, " +
        "quote_extraction_status, quote_extraction_intent) " +
        "VALUES ('neg-m-bravo', NULL, 'inbound', ?, 'succeeded', 'quote')",
    ).run(PROFILE_ID);
    insertQuote(c, {
      quoteId: "neg-q-bravo",
      dealerId: DEALER_B,
      messageId: "neg-m-bravo",
      otdTotal: 41000,
      sellingPrice: 38000,
      vin: "KM8J3CA46PU000002",
      receivedAt: 1500,
    });
  },
};
