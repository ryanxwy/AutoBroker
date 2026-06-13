/**
 * ProfileEditPanel — in-dashboard PREFERENCE EDITING for the active search.
 * Self-contained: it owns the edit-mode form, per-field value state, client
 * validation, the PATCH call, and every state (saving / saved / client-error /
 * server-400 / 409-identity-locked). The host (ProfileCard) toggles it on and
 * passes the active profile id + an onSaved() callback; on entering edit mode
 * the panel fetches the FULL profile row (client.getProfile) — the budget +
 * email/phone + JSON arrays the budget-stripped Canvas snapshot deliberately
 * omits.
 *
 * BUDGET RED-LINE: budget surfaces ONLY as the in-edit "Budget (internal-only)"
 * number input — never echoed into any chip, summary, or read view. It rides
 * the PATCH as budgetMax when the user changes it; otherwise it is left as-is.
 *
 * FROZEN IDENTITY: make/model/year/trim are NEVER inputs here. They render as
 * locked, aria-disabled chips with a 🔒 micro-label — to change the vehicle the
 * user must replace (delete + recreate) the search. The panel never sends an
 * identity field, so the 409 guard below should be unreachable; it is kept as a
 * defensive strip in case a future caller path sends one.
 *
 * The four color/trim/feature columns are JSON-encoded STRINGS in the DB: the
 * editor reads them with JSON.parse (tolerant of null/garbage → []) and writes
 * a JSON.stringify(string[]) on save.
 */

import { useEffect, useId, useRef, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import { invalidate } from "../api/useDataChanged.js";
import type { PatchProfileBody, ProfileRow } from "../api/wire.js";

// ---------------------------------------------------------------------------
// JSON-string <-> string[] (de)serialization for the four array columns.
// ---------------------------------------------------------------------------

/** Parse a JSON-encoded string column into a string[] (tolerant: null / a
 *  non-array / malformed JSON all collapse to []). */
function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** Serialize a string[] back to the JSON-string the column stores. */
function toJsonArray(values: string[]): string {
  return JSON.stringify(values);
}

// ---------------------------------------------------------------------------
// MultiValueChipEditor — chips + an add input, reused 4× (colors/trims/features).
// ---------------------------------------------------------------------------

interface MultiValueChipEditorProps {
  /** Stable testid root, e.g. "profile-edit-colors-exterior". */
  testidRoot: string;
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}

function MultiValueChipEditor({
  testidRoot,
  label,
  values,
  onChange,
  disabled,
}: MultiValueChipEditorProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const inputId = useId();

  const add = (): void => {
    const v = draft.trim();
    if (v === "" || values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  };

  const remove = (value: string): void => {
    onChange(values.filter((v) => v !== value));
  };

  return (
    <div className="field" data-testid={testidRoot}>
      <label htmlFor={inputId}>{label}</label>
      <div className="chip-row">
        {values.map((v) => (
          <span className="mini-chip" key={v}>
            {v}
            <button
              type="button"
              aria-label={`remove ${v}`}
              data-testid={`${testidRoot}-remove-${v}`}
              className="chip-remove"
              disabled={disabled}
              onClick={() => remove(v)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="chip-add">
        <input
          type="text"
          id={inputId}
          data-testid={`${testidRoot}-input`}
          value={draft}
          placeholder="Add…"
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          data-testid={`${testidRoot}-add`}
          disabled={disabled || draft.trim() === ""}
          onClick={add}
        >
          +
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProfileEditPanel — the edit-mode form.
// ---------------------------------------------------------------------------

/** The financing-preference options, mirroring intake's segmented enum. The
 *  empty value clears the field (financing is optional). */
const FINANCING_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "finance", label: "Finance" },
  { value: "lease", label: "Lease" },
  { value: "cash", label: "Cash" },
];

/** The in-edit form value bag — only the editable preference fields. */
interface EditValues {
  budgetMax: string; // raw input string; "" → null on save
  searchRadiusMiles: string; // raw input string
  followUpEmail: string;
  followUpPhone: string;
  financingPreference: string | null;
  tradeInDescription: string;
  exteriorColors: string[];
  interiorColors: string[];
  trims: string[];
  features: string[];
}

function strField(row: ProfileRow, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function valuesFromRow(row: ProfileRow): EditValues {
  return {
    budgetMax: strField(row, "budget_max"),
    searchRadiusMiles: strField(row, "search_radius_miles"),
    followUpEmail: strField(row, "follow_up_email"),
    followUpPhone: strField(row, "follow_up_phone"),
    financingPreference:
      typeof row["financing_preference"] === "string" && row["financing_preference"] !== ""
        ? (row["financing_preference"] as string)
        : null,
    tradeInDescription: strField(row, "trade_in_description"),
    exteriorColors: parseJsonArray(row["preferred_exterior_colors_json"]),
    interiorColors: parseJsonArray(row["preferred_interior_colors_json"]),
    trims: parseJsonArray(row["acceptable_trims_json"]),
    features: parseJsonArray(row["feature_preferences_json"]),
  };
}

/** Per-field client validation. Returns a message or null. Only the two
 *  numeric fields carry a real constraint (radius 1–500, mirroring the server
 *  bound; budget non-negative). Empty is always valid (clears the column). */
function validate(values: EditValues): { radius: string | null; budget: string | null } {
  let radius: string | null = null;
  const r = values.searchRadiusMiles.trim();
  if (r !== "") {
    const n = Number(r);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      radius = "Radius must be a whole number from 1 to 500 miles.";
    }
  }
  let budget: string | null = null;
  const b = values.budgetMax.trim();
  if (b !== "") {
    const n = Number(b);
    if (!Number.isFinite(n) || n < 0) {
      budget = "Budget must be a non-negative number.";
    }
  }
  return { radius, budget };
}

/** Build the PATCH body from the edit values. Empty numeric/text inputs send
 *  null (clear the column); the four arrays are JSON-serialized. Identity is
 *  NEVER included. */
function buildPatch(values: EditValues): PatchProfileBody {
  const numOrNull = (raw: string): number | null => {
    const t = raw.trim();
    return t === "" ? null : Number(t);
  };
  const strOrNull = (raw: string): string | null => {
    const t = raw.trim();
    return t === "" ? null : t;
  };
  return {
    budgetMax: numOrNull(values.budgetMax),
    searchRadiusMiles: numOrNull(values.searchRadiusMiles),
    followUpEmail: strOrNull(values.followUpEmail),
    followUpPhone: strOrNull(values.followUpPhone),
    financingPreference: values.financingPreference,
    tradeInDescription: strOrNull(values.tradeInDescription),
    preferredExteriorColorsJson: toJsonArray(values.exteriorColors),
    preferredInteriorColorsJson: toJsonArray(values.interiorColors),
    acceptableTrimsJson: toJsonArray(values.trims),
    featurePreferencesJson: toJsonArray(values.features),
  };
}

/** Map a server 400 content_invalid JSON-pointer field (e.g.
 *  "/searchRadiusMiles") back to the panel's field key, so the inline
 *  field-error renders on the right control. */
function fieldKeyFromPointer(pointer: string | undefined): "radius" | "budget" | null {
  if (pointer === undefined) return null;
  if (pointer.includes("searchRadiusMiles")) return "radius";
  if (pointer.includes("budgetMax")) return "budget";
  return null;
}

export interface ProfileEditPanelProps {
  client: ApiClient;
  /** The active profile id (the panel fetches its full row on mount). */
  profileId: string;
  /** Called on a successful save (the host exits edit mode + focuses the open
   *  button). Also receives focus-return responsibility. */
  onSaved: () => void;
  /** Called when the user cancels (no write). */
  onCancel: () => void;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "server_error"; message: string; field: "radius" | "budget" | null }
  | { kind: "identity_locked"; lockedFields: string[] };

export function ProfileEditPanel({
  client,
  profileId,
  onSaved,
  onCancel,
}: ProfileEditPanelProps): JSX.Element {
  const [row, setRow] = useState<ProfileRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<EditValues | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const firstFieldRef = useRef<HTMLInputElement>(null);
  // Two error-region ids (radius/budget carry inline validation) + one neutral
  // base the plain text fields suffix for their input ids.
  const errIds = {
    radius: useId(),
    budget: useId(),
  };
  const fieldIds = useId();

  // Fetch the FULL row on entering edit mode (budget + email/phone + arrays).
  useEffect(() => {
    let live = true;
    client
      .getProfile(profileId)
      .then((r) => {
        if (!live) return;
        setRow(r);
        setValues(valuesFromRow(r));
      })
      .catch((e: unknown) => {
        if (!live) return;
        setLoadError(e instanceof Error ? e.message : "could not load the profile");
      });
    return () => {
      live = false;
    };
  }, [client, profileId]);

  // Focus the first field once the form is populated.
  useEffect(() => {
    if (values !== null) firstFieldRef.current?.focus();
  }, [values]);

  // On a 200 the read views refresh IMMEDIATELY (invalidate fires at save time,
  // below). The shared profile fetch is stale-while-revalidate, so the refetch
  // keeps the active profile on screen — this panel is NOT unmounted out from
  // under itself, the chips just refresh in place. The brief green "Saved" badge
  // then fades on its own ~2s timer (a pure confirmation, decoupled from the
  // refresh); at that mark the host exits edit mode and the read view returns.
  useEffect(() => {
    if (saveState.kind !== "saved") return;
    const t = setTimeout(() => {
      onSaved();
    }, 2000);
    return () => clearTimeout(t);
  }, [saveState, onSaved]);

  if (loadError !== null) {
    return (
      <div className="profile-edit-panel" data-testid="profile-edit-panel">
        <p className="danger-text" role="alert" data-testid="profile-edit-error">
          Couldn’t load preferences: {loadError}
        </p>
        <button type="button" data-testid="profile-edit-cancel" onClick={onCancel}>
          Back
        </button>
      </div>
    );
  }

  if (values === null || row === null) {
    return (
      <div className="profile-edit-panel" data-testid="profile-edit-panel">
        <p className="muted">Loading preferences…</p>
      </div>
    );
  }

  const errors = validate(values);
  const clientInvalid = errors.radius !== null || errors.budget !== null;
  const saving = saveState.kind === "saving";

  const set = <K extends keyof EditValues>(key: K, value: EditValues[K]): void => {
    setValues((v) => (v === null ? v : { ...v, [key]: value }));
    // Any edit clears a stale server/identity error so the user can retry.
    if (saveState.kind === "server_error" || saveState.kind === "identity_locked") {
      setSaveState({ kind: "idle" });
    }
  };

  const handleSave = async (): Promise<void> => {
    if (clientInvalid || saving) return;
    setSaveState({ kind: "saving" });
    try {
      await client.patchProfile(profileId, buildPatch(values));
      // The write landed — refresh the read views NOW (stale-while-revalidate
      // keeps the profile mounted, so the chips update promptly without
      // unmounting this panel) and flip to the success badge, which fades on its
      // own timer.
      invalidate(["profiles"]);
      setSaveState({ kind: "saved" });
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409 && e.code === "identity_locked") {
        const locked = e.envelope?.["locked_fields"];
        setSaveState({
          kind: "identity_locked",
          lockedFields: Array.isArray(locked) ? locked.map(String) : [],
        });
        return;
      }
      if (e instanceof ApiError && e.status === 400) {
        setSaveState({
          kind: "server_error",
          message: e.message,
          field: fieldKeyFromPointer(e.field),
        });
        return;
      }
      setSaveState({
        kind: "server_error",
        message: e instanceof Error ? e.message : "save failed",
        field: null,
      });
    }
  };

  // A server 400 mapped to a specific field shows the inline error on it; a
  // client validation error always wins (the Save is disabled, never sent).
  const serverErr = saveState.kind === "server_error" ? saveState : null;
  const radiusError =
    errors.radius ?? (serverErr?.field === "radius" ? serverErr.message : null);
  const budgetError =
    errors.budget ?? (serverErr?.field === "budget" ? serverErr.message : null);

  // The generic (non-field) server error message — shown when a 400 had no
  // field pointer we recognize, or a non-400 failure.
  const genericError = serverErr !== null && serverErr.field === null ? serverErr.message : null;

  return (
    <div className="profile-edit-panel" data-testid="profile-edit-panel">
      {saveState.kind === "identity_locked" && (
        <div
          className="gate-card failure"
          role="alert"
          data-testid="profile-edit-identity-locked"
        >
          <strong>Vehicle identity is frozen</strong>
          <p className="muted">
            {saveState.lockedFields.length > 0
              ? `These fields can’t be edited: ${saveState.lockedFields.join(", ")}. `
              : ""}
            To change the vehicle, replace the search (delete + recreate).
          </p>
        </div>
      )}

      <div className="form-grid">
        <div className="field">
          <label htmlFor={errIds.radius + "-radius"}>Search radius (miles)</label>
          <input
            ref={firstFieldRef}
            type="number"
            id={errIds.radius + "-radius"}
            data-testid="profile-edit-field-radius"
            value={values.searchRadiusMiles}
            disabled={saving}
            aria-invalid={radiusError !== null}
            aria-describedby={radiusError !== null ? errIds.radius : undefined}
            onChange={(e) => set("searchRadiusMiles", e.target.value)}
          />
          {radiusError !== null && (
            <div
              className="field-error"
              id={errIds.radius}
              data-testid="field-error-radius"
              role="alert"
            >
              {radiusError}
            </div>
          )}
        </div>

        <div className="field" data-testid="profile-edit-field-financing">
          <label>Financing preference</label>
          <div className="radiogroup" role="radiogroup" aria-label="Financing preference">
            <label>
              <input
                type="radio"
                name="financing"
                checked={values.financingPreference === null}
                disabled={saving}
                onChange={() => set("financingPreference", null)}
              />
              Any
            </label>
            {FINANCING_OPTIONS.map((o) => (
              <label key={o.value}>
                <input
                  type="radio"
                  name="financing"
                  checked={values.financingPreference === o.value}
                  disabled={saving}
                  onChange={() => set("financingPreference", o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>
        </div>

        {/* Budget — the ONLY surface budget renders on, and it never leaves
            this edit form (no chip/summary echo). */}
        <div className="field">
          <label htmlFor={errIds.budget + "-budget"}>
            Budget (internal-only)
            <span className="pii-hint" style={{ display: "inline", marginLeft: 6 }}>
              never shared with dealers
            </span>
          </label>
          <input
            type="number"
            id={errIds.budget + "-budget"}
            data-testid="profile-edit-field-budget"
            value={values.budgetMax}
            disabled={saving}
            aria-invalid={budgetError !== null}
            aria-describedby={budgetError !== null ? errIds.budget : undefined}
            onChange={(e) => set("budgetMax", e.target.value)}
          />
          {budgetError !== null && (
            <div
              className="field-error"
              id={errIds.budget}
              data-testid="field-error-budget"
              role="alert"
            >
              {budgetError}
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor={fieldIds + "-email"}>Follow-up email</label>
          <input
            type="email"
            id={fieldIds + "-email"}
            data-testid="profile-edit-field-follow-up-email"
            value={values.followUpEmail}
            disabled={saving}
            onChange={(e) => set("followUpEmail", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor={fieldIds + "-phone"}>Follow-up phone</label>
          <input
            type="tel"
            id={fieldIds + "-phone"}
            data-testid="profile-edit-field-follow-up-phone"
            value={values.followUpPhone}
            disabled={saving}
            onChange={(e) => set("followUpPhone", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor={fieldIds + "-tradein"}>Trade-in</label>
          <input
            type="text"
            id={fieldIds + "-tradein"}
            data-testid="profile-edit-field-trade-in"
            value={values.tradeInDescription}
            placeholder="e.g. 2018 Civic, 60k miles"
            disabled={saving}
            onChange={(e) => set("tradeInDescription", e.target.value)}
          />
        </div>

        <MultiValueChipEditor
          testidRoot="profile-edit-colors-exterior"
          label="Exterior colors"
          values={values.exteriorColors}
          disabled={saving}
          onChange={(next) => set("exteriorColors", next)}
        />
        <MultiValueChipEditor
          testidRoot="profile-edit-colors-interior"
          label="Interior colors"
          values={values.interiorColors}
          disabled={saving}
          onChange={(next) => set("interiorColors", next)}
        />
        <MultiValueChipEditor
          testidRoot="profile-edit-trims"
          label="Acceptable trims"
          values={values.trims}
          disabled={saving}
          onChange={(next) => set("trims", next)}
        />
        <MultiValueChipEditor
          testidRoot="profile-edit-features"
          label="Must-have features"
          values={values.features}
          disabled={saving}
          onChange={(next) => set("features", next)}
        />
      </div>

      {genericError !== null && (
        <p className="danger-text" role="alert" data-testid="profile-edit-error">
          Couldn’t save: {genericError}
        </p>
      )}

      <div className="form-footer">
        {saveState.kind === "saved" && (
          <span className="saved-badge" role="status" aria-live="polite" data-testid="profile-edit-saved">
            Saved
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" data-testid="profile-edit-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          data-testid="profile-edit-save"
          aria-busy={saving}
          disabled={clientInvalid || saving}
          onClick={() => void handleSave()}
        >
          {saving ? <span data-testid="profile-edit-saving">Saving…</span> : "Save"}
        </button>
      </div>
    </div>
  );
}
