/**
 * GateBannerHost — the app-level gate surface: a system layer mounted ABOVE the
 * workbench/rail split, so a banner-tracked gate structurally precedes the main
 * region and every prose zone in document order (the gate-before-prose
 * invariant, held by MOUNT POSITION here, by zone order in the rail).
 *
 * Which gates land here is decided by the single routing point (gateTrack):
 * run-blocking decisions that span both panes — mutation approvals, per-item
 * batch review, typed-YES destructive confirms. None of those kinds are
 * emitted yet, so the host renders EMPTY today; the placeholder card below is
 * the never-hidden safety floor in case a banner-tracked kind arrives before
 * its decision surface is built (a pending gate must always be visible).
 *
 * Presentational: the App (the single useChat host) projects the active run's
 * pending suspend and passes it down; this component never reads the network.
 */

import type { AwaitingUserPayload } from "../chat/messageModel.js";
import { gateTrack } from "./gateTrack.js";

export function GateBannerHost({
  awaiting,
}: {
  /** The active run's pending suspend (null when not suspended). */
  awaiting: AwaitingUserPayload | null;
}): JSX.Element {
  const rawKind = awaiting?.specInline?.["kind"];
  const kind = typeof rawKind === "string" ? rawKind : null;
  const showBanner = awaiting !== null && gateTrack(kind) === "banner";

  return (
    <section className="gate-banner" data-testid="gate-banner" aria-label="Pending approval">
      {showBanner && (
        <div className="gate-card sensitive" data-testid="gate-banner-pending" role="alertdialog">
          <strong>Approval required</strong>
          <p className="muted">
            This run is paused on a &quot;{kind}&quot; decision. Its decision surface mounts
            here when that gate kind ships — nothing proceeds until you decide.
          </p>
        </div>
      )}
    </section>
  );
}
