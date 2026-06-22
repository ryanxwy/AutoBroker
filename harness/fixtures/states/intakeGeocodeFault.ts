/**
 * intakeGeocodeFault — the T4-U2 transient-tool-fault world. No DB rows; the world
 * IS the scenario flip: fault="tool_timeout" makes resolveLocationStub reject on the
 * next tick, so the intake geocode (resolveLocation) step fails CLOSED — the run
 * errors, no profile is persisted, and no NULL-coords row is written (persist
 * independently fail-louds on null coords). Never a hallucinated "resolved" success.
 * The case arms this, drives a fresh intake, and asserts the fail-closed terminal +
 * zero writes (the first adversarial test of inv #4/#12 for a TOOL fault, distinct
 * from the #1244 malformed-LLM-tool-call case).
 */

import type { FixtureState } from "./index.js";

export const intakeGeocodeFault: FixtureState = {
  id: "intake_geocode_fault",
  // No rows: a fresh intake builds its own profile; this world only flips the stub.
  seed: () => {},
  scenario: { fault: "tool_timeout" },
};
