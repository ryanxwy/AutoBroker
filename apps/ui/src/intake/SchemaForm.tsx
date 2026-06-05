/**
 * SchemaForm — the single schema-driven intake form (FRONTEND_LAYOUT §5.3). Renders
 * ONE <form> with a required "Car & contact" section + a collapsed
 * "Optional / Buyer context" <details>, a completeness meter, and one
 * "Submit intake" button — NOT a per-question wizard (§5). Field set + order +
 * sections + widgets all derive from core's INTAKE_FIELD_META (no codegen). It:
 *
 *   - seeds initial values from the prefill `seedFields` (freeform launch) on
 *     mount, then restores a same-runId localStorage draft over the seed (the
 *     draft is the user's later edit; §5.6) — PII fields come back EMPTY (they
 *     were stripped at persist) and show a "cleared for privacy" hint.
 *   - autosaves a PII-stripped draft (debounced) keyed by the STABLE runId.
 *   - validates per-field for instant feedback; the server's strict() Zod is the
 *     authority on form-decision (§5.4).
 *   - on submit builds the form-decision content and calls onSubmit (the parent
 *     posts form-decision → same-run resume; §5.7). decline maps to action
 *     'decline' (terminal, zero write).
 *
 * Every assertable node has a stable data-testid (M3 ui_checks).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { type IntakeFieldName } from "@autobroker/core";

import { clearDraft, INTAKE_PII_FIELDS, loadDraft, saveDraft } from "../store/drafts.js";
import { ResumeBanner } from "./ResumeBanner.js";
import {
  allRequiredValid,
  buildFormDecisionContent,
  fieldsForSection,
  REQUIRED_FIELD_NAMES,
  SECTION_ORDER,
  validateField,
  type FieldDescriptor,
  type FormValues,
} from "./formModel.js";
import { FieldWidget } from "./widgets.js";

const PII_SET = new Set<string>(INTAKE_PII_FIELDS);
const DEBOUNCE_MS = 120;

export interface SchemaFormProps {
  runId: string;
  /** Prefill seed (freeform extraction; nullable subset). */
  seedFields: Record<string, unknown> | null;
  /** Disabled while the run is resuming (post-submit). */
  submitting: boolean;
  /** action 'accept' with the built content. */
  onSubmit: (content: Record<string, unknown>) => void;
  /** action 'decline' — terminal, zero write. */
  onDecline: () => void;
}

function coerceSeed(seed: Record<string, unknown> | null): FormValues {
  if (seed === null) return {};
  const out: FormValues = {};
  for (const [k, v] of Object.entries(seed)) {
    if (v === undefined) continue;
    out[k as IntakeFieldName] = v;
  }
  return out;
}

export function SchemaForm({
  runId,
  seedFields,
  submitting,
  onSubmit,
  onDecline,
}: SchemaFormProps): JSX.Element {
  // Did a same-runId draft exist at mount? (drives the ResumeBanner + whether PII
  // was cleared). Computed once.
  const restored = useMemo(() => loadDraft(runId), [runId]);
  const [showResume, setShowResume] = useState(restored !== null);

  const [values, setValues] = useState<FormValues>(() => {
    const seeded = coerceSeed(seedFields);
    if (restored !== null) {
      // Draft wins over seed (it is the user's later edit). PII fields are absent
      // from the draft (stripped) → they stay empty; the hint surfaces below.
      return { ...seeded, ...restored.values };
    }
    return seeded;
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());

  // Debounced PII-stripped autosave keyed by the stable runId (§5.6).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveDraft(runId, values as Record<string, unknown>);
    }, DEBOUNCE_MS);
    return () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    };
  }, [runId, values]);

  const setValue = (name: IntakeFieldName, value: unknown): void => {
    setValues((v) => ({ ...v, [name]: value }));
  };
  const markTouched = (name: IntakeFieldName): void => {
    setTouched((t) => (t.has(name) ? t : new Set(t).add(name)));
  };

  const completeCount = REQUIRED_FIELD_NAMES.filter(
    (n) => validateField(n, values[n]) === null,
  ).length;
  const canSubmit = allRequiredValid(values) && !submitting;

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!allRequiredValid(values)) {
      // Mark every required field touched so all errors surface (§5.4).
      setTouched(new Set(REQUIRED_FIELD_NAMES));
      return;
    }
    clearDraft(runId);
    onSubmit(buildFormDecisionContent(values));
  };

  // A PII field shows a "cleared for privacy" hint when we restored a draft AND
  // the field is currently empty (it was stripped, not re-entered yet).
  const piiCleared = (name: IntakeFieldName): boolean =>
    restored !== null &&
    PII_SET.has(name) &&
    (values[name] === null || values[name] === undefined || values[name] === "");

  const renderField = (desc: FieldDescriptor): JSX.Element => {
    const name = desc.name;
    const error = touched.has(name) ? validateField(name, values[name]) : null;
    const errorId = error !== null ? `err-${name}` : undefined;
    const paired = name === "follow_up_phone" || name === "phone_policy";
    return (
      <div className={`field${paired ? " paired" : ""}`} key={name} data-testid={`intake-row-${name}`}>
        <label htmlFor={`intake-field-${name}`}>
          {desc.meta.label}
          {desc.meta.required && (
            <span className="req-mark" data-testid={`required-mark-${name}`} aria-hidden="true">
              *
            </span>
          )}
        </label>
        <FieldWidget
          desc={desc}
          value={values[name]}
          invalid={error !== null}
          describedById={errorId}
          onChange={(v) => setValue(name, v)}
          onBlur={() => markTouched(name)}
        />
        {error !== null && (
          <div className="field-error" id={errorId} data-testid={`field-error-${name}`} role="alert">
            {error}
          </div>
        )}
        {piiCleared(name) && (
          <div className="pii-hint" data-testid={`pii-cleared-${name}`}>
            Cleared for privacy on reload — please re-enter.
          </div>
        )}
      </div>
    );
  };

  return (
    <form className="intake-form" onSubmit={handleSubmit} data-testid="intake-form" noValidate>
      {showResume && restored !== null && (
        <ResumeBanner
          savedAt={restored.savedAt}
          onContinue={() => setShowResume(false)}
          onStartFresh={() => {
            clearDraft(runId);
            setValues(coerceSeed(seedFields));
            setTouched(new Set());
            setShowResume(false);
          }}
        />
      )}

      {SECTION_ORDER.map((section) => {
        const fields = fieldsForSection(section);
        const isRequiredSection = section === "Car & contact";
        if (isRequiredSection) {
          return (
            <fieldset className="form-section" key={section} data-testid="intake-section-required">
              <legend>{section}</legend>
              <div className="form-grid">{fields.map(renderField)}</div>
            </fieldset>
          );
        }
        return (
          <details className="form-section optional" key={section} data-testid="intake-section-optional">
            <summary>{section}</summary>
            <div className="form-grid">{fields.map(renderField)}</div>
          </details>
        );
      })}

      <div className="form-footer">
        <span className="completeness" aria-live="polite" data-testid="intake-completeness">
          {completeCount}/{REQUIRED_FIELD_NAMES.length} required
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="intake-decline"
          onClick={onDecline}
          disabled={submitting}
        >
          Cancel
        </button>
        <button type="submit" className="btn-primary" data-testid="intake-submit" disabled={!canSubmit}>
          {submitting ? "Submitting…" : "Submit intake"}
        </button>
      </div>
    </form>
  );
}
