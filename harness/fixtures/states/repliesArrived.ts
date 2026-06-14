/**
 * repliesArrived — the "dealer replies have landed" world: ONE active Tucson
 * Hyundai search profile (so the Canvas projects the active profile card) plus a
 * deterministic inbound dealer-reply corpus staged in the fake mailbox sandbox
 * (two threads, scoped to that profile). This is the moment after the email-pull
 * skill syncs replies: a Wave-E inbox surface reads these through the
 * FakeGmailAdapter; today the proof is the active profile renders and the fake
 * rows are present and readable back.
 *
 * WHAT THIS SEEDS:
 *   - 1 search_profiles row (status='active', account=acct-harness-1, Hyundai) —
 *     the exact shape the active_search world uses, so the Canvas renders it.
 *   - 2 fake_mailbox_threads + their inbound messages (one with an attachment),
 *     scoped to the profile, with strictly-increasing internalDateMs (the
 *     watermark ordering the sync engine trusts).
 *
 * Addresses are generic placeholders — no real account string appears anywhere.
 */

import { seedFakeMailbox } from "@autobroker/tools";
import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
const PROFILE_ID = "replies-tucson-1";

/** A tiny valid 1x1 PNG (base64) so the attachment row has real decodable bytes. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const repliesArrived: FixtureState = {
  id: "replies_arrived",
  seed: (db: Db) => {
    const c = db.$client;
    // The active search (Tucson corpus shape) — same insert as the active_search
    // world so the Canvas projects the active profile card. ON CONFLICT on the
    // primary key absorbs an identical re-seed (the whole state stays
    // re-runnable, matching the fake-mailbox half); a DIFFERENT id in the same
    // active slot still trips the partial unique index, so the one-active-per-
    // (account, brand) invariant is unchanged.
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(search_profile_id) DO NOTHING",
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

    // Two inbound dealer-reply threads scoped to the profile. internalDateMs is
    // strictly increasing across the whole batch (the watermark invariant).
    seedFakeMailbox({
      db,
      threads: [
        {
          threadId: "replies-thread-1",
          subject: "Re: 2026 Tucson Hybrid SEL availability",
          searchProfileId: PROFILE_ID,
          messages: [
            {
              messageId: "replies-msg-1",
              direction: "inbound",
              from: "sales@example-dealer.com",
              to: "buyer@example.com",
              subject: "Re: 2026 Tucson Hybrid SEL availability",
              bodyText:
                "Thanks for reaching out! We have a 2026 Tucson Hybrid SEL in stock. " +
                "Sale price is 33,995 before tax and fees. Let me know if you'd like to come in.",
              internalDateMs: 1_711_900_000_000,
            },
          ],
        },
        {
          threadId: "replies-thread-2",
          subject: "Re: Tucson Hybrid quote",
          searchProfileId: PROFILE_ID,
          messages: [
            {
              messageId: "replies-msg-2",
              direction: "inbound",
              from: "sales@example-dealer-two.com",
              to: "buyer@example.com",
              subject: "Re: Tucson Hybrid quote",
              bodyText:
                "Attached is our out-the-door quote for the Tucson Hybrid SEL. " +
                "Happy to answer any questions.",
              internalDateMs: 1_711_900_060_000,
              attachments: [
                {
                  attachmentId: "replies-att-1",
                  filename: "quote.png",
                  mimeType: "image/png",
                  dataBase64: TINY_PNG_BASE64,
                },
              ],
            },
          ],
        },
      ],
    });
  },
};
