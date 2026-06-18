/**
 * quoteSourceDoc — the "click a quote card → embed the dealer's ORIGINAL source
 * document" world. ONE active Hyundai Tucson profile + ONE bound dealer + ONE
 * extracted IMAGE quote whose `source_gmail_message_id` points at a fake-mailbox
 * message that carries a decodable PNG attachment in `fake_mailbox_attachments`.
 *
 * This is the seed half of the end-to-end func proof: open the Quotes tab, expand
 * the raw "Extracted quotes" foldout, click the quote card, and the
 * QuoteDetailModal fetches GET …/quotes/:quoteId/source — the route re-reads the
 * PNG bytes via the (fake) Gmail adapter and the modal embeds it
 * (data-testid="quote-source-image"). The whole chain (route → reader → fake
 * adapter → fake_mailbox_attachments) is proven offline.
 *
 * WHAT THIS SEEDS:
 *   - 1 search_profiles row (status='active', Hyundai) so the Canvas auto-selects
 *     it (no pin step) and the Quotes tab projects this profile's quotes.
 *   - 1 dealers row + profile_dealers bind (the quote's display name).
 *   - 1 fake_mailbox message (gmail id "qsd-msg-1") WITH a PNG attachment row.
 *   - 1 messages row (so the raw read's source-email LEFT JOIN resolves and the
 *     modal's "Source email" section mounts) keyed to the quote's message_id.
 *   - 1 dealer_quotes row: quote_format='image', source_gmail_message_id='qsd-msg-1'.
 *
 * Addresses are generic placeholders — no real account string appears anywhere.
 */

import { seedFakeMailbox } from "@autobroker/tools";
import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

const PROFILE_ID = "quote-source-doc-1";
const DEALER_ID = "qsd-dealer-1";
const SOURCE_MSG_ID = "qsd-msg-1";
const QUOTE_ID = "qsd-quote-1";

/** A tiny valid 1x1 PNG (base64) so the attachment row has real decodable bytes. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const quoteSourceDoc: FixtureState = {
  id: "quote_source_doc",
  seed: (db: Db) => {
    const c = db.$client;

    // The one active profile → the Canvas auto-selects it (first active) so the
    // Quotes tab + its quoteSourceUrl wiring activate with no pin step.
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson Hybrid', 'SEL', 50, ?, 'Tucson', 'AZ', " +
        "'85704', 32.3349, -110.9762, 'finance', 'fake', 'acct-harness-1', 'Hyundai', ?, 'active')",
    ).run(PROFILE_ID, "Tucson, AZ 85704", "Tucson, AZ 85704");

    // The bound dealer → the quote card's display name.
    c.prepare(
      "INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, 'Source Doc Hyundai', 5.0, 'US')",
    ).run(DEALER_ID);
    c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    ).run(PROFILE_ID, DEALER_ID);

    // The fake-mailbox message that physically carries the PNG attachment the
    // route re-fetches. gmail message id MUST equal the quote's
    // source_gmail_message_id so adapter.getMessage(...) resolves it.
    seedFakeMailbox({
      db,
      threads: [
        {
          threadId: "qsd-thread-1",
          subject: "Re: 2026 Tucson Hybrid SEL out-the-door quote",
          searchProfileId: PROFILE_ID,
          messages: [
            {
              messageId: SOURCE_MSG_ID,
              direction: "inbound",
              from: "sales@example-dealer.com",
              to: "buyer@example.com",
              subject: "Re: 2026 Tucson Hybrid SEL out-the-door quote",
              bodyText:
                "Attached is our out-the-door quote for the 2026 Tucson Hybrid SEL.",
              internalDateMs: 1_711_900_000_000,
              attachments: [
                {
                  attachmentId: "qsd-att-1",
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

    // A 'succeeded'-extraction messages row so the raw read's source-email LEFT
    // JOIN resolves (the modal's "Source email" section mounts). The CHECK
    // requires a non-null intent when status is 'succeeded'.
    const QUOTE_MESSAGE_ID = "qsd-m-1";
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, " +
        "subject, body_text, sender_email, " +
        "quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, NULL, ?, 'inbound', ?, ?, 'sales@example-dealer.com', 'succeeded', 'quote')",
    ).run(
      QUOTE_MESSAGE_ID,
      SOURCE_MSG_ID,
      "Re: 2026 Tucson Hybrid SEL out-the-door quote",
      "Attached is our out-the-door quote for the 2026 Tucson Hybrid SEL.",
    );

    // The extracted IMAGE quote: quote_format='image' → the modal embeds the
    // source doc; source_gmail_message_id='qsd-msg-1' → the route resolves the
    // fake message + its PNG.
    c.prepare(
      "INSERT INTO dealer_quotes " +
        "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, " +
        " financing_mode, quote_format, otd_total) " +
        "VALUES (?, ?, ?, ?, ?, 'finance', 'image', 38995)",
    ).run(QUOTE_ID, DEALER_ID, QUOTE_MESSAGE_ID, SOURCE_MSG_ID, PROFILE_ID);
  },
};
