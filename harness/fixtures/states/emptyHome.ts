/**
 * emptyHome — the empty-home fixture world: no profiles, no searches, nothing
 * to project. The fresh-migrated fixture DB (migration journal applied + the
 * single seed account) ALREADY is this world, so the seed is a no-op. This
 * state proves the empty-home UI renders its start-here CTA with zero search
 * rows.
 */

import type { FixtureState } from "./index.js";

export const emptyHome: FixtureState = {
  id: "empty_home",
  // The fresh-migrated DB is already empty — no rows to write.
  seed: () => {},
};
