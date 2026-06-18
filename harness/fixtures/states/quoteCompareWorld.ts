/**
 * quoteCompareWorld — the "quotes ready to compare" worlds for the Quote compare
 * Canvas section. The /quote_compare ranker reads the active profile's
 * financing_preference + its dealer_quotes (joined to the latest audit per quote
 * + the dealer name), gates by preference, and ranks each bucket by OTD at read
 * time (nothing is persisted).
 *
 * TWO worlds (each func case owns its server+DB, so the two never collide):
 *
 *   quote_compare_world (financing_preference='undecided') — BOTH buckets render:
 *     - 2 bound dealers (the quote display names)
 *     - 3 finance quotes: two with an OTD (one carrying an APR_MARKUP audit flag),
 *       one with a NULL OTD (the "incomplete" badge; sorts last)
 *     - 2 lease quotes (one carrying a DEALER_FEE_OUTLIER audit flag)
 *     The case asserts: both buckets visible, the finance/lease row counts, a
 *     decoded audit-flag pill, and the incomplete badge (the NULL-OTD row).
 *
 *   quote_compare_cash_world (financing_preference='cash') — cash bucket ranked:
 *     - 1 bound dealer, 1 cash-mode quote
 *     The case asserts: the Cash bucket renders (quote-compare-cash) — a cash
 *     buyer's OTD quotes are compared, not dropped.
 *
 * USED BY: quote_compare.func.toml (undecided) + quote_compare_cash.func.toml
 * (cash) — runless kind="ui" render steps (Δ=0 by construction; a pure read
 * panel reaches no side effect).
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

const PROFILE_ID = "quote-compare-tucson-1";
const DEALER_A = "qc-dealer-alpha";
const DEALER_B = "qc-dealer-bravo";

const CASH_PROFILE_ID = "quote-compare-cash-1";
const CASH_DEALER = "qc-cash-dealer";

/** Insert a 'succeeded'-extraction message (the CHECK requires a non-null intent
 *  when status is 'succeeded'). */
function insertMessage(c: Db["$client"], messageId: string): void {
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, " +
      "quote_extraction_status, quote_extraction_intent) " +
      "VALUES (?, NULL, NULL, 'inbound', 'succeeded', 'quote')",
  ).run(messageId);
}

interface CompareQuoteSeed {
  quoteId: string;
  dealerId: string;
  mode: "finance" | "lease" | "cash";
  otdTotal: number | null;
  apr?: number | null;
  downPayment?: number | null;
  financeMonthly?: number | null;
  mf?: number | null;
  dueAtSigning?: number | null;
  leaseMonthly?: number | null;
}

function insertQuote(c: Db["$client"], profileId: string, q: CompareQuoteSeed): void {
  const messageId = `qc-m-${q.quoteId}`;
  insertMessage(c, messageId);
  c.prepare(
    "INSERT INTO dealer_quotes " +
      "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, " +
      " otd_total, finance_apr, finance_down_payment, finance_monthly_payment, finance_term_months, " +
      " lease_money_factor, lease_due_at_signing, lease_monthly_payment, lease_term_months) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    q.quoteId,
    q.dealerId,
    messageId,
    `qc-gmsg-${q.quoteId}`,
    profileId,
    q.mode,
    q.otdTotal,
    q.mode === "finance" ? (q.apr ?? null) : null,
    q.mode === "finance" ? (q.downPayment ?? null) : null,
    q.mode === "finance" ? (q.financeMonthly ?? null) : null,
    q.mode === "finance" ? 60 : null,
    q.mode === "lease" ? (q.mf ?? null) : null,
    q.mode === "lease" ? (q.dueAtSigning ?? null) : null,
    q.mode === "lease" ? (q.leaseMonthly ?? null) : null,
    q.mode === "lease" ? 36 : null,
  );
}

/** Write one audit row carrying the given codes (latest by audited_at). */
function insertAudit(c: Db["$client"], profileId: string, quoteId: string, codes: string[]): void {
  const flagsJson = JSON.stringify(
    codes.map((code) => ({ code, severity: "warn", evidence: "compare-fixture" })),
  );
  c.prepare(
    "INSERT INTO quote_audits (dealer_quote_id, search_profile_id, flags_json, audited_at, audit_pass_version) " +
      "VALUES (?, ?, ?, '2026-05-05 12:00:00', 'v1')",
  ).run(quoteId, profileId, flagsJson);
}

/** The undecided world — both buckets populate. */
export const quoteCompareWorld: FixtureState = {
  id: "quote_compare_world",
  seed: (db: Db) => {
    const c = db.$client;

    // The active UNDECIDED profile → the ranker populates BOTH buckets.
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

    // 3 finance quotes: two with OTD (the cheaper one carries an APR_MARKUP
    // audit flag), one with a NULL OTD (the incomplete badge; sorts last).
    insertQuote(c, PROFILE_ID, {
      quoteId: "f-bravo",
      dealerId: DEALER_B,
      mode: "finance",
      otdTotal: 42987,
      apr: 7.9,
      downPayment: 3000,
      financeMonthly: 612,
    });
    insertQuote(c, PROFILE_ID, {
      quoteId: "f-alpha",
      dealerId: DEALER_A,
      mode: "finance",
      otdTotal: 44540,
      apr: 6.5,
      downPayment: 2500,
      financeMonthly: 648,
    });
    insertQuote(c, PROFILE_ID, {
      quoteId: "f-incomplete",
      dealerId: DEALER_A,
      mode: "finance",
      otdTotal: null,
      apr: 5.9,
    });
    // The cheaper finance quote has an audit → its row shows the APR_MARKUP pill.
    insertAudit(c, PROFILE_ID, "f-bravo", ["APR_MARKUP"]);

    // 2 lease quotes (the cheaper one carries a DEALER_FEE_OUTLIER audit flag).
    insertQuote(c, PROFILE_ID, {
      quoteId: "l-bravo",
      dealerId: DEALER_B,
      mode: "lease",
      otdTotal: 36000,
      mf: 0.00115,
      dueAtSigning: 3800,
      leaseMonthly: 389,
    });
    insertQuote(c, PROFILE_ID, {
      quoteId: "l-alpha",
      dealerId: DEALER_A,
      mode: "lease",
      otdTotal: 38000,
      mf: 0.0012,
      dueAtSigning: 4500,
      leaseMonthly: 412,
    });
    insertAudit(c, PROFILE_ID, "l-bravo", ["DEALER_FEE_OUTLIER"]);
  },
};

/** The cash world — finance + lease empty, cash bucket ranked. */
export const quoteCompareCashWorld: FixtureState = {
  id: "quote_compare_cash_world",
  seed: (db: Db) => {
    const c = db.$client;

    // The active CASH profile → the ranker ranks cash quotes in the cash bucket
    // (finance + lease empty).
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, location_query, city, " +
        "state, postal_code, financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', 'Limited', 25, ?, 'Irvine', 'CA', '92614', " +
        "'cash', 'fake', 'acct-harness-1', 'Hyundai', ?, 'active')",
    ).run(CASH_PROFILE_ID, "Irvine, CA 92614", "Irvine, CA 92614");

    c.prepare(
      "INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, 'Cash Hyundai', 5.0, 'US')",
    ).run(CASH_DEALER);
    c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    ).run(CASH_PROFILE_ID, CASH_DEALER);

    // A cash-mode quote — ranked in the cash bucket for a cash buyer.
    insertQuote(c, CASH_PROFILE_ID, {
      quoteId: "c-cash",
      dealerId: CASH_DEALER,
      mode: "cash",
      otdTotal: 41000,
    });
  },
};
