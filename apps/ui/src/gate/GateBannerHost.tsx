/**
 * GateBannerHost — the app-level gate surface: a system layer mounted ABOVE the
 * workbench/rail split, so a banner-tracked gate structurally precedes the main
 * region and every prose zone in document order (the gate-before-prose
 * invariant, held by MOUNT POSITION here, by zone order in the rail).
 *
 * Which gates land here is decided by the single routing point (gateTrack): the
 * run-blocking decisions that span both panes — mutation approvals (`approval`)
 * and the typed-YES destructive confirm (`confirmation_gate`). The per-item
 * batch-review family now renders inline in the chat rail (see gateTrack), so it
 * no longer reaches this host; a rail-tracked kind leaves the banner empty.
 *
 * The actual card dispatch is the shared, surface-agnostic GateCardSwitch — this
 * host only owns the banner mount position + its showBanner routing guard.
 *
 * Presentational: the App (the single useChat host) projects the active run's
 * pending suspend + the decide() controller and passes them down; this
 * component never reads the network itself.
 */

import type { AwaitingUserPayload } from "../chat/messageModel.js";
import type { DecisionController } from "../chat/useDecision.js";
import { GateCardSwitch } from "./GateCardSwitch.js";
import { gateTrack } from "./gateTrack.js";

export function GateBannerHost({
  awaiting,
  decision,
}: {
  /** The active run's pending suspend (null when not suspended). */
  awaiting: AwaitingUserPayload | null;
  /** The decide() controller bound to the active run's pending decision. */
  decision: DecisionController;
}): JSX.Element {
  const rawKind = awaiting?.specInline?.["kind"];
  const kind = typeof rawKind === "string" ? rawKind : null;
  const showBanner = awaiting !== null && gateTrack(kind) === "banner";

  return (
    <section className="gate-banner" data-testid="gate-banner" aria-label="Pending approval">
      {showBanner && awaiting !== null && <GateCardSwitch awaiting={awaiting} decision={decision} />}
    </section>
  );
}
