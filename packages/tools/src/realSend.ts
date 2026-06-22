/**
 * AUTOBROKER_REAL_SEND — the single master switch for really sending to the
 * outside world (Gmail `send` + dealer web-form `submit`). REAL-BY-DEFAULT: a
 * normal run really sends, after the per-action human approval the L2 gate still
 * requires. Set `AUTOBROKER_REAL_SEND="0"` to brake every external send back to
 * fake/local — that is the ONLY way to disable real sending.
 *
 * The value is read FRESH on every call (never cached at module scope), mirroring
 * the Gmail backend selector in {@link ./gmail.ts}, so a future settings change
 * could take effect with no restart. (It is not yet a settings-UI descriptor.)
 *
 * Test / harness lanes must NEVER really send. They force the brake to "0" via
 * {@link forceTestLaneInternal}, and {@link assertTestLaneInternal} is a
 * fail-CLOSED tripwire that throws if a test process is ever observed real-send
 * capable — independent of the global default, so flipping the default to real
 * can never make a test or CI run reach a real dealer.
 */

/** The brake is engaged ONLY by the exact string "0"; unset/empty/anything else
 *  is real (real-by-default). */
export function isRealSendEnabled(): boolean {
  return process.env.AUTOBROKER_REAL_SEND !== "0";
}

/** True inside a test/harness lane that must never really send. Keys on the two
 *  EXPLICIT lane sentinels first; NODE_ENV==="test" is only a belt (it is an
 *  overloaded flag, so it must not be the sole discriminator). */
export function isTestLane(): boolean {
  return (
    process.env.AUTOBROKER_HARNESS_FIXTURE === "1" ||
    process.env.AUTOBROKER_E2E_LANE === "1" ||
    process.env.NODE_ENV === "test"
  );
}

/** Force the internal posture for a test lane by engaging the master brake. We
 *  set ONLY AUTOBROKER_REAL_SEND here — the fake Gmail backend is already the
 *  default (an unset AUTOBROKER_GMAIL_BACKEND resolves to "fake"), and the lanes
 *  that need it pin it explicitly, so boot must not synthesize a backend value
 *  (a settings-route integration test asserts boot leaves the var untouched). The
 *  brake is the master floor: with it engaged, the send seams resolve fake. */
export function forceTestLaneInternal(): void {
  process.env.AUTOBROKER_REAL_SEND = "0";
}

/** Thrown when a test/harness lane is observed real-send capable — a fail-closed
 *  refusal to risk a real external send from a test or CI run. */
export class RealSendInTestLaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealSendInTestLaneError";
  }
}

/** Fail-CLOSED tripwire. A no-op outside a test lane; inside one it throws unless
 *  real send is braked. Wired into boot so EVERY lane that shares the boot
 *  chokepoint is checked, regardless of the global default. */
export function assertTestLaneInternal(): void {
  if (!isTestLane()) return;
  if (isRealSendEnabled()) {
    throw new RealSendInTestLaneError(
      'a test/harness lane is real-send capable (AUTOBROKER_REAL_SEND is not "0") — ' +
        "refusing to risk a real external send from a test or CI run",
    );
  }
  if (process.env.AUTOBROKER_GMAIL_BACKEND === "real") {
    throw new RealSendInTestLaneError(
      'a test/harness lane has AUTOBROKER_GMAIL_BACKEND="real" — refusing a real Gmail backend in a test lane',
    );
  }
}
