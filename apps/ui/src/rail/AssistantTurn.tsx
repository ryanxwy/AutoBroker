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
 * or — when a future gated tool lands — an ApprovalPrompt. intake in
 * this slice only produces awaiting_user, so the form/gate is the gate zone.
 *
 * Presentational w.r.t. I/O: it takes the AssistantTurn store shape + an
 * onDecision dispatcher (the parent posts form-decision). Stable data-testid.
 */

import type { ApiClient } from "../api/client.js";
import { gateTrack } from "../gate/gateTrack.js";
import { IntakeForm, type DecisionAction } from "../intake/IntakeForm.js";
import { geosearchStopCode, type AssistantTurnView } from "../chat/messageModel.js";
import { StopCard } from "./StopCard.js";

export interface AssistantTurnProps {
  turn: AssistantTurnView;
  /** True while a decision is in flight (disables the gate actions). */
  submitting: boolean;
  /** Post a form-decision for this turn's run (accept|decline|cancel). */
  onDecision: (action: DecisionAction, content?: Record<string, unknown>) => void;
  /** The typed client (the STOP picker fetches active profiles live). */
  client: ApiClient;
  /** Start a fresh intake (the 0-active STOP card's CTA). */
  onStartIntake: () => void;
  /** Re-launch this turn's skill pinned to the picked profile (a NEW run). */
  onPickStopProfile: (profileId: string) => void;
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
  client,
  onStartIntake,
  onPickStopProfile,
}: AssistantTurnProps): JSX.Element {
  // The rail renders only rail-tracked gate kinds (gateTrack is the single
  // kind→track routing point; banner-tracked kinds render in GateBannerHost).
  const rawGateKind = turn.awaitingUser?.specInline?.["kind"];
  const showGate =
    turn.awaitingUser !== null &&
    turn.status === "awaiting_approval" &&
    gateTrack(typeof rawGateKind === "string" ? rawGateKind : null) === "rail";
  // Typed profile-resolution STOP (error name + code allowlist) → the card with
  // the answerable affordance (intake CTA / pick-by-vehicle picker).
  const stopCode = geosearchStopCode(turn);

  return (
    <div className="turn assistant" data-testid="assistant-turn" data-status={turn.status}>
      {/* ZONE 1 — GATE (structurally first; gate-before-prose). */}
      {showGate && turn.runId !== null && (
        <div className="zone-gate" data-testid="turn-zone-gate">
          <IntakeForm
            runId={turn.runId}
            awaitingUser={turn.awaitingUser!}
            submitting={submitting}
            onDecision={onDecision}
          />
        </div>
      )}

      {/* ZONE 2 — TEXT / prose (always after the gate zone). */}
      {turn.text !== "" && (
        <div className="zone-text" data-testid="turn-zone-text">
          {turn.text}
        </div>
      )}

      {turn.status === "declined" && (
        <div className="zone-text muted" data-testid="turn-declined">
          {STATUS_LABEL.declined}
        </div>
      )}

      {turn.status === "error" && (
        <div className="zone-text danger-text" data-testid="turn-error">
          {turn.error ?? "Something went wrong."}
        </div>
      )}

      {stopCode !== null && (
        <StopCard
          code={stopCode}
          client={client}
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

      {/* ZONE 4 — CURRENT ACTIVITY (single in-flight line). */}
      {turn.currentActivity !== null && (
        <div className="zone-activity" data-testid="turn-zone-activity">
          {turn.currentActivity}
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
