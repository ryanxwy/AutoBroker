/**
 * hygieneReady — the dealer_hygiene "one candidate per cleanup stage" world.
 * Launching dealer_hygiene over this world surfaces EXACTLY one candidate in
 * each of the three strictly-ordered batch-review stages, so the destructive
 * HygieneReviewCard renders for 5a → 5b → 5c in turn.
 *
 * Hygiene detection is GLOBAL (the pinned profile is provenance only, never a
 * WHERE filter), and its writes are global too — so the candidate rows are seeded
 * to satisfy the three detection queries directly, and the case anchors measure
 * GLOBAL table deltas (the orphan-thread DELETE, the thread_suppression INSERT,
 * the dealer_contacts soft-demote — none of which reliably carry the pinned
 * profile's search_profile_id, e.g. the suppression rows are written with a NULL
 * search_profile_id).
 *
 * THE THREE STAGE CANDIDATES (one each, to keep the card single-row per stage):
 *   5a — ONE orphan thread: a `threads` row whose gmail_thread_id is actually a
 *        real messages.gmail_message_id (a message-id mis-saved as a thread
 *        record) AND which has ZERO messages of its own. The decoy message that
 *        owns that gmail_message_id lives on NO thread (thread_id NULL), so the
 *        orphan thread itself stays message-free. This is the ONE allowed
 *        HARD-DELETE candidate.
 *   5b — ONE CRM-only thread: an inbound thread with NO offers row, whose CURRENT
 *        message_analysis intent is the suppressible CRM-noise 'nurture', whose
 *        dealer ALSO has ANOTHER OUTBOUND thread (a real conversation exists),
 *        state not 'agreed', and NO value-class intent. SUPPRESS candidate.
 *   5c — ONE CRM-platform contact: a dealer_contacts row flagged
 *        is_crm_platform_sender=1, NOT the primary reply target, owning ZERO
 *        dealer_quotes, not already cleanup-suppressed. SOFT-DEMOTE candidate.
 *
 * It also seeds ONE active Tucson Hyundai search_profiles row (so the dashboard
 * projects an active profile the case can PIN — dealer_hygiene is pin_required,
 * which gates the popover Run; the workflow resolve is SOFT, so a pin gives a
 * `pinned` resolution while detection stays global).
 *
 * Addresses are generic placeholders — no real account string appears anywhere.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
export const HYGIENE_READY_PROFILE_ID = "hygiene-ready-1";

const DEALER_ID = "hygiene-ready-dealer-1";

// Stage-candidate ids (stable so the case can read the deltas deterministically).
const ORPHAN_THREAD_ID = "hygiene-orphan-thread-1";
/** The orphan thread's stored gmail_thread_id — actually a real message-id (the
 *  red-line value: it must be DELETEd over, never suppressed). */
const ORPHAN_STRAY_MESSAGE_ID = "hygiene-stray-msg-1";
const CRM_THREAD_ID = "hygiene-crm-thread-1";
const OUTBOUND_THREAD_ID = "hygiene-outbound-thread-1";
const CRM_CONTACT_ID = "hygiene-crm-contact-1";

/** Seed the active profile + the dealer the candidates hang off. */
function seedProfileAndDealer(db: Db): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO search_profiles " +
      "(search_profile_id, year, make, model, trim, search_radius_miles, " +
      "location_query, city, state, postal_code, latitude, longitude, " +
      "financing_preference, phone_policy, account_id, brand, location, status) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(search_profile_id) DO NOTHING",
  ).run(
    HYGIENE_READY_PROFILE_ID,
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
  c.prepare(
    "INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, ?, 4.2, 'US') " +
      "ON CONFLICT(dealer_id) DO NOTHING",
  ).run(DEALER_ID, "Example Hyundai");
  c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound') " +
      "ON CONFLICT(search_profile_id, dealer_id) DO NOTHING",
  ).run(HYGIENE_READY_PROFILE_ID, DEALER_ID);
}

/** 5a — the orphan thread (zero messages; its gmail_thread_id is a real
 *  message-id owned by a decoy message that lives on NO thread). */
function seedOrphanThread(db: Db): void {
  const c = db.$client;
  // The decoy message owning the stray id — thread_id NULL so the orphan thread
  // itself keeps zero messages (the orphan-shape requirement).
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, search_profile_id) " +
      "VALUES (?, NULL, ?, 'inbound', ?) ON CONFLICT(message_id) DO NOTHING",
  ).run("hygiene-decoy-msg-1", ORPHAN_STRAY_MESSAGE_ID, HYGIENE_READY_PROFILE_ID);
  // The orphan thread: gmail_thread_id = the stray message-id, zero messages.
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, subject, state, search_profile_id) " +
      "VALUES (?, ?, ?, ?, 'replied', ?) ON CONFLICT(thread_id) DO NOTHING",
  ).run(ORPHAN_THREAD_ID, DEALER_ID, ORPHAN_STRAY_MESSAGE_ID, "(empty record)", HYGIENE_READY_PROFILE_ID);
}

/** 5b — the CRM-only thread (inbound nurture, no offer, dealer also has an
 *  outbound thread, no value-class intent). */
function seedCrmThread(db: Db): void {
  const c = db.$client;
  // The suppressible thread + its inbound message.
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) " +
      "VALUES (?, ?, ?, 'replied', ?) ON CONFLICT(thread_id) DO NOTHING",
  ).run(CRM_THREAD_ID, DEALER_ID, "We miss you — still shopping?", HYGIENE_READY_PROFILE_ID);
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, search_profile_id) " +
      "VALUES (?, ?, 'inbound', ?) ON CONFLICT(message_id) DO NOTHING",
  ).run("hygiene-crm-msg-1", CRM_THREAD_ID, HYGIENE_READY_PROFILE_ID);
  // Its CURRENT analysis: a suppressible CRM-noise intent (the only current
  // intent → no value-class intent on the thread, so the keep-bias passes it).
  c.prepare(
    "INSERT INTO message_analysis (analysis_id, message_id, analysis_version, is_current, intent, search_profile_id) " +
      "VALUES (?, 'hygiene-crm-msg-1', 1, 1, 'nurture', ?) ON CONFLICT(analysis_id) DO NOTHING",
  ).run("hygiene-crm-ana-1", HYGIENE_READY_PROFILE_ID);

  // The SAME dealer's OTHER thread with an OUTBOUND message (proves a real
  // conversation exists — required by the CRM-only detection). This thread is
  // NOT a candidate (it has an outbound message + no suppressible analysis).
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) " +
      "VALUES (?, ?, ?, 'replied', ?) ON CONFLICT(thread_id) DO NOTHING",
  ).run(OUTBOUND_THREAD_ID, DEALER_ID, "Your quote request", HYGIENE_READY_PROFILE_ID);
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, search_profile_id) " +
      "VALUES (?, ?, 'outbound', ?) ON CONFLICT(message_id) DO NOTHING",
  ).run("hygiene-outbound-msg-1", OUTBOUND_THREAD_ID, HYGIENE_READY_PROFILE_ID);
}

/** 5c — the CRM-platform contact (auto-sender flag, not primary, owns no quote,
 *  not already cleanup-suppressed). */
function seedCrmContact(db: Db): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO dealer_contacts " +
      "(contact_id, dealer_id, email, display_name, normalized_email, " +
      "is_primary_reply_target, is_crm_platform_sender, search_profile_id) " +
      "VALUES (?, ?, ?, ?, ?, 0, 1, ?) ON CONFLICT(contact_id) DO NOTHING",
  ).run(
    CRM_CONTACT_ID,
    DEALER_ID,
    "no-reply@crm-platform.example",
    "Lead Platform Auto-Sender",
    "no-reply@crm-platform.example",
    HYGIENE_READY_PROFILE_ID,
  );
}

/** The hygiene world: one candidate per stage (orphan + CRM thread + CRM
 *  contact), a bound dealer, an active pinnable profile. */
export const hygieneReady: FixtureState = {
  id: "hygiene_ready",
  seed: (db: Db) => {
    seedProfileAndDealer(db);
    seedOrphanThread(db);
    seedCrmThread(db);
    seedCrmContact(db);
  },
};
