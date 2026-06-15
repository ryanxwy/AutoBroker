/**
 * dealerReplyExtractRetryWorld — the "one failed extraction, the user wants to
 * retry it on another provider" world for the dealer_reply_extract MANUAL
 * cross-provider retry (the F1 privacy-conservative escape hatch).
 *
 * The auto-path (DeepSeek, fail-closed) left one inbound dealer reply with
 * quote_extraction_status='failed' (a deterministic serialization defect a
 * same-provider retry can't fix). This world stages exactly that recoverable
 * after-state PLUS the Anthropic key present, so the Threads section renders the
 * key-guarded "Retry failed extractions — sends the reply text to Anthropic"
 * button. The func case clicks it → dealer_reply_extract runs with escalate:true
 * → the stubbed harness (standing in for Anthropic — ZERO real egress) recovers
 * the message → a dealer_quotes row lands and the extract-failed badge clears.
 *
 * WHAT THIS SEEDS:
 *   - 1 active Tucson Hyundai search_profiles row (the Canvas projects it).
 *   - 1 bound dealer (the thread display name + the dealer_id the quote keys to).
 *   - 1 thread + 1 inbound message with quote_extraction_status='failed', a
 *     non-null gmail_message_id (the UNIQUE upsert key + the candidate guard),
 *     and a body_text the extraction reads — so the message IS a retry candidate.
 *   - the Anthropic key set present in the isolated secretsStore (so the
 *     anthropicReady gate opens the active retry button, not the Settings hint).
 *
 * USED BY: dealer_reply_extract.ui_retry.func.toml.
 */

import { setKey, type Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

const PROFILE_ID = "drer-tucson-1";
const DEALER_ID = "drer-dealer-alpha";
const THREAD_ID = "drer-thread-fail";

export const dealerReplyExtractRetryWorld: FixtureState = {
  id: "dealer_reply_extract_retry_world",
  seed: (db: Db) => {
    const c = db.$client;

    // Make the cross-provider RETRY key present so the Threads section renders the
    // active retry button (absent → the Settings hint instead). A fixture-only
    // value — the func host stubs every model call, so no real Anthropic request
    // ever fires; this only flips the UI key-presence gate.
    setKey("anthropic", "sk-ant-fixture-not-used");

    // The active profile → the Canvas projects the active card + its sections.
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, location_query, city, " +
        "state, postal_code, financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', 'Limited', 25, ?, 'Irvine', 'CA', '92614', " +
        "'undecided', 'fake', 'acct-harness-1', 'Hyundai', ?, 'active')",
    ).run(PROFILE_ID, "Irvine, CA 92614", "Irvine, CA 92614");

    // One bound dealer → a clickable canvas tile (the step clicks it to mount the
    // active projection) + the dealer_id the recovered quote keys to.
    c.prepare(
      "INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, 'Alpha Hyundai', 5.0, 'US')",
    ).run(DEALER_ID);
    c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    ).run(PROFILE_ID, DEALER_ID);

    // One thread whose single inbound message is 'failed' → the extract-failed
    // badge lights AND the message is a retry candidate (inbound, failed,
    // profile-scoped, a non-null gmail_message_id, a thread with a dealer_id, a
    // body to extract). The CHECK requires intent NULL when status is 'failed'.
    c.prepare(
      "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, 'replied', ?)",
    ).run(THREAD_ID, DEALER_ID, "Re: 2026 Tucson Limited quote", PROFILE_ID);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, body_text, " +
        "search_profile_id, quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, ?, ?, 'inbound', ?, ?, 'failed', NULL)",
    ).run(
      "drer-msg-fail",
      THREAD_ID,
      "drer-gmsg-fail",
      "Out the door on the 2026 Tucson Limited is $43,000.",
      PROFILE_ID,
    );
  },
};
