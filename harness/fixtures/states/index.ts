/**
 * states — the FixtureState catalogue for the FUNCTIONAL lane.
 *
 * A FixtureState is a named, deterministic world the functional lane installs
 * BEFORE driving a kind="ui" step: a seed that writes rows into the ISOLATED
 * fixture DB (the migration journal already ran; the DB starts empty + a seed
 * account) plus an optional scenario block that flips the DI stubs. The runner
 * applies a state by id; an unknown id fails LOUD here (a typo in a case must
 * never silently install the wrong world).
 *
 * Dependency wall: harness layer (which may import @autobroker/tools — the host
 * already does for openDb). The seed receives the real tools Db handle the
 * host's openDb returns (db.$client.prepare(...).run(...)); the host owns the
 * connection and passes it in.
 *
 * A state is built ONLY when both hold: its rows are seedable with the committed
 * schema, AND the current dashboard actually renders that data so a dom_state
 * anchor can assert it. A seed that asserts nothing is worse than no state.
 *
 * DEFERRED (no state yet — the data has no rendering/seeding surface today):
 *   - quotes_ready          — no quotes panel renders dealer_quotes yet.
 *   - incentives_present    — likewise no manufacturer_incentives surface in the
 *                             dashboard; seeding asserts nothing.
 *   - gmail_not_connected   — needs the Gmail connection surface (E0).
 *   - approval_pending      — a suspended workflow is runtime state, not a row
 *                             seed; there is no static-DB way to install one.
 *   - mid_intake_draft      — a localStorage draft / mid-run UI state, not a DB
 *                             world.
 *   - declined_run          — runtime run state, not a static seed.
 *   - geocode_down          — an intake-flow scenario (the failed-geocode stub),
 *                             exercised by the intake cases, not a static world.
 * The catalogue grows as those surfaces land.
 */

import type { Db } from "@autobroker/tools";

import type { Scenario } from "../stubs.js";

import { activeSearch } from "./activeSearch.js";
import { closedOnly } from "./closedOnly.js";
import { closedProfile } from "./closedProfile.js";
import { dataArriving, dataArrivingGrown } from "./dataArriving.js";
import { digestReady } from "./digestReady.js";
import { emptyHome } from "./emptyHome.js";
import { inventoryListings } from "./inventoryListings.js";
import { keysUnset, keysUnsetReclear } from "./keysUnset.js";
import { multiActive } from "./multiActive.js";
import { quoteAuditWorld } from "./quoteAuditWorld.js";
import { repliesArrived } from "./repliesArrived.js";

/** One named deterministic world the functional lane can install. */
export interface FixtureState {
  /** The stable id a case's fixture_state names. */
  id: string;
  /** Write the world's rows into the isolated fixture DB (no-op when the
   *  fresh-migrated empty DB IS the world). Writes through the real tools Db
   *  handle the host opens (openDb) and passes in. */
  seed: (db: Db) => void;
  /** The DI-stub scenario this world flips to (location outcome + trim verdict),
   *  or undefined to leave the scenario untouched. */
  scenario?: Partial<Scenario>;
}

/** The registry of every known fixture state, keyed by id. */
export const FIXTURE_STATES: Record<string, FixtureState> = {
  [emptyHome.id]: emptyHome,
  [activeSearch.id]: activeSearch,
  [multiActive.id]: multiActive,
  [closedProfile.id]: closedProfile,
  [closedOnly.id]: closedOnly,
  [dataArriving.id]: dataArriving,
  [dataArrivingGrown.id]: dataArrivingGrown,
  [digestReady.id]: digestReady,
  [inventoryListings.id]: inventoryListings,
  [keysUnset.id]: keysUnset,
  [keysUnsetReclear.id]: keysUnsetReclear,
  [quoteAuditWorld.id]: quoteAuditWorld,
  [repliesArrived.id]: repliesArrived,
};

/** Resolve a fixture state by id, failing LOUD on an unknown id. */
export function getFixtureState(id: string): FixtureState {
  const state = FIXTURE_STATES[id];
  if (state === undefined) {
    const known = Object.keys(FIXTURE_STATES).join(", ") || "(none)";
    throw new Error(`unknown fixture_state "${id}" (known: ${known})`);
  }
  return state;
}
