/**
 * intakeMalformed — the #1244 fail-closed intake world. No DB rows to seed (a
 * fresh intake creates its own profile); the world IS the scenario flip:
 * llmMalformed=true makes the intake_freeform_prefill stub fail-closed with a
 * malformed_tool_call HarnessSuspend (prefill is intake's fail-closed LLM surface,
 * so the case runs a FREEFORM launch). The case then DECLINES that suspend and
 * asserts the run ends `declined` with ZERO search_profiles writes (fail-closed,
 * never a fabricated profile). location stays `resolved` (never reached — the
 * malformed suspend at prefill precedes collect/resolveLocation).
 */

import type { FixtureState } from "./index.js";

export const intakeMalformed: FixtureState = {
  id: "intake_malformed",
  // No rows: intake builds its own profile; this world only flips the stub.
  seed: () => {},
  scenario: { llmMalformed: true },
};
