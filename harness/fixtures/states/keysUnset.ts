/**
 * keysUnset — the FRESH-INSTALL world for the centralized Keys panel: no managed
 * API keys configured. The fixture-mode host seeds a dummy DeepSeek key by
 * default (so every OTHER case clears the first-run gate); this state's seed
 * UNDOES that, clearing all four managed keys from both the isolated keys file
 * AND process.env so the keys panel reports a genuine no-keys world.
 *
 * It proves: with no DeepSeek key the dashboard gates skill launch + the Keys
 * panel shows its setup strip, and the real save flow (a true write to the
 * isolated secretsStore, with the probe stubbed to a deterministic pass) flips
 * presence with no reload.
 *
 * TWO ids, ONE seed: a kind="ui" step needs a fixture_state to satisfy the
 * "needs setup to act on" guard, and a case may not name the SAME fixture_state
 * twice (ambiguous). The keys_setup case has two fresh-install steps (the
 * panel/test-pass proof, then the save/unlock proof — each wants a clean
 * no-keys start), so the same clearing seed is registered under two ids.
 *
 * The DB rows are untouched (the fresh-migrated DB is already empty) — this state
 * is about the secretsStore, not the product tables.
 */

import { clearKey } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** Clear every managed key (file + live env var) → a fresh-install world. */
function clearAllManagedKeys(): void {
  for (const id of ["deepseek", "anthropic", "openai", "google_places"] as const) {
    clearKey(id);
  }
}

export const keysUnset: FixtureState = {
  id: "keys_unset",
  seed: clearAllManagedKeys,
};

/** A second id for the same fresh-install world (the save/unlock step re-clears
 *  to a clean start; the no-same-id-twice rule needs a distinct name). */
export const keysUnsetReclear: FixtureState = {
  id: "keys_unset_reclear",
  seed: clearAllManagedKeys,
};
