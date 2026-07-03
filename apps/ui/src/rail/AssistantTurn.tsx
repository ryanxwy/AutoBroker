/**
 * AssistantTurn — the three-zone assistant turn renderer.
 * THE load-bearing UI invariant lives here: the zones are laid out in a FIXED
 * structural order — GATE zone, THEN text/prose zone, THEN milestones, THEN
 * current-activity, THEN meta. The gate is rendered before the prose by COMPONENT
 * STRUCTURE, never by sorting on timestamps (gate-before-prose). Even
 * if a `text` frame arrived before the `awaiting_user` frame in the stream, the
 * gate still renders above the prose because the zones are fixed JSX positions.
 *
 * The gate zone hosts either the IntakeForm (data_collection or a semantic gate)
 * or the shared GateCardSwitch (the per-item batch-review family —
 * dealer_web_lead_submit's "Submit lead inquiries?" card and its inbox/hygiene
 * shapes), so a batch approval reads inline as part of the conversation.
 *
 * Presentational w.r.t. I/O: it takes the AssistantTurn store shape + an
 * onDecision dispatcher (the parent posts form-decision) + the active run's
 * decide() controller (used only for the live gate). Stable data-testid.
 */

import type { ApiClient } from "../api/client.js";
import { GateCardSwitch } from "../gate/GateCardSwitch.js";
import { gateTrack } from "../gate/gateTrack.js";
import { IntakeForm, type DecisionAction } from "../intake/IntakeForm.js";
import type { BrowserView } from "../chat/browserView.js";
import { profileStopCode, type AssistantTurnView } from "../chat/messageModel.js";
import type { DecisionController } from "../chat/useDecision.js";
import { StopCard } from "./StopCard.js";

/** An inert controller for non-active turns — a stale turn's gate is never live.
 *  The active turn receives the real decide() controller from the rail. */
const INERT_DECISION: DecisionController = { submitting: false, decisionError: null, decide: () => {} };

export interface AssistantTurnProps {
  turn: AssistantTurnView;
  /** True while a decision is in flight (disables the gate actions). */
  submitting: boolean;
  /** Post a form-decision for this turn's run (accept|decline|cancel). */
  onDecision: (action: DecisionAction, content?: Record<string, unknown>) => void;
  /** The decide() controller for the batch-review family card (active turn only;
   *  the rail passes undefined for stale turns → the inert default). */
  decision?: DecisionController | undefined;
  /** The typed client (the STOP picker fetches active profiles live). */
  client: ApiClient;
  /** Start a fresh intake (the 0-active STOP card's CTA). */
  onStartIntake: () => void;
  /** Re-launch this turn's skill pinned to the picked profile (a NEW run). */
  onPickStopProfile: (profileId: string) => void;
  /** Launch the clarify turn's suggested skill (the "Run it explicitly"
   *  affordance for a sensitivity-downgrade clarify; button-only, gates
   *  downstream — identical to a slash/Skills-tray launch). */
  onRunSuggested?: (skill: string) => void;
  /** The LIVE browser activity view for the ACTIVE turn (transient — App
   *  passes null for every other turn and after terminal; never from parts). */
  browser?: BrowserView | null;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Starting…",
  running: "Running",
  awaiting_approval: "Awaiting your input",
  done: "Done",
  error: "Error",
  declined: "Cancelled — nothing was saved",
  aborted: "Stopped",
};

export function AssistantTurn({
  turn,
  submitting,
  onDecision,
  decision = INERT_DECISION,
  client,
  onStartIntake,
  onPickStopProfile,
  onRunSuggested,
  browser = null,
}: AssistantTurnProps): JSX.Element {
  // The rail renders only rail-tracked gate kinds (gateTrack is the single
  // kind→track routing point; banner-tracked kinds render in GateBannerHost).
  const rawGateKind = turn.awaitingUser?.specInline?.["kind"];
  const gateKind = typeof rawGateKind === "string" ? rawGateKind : null;
  const showGate =
    turn.awaitingUser !== null &&
    turn.status === "awaiting_approval" &&
    gateTrack(gateKind) === "rail";
  // Typed profile/precondition STOP (error name + code allowlist) → the card
  // with the answerable affordance (intake CTA / pick-by-vehicle picker /
  // friendly pointer). no_lead_submitted renders as a calm pointer, so it
  // SUPPRESSES the generic red error line (its message lives on the card).
  const stopCode = profileStopCode(turn);
  const friendlyStop = stopCode === "no_lead_submitted";

  return (
    <div
      className="turn assistant"
      data-testid="assistant-turn"
      data-status={turn.status}
      data-run-id={turn.runId ?? undefined}
    >
      {/* ZONE 1 — GATE (structurally first; gate-before-prose). The batch-review
          family renders the shared GateCardSwitch (inventory batch / inbox /
          hygiene cards); every other rail-tracked kind is the IntakeForm. */}
      {showGate && turn.runId !== null && (
        <div className="zone-gate" data-testid="turn-zone-gate">
          {gateKind === "batch_review" ? (
            <GateCardSwitch awaiting={turn.awaitingUser!} decision={decision} />
          ) : (
            <IntakeForm
              runId={turn.runId}
              awaitingUser={turn.awaitingUser!}
              submitting={submitting}
              onDecision={onDecision}
            />
          )}
        </div>
      )}

      {/* ZONE 2 — TEXT / prose (always after the gate zone). */}
      {turn.text !== "" && (
        <div className="zone-text" data-testid="turn-zone-text">
          {turn.text}
        </div>
      )}

      {/* Sensitivity-downgrade clarify: a button-only "Run it explicitly" launch
          of the detected skill. It goes through the normal launch path, so every
          pin/approval gate still renders downstream — nothing is pre-approved. */}
      {turn.suggestedSkill !== null && onRunSuggested !== undefined && (
        <button
          type="button"
          className="btn-secondary"
          data-testid="clarify-run-explicit"
          onClick={() => onRunSuggested(turn.suggestedSkill!)}
        >
          Run it explicitly
        </button>
      )}

      {turn.status === "declined" && (
        <div className="zone-text muted" data-testid="turn-declined">
          {STATUS_LABEL.declined}
        </div>
      )}

      {turn.status === "error" && !friendlyStop && (
        <div className="zone-text danger-text" data-testid="turn-error">
          {turn.error ?? "Something went wrong."}
        </div>
      )}

      {stopCode !== null && (
        <StopCard
          code={stopCode}
          client={client}
          message={turn.error}
          onStartIntake={onStartIntake}
          onPickProfile={onPickStopProfile}
        />
      )}

      {/* ZONE 3 — MILESTONES (completed tools). */}
      {turn.milestones.length > 0 && (
        <details className="zone-milestones" data-testid="turn-zone-milestones">
          <summary>{turn.milestones.length} step(s)</summary>
          <ul>
            {turn.milestones.map((m, i) => (
              <li key={i} className={m.ok ? "milestone-ok" : "milestone-fail"}>
                {m.label || m.toolName}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* ZONE 4 — CURRENT ACTIVITY: the in-flight tool line plus, on the
          active turn, the LIVE browser trail (transient — host + verb per
          moment, error moments visibly distinct, a concurrent-open count for
          the parallel-browser scans, and the latest live screenshot). The
          cold-path install bar renders here too, before any browser opens. */}
      {(turn.currentActivity !== null ||
        (browser !== null && (browser.entries.length > 0 || browser.acquire !== null))) && (
        <div className="zone-activity" data-testid="turn-zone-activity">
          {turn.currentActivity !== null && <div>{turn.currentActivity}</div>}
          {browser !== null && browser.acquire !== null && (
            <div className="browser-acquire" data-testid="turn-browser-acquire">
              <div className="muted">Installing browser… {browser.acquire.message}</div>
              <div
                className="browser-acquire-bar"
                data-testid="turn-browser-acquire-bar"
                data-indeterminate={browser.acquire.progress === null ? "true" : "false"}
              >
                <div
                  className="browser-acquire-bar-fill"
                  style={
                    browser.acquire.progress === null
                      ? undefined
                      : {
                          width: `${Math.round(Math.max(0, Math.min(1, browser.acquire.progress)) * 100)}%`,
                        }
                  }
                />
              </div>
            </div>
          )}
          {browser !== null && browser.entries.length > 0 && (
            <div className="browser-trail" data-testid="turn-browser-trail">
              {browser.openCount > 0 && (
                <div className="muted" data-testid="turn-browser-open-count">
                  {browser.openCount} browser{browser.openCount === 1 ? "" : "s"} active
                </div>
              )}
              <ul className="browser-trail-entries">
                {browser.entries.map((entry, i) => (
                  <li
                    key={i}
                    data-kind={entry.kind}
                    className={entry.kind === "error" ? "danger-text" : undefined}
                  >
                    {entry.label}
                  </li>
                ))}
              </ul>
              {browser.screenshot !== null && (
                <img
                  data-testid="turn-browser-screenshot"
                  alt="Live browser view"
                  src={`data:image/jpeg;base64,${browser.screenshot}`}
                  style={{ width: 220, borderRadius: 4, display: "block", marginTop: 4 }}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* ZONE 5 — META (status + driver + resolution provenance). */}
      <div className="zone-meta" data-testid="turn-zone-meta">
        <span data-testid="turn-status">{STATUS_LABEL[turn.status] ?? turn.status}</span>
        {turn.driverKind !== null && <span> · {turn.driverKind}</span>}
        {turn.resolution !== null && (
          <span data-testid="turn-resolution" data-resolution={turn.resolution}>
            {" "}
            · {turn.resolution === "pinned" ? "pinned profile" : "newest active profile (inferred)"}
          </span>
        )}
      </div>
    </div>
  );
}
