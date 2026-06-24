/**
 * multiprofile/world — the deterministic collision core: seed the multi-active
 * different-brand world + ONE shared dealer, then drive the claimDealer
 * exclusivity path in a PRNG-determined order.
 *
 * THE SEED SHAPE mirrors apps/ui/e2e/serve-live.mjs's B2 shared-dealer mode
 * EXACTLY: a single shared dealer row `dealer_id = live-dealer-<dealerKey>` and a
 * `profile_dealers` row per profile with status 'candidate' (NOT pre-bound) — so
 * the live claimDealer step picks the exclusivity winner. A 'bound' second row
 * sharing one dealer_id would trip the partial-unique uq_profile_dealers_bound_
 * dealer index, so 'candidate' is the only shape both profiles can hold up front.
 *
 * SEED WRITES are the SANCTIONED harness setup path. Like seed.ts, multiActive.ts,
 * and serve-live.mjs, this module writes the ISOLATED run DB directly via the Db
 * handle's raw client to stage the world before the SUT/claim runs. The product
 * path NEVER writes the DB this way; these direct INSERTs are clearly-commented
 * test/seed setup only.
 *
 * Dependency wall: harness layer. Imports @autobroker/tools (the Db type +
 * claimDealer/ClaimResult) and the sibling prng module. NEVER better-sqlite3 /
 * drizzle-orm / playwright directly (it uses the Db handle, the same wall-legal
 * pattern dbReads / invariants use).
 */

import { claimDealer, type ClaimResult, type Db } from "@autobroker/tools";

import type { Prng } from "./prng.js";

// ---------------------------------------------------------------------------
// seed shapes
// ---------------------------------------------------------------------------

export interface MpProfileSeed {
  id: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  /** Feeds the budget_no_leak invariant ONLY (inv #9) — never rendered/printed. */
  budgetMax: number;
}

export interface SharedDealerSeed {
  dealerKey: string;
  name: string;
  website: string;
}

// SEED SQL — sanctioned harness setup (direct INSERTs into the isolated run DB).
// search_profiles: status='active', account_id from makeTmpDb's seeded account
// ('acct-test-1'), brand=make so two distinct brands hold two active slots without
// tripping uq_search_profiles_active_account_brand (mirrors multiActive.ts).
const INSERT_PROFILE =
  "INSERT INTO search_profiles " +
  "(search_profile_id, year, make, model, trim, budget_max, account_id, brand, status) " +
  "VALUES (?, ?, ?, ?, ?, ?, 'acct-test-1', ?, 'active')";

// dealers: one shared rooftop, upsert-on-conflict like serve-live's INSERT_DEALER
// (so seeding the same dealerKey twice reuses the one row).
const INSERT_DEALER =
  "INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US') " +
  "ON CONFLICT(dealer_id) DO NOTHING";

// profile_dealers: a 'candidate' row per profile (NOT pre-bound) so claimDealer
// decides the winner — exactly serve-live's BIND_DEALER shared-dealer shape.
const BIND_CANDIDATE =
  "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate') " +
  "ON CONFLICT(search_profile_id, dealer_id) DO NOTHING";

/**
 * Seed N different-brand active search_profiles + ONE shared dealer
 * (`live-dealer-<dealerKey>`) + a 'candidate' profile_dealers row per profile.
 * Returns the shared dealerId. Direct INSERTs = sanctioned test/seed setup.
 */
export function seedMultiActiveSharedDealer(
  db: Db,
  profiles: MpProfileSeed[],
  dealer: SharedDealerSeed,
): { dealerId: string } {
  const conn = db.$client;
  const dealerId = `live-dealer-${dealer.dealerKey}`;

  const insertProfile = conn.prepare(INSERT_PROFILE);
  const insertDealer = conn.prepare(INSERT_DEALER);
  const bindCandidate = conn.prepare(BIND_CANDIDATE);

  insertDealer.run(dealerId, dealer.name, dealer.website);
  for (const p of profiles) {
    insertProfile.run(p.id, p.year, p.make, p.model, p.trim, p.budgetMax, p.make);
    bindCandidate.run(p.id, dealerId);
  }

  return { dealerId };
}

// ---------------------------------------------------------------------------
// collision drive
// ---------------------------------------------------------------------------

export interface ClaimStep {
  profileId: string;
  result: ClaimResult;
}

/**
 * Drive claimDealer for each profile against the shared dealer in a PRNG-shuffled
 * order. The FIRST profile to claim binds the rooftop ('claimed'); every later
 * profile takes the exclusivity conflict path ('conflict', its row marked
 * 'excluded_conflict'). Pure given (db state, prng): the same db + the same prng
 * sequence always produce the same per-profile verdicts in the same claim order.
 *
 * Returns the per-profile ClaimResult in CLAIM order (the shuffled order), so the
 * caller can see which profile won and which lost the deterministic race.
 */
export function interleaveClaims(
  db: Db,
  profileIds: string[],
  dealerId: string,
  prng: Prng,
): ClaimStep[] {
  // PRNG-determined claim order (Fisher-Yates over a copy).
  const order = prng.shuffle(profileIds);
  return order.map((profileId) => ({
    profileId,
    result: claimDealer({ searchProfileId: profileId, dealerId, db }),
  }));
}
