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
 */

import type { Db } from "@autobroker/tools";

import type { Scenario } from "../stubs.js";

import { emptyHome } from "./emptyHome.js";

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
