/**
 * leadSubmitReady — the world the X1 (dealer_web_lead_submit) keystone func
 * cases drive against. It is the moment after intake + geosearch where a search
 * is ready to submit leads: ONE active PINNABLE Tucson profile with three bound
 * US dealers — one exposes a known-platform web form, one has NO web form but a
 * contact_email, and one has a captcha-gated form. The latter two route to the
 * email fallback (the captcha dealer with reason "captcha_fallback", never
 * submitting the captcha).
 *
 * WHAT THIS SEEDS:
 *   - 1 search_profiles row (status='active', account=acct-harness-1, brand=make)
 *     — PINNABLE through the Searches popover (the X1 pin-required launch threads
 *     the pin as search_profile_id).
 *   - 3 dealers (country='US', a usable website, AND contact_email set) +
 *     3 profile_dealers bindings (status='bound'):
 *       · dealer-jim-click  — a DealerFire-platform website (a KNOWN platform →
 *                             NO LLM field-map step) → the web-form submit path.
 *       · dealer-tucson-kia — NO web form path (its site fingerprints to no known
 *                             contact form) but a contact_email → the email
 *                             fallback path (the re-confirm suspend ②).
 *       · dealer-captcha-1  — a captcha-gated contact form (the injected scout
 *                             returns captcha:true) → the email fallback with
 *                             reason "captcha_fallback" (the captcha is never
 *                             submitted or retried).
 *   - 1 inventory_listings row (the single-store path's listing — present so the
 *     world is complete; the full-batch cases do not name a target_listing_id).
 *   - NO prior lead_submissions (so the first run is never a duplicate-skip).
 *
 * The X1 deps the host injects in fixture mode decide the per-dealer SHAPE
 * (scoutForms returns a web-form outcome for jim-click and a no-form-with-email
 * outcome for tucson-kia; submitOne returns fuse_blocked / needs_fallback). The
 * fixture only seeds the DB rows the workflow reads (profile + bound dealers +
 * contact_email); the deterministic scout/submit verdicts come from the stubs,
 * not the browser. recordSubmission / sendAndRecord stay REAL against this DB.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
export const LEAD_SUBMIT_PROFILE_ID = "leadsubmit-tucson-1";

/** The web-form dealer (a known DealerFire platform → no LLM field-map). */
export const LEAD_SUBMIT_WEBFORM_DEALER = "dealer-jim-click";

/** The no-web-form dealer (email fallback via contact_email). */
export const LEAD_SUBMIT_NOFORM_DEALER = "dealer-tucson-kia";

/** The captcha-gated-form dealer (email fallback, reason "captcha_fallback" — the
 *  captcha is NEVER submitted). The injected scout returns form:null + captcha:true
 *  for this dealer; the contact_email is the fallback target. */
export const LEAD_SUBMIT_CAPTCHA_DEALER = "dealer-captcha-1";

/** The single-store listing id (the world's completeness — the full-batch cases
 *  do not reference it). */
const LEAD_SUBMIT_LISTING_ID = "listing-jim-click-1";

export const leadSubmitReady: FixtureState = {
  id: "lead_submit_ready",
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
      LEAD_SUBMIT_PROFILE_ID,
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

    // Two bound US dealers. BOTH carry a website + a contact_email so the no-form
    // dealer has an email-fallback target; the per-dealer SCOUT shape (form vs
    // no-form) is decided by the injected scoutForms stub, not these columns.
    const dealers: Array<{
      id: string;
      name: string;
      website: string;
      contactEmail: string;
      distance: number;
    }> = [
      {
        id: LEAD_SUBMIT_WEBFORM_DEALER,
        name: "Jim Click Hyundai",
        website: "https://www.jimclickhyundai.example.com",
        contactEmail: "sales@jimclickhyundai.example.com",
        distance: 4.2,
      },
      {
        id: LEAD_SUBMIT_NOFORM_DEALER,
        name: "Tucson Kia",
        website: "https://www.tucsonkia.example.com",
        contactEmail: "sales@tucsonkia.example.com",
        distance: 6.8,
      },
      {
        id: LEAD_SUBMIT_CAPTCHA_DEALER,
        name: "Captcha Motors",
        website: "https://www.captcha-dealer.example.com",
        contactEmail: "sales@captcha-dealer.example.com",
        distance: 7.5,
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
      bind.run(LEAD_SUBMIT_PROFILE_ID, d.id);
    }

    // One inventory listing for the web-form dealer (the single-store path's row).
    // The full-batch cases do not name target_listing_id, so this is only world
    // completeness; the NOT NULL columns are filled with their canonical empties.
    const nowIso = new Date().toISOString();
    c.prepare(
      "INSERT INTO inventory_listings " +
        "(listing_id, search_profile_id, dealer_id, year, make, model, trim, " +
        "inventory_status, match_status, raw_listing_json, first_seen_at, last_seen_at, observed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'in_stock', 'matched', '{}', ?, ?, ?)",
    ).run(
      LEAD_SUBMIT_LISTING_ID,
      LEAD_SUBMIT_PROFILE_ID,
      LEAD_SUBMIT_WEBFORM_DEALER,
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "Limited",
      nowIso,
      nowIso,
      nowIso,
    );
  },
};
