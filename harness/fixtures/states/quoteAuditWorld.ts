/**
 * quoteAuditWorld — the "quotes ready to audit" world: ONE active CA search
 * profile with two bound dealers, a set of dealer_quotes (each with a
 * 'succeeded'-extraction message so the recent batch picks them up), and a
 * matching manufacturer_incentives slice. The /quote_audit skill resolves this
 * profile, reads the quotes/peers/incentives, runs the deterministic 10-check
 * audit, and UPSERTs one quote_audits row per quote.
 *
 * WHAT THIS SEEDS:
 *   - 1 search_profiles row (status='active', account=acct-harness-1, state='CA'
 *     so the doc-fee cap is $85, postal_code='92614', financing_preference='finance')
 *   - 2 dealers + 2 profile_dealers bindings (the dealer display names)
 *   - 1 manufacturer_incentives row (Hyundai Tucson 92614 customer_cash $1500,
 *     eligibility 'all') — drives MISSING_REBATE on the quote that omits it
 *   - 4 messages (quote_extraction_status='succeeded') + 4 dealer_quotes:
 *       q-doc    → DOC_FEE_CAP (doc_fee 599 > the CA $85 cap; math reconciles)
 *       q-math   → MATH_SANITY (40000+85+3000=43085 vs stated 50000)
 *       q-rebate → MISSING_REBATE (no rebate applied; the incentive is unused)
 *       q-clean  → ZERO findings (within cap, math reconciles, rebate applied)
 *
 * USED BY: quote_audit.idempotency.func.toml — a kind="skill" UI-lane case run
 * offline under --fixture (quote_audit is zero-LLM, so no provider call fires).
 * The case launches /quote_audit twice: the first run UPSERTs 4 quote_audits
 * rows; the second run's recent anti-join finds them already audited → ZERO new
 * rows (quote_audits Δ=0 EXACT — the idempotency keystone).
 *
 * NOTE: there is no Canvas panel for quotes, so this world renders nothing in a
 * runless kind="ui" step — it exists solely as the seed for a kind="skill" run.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
const PROFILE_ID = "quote-audit-tucson-1";
const DEALER_A = "dealer-alpha-hyundai";
const DEALER_B = "dealer-bravo-hyundai";

interface QuoteRow {
  quoteId: string;
  dealerId: string;
  messageId: string;
  sellingPrice: number;
  docFee: number;
  salesTax: number;
  otdTotal: number;
  /** JSON string of applied rebates, or null. */
  rebatesJson: string | null;
}

const REBATE_APPLIED = JSON.stringify([{ type: "customer_cash", name: "Customer Cash" }]);

const QUOTES: QuoteRow[] = [
  // q-doc: doc_fee over the CA $85 cap; selling+doc+tax reconciles to otd; rebate
  // applied; breakdown complete → DOC_FEE_CAP is the only finding.
  {
    quoteId: "q-doc",
    dealerId: DEALER_A,
    messageId: "qa-m-doc",
    sellingPrice: 40000,
    docFee: 599,
    salesTax: 3000,
    otdTotal: 43599,
    rebatesJson: REBATE_APPLIED,
  },
  // q-math: 40000+85+3000=43085 but stated 50000 → MATH_SANITY; doc within cap,
  // rebate applied, breakdown complete.
  {
    quoteId: "q-math",
    dealerId: DEALER_B,
    messageId: "qa-m-math",
    sellingPrice: 40000,
    docFee: 85,
    salesTax: 3000,
    otdTotal: 50000,
    rebatesJson: REBATE_APPLIED,
  },
  // q-rebate: no rebate applied → MISSING_REBATE; doc within cap, math reconciles.
  {
    quoteId: "q-rebate",
    dealerId: DEALER_A,
    messageId: "qa-m-rebate",
    sellingPrice: 38000,
    docFee: 85,
    salesTax: 2850,
    otdTotal: 40935,
    rebatesJson: null,
  },
  // q-clean: everything reconciles, doc within cap, rebate applied → ZERO findings.
  {
    quoteId: "q-clean",
    dealerId: DEALER_B,
    messageId: "qa-m-clean",
    sellingPrice: 41000,
    docFee: 80,
    salesTax: 3075,
    otdTotal: 44155,
    rebatesJson: REBATE_APPLIED,
  },
];

export const quoteAuditWorld: FixtureState = {
  id: "quote_audit_world",
  seed: (db: Db) => {
    const c = db.$client;

    // The active CA search. state='CA' → doc-fee cap $85; financing 'finance' →
    // the finance quotes raise no MODE_MISMATCH.
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, budget_max, search_radius_miles, " +
        "location_query, city, state, postal_code, financing_preference, current_brand_owner, " +
        "military_first_responder, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', 'Limited', 50000, 25, ?, 'Irvine', 'CA', '92614', " +
        "'finance', 0, 0, 'fake', 'acct-harness-1', 'Hyundai', ?, 'active')",
    ).run(PROFILE_ID, "Irvine, CA 92614", "Irvine, CA 92614");

    // Two bound dealers — the quote display names.
    const dealers: Array<[string, string]> = [
      [DEALER_A, "Alpha Hyundai"],
      [DEALER_B, "Bravo Hyundai"],
    ];
    const insertDealer = c.prepare(
      "INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, ?, 5.0, 'US')",
    );
    const bind = c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    );
    for (const [id, name] of dealers) {
      insertDealer.run(id, name);
      bind.run(PROFILE_ID, id);
    }

    // The (make,model,zip)-exact incentive slice — Hyundai Tucson 92614
    // customer_cash $1500, eligibility 'all' → MISSING_REBATE on the quote that
    // omits it.
    c.prepare(
      "INSERT INTO manufacturer_incentives (make, model, zip, type, amount, eligibility, " +
        "scraped_at, scrape_source_url) " +
        "VALUES ('Hyundai', 'Tucson', '92614', 'customer_cash', 1500, 'all', '2026-06-01', " +
        "'https://www.hyundaiusa.com/offers')",
    ).run();

    // The messages (succeeded extraction — the recent-batch join requires it; the
    // CHECK constraint requires a non-null intent when status is 'succeeded') +
    // the dealer_quotes.
    const insertMessage = c.prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, " +
        "quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, NULL, NULL, 'inbound', 'succeeded', 'quote')",
    );
    const insertQuote = c.prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
        "search_profile_id, financing_mode, selling_price, doc_fee, sales_tax, otd_total, " +
        "rebates_json, quote_received_at) " +
        "VALUES (?, ?, ?, ?, ?, 'finance', ?, ?, ?, ?, ?, NULL)",
    );
    for (const q of QUOTES) {
      insertMessage.run(q.messageId);
      insertQuote.run(
        q.quoteId,
        q.dealerId,
        q.messageId,
        `gmsg-${q.quoteId}`,
        PROFILE_ID,
        q.sellingPrice,
        q.docFee,
        q.salesTax,
        q.otdTotal,
        q.rebatesJson,
      );
    }
  },
};
