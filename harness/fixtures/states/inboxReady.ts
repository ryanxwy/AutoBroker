/**
 * inboxReady — the dealer_inbox_check "replies are in, a lead was submitted,
 * dealers are bound with websites" world. This is the journey/decline/
 * new-salesperson fixture: launching dealer_inbox_check (pinned) over this world
 * discovers the seeded replies, routes them under the bound dealer by the
 * dealer-domain rung, and renders the InboxReviewCard.
 *
 * WHAT THIS SEEDS:
 *   - 1 active search_profiles row (Hyundai Tucson Hybrid, account acct-harness-1).
 *   - 1 dealers row WITH a website whose host stem ("example-dealer") matches the
 *     reply sender domain, bound to the profile (profile_dealers status='bound').
 *     The dealer-domain routing rung (2.5) binds the replies via this host match —
 *     dealer_contacts is empty on a first sweep, so rung 2 cannot fire.
 *   - 1 lead_submissions row: outcome='submitted', submission_channel='web_form'
 *     (the XOR CHECK shape — fail_reason/email_fallback_reason NULL), submitted_at
 *     BEFORE the reply dates. This is the discovery-window anchor: without it the
 *     workflow STOPs no_lead_submitted (see inboxNoLead).
 *   - fake_mailbox threads via seedFakeMailbox: inbound replies whose `from` is at
 *     the BOUND dealer's domain. Includes (i) a reply from a known-style
 *     dealer-domain address AND (ii) a reply from a NEW salesperson address at the
 *     SAME dealer domain (NOT in dealer_contacts) — the new-salesperson route case.
 *
 * THE DATE WINDOW (load-bearing): the inbox first sweep's discovery window is
 * computeWindow(leadSubmitMs, Date.now()), and the FakeGmailAdapter honors the
 * resulting `newer_than:Nh|Nd` clause RELATIVE TO Date.now(). So the lead submit
 * and the reply internalDateMs are pinned to fixed offsets BACK FROM "now" at
 * seed time (the seed runs moments before the run executes), guaranteeing the
 * replies fall inside the window of a run executed now. The lead submit is 2h
 * ago → window rounds to "3h"; the replies are 90/60/30 min ago → all inside it.
 *
 * Addresses are generic placeholders — no real account string appears anywhere.
 */

import { seedFakeMailbox } from "@autobroker/tools";
import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
export const INBOX_READY_PROFILE_ID = "inbox-ready-1";

/** The bound dealer + its website. The host stem ("example-dealer") matches the
 *  reply senders' domain, so the dealer-domain routing rung binds them. */
const DEALER_ID = "inbox-ready-dealer-1";
const DEALER_WEBSITE = "https://www.example-dealer.com/";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Seed the active profile + the bound dealer (with website). Shared by the
 *  ready and no-lead worlds so they are identical except for the lead row. */
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
    INBOX_READY_PROFILE_ID,
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
    "INSERT INTO dealers (dealer_id, name, address, city, state, postal_code, website, distance_miles, country) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'US') ON CONFLICT(dealer_id) DO NOTHING",
  ).run(
    DEALER_ID,
    "Example Hyundai",
    "100 Auto Mall Dr, Tucson, AZ",
    "Tucson",
    "AZ",
    "85704",
    DEALER_WEBSITE,
    4.2,
  );
  c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound') " +
      "ON CONFLICT(search_profile_id, dealer_id) DO NOTHING",
  ).run(INBOX_READY_PROFILE_ID, DEALER_ID);
}

/** Seed the inbound reply corpus from the bound dealer's domain. internalDateMs
 *  is pinned to fixed offsets back from `now` so the replies land inside the
 *  lead-submit-anchored window of a run executed now. Two replies: one from a
 *  known-style sales address, one from a NEW salesperson at the SAME domain. */
function seedReplies(db: Db, now: number): void {
  seedFakeMailbox({
    db,
    threads: [
      {
        threadId: "inbox-ready-thread-1",
        subject: "Re: 2026 Tucson Hybrid SEL availability",
        searchProfileId: INBOX_READY_PROFILE_ID,
        messages: [
          {
            messageId: "inbox-ready-msg-1",
            direction: "inbound",
            from: "sales@example-dealer.com",
            to: "buyer@example.com",
            subject: "Re: 2026 Tucson Hybrid SEL availability",
            bodyText:
              "Thanks for reaching out! We have a 2026 Tucson Hybrid SEL in stock. " +
              "Happy to send a quote — let me know if you'd like to come in.",
            internalDateMs: now - 90 * MINUTE_MS,
          },
        ],
      },
      {
        threadId: "inbox-ready-thread-2",
        subject: "Re: Tucson Hybrid quote request",
        searchProfileId: INBOX_READY_PROFILE_ID,
        messages: [
          {
            // A NEW salesperson address at the SAME dealer domain — NOT seeded
            // into dealer_contacts, so only the dealer-domain host rung can bind
            // it. Proves the new-salesperson route lands under the dealer.
            messageId: "inbox-ready-msg-2",
            direction: "inbound",
            from: "jordan.newrep@example-dealer.com",
            to: "buyer@example.com",
            subject: "Re: Tucson Hybrid quote request",
            bodyText:
              "Hi, I'm taking over from our team — here is our out-the-door quote " +
              "for the Tucson Hybrid SEL. Let me know if you have questions.",
            internalDateMs: now - 30 * MINUTE_MS,
          },
        ],
      },
    ],
  });
}

/** The journey/decline/new-salesperson world: replies + a submitted lead. */
export const inboxReady: FixtureState = {
  id: "inbox_ready",
  seed: (db: Db) => {
    const now = Date.now();
    seedProfileAndDealer(db);
    // The discovery-window anchor: a submitted web_form lead 2h ago (XOR-valid:
    // submission_channel='web_form' ⇒ fail_reason + email_fallback_reason NULL).
    db.$client
      .prepare(
        "INSERT INTO lead_submissions " +
          "(submission_id, dealer_id, search_profile_id, submitted_at, outcome, submission_channel) " +
          "VALUES (?, ?, ?, ?, 'submitted', 'web_form') " +
          "ON CONFLICT(submission_id) DO NOTHING",
      )
      .run("inbox-ready-lead-1", DEALER_ID, INBOX_READY_PROFILE_ID, now - 2 * HOUR_MS);
    seedReplies(db, now);
  },
};

/** The no-lead world: IDENTICAL to inboxReady (replies + bound dealer) EXCEPT it
 *  seeds ZERO lead_submissions rows — so the first sweep has no anchor and the
 *  workflow STOPs no_lead_submitted (zero writes, no batch card). */
export const inboxNoLead: FixtureState = {
  id: "inbox_no_lead",
  seed: (db: Db) => {
    const now = Date.now();
    seedProfileAndDealer(db);
    seedReplies(db, now);
  },
};
