/**
 * sendPreflight — the fail-CLOSED gate the irreversible-send skills (X1/X2/X3)
 * run BEFORE any send during the fake-send phase. Until the irreversible wave is
 * accepted GREEN, a send must be PHYSICALLY incapable of escaping to a real
 * mailbox; this preflight is the structural proof of that.
 *
 * It is a 2-condition AND matrix, fail-CLOSED: every condition must be true to
 * pass, and ANY false throws FakeMailboxPreflightError. There is no soft result
 * and no "warn" path — a failed preflight aborts the send. The two conditions
 * are deliberately redundant (instance identity AND the self-declared backend)
 * so that no single mistake — an injected wrong adapter or a mislabelled backend
 * — can let a real send through. Together they fully guarantee the send can only
 * ever reach the local fake mailbox.
 *
 * This preflight does NOT inspect the L1 env fuse: the offline happy path runs
 * with the fuse DISARMED (a fake send must be able to actually write its row),
 * so requiring the fuse armed here would make a successful fake send impossible.
 * The armed-fuse outer ring is enforced independently at the send boundary by
 * the gate's fuse assertion, not by this per-send preflight.
 */

import { FakeGmailAdapter } from "./fakeAdapter.js";
import type { GmailAdapter } from "./types.js";

/**
 * Thrown when the fake-mailbox-send-only preflight fails. FAIL-CLOSED: the send
 * MUST NOT proceed. `failedCondition` names the first condition that was not
 * satisfied (in matrix order) for audit.
 */
export class FakeMailboxPreflightError extends Error {
  readonly code = "fake_mailbox_preflight_failed" as const;
  readonly failedCondition: "adapter_not_fake_instance" | "backend_not_fake";
  constructor(failedCondition: "adapter_not_fake_instance" | "backend_not_fake") {
    super(
      `fake_mailbox_preflight_failed: ${failedCondition} — a send is only permitted ` +
        `when the active adapter is the local fake and its backend self-declares ` +
        `'fake'. Failing CLOSED; the send is aborted.`,
    );
    this.name = "FakeMailboxPreflightError";
    this.failedCondition = failedCondition;
  }
}

/**
 * The inputs the preflight inspects. Injected as one flat object so a test can
 * flip each condition independently.
 */
export interface FakeMailboxPreflightDeps {
  /** The adapter that would actually perform the send. */
  adapter: GmailAdapter;
}

/**
 * Assert the fake-mailbox-send-only invariant. Passes (returns void) ONLY when
 * both hold:
 *   (a) the active adapter IS a FakeGmailAdapter instance;
 *   (b) the adapter self-declares its backend as "fake" (adapter.kind).
 * ANY false throws FakeMailboxPreflightError. Conditions are checked in matrix
 * order; the first failure is reported. Together (a)+(b) guarantee a send can
 * only ever write to the local fake mailbox.
 */
export function assertFakeMailboxSendOnly(deps: FakeMailboxPreflightDeps): void {
  // (a) instance identity — not just any adapter shaped like the fake.
  if (!(deps.adapter instanceof FakeGmailAdapter)) {
    throw new FakeMailboxPreflightError("adapter_not_fake_instance");
  }
  // (b) the adapter's self-declared backend — the same field the send seam
  //     stamps onto the result, so a mislabelled adapter is caught here too.
  if (deps.adapter.kind !== "fake") {
    throw new FakeMailboxPreflightError("backend_not_fake");
  }
}
