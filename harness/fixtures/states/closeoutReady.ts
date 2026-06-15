/**
 * closeoutReady — the world the X3 (dealer_closeout_email) keystone func cases
 * drive against. It is the EXIT moment: a pinned search has bound dealers with
 * OPEN threads, ready to be closed out (a fake closeout email + the LOCAL
 * threads.state='closed' + a thread_suppression row per dealer, then the profile
 * flips to 'closed').
 *
 * WHAT THIS SEEDS:
 *   - 1 search_profiles row (status='active', account=acct-harness-1, brand
 *     Hyundai) — PINNABLE through the Searches popover (X3 is pin-required → the
 *     launch threads the pin as search_profile_id).
 *   - 3 bound US dealers + 3 profile_dealers bindings (status='bound'), each with
 *     an OPEN thread (state='replied', a gmail_thread_id, ≥1 inbound message):
 *       · dealer-jim-click  — ADDRESSABLE (a dealer_contacts row WITH an email +
 *                             a contact-carrying inbound message → the ladder
 *                             resolves a reply address).
 *       · dealer-tucson-kia — ADDRESSABLE (likewise).
 *       · dealer-noaddr      — an OPEN thread but NO resolvable reply address (NO
 *                             dealer_contacts, the inbound message carries no
 *                             contact/sender email, NO lead submission, and the
 *                             dealer's contact_email is NULL) → the 4-rung ladder
 *                             yields nothing → SKIPPED + counted (skippedNoAddress)
 *                             BEFORE the gate, never a card row.
 *   - NO prior thread_suppression `closeout:%` rows (so the first run is never a
 *     no-op idempotency skip).
 *
 * The func anchors read row deltas: ui_send asserts +2 thread_suppression (one
 * per closed addressable dealer) + 2 threads flipped to 'closed' + ZERO messages
 * (the gmail send is L1-fuse-blocked under BLOCK=1, while the LOCAL close+suppress
 * commit on approve regardless of the fuse). ui_decline asserts Δ0 on all three.
 * X3 is zero-LLM + zero-browser, so the workflow runs REAL against this DB with
 * no stubbed collaborators.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
export const CLOSEOUT_PROFILE_ID = "closeout-tucson-1";

/** The two ADDRESSABLE dealers (the closeout card's two rows). */
export const CLOSEOUT_ADDRESSABLE_DEALERS = ["dealer-jim-click", "dealer-tucson-kia"] as const;

/** The no-address dealer (open thread, but no resolvable reply target → skipped). */
export const CLOSEOUT_NOADDR_DEALER = "dealer-noaddr";

export const closeoutReady: FixtureState = {
  id: "closeout_ready",
  seed: (db: Db) => {
    const c = db.$client;

    // The active, pinnable search (Tucson corpus shape).
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "follow_up_email, financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      CLOSEOUT_PROFILE_ID,
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

    const insertDealer = c.prepare(
      "INSERT INTO dealers (dealer_id, name, address, city, state, postal_code, " +
        "website, contact_email, distance_miles, country) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'US')",
    );
    const bind = c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    );
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

    const inboundAtMs = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago.

    // The two addressable dealers: a contact row (with an email) + a
    // contact-carrying inbound message → the ladder resolves a reply address.
    const addressable: Array<{
      dealerId: string;
      name: string;
      threadId: string;
      contactId: string;
      contactEmail: string;
      senderName: string;
    }> = [
      {
        dealerId: "dealer-jim-click",
        name: "Jim Click Hyundai",
        threadId: "thread-jim-click",
        contactId: "contact-jim-click-1",
        contactEmail: "rep@jimclickhyundai.example.com",
        senderName: "Jim Click Sales",
      },
      {
        dealerId: "dealer-tucson-kia",
        name: "Tucson Kia",
        threadId: "thread-tucson-kia",
        contactId: "contact-tucson-kia-1",
        contactEmail: "rep@tucsonkia.example.com",
        senderName: "Tucson Kia Sales",
      },
    ];

    for (const d of addressable) {
      insertDealer.run(
        d.dealerId,
        d.name,
        "750 W Auto Mall Dr, Tucson, AZ",
        "Tucson",
        "AZ",
        "85704",
        `https://www.${d.dealerId}.example.com`,
        `sales@${d.dealerId}.example.com`,
        4.2,
      );
      bind.run(CLOSEOUT_PROFILE_ID, d.dealerId);
      insertThread.run(d.threadId, d.dealerId, `gthread-${d.threadId}`, "Quote request", CLOSEOUT_PROFILE_ID);
      insertContact.run(
        d.contactId,
        d.dealerId,
        d.contactEmail,
        d.contactEmail.toLowerCase(),
        d.senderName,
        "sales",
        CLOSEOUT_PROFILE_ID,
      );
      insertInbound.run(
        `msg-in-${d.threadId}`,
        d.threadId,
        `gmail-${d.threadId}`,
        d.contactEmail,
        "jordan.buyer@example.com",
        "Quote request",
        "Here is our quote on the Tucson Limited. Let me know.",
        inboundAtMs,
        inboundAtMs,
        d.contactId,
        d.contactEmail,
        d.senderName,
        CLOSEOUT_PROFILE_ID,
      );
    }

    // The no-address dealer: an OPEN thread (so it reaches the resolve step) with
    // an inbound message that carries NO contact_id / NO sender_email, NO
    // dealer_contacts, NO lead submission, and a NULL contact_email → every ladder
    // rung is empty → resolveReplyTarget returns null → skippedNoAddress (counted
    // before the gate, never a card row).
    insertDealer.run(
      CLOSEOUT_NOADDR_DEALER,
      "Desert Auto (no contact)",
      "100 E Speedway Blvd, Tucson, AZ",
      "Tucson",
      "AZ",
      "85705",
      "https://www.desertauto.example.com",
      null, // NULL contact_email — the final ladder rung is empty.
      9.1,
    );
    bind.run(CLOSEOUT_PROFILE_ID, CLOSEOUT_NOADDR_DEALER);
    insertThread.run(
      "thread-noaddr",
      CLOSEOUT_NOADDR_DEALER,
      "gthread-thread-noaddr",
      "Inventory question",
      CLOSEOUT_PROFILE_ID,
    );
    insertInbound.run(
      "msg-in-thread-noaddr",
      "thread-noaddr",
      "gmail-thread-noaddr",
      null, // sender (display) — irrelevant; the ladder reads sender_email/contact.
      "jordan.buyer@example.com",
      "Inventory question",
      "Thanks for reaching out.",
      inboundAtMs,
      inboundAtMs,
      null, // contact_id — no contact rung.
      null, // sender_email — no latest-inbound-contact rung email.
      null, // sender_name
      CLOSEOUT_PROFILE_ID,
    );
  },
};
