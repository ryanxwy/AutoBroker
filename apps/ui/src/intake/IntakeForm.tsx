/**
 * IntakeForm — the turn-level wiring that dispatches an awaiting_user suspend to
 * the right surface (FRONTEND_LAYOUT §5.5 / §8.2). It classifies the suspend's
 * spec_inline (gateModel.classifyGate) and renders either the data_collection
 * SchemaForm or one of the three semantic gates. The decision_id is injected from
 * the part and echoed back verbatim on every resume; the runId keys the draft.
 *
 * This is the GATE-zone content of an assistant turn: it renders structurally
 * BEFORE the prose text zone (the AssistantTurn lays the zones in that order).
 *
 * The resume call is the parent's `onDecision(content, action)` — it posts
 * form-decision (same-run Mastra resume, §5.7). One path only (no respawn).
 */

import { classifyGate } from "./gateModel.js";
import { SchemaForm } from "./SchemaForm.js";
import {
  AmbiguousLocationPicker,
  ForceOverrideBar,
  LocationFailureBanner,
  MalformedRetryGate,
} from "../gate/IntakeGates.js";
import { FormBoundary } from "./FormBoundary.js";
import type { AwaitingUserPayload } from "../api/useRunStream.js";

export type DecisionAction = "accept" | "decline" | "cancel";

export interface IntakeFormProps {
  runId: string;
  awaitingUser: AwaitingUserPayload;
  submitting: boolean;
  /** Post a form-decision: accept carries `content`; decline/cancel carries none. */
  onDecision: (action: DecisionAction, content?: Record<string, unknown>) => void;
}

export function IntakeForm({ runId, awaitingUser, submitting, onDecision }: IntakeFormProps): JSX.Element {
  const decisionId = awaitingUser.decisionId ?? "";
  const gate = classifyGate(awaitingUser.specInline);

  const resume = (content: Record<string, unknown>): void => onDecision("accept", content);
  const decline = (): void => onDecision("decline");

  switch (gate.kind) {
    case "data_collection":
      return (
        <FormBoundary spec={awaitingUser.specInline}>
          <SchemaForm
            runId={runId}
            seedFields={gate.seedFields}
            submitting={submitting}
            onSubmit={(content) => onDecision("accept", content)}
            onDecline={decline}
          />
        </FormBoundary>
      );
    case "force_override":
      return (
        <ForceOverrideBar
          gate={gate}
          decisionId={decisionId}
          submitting={submitting}
          onResume={resume}
          onDecline={decline}
        />
      );
    case "ambiguous_location":
      return (
        <AmbiguousLocationPicker
          gate={gate}
          decisionId={decisionId}
          submitting={submitting}
          onResume={resume}
          onDecline={decline}
        />
      );
    case "location_failure":
      return (
        <LocationFailureBanner
          gate={gate}
          decisionId={decisionId}
          submitting={submitting}
          onResume={resume}
          onDecline={decline}
        />
      );
    case "malformed_tool_call":
      return (
        <MalformedRetryGate
          gate={gate}
          decisionId={decisionId}
          submitting={submitting}
          onResume={resume}
          onDecline={decline}
        />
      );
    default:
      // Unknown suspend kind → fail VISIBLE (never silently pass) with the raw
      // spec so the user/operator can see what arrived (§5.9 graceful degrade).
      return (
        <div className="gate-card" data-testid="gate-unknown" role="alert">
          <strong>This step needs your input.</strong>
          <pre className="muted" style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(gate.raw ?? {}, null, 2)}
          </pre>
          <div className="gate-actions">
            <button type="button" className="btn-danger" data-testid="gate-unknown-decline" onClick={decline} disabled={submitting}>
              Cancel
            </button>
          </div>
        </div>
      );
  }
}
