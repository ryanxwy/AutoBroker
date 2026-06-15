/**
 * ConfirmationGateCard — the DESTRUCTIVE typed-YES second-confirm surface for
 * the pipeline_reset skill's ONE confirmation_gate suspend. Renders straight off
 * the suspend spec_inline {kind:"confirmation_gate", destructive:true,
 * confirm_token:"YES", question, consequence_lines[5]}.
 *
 * This is the destructive second-confirm — approval is NEVER hidden (`sensitive`
 * orange frame + a destructive-tone banner, mounted by GateBannerHost ABOVE the
 * prose). The contract:
 *   - the `question` is the heading; the 5 plain-speech consequence_lines render
 *     as an ordered list, each carrying data-testid="reset-consequence-line";
 *   - a typed-YES text input — the Confirm/destructive button stays DISABLED
 *     until the input trims to the literal token (case-insensitive). This is a
 *     CLIENT-SIDE pre-check ONLY — the server re-validates the token verbatim on
 *     resume regardless of what we post;
 *   - Confirm → action "accept" with content {confirm_token:"YES"} (the canonical
 *     token, not the user's raw casing); Cancel → action "decline" (the
 *     never-hidden stop verb, always enabled, terminal = zero destruction).
 *
 * Presentational only — the parsed spec + the decision-submit callbacks arrive as
 * props (GateBannerHost owns the decide() controller and the network).
 */

import { useState } from "react";

/** The literal word the user must type back. The server holds the load-bearing
 *  re-validation; this is the case-insensitive client pre-check + the wire value
 *  we post on accept. */
const CONFIRM_TOKEN = "YES" as const;

/** The parsed confirmation_gate suspend spec_inline this card renders. */
export interface ConfirmationGateSpec {
  question: string;
  /** Exactly 5 plain-speech lines (never names a table). */
  consequenceLines: string[];
}

/**
 * Defensively read a confirmation_gate spec_inline off the wire. Returns null on
 * a malformed payload — the banner host then falls back to its never-hidden
 * pending placeholder (a destructive gate is never silently auto-approved, never
 * mis-rendered). Requires kind === "confirmation_gate", destructive === true, the
 * literal confirm_token, and EXACTLY 5 string consequence lines.
 */
export function readConfirmationGateSpec(spec: Record<string, unknown>): ConfirmationGateSpec | null {
  if (spec["kind"] !== "confirmation_gate") return null;
  if (spec["destructive"] !== true) return null;
  if (spec["confirm_token"] !== CONFIRM_TOKEN) return null;
  const linesRaw = spec["consequence_lines"];
  if (!Array.isArray(linesRaw) || linesRaw.length !== 5) return null;
  if (!linesRaw.every((l): l is string => typeof l === "string")) return null;
  const question = spec["question"];
  if (typeof question !== "string") return null;
  return { question, consequenceLines: linesRaw };
}

/** The typed value matches the token (trimmed, case-insensitive). */
function tokenMatches(typed: string): boolean {
  return typed.trim().toUpperCase() === CONFIRM_TOKEN;
}

export function ConfirmationGateCard({
  spec,
  submitting,
  onConfirm,
  onCancel,
}: {
  spec: ConfirmationGateSpec;
  submitting: boolean;
  /** action "accept" with {confirm_token:"YES"} — the canonical token. */
  onConfirm: () => void;
  /** action "decline" — terminal, zero destruction for the whole run. */
  onCancel: () => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  // CLIENT-SIDE pre-check only — the server re-validates the token verbatim.
  const canConfirm = tokenMatches(typed) && !submitting;

  return (
    <div
      className="gate-card sensitive"
      data-testid="confirmation-gate-card"
      role="alertdialog"
      aria-label="Destructive confirmation required"
    >
      <p className="danger-text" data-testid="reset-banner">
        This permanently erases your local data — read every line, then type {CONFIRM_TOKEN} to confirm.
      </p>
      <strong>{spec.question}</strong>

      <ol className="reset-consequences">
        {spec.consequenceLines.map((line, i) => (
          <li key={i} data-testid="reset-consequence-line">
            {line}
          </li>
        ))}
      </ol>

      <div className="reset-confirm-row">
        <label htmlFor="reset-confirm-token">
          Type <code>{CONFIRM_TOKEN}</code> to confirm
        </label>
        <input
          id="reset-confirm-token"
          data-testid="reset-confirm-token"
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="reset-banner"
          value={typed}
          disabled={submitting}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>

      <div className="gate-actions">
        <button
          type="button"
          className="btn-primary"
          data-testid="reset-confirm"
          aria-label="Confirm — permanently erase all local pipeline data"
          disabled={!canConfirm}
          onClick={onConfirm}
        >
          Erase everything
        </button>
        <button
          type="button"
          className="btn-danger"
          data-testid="reset-cancel"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
