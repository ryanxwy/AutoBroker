/**
 * IntakeGates — the gate-stack projection components for intake's three SEMANTIC
 * suspends. Each takes a typed GateModel variant and a
 * resume dispatcher; the resume content maps to the workflow's exported resume
 * schemas (intakeContracts.ts):
 *
 *   - ForceOverrideBar  → ForceOverrideResumeSchema:
 *       {action:'force_override', reason} | {action:'revise', trim} |
 *       {action:'retry_step'} | {action:'decline'}
 *   - AmbiguousLocationPicker → AmbiguousLocationResumeSchema:
 *       {action:'pick', picked_index} | {action:'retry', retry_query} |
 *       {action:'decline'}
 *   - LocationFailureBanner → AmbiguousLocationResumeSchema:
 *       {action:'retry', retry_query} | {action:'decline'} — the location field
 *       is flagged, the failure reason shown, the user re-fills (retry_query).
 *       (coordinate-resolution invariant: coordinates must be resolved before
 *       persist; geocode failure suspends, never silently passes.)
 *   - MalformedRetry → MalformedRetryResumeSchema:
 *       {action:'retry_step'} | {action:'decline'}
 *
 * These render as the assistant turn's GATE zone — structurally BEFORE the text
 * zone (gate before prose). Every node has a stable data-testid.
 */

import { useState } from "react";

import type { GateModel, LocationCandidate } from "../intake/gateModel.js";

export type ResumeContent = Record<string, unknown>;

export interface GateProps {
  decisionId: string;
  submitting: boolean;
  /** action 'accept' with the typed resume content (mapped to a resume schema). */
  onResume: (content: ResumeContent) => void;
  /** action 'decline' — terminal, zero write. */
  onDecline: () => void;
}

/** force_override: trim invalid but the user insists. reason is REQUIRED (audited). */
export function ForceOverrideBar({
  gate,
  submitting,
  onResume,
  onDecline,
}: GateProps & { gate: Extract<GateModel, { kind: "force_override" }> }): JSX.Element {
  const [reason, setReason] = useState(gate.reason);
  return (
    <div className="gate-card" data-testid="gate-force-override" role="alertdialog" aria-label="Trim override">
      <strong>{gate.question}</strong>
      <p className="muted">
        Trim <code>{gate.trim}</code> isn&apos;t verified against dealer inventory yet — we&apos;ll
        cross-check it against the real in-stock cars once we search dealers. Keep it, revise, or cancel.
      </p>
      <div className="field">
        <label htmlFor="force-override-reason">Reason (recorded for audit)</label>
        <input
          id="force-override-reason"
          type="text"
          data-testid="gate-force-override-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="gate-actions">
        <button
          type="button"
          className="btn-primary"
          data-testid="gate-force-override-confirm"
          disabled={submitting || reason.trim() === ""}
          onClick={() => onResume({ action: "force_override", reason: reason.trim() })}
        >
          Keep this trim anyway
        </button>
        <button
          type="button"
          data-testid="gate-force-override-revise"
          disabled={submitting}
          onClick={() => onResume({ action: "revise", trim: null })}
        >
          Revise trim
        </button>
        <button type="button" className="btn-danger" data-testid="gate-force-override-decline" disabled={submitting} onClick={onDecline}>
          Cancel search
        </button>
      </div>
    </div>
  );
}

/** ambiguous_location: a radio list of candidate addresses; pick → picked_index. */
export function AmbiguousLocationPicker({
  gate,
  submitting,
  onResume,
  onDecline,
}: GateProps & { gate: Extract<GateModel, { kind: "ambiguous_location" }> }): JSX.Element {
  const [picked, setPicked] = useState<number | null>(
    gate.candidates.length > 0 ? gate.candidates[0]!.index : null,
  );
  const [retry, setRetry] = useState(gate.effectiveQuery ?? "");
  return (
    <div className="gate-card" data-testid="gate-ambiguous-location" role="alertdialog" aria-label="Pick a location">
      <strong>Which location did you mean?</strong>
      <div className="candidate-list" role="radiogroup" aria-label="Location candidates">
        {gate.candidates.map((c: LocationCandidate) => (
          <label key={c.index}>
            <input
              type="radio"
              name="location-candidate"
              data-testid={`gate-location-candidate-${c.index}`}
              checked={picked === c.index}
              onChange={() => setPicked(c.index)}
            />
            {c.label}
          </label>
        ))}
      </div>
      <div className="gate-actions">
        <button
          type="button"
          className="btn-primary"
          data-testid="gate-location-pick"
          disabled={submitting || picked === null}
          onClick={() => picked !== null && onResume({ action: "pick", picked_index: picked })}
        >
          Use this location
        </button>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="location-retry">…or correct the search</label>
        <input
          id="location-retry"
          type="text"
          data-testid="gate-location-retry-input"
          value={retry}
          onChange={(e) => setRetry(e.target.value)}
        />
      </div>
      <div className="gate-actions">
        <button
          type="button"
          data-testid="gate-location-retry"
          disabled={submitting || retry.trim() === ""}
          onClick={() => onResume({ action: "retry", retry_query: retry.trim() })}
        >
          Search again
        </button>
        <button type="button" className="btn-danger" data-testid="gate-location-decline" disabled={submitting} onClick={onDecline}>
          Cancel search
        </button>
      </div>
    </div>
  );
}

/** trim_suggestion: a web-grounded radio list of real trims (name + what
 *  distinguishes it); pick → seeds the form trim. "Enter it myself" is a distinct
 *  ACCEPT-style skip (NOT decline — decline cancels the whole search). The list
 *  starts UNSELECTED (product-rule #1: never auto-pick a trim for the buyer). */
export function TrimSuggestionPicker({
  gate,
  submitting,
  onResume,
  onDecline,
}: GateProps & { gate: Extract<GateModel, { kind: "trim_suggestion" }> }): JSX.Element {
  const [picked, setPicked] = useState<number | null>(null);
  const [refine, setRefine] = useState("");
  const vehicle = `${gate.year ?? ""} ${gate.make} ${gate.model}`.trim();
  return (
    <div className="gate-card" data-testid="gate-trim-suggestion" role="alertdialog" aria-label="Pick a trim">
      <strong>Which trim of the {vehicle}?</strong>
      <p className="muted">
        We looked up the {vehicle} trims on the web. Pick the one you want, or enter it yourself.
      </p>
      <div
        className="candidate-list"
        role="radiogroup"
        aria-label="Trim candidates"
        style={{ maxHeight: 260, overflowY: "auto" }}
      >
        {gate.candidates.map((c) => (
          <label key={c.index} style={{ display: "block", marginBottom: 6 }}>
            <input
              type="radio"
              name="trim-candidate"
              data-testid={`gate-trim-option-${c.index}`}
              checked={picked === c.index}
              onChange={() => setPicked(c.index)}
            />
            <strong>{c.name}</strong>
            {c.summary !== "" ? <span className="muted"> — {c.summary}</span> : null}
          </label>
        ))}
      </div>
      <div className="gate-actions">
        <button
          type="button"
          className="btn-primary"
          data-testid="gate-trim-pick"
          disabled={submitting || picked === null}
          onClick={() => picked !== null && onResume({ action: "pick", picked_index: picked })}
        >
          Use this trim
        </button>
        <button
          type="button"
          data-testid="gate-trim-skip"
          disabled={submitting}
          onClick={() => onResume({ action: "skip" })}
        >
          I&apos;ll enter it myself
        </button>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="trim-refine">…or refine the search (e.g. a body style)</label>
        <input
          id="trim-refine"
          type="text"
          data-testid="gate-trim-retry-input"
          value={refine}
          onChange={(e) => setRefine(e.target.value)}
        />
      </div>
      <div className="gate-actions">
        <button
          type="button"
          data-testid="gate-trim-retry"
          disabled={submitting}
          onClick={() => onResume({ action: "retry", refine_query: refine.trim() === "" ? null : refine.trim() })}
        >
          Search again
        </button>
        <button type="button" className="btn-danger" data-testid="gate-trim-decline" disabled={submitting} onClick={onDecline}>
          Cancel search
        </button>
      </div>
    </div>
  );
}

/** location failure (coordinate-resolution invariant): geocode
 *  parse/no-result/exhausted → re-fill. The location field is flagged, the
 *  failure reason is shown, the user retries. */
export function LocationFailureBanner({
  gate,
  submitting,
  onResume,
  onDecline,
}: GateProps & { gate: Extract<GateModel, { kind: "location_failure" }> }): JSX.Element {
  const [retry, setRetry] = useState(gate.effectiveQuery ?? "");
  return (
    <div className="gate-card failure" data-testid="gate-location-failure" role="alertdialog" aria-label="Location not found">
      <strong className="danger-text">We couldn't resolve that location.</strong>
      <p className="field-error" data-testid="gate-location-failure-reason">
        {gate.failureReason}
      </p>
      <div className="field">
        <label htmlFor="location-failure-retry">
          Location<span className="req-mark" aria-hidden="true">*</span>
        </label>
        <input
          id="location-failure-retry"
          type="text"
          data-testid="gate-location-failure-input"
          aria-invalid={true}
          value={retry}
          onChange={(e) => setRetry(e.target.value)}
          placeholder="Irvine, CA 92614"
        />
      </div>
      <div className="gate-actions">
        <button
          type="button"
          className="btn-primary"
          data-testid="gate-location-failure-retry"
          disabled={submitting || retry.trim() === ""}
          onClick={() => onResume({ action: "retry", retry_query: retry.trim() })}
        >
          Try this location
        </button>
        <button type="button" className="btn-danger" data-testid="gate-location-failure-decline" disabled={submitting} onClick={onDecline}>
          Cancel search
        </button>
      </div>
    </div>
  );
}

/** malformed_tool_call: #1244 fail-closed HITL. retry_step | decline. */
export function MalformedRetryGate({
  gate,
  submitting,
  onResume,
  onDecline,
}: GateProps & { gate: Extract<GateModel, { kind: "malformed_tool_call" }> }): JSX.Element {
  return (
    <div className="gate-card sensitive" data-testid="gate-malformed" role="alertdialog" aria-label="Tool call needs retry">
      <strong className="danger-text">The model returned a malformed tool call.</strong>
      <p className="muted">
        Stopped to protect against a silent fallback. Retry the step, or cancel.
      </p>
      {gate.signals.length > 0 && (
        <ul className="muted" data-testid="gate-malformed-signals">
          {gate.signals.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      <div className="gate-actions">
        <button
          type="button"
          className="btn-primary"
          data-testid="gate-malformed-retry"
          disabled={submitting}
          onClick={() => onResume({ action: "retry_step" })}
        >
          Retry
        </button>
        <button type="button" className="btn-danger" data-testid="gate-malformed-decline" disabled={submitting} onClick={onDecline}>
          Cancel
        </button>
      </div>
    </div>
  );
}
