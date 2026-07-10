/**
 * EnvRow — one curated environment variable, rendered as a ledger-plate card row
 * matching the API-key rows above it. The control shape is chosen entirely from
 * the server descriptor's `classification` (the panel never hardcodes which row
 * is which) — editable-enum → <select>, editable-bool → toggle, read-only-status
 * → a status pill (NEVER a control), read-only-path → a mono <code>.
 *
 * Each row shows the env-var keyword itself in monospace with an InfoHint beside
 * it (hover/focus tooltip), the human label, and a one-line description from the
 * descriptor tooltip.
 *
 * GATE-BEFORE-CONTROL (enum → "buyer"): switching the mode select to the
 * sensitive value does NOT commit until the inline confirmation is accepted.
 *
 * BOOL ENCODING: values cross the wire as STRING "1"/"0". Polarity is
 * presentational per row: Show browser is checked at "0" (not headless), while
 * Auto-run my searches is checked at "1".
 *
 * Dependency wall: app/ui layer. react + the wire type + the presentational
 * extras only.
 */

import { useEffect, useState } from "react";

import type { EnvVarState } from "../api/wire.js";
import {
  APP_MODE_CONFIRM,
  APP_MODE_CONFIRM_VALUE,
  APP_MODE_OPTION_LABELS,
  ENV_BOOL_PRESENTATIONS,
} from "./envDefs.js";
import { InfoHint } from "./InfoHint.js";

export interface EnvRowProps {
  /** The curated row + its current effective value (straight off getEnvConfig). */
  state: EnvVarState;
  /** Set this editable var (enum value or the bool "1"/"0"). Absent semantics:
   *  read-only rows never call it. A rejected write surfaces via `busyError`. */
  onSet: (id: string, value: string) => void;
  /** A write error to surface under the row. */
  busyError?: string | null;
  /** A brief "Saved" confirmation badge after a successful write. */
  saved?: boolean;
}

export function EnvRow({ state, onSet, busyError, saved }: EnvRowProps): JSX.Element {
  const { id, envVar, classification, allowedValues, label, tooltip, value } = state;
  // The keyword shown in mono — db_path has no backing env var, so fall back to
  // the descriptor label spelled as a keyword would not help; show "(active_db)".
  const keyword = envVar.length > 0 ? envVar : "(active_db)";

  return (
    <section
      className="card key-row env-row"
      data-testid={`env-row-${id}`}
      aria-labelledby={`env-label-${id}`}
    >
      <span id={`env-label-${id}`} className="key-row-label">
        {label}
      </span>
      <div className="env-keyword">
        <code data-testid={`env-keyword-${id}`}>{keyword}</code>
        <InfoHint text={tooltip} label={`What does ${label} do?`} idSuffix={id} />
      </div>

      <div className="key-row-controls">
        {classification === "editable-enum" && (
          <EnumControl id={id} value={value} allowedValues={allowedValues ?? []} onSet={onSet} />
        )}
        {classification === "editable-bool" && (
          <BoolControl id={id} value={value} onSet={onSet} />
        )}
        {classification === "editable-text" && (
          <TextControl id={id} value={value} onSet={onSet} />
        )}
        {classification === "editable-numeric" && (
          <NumericControl
            id={id}
            value={value}
            numericMin={state.numericMin}
            numericMax={state.numericMax}
            onSet={onSet}
          />
        )}
        {classification === "read-only-status" && <StatusBadge id={id} value={value} />}
        {classification === "read-only-path" && (
          <code className="env-path" data-testid={`env-path-${id}`}>
            {value}
          </code>
        )}
        {saved === true && (
          <span className="saved-badge" data-testid={`env-saved-${id}`}>
            Saved
          </span>
        )}
      </div>

      {busyError !== null && busyError !== undefined && (
        <p className="danger-text" role="alert" data-testid={`env-error-${id}`}>
          {busyError}
        </p>
      )}
    </section>
  );
}

/** The mode enum: native select plus gate-before-control for buyer mode. */
function EnumControl({
  id,
  value,
  allowedValues,
  onSet,
}: {
  id: string;
  value: string;
  allowedValues: readonly string[];
  onSet: (id: string, value: string) => void;
}): JSX.Element {
  const [pending, setPending] = useState<string | null>(null);

  const onSelect = (next: string): void => {
    if (next === value) return;
    if (next === APP_MODE_CONFIRM_VALUE) {
      // Sensitive direction → confirm before committing (no call yet).
      setPending(next);
      return;
    }
    // Safe direction → commit immediately.
    onSet(id, next);
  };

  return (
    <>
      <select
        className="env-select"
        data-testid={`env-select-${id}`}
        // While a confirm is pending the select reflects the would-be value so
        // the dropdown reads "My real Gmail"; cancelling snaps it back.
        value={pending ?? value}
        onChange={(e) => onSelect(e.target.value)}
      >
        {allowedValues.map((opt) => (
          <option key={opt} value={opt}>
            {APP_MODE_OPTION_LABELS[opt] ?? opt}
          </option>
        ))}
      </select>

      {pending !== null && (
        <div
          className="gate-card sensitive env-confirm"
          role="alertdialog"
          aria-labelledby={`env-confirm-title-${id}`}
          data-testid={`env-confirm-${id}`}
        >
          <strong id={`env-confirm-title-${id}`}>{APP_MODE_CONFIRM.title}</strong>
          <p className="muted">{APP_MODE_CONFIRM.body}</p>
          <div className="gate-actions">
            <button
              type="button"
              className="btn-primary"
              data-testid={`env-confirm-yes-${id}`}
              onClick={() => {
                const next = pending;
                setPending(null);
                onSet(id, next);
              }}
            >
              {APP_MODE_CONFIRM.confirmLabel}
            </button>
            <button
              type="button"
              data-testid={`env-confirm-no-${id}`}
              onClick={() => setPending(null)}
            >
              {APP_MODE_CONFIRM.cancelLabel}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** A bool toggle whose checked polarity and labels come from presentational
 * metadata keyed by the server-owned descriptor id. */
function BoolControl({
  id,
  value,
  onSet,
}: {
  id: string;
  value: string;
  onSet: (id: string, value: string) => void;
}): JSX.Element {
  const presentation = ENV_BOOL_PRESENTATIONS[id] ?? {
    checkedValue: "1" as const,
    checkedLabel: "On",
    uncheckedLabel: "Off",
  };
  const checked = value === presentation.checkedValue;
  const uncheckedValue = presentation.checkedValue === "1" ? "0" : "1";
  return (
    <label className="env-toggle" data-testid={`env-toggle-${id}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onSet(id, e.target.checked ? presentation.checkedValue : uncheckedValue)}
      />
      <span>{checked ? presentation.checkedLabel : presentation.uncheckedLabel}</span>
    </label>
  );
}

/** A free-text editable var (the Gmail account). A small form: typing parks a
 *  local draft and Save commits it (typing never fires a write). The draft resets
 *  to the committed value after a successful save / external refetch. An empty or
 *  unchanged draft disables Save; the server re-validates the address shape. */
function TextControl({
  id,
  value,
  onSet,
}: {
  id: string;
  value: string;
  onSet: (id: string, value: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  // Reflect the committed value when it changes (after a save lands / a refetch).
  useEffect(() => setDraft(value), [value]);

  const trimmed = draft.trim();
  const dirty = trimmed.length > 0 && trimmed !== value;

  return (
    <form
      className="env-text"
      data-testid={`env-text-${id}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) onSet(id, trimmed);
      }}
    >
      <input
        type="email"
        className="env-input"
        data-testid={`env-input-${id}`}
        value={draft}
        placeholder="you@example.com"
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="submit"
        className="btn-primary"
        data-testid={`env-save-${id}`}
        disabled={!dirty}
      >
        Save
      </button>
    </form>
  );
}

/** A numeric editable var. Types a draft and Save commits it. Resets to the
 *  committed value after a successful save / external refetch. An unchanged
 *  draft disables Save; the server re-validates the range. */
function NumericControl({
  id,
  value,
  numericMin,
  numericMax,
  onSet,
}: {
  id: string;
  value: string;
  numericMin: number | null;
  numericMax: number | null;
  onSet: (id: string, value: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const trimmed = draft.trim();
  const dirty = trimmed.length > 0 && trimmed !== value;

  return (
    <form
      className="env-text"
      data-testid={`env-numeric-${id}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) onSet(id, trimmed);
      }}
    >
      <input
        type="number"
        className="env-input"
        data-testid={`env-input-${id}`}
        value={draft}
        min={numericMin ?? undefined}
        max={numericMax ?? undefined}
        step={1}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="submit"
        className="btn-primary"
        data-testid={`env-save-${id}`}
        disabled={!dirty}
      >
        Save
      </button>
    </form>
  );
}

/** A read-only status pill — NEVER a control. Demo reads "on"/"off". */
function StatusBadge({ id, value }: { id: string; value: string }): JSX.Element {
  return (
    <span className="session-pill" data-testid={`env-badge-${id}`}>
      {value}
    </span>
  );
}
