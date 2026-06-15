/**
 * followupReady — the world the X2 (negotiation_followup) keystone func cases
 * drive against. It is the moment after dealer replies have landed: a pinned
 * search has TWO bound dealers, each with an OPEN thread whose latest message is
 * an INBOUND dealer reply (needs-response), and the target dealer's open quote
 * sits clearly above a competing dealer's open quote — so classifyQuoteSituation
 * picks the `assertive` tone IN CODE (the LLM only writes that tone's prose).
 *
 * WHAT THIS SEEDS:
 *   - 1 search_profiles row (status='active', account=acct-harness-1, brand
 *     Hyundai) — PINNABLE through the Searches popover (X2 is pin-required → the
 *     launch threads the pin as search_profile_id).
 *   - 2 bound US dealers (country='US', a usable website + contact_email) +
 *     2 profile_dealers bindings (status='bound'):
 *       · dealer-jim-click  — the FOLLOW-UP target. Its open quote OTD sits well
 *                             above the competitor's (the `assertive` leverage).
 *       · dealer-tucson-kia — the cheaper COMPETITOR (its lower open-quote OTD is
 *                             the best-competing number the tone is derived from;
 *                             its own thread is also a ready follow-up candidate).
 *   - 1 threads row per dealer (state='replied', a gmail_thread_id) whose latest
 *     message is an INBOUND dealer reply with a gmail_message_id (the reply
 *     double-flag anchor) and a recent received_at (so gateDecisionForTarget
 *     returns `ready` — NOT `skip`/`wait`). NO prior outbound rows (roundsSent=0,
 *     under the 3-round cap; no recent outbound to trigger `wait`).
 *   - 1 dealer_quotes row per dealer (open — quote_expires_at NULL), itemized
 *     (a real selling_price + itemized fee columns) so the current quote is not
 *     read as estimate-only (estimate-only → `conservative`). The target's
 *     otd_total is > the assertive threshold above the competitor's.
 *   - 1 dealer_contacts row per dealer, NON-primary (is_primary_reply_target=0):
 *     the reply-target ladder resolves through the latest-inbound contact, and a
 *     non-primary contact is the candidate a contact-flip override would promote.
 *
 * The X2 deps the host injects in fixture mode stub ONLY the prose draft
 * (draftProse → a fixed, budget-free, no-competing-name body); every DB read
 * (candidate threads / quote situation / thread snapshot / reply-target ladder)
 * and the send + thread-state write stay REAL against this seeded DB.
 * sendAndRecord is L1-fuse-blocked under BLOCK=1 → ZERO messages rows; the
 * threads.state='negotiating' write on a sent thread is a LOCAL product write
 * that lands regardless of the fuse.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
export const FOLLOWUP_PROFILE_ID = "followup-tucson-1";

/** The follow-up TARGET dealer (its open quote sits above the competitor's). */
export const FOLLOWUP_TARGET_DEALER = "dealer-jim-click";

/** The cheaper COMPETITOR dealer (the best-competing OTD the tone is derived from). */
export const FOLLOWUP_COMPETE_DEALER = "dealer-tucson-kia";

export const followupReady: FixtureState = {
  id: "followup_ready",
  seed: (db: Db) => {
    const c = db.$client;

    // The active, pinnable search (Tucson corpus shape). account_id + brand carry
    // the active-slot key; status='active' puts it in the active list the Canvas
    // and Searches popover read (so the pin verb can find + pin it).
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "follow_up_email, financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      FOLLOWUP_PROFILE_ID,
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "Limited",
      120,
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

    // Two bound US dealers (both carry a website + a contact_email — the final
    // ladder rung — but the resolved reply target rides the latest-inbound contact).
    const dealers: Array<{ id: string; name: string; website: string; contactEmail: string; distance: number }> = [
      {
        id: FOLLOWUP_TARGET_DEALER,
        name: "Jim Click Hyundai",
        website: "https://www.jimclickhyundai.example.com",
        contactEmail: "sales@jimclickhyundai.example.com",
        distance: 4.2,
      },
      {
        id: FOLLOWUP_COMPETE_DEALER,
        name: "Tucson Kia",
        website: "https://www.tucsonkia.example.com",
        contactEmail: "sales@tucsonkia.example.com",
        distance: 6.8,
      },
    ];
    const insertDealer = c.prepare(
      "INSERT INTO dealers (dealer_id, name, address, city, state, postal_code, " +
        "website, contact_email, distance_miles, country) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'US')",
    );
    const bind = c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    );
    for (const d of dealers) {
      insertDealer.run(
        d.id,
        d.name,
        "750 W Auto Mall Dr, Tucson, AZ",
        "Tucson",
        "AZ",
        "85704",
        d.website,
        d.contactEmail,
        d.distance,
      );
      bind.run(FOLLOWUP_PROFILE_ID, d.id);
    }

    // Recent inbound recency — comfortably inside the 7-day silence window (the
    // X2 gate uses maxGapDays:7), so gateDecisionForTarget returns `ready`. Epoch
    // ms (the read parses numeric|ISO; numeric is the simplest deterministic form).
    const inboundAtMs = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago.

    // One thread + one INBOUND dealer reply per dealer. state='replied' (a
    // follow-up candidate, not agreed/closed). The inbound message carries a
    // gmail_message_id (the reply double-flag anchor), a contact_id (the
    // latest-inbound ladder rung), and a sender_email. NO outbound rows
    // (roundsSent=0; no recent outbound to trigger `wait`).
    const insertThread = c.prepare(
      "INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, subject, state, search_profile_id) " +
        "VALUES (?, ?, ?, ?, 'replied', ?)",
    );
    const insertInbound = c.prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, recipient, " +
        "subject, body_text, received_at, processed_at, contact_id, sender_email, sender_name, " +
        "search_profile_id, quote_extraction_status) " +
        "VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
    );
    const insertContact = c.prepare(
      "INSERT INTO dealer_contacts (contact_id, dealer_id, email, normalized_email, " +
        "display_name, role, is_primary_reply_target, search_profile_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    );
    // Itemized OPEN quotes (quote_expires_at NULL): a real selling_price + itemized
    // fee columns → NOT estimate-only (so not `conservative`). The target OTD sits
    // well above the competitor's → classifyQuoteSituation picks `assertive`.
    const insertQuote = c.prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
        "search_profile_id, financing_mode, selling_price, doc_fee, dealer_fee, sales_tax, " +
        "otd_total, quote_received_at, quote_expires_at) " +
        "VALUES (?, ?, ?, ?, ?, 'cash', ?, ?, ?, ?, ?, ?, NULL)",
    );

    const threadSeed: Array<{
      dealerId: string;
      threadId: string;
      contactId: string;
      contactEmail: string;
      senderName: string;
      otd: number;
    }> = [
      {
        dealerId: FOLLOWUP_TARGET_DEALER,
        threadId: "thread-jim-click",
        contactId: "contact-jim-click-1",
        contactEmail: "rep@jimclickhyundai.example.com",
        senderName: "Jim Click Sales",
        otd: 34800, // target — above the competitor by > the assertive threshold.
      },
      {
        dealerId: FOLLOWUP_COMPETE_DEALER,
        threadId: "thread-tucson-kia",
        contactId: "contact-tucson-kia-1",
        contactEmail: "rep@tucsonkia.example.com",
        senderName: "Tucson Kia Sales",
        otd: 31200, // the cheaper best-competing OTD.
      },
    ];

    for (const t of threadSeed) {
      insertThread.run(t.threadId, t.dealerId, `gthread-${t.threadId}`, "Quote request", FOLLOWUP_PROFILE_ID);
      insertContact.run(
        t.contactId,
        t.dealerId,
        t.contactEmail,
        t.contactEmail.toLowerCase(),
        t.senderName,
        "sales",
        FOLLOWUP_PROFILE_ID,
      );
      insertInbound.run(
        `msg-in-${t.threadId}`,
        t.threadId,
        `gmail-${t.threadId}`,
        t.contactEmail,
        "jordan.buyer@example.com",
        "Quote request",
        "Here is our quote on the Tucson Limited. Let me know if you have questions.",
        inboundAtMs,
        inboundAtMs,
        t.contactId,
        t.contactEmail,
        t.senderName,
        FOLLOWUP_PROFILE_ID,
      );
      insertQuote.run(
        `quote-${t.dealerId}`,
        t.dealerId,
        `qmsg-${t.dealerId}`,
        `qgmail-${t.dealerId}`,
        FOLLOWUP_PROFILE_ID,
        t.otd - 2500, // selling_price (a real number → itemized).
        85, // doc_fee
        499, // dealer_fee
        1900, // sales_tax
        t.otd, // otd_total
        inboundAtMs,
      );
    }
  },
};
