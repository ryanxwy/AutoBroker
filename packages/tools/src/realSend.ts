/**
 * AUTOBROKER_MODE — the single user-facing switch between the two app postures:
 *
 *   - "buyer" (the DEFAULT): the real product. Real Gmail send + real dealer
 *     web-form submit + real LLM — after the per-action human approval the L2
 *     gate still requires. This is what a real buyer runs.
 *   - "test": the internal/safe posture. The fake mailbox, no real web submit, no
 *     real external mutation — everything stays local on this machine.
 *
 * The value is read FRESH on every call (never cached at module scope), mirroring
 * the Gmail backend selector in {@link ./gmail.ts}, so a settings change can take
 * effect with no restart.
 *
 * Test / harness / CI contexts must NEVER be able to send for real, regardless of
 * the chosen mode. They force test mode via {@link forceTestMode}, and
 * {@link assertTestModeSafe} is a fail-CLOSED tripwire that throws if such a
 * context is ever observed not-in-test-mode — independent of the global default,
 * so the product being buyer-by-default can never make a test or CI run reach a
 * real dealer. (The Gmail backend projects FROM this mode, so the not-in-test
 * check fully covers the send-control floor; there is no separate backend var.)
 */

/** The two app modes. "buyer" is the real product; "test" is internal/safe. */
export type AppMode = "buyer" | "test";

/** Resolve the active app mode, read FRESH from process.env. ONLY the exact
 *  string "test" selects test mode; unset/empty/anything else is "buyer"
 *  (buyer-by-default). */
export function resolveMode(): AppMode {
  return process.env.AUTOBROKER_MODE === "test" ? "test" : "buyer";
}

/** True in buyer mode (the real product) — real send is enabled (still behind
 *  the L2 human-approval gate). True by default; false only when
 *  AUTOBROKER_MODE === "test". */
export function isBuyerMode(): boolean {
  return resolveMode() !== "test";
}

/** True in test mode (internal/safe) — every external send resolves fake/local. */
export function isTestMode(): boolean {
  return resolveMode() === "test";
}

/** True inside a context that MUST run in test mode no matter what mode was
 *  chosen: ANY harness run (AUTOBROKER_HARNESS === "1", set unconditionally by the
 *  runner + host so the LIVE harness host is covered too, not just the fixture
 *  lane), the fixture lane (AUTOBROKER_HARNESS_FIXTURE === "1"), or any
 *  NODE_ENV==="test" process. These contexts can never be allowed to send for
 *  real, so boot forces test mode for them and the tripwire below re-checks. */
export function isHarnessContext(): boolean {
  return (
    process.env.AUTOBROKER_HARNESS === "1" ||
    process.env.AUTOBROKER_HARNESS_FIXTURE === "1" ||
    process.env.NODE_ENV === "test"
  );
}

/** Force the internal/safe posture by pinning AUTOBROKER_MODE="test". This is the
 *  one knob: the Gmail backend is a pure projection of the mode, so pinning test
 *  mode resolves every send seam to fake/local. */
export function forceTestMode(): void {
  process.env.AUTOBROKER_MODE = "test";
}

/** Thrown when a harness/test/CI context is observed capable of a real external
 *  send — a fail-closed refusal to risk a real send from a test or CI run. */
export class ModeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeViolationError";
  }
}

/** Fail-CLOSED tripwire. A no-op outside a harness context; INSIDE one it throws
 *  unless the process is in test mode. The Gmail backend projects FROM the mode,
 *  so the not-in-test check is the sole floor here. Wired into boot so EVERY lane
 *  that shares the boot chokepoint is checked, regardless of the global default. */
export function assertTestModeSafe(): void {
  if (!isHarnessContext()) return;
  if (!isTestMode()) {
    throw new ModeViolationError(
      'a harness/test context is not in test mode (AUTOBROKER_MODE is not "test") — ' +
        "refusing to risk a real external send from a test or CI run",
    );
  }
}
