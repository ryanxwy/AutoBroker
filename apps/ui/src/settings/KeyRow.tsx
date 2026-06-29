/**
 * KeyRow — one managed API key, rendered as a ledger-plate card row. It owns its
 * own edit/show/test state; the parent (Settings) owns the presence read and
 * refetches it on a save/clear (passed down as onChanged).
 *
 * NEVER displays a stored secret: a configured key shows the masked `••••`
 * placeholder, the input is empty until the owner types a new value, and a Show
 * toggle only ever reveals what was JUST typed in this session. The value is
 * sent on Save (POST) and on Test (the candidate is probed before it is stored).
 *
 * STATES (driven by `present` + local state):
 *   - required-missing — required key, not configured: the row flags it.
 *   - optional-empty   — optional key, not configured: quiet, no flag.
 *   - saved            — configured: the masked placeholder + Clear.
 *   - editing          — a new value typed (Save enables; Test uses it live).
 *   - testing/pass/fail — the probe verdict, reusing the session-pill / failure
 *     gate tokens (a fail is role=alert with the readable detail).
 *
 * A11y: a labelled <section>; <label htmlFor> + a password input that flips to
 * text under aria-pressed on the Show toggle; the test result is role=status
 * while testing → role=alert on a fail; requiredness is in the label text.
 */

import { useState } from "react";

import type { ApiClient } from "../api/client.js";
import type { KeyDef } from "./keyDefs.js";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "pass"; detail: string }
  | { kind: "fail"; detail: string };

export interface KeyRowProps {
  client: ApiClient;
  def: KeyDef;
  /** Whether this key is currently configured (from the parent's presence read). */
  present: boolean;
  /** Refetch presence after a save/clear lands (the parent re-reads the gate). */
  onChanged: () => void;
}

export function KeyRow({ client, def, present, onChanged }: KeyRowProps): JSX.Element {
  const { id, label, description, required, testKind } = def;
  // Presence-only keys (e.g. the Claude OAuth token) have no probe: the backend
  // skips it, so the row hides the Test button and never calls testKey.
  const canTest = testKind !== "none";
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saved, setSaved] = useState(false);
  const [busyError, setBusyError] = useState<string | null>(null);

  const hasCandidate = value.length > 0;
  const inputId = `key-input-${id}`;

  const onTest = (): void => {
    if (!hasCandidate) return;
    setTest({ kind: "testing" });
    setBusyError(null);
    client
      .testKey(id, value)
      .then((r) =>
        setTest(r.ok ? { kind: "pass", detail: r.detail } : { kind: "fail", detail: r.detail }),
      )
      .catch((err: unknown) => {
        setTest({ kind: "fail", detail: err instanceof Error ? err.message : "test failed" });
      });
  };

  const onSave = (): void => {
    if (!hasCandidate) return;
    setBusyError(null);
    client
      .saveKey(id, value)
      .then(() => {
        setValue("");
        setShow(false);
        setTest({ kind: "idle" });
        setSaved(true);
        onChanged();
        // The badge is a brief confirmation; clear it so it does not linger.
        setTimeout(() => setSaved(false), 2500);
      })
      .catch((err: unknown) => {
        setBusyError(err instanceof Error ? err.message : "could not save the key");
      });
  };

  const onClear = (): void => {
    setBusyError(null);
    client
      .clearKey(id)
      .then(() => {
        setValue("");
        setShow(false);
        setTest({ kind: "idle" });
        onChanged();
      })
      .catch((err: unknown) => {
        setBusyError(err instanceof Error ? err.message : "could not clear the key");
      });
  };

  const requiredMissing = required && !present && !hasCandidate;

  return (
    <section
      className="card key-row"
      data-testid={`key-row-${id}`}
      data-present={present}
      aria-labelledby={`key-label-${id}`}
    >
      <label id={`key-label-${id}`} htmlFor={inputId} className="key-row-label">
        {label}
        {required && (
          <span className="req-mark" data-testid={`key-required-mark-${id}`} aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="visually-hidden"> (required)</span>}
      </label>
      <p className="muted key-row-desc">{description}</p>

      <div className="key-row-controls">
        <input
          id={inputId}
          data-testid={`key-input-${id}`}
          type={show ? "text" : "password"}
          className="key-row-input"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={present ? "•••• stored" : required ? "required" : "optional"}
          onChange={(e) => {
            setValue(e.target.value);
            if (test.kind !== "idle") setTest({ kind: "idle" });
          }}
        />
        <button
          type="button"
          data-testid={`key-toggle-${id}`}
          aria-pressed={show}
          onClick={() => setShow((s) => !s)}
        >
          {show ? "Hide" : "Show"}
        </button>
        {canTest && (
          <button
            type="button"
            data-testid={`key-test-${id}`}
            disabled={!hasCandidate || test.kind === "testing"}
            onClick={onTest}
          >
            Test connection
          </button>
        )}
        <button
          type="button"
          className="btn-primary"
          data-testid={`key-save-${id}`}
          disabled={!hasCandidate}
          onClick={onSave}
        >
          Save
        </button>
        {present && (
          <button
            type="button"
            className="btn-danger"
            data-testid={`key-clear-${id}`}
            onClick={onClear}
          >
            Clear
          </button>
        )}
        {saved && (
          <span className="saved-badge" data-testid={`key-saved-${id}`}>
            Saved
          </span>
        )}
      </div>

      {test.kind !== "idle" && (
        <div
          className={`key-test-result${test.kind === "fail" ? " gate-card failure" : ""}`}
          data-testid={`key-test-result-${id}`}
          data-state={test.kind}
          role={test.kind === "fail" ? "alert" : "status"}
        >
          {test.kind === "testing" && <span className="session-pill" data-status="running">Testing…</span>}
          {test.kind === "pass" && (
            <span className="session-pill" data-status="done">
              Connected — {test.detail}
            </span>
          )}
          {test.kind === "fail" && <span className="danger-text">Failed — {test.detail}</span>}
        </div>
      )}

      {requiredMissing && (
        <p className="muted key-row-missing" data-testid={`key-missing-${id}`}>
          {id === "google_places"
            ? "Add this key to enable dealer search."
            : "Add this key to start using AutoBroker."}
        </p>
      )}

      {busyError !== null && (
        <p className="danger-text" role="alert" data-testid={`key-error-${id}`}>
          {busyError}
        </p>
      )}
    </section>
  );
}
