// @vitest-environment happy-dom
/**
 * SchemaForm.test — the schema-driven intake form. Covers:
 *   - all 18 META fields render, with the 6 required marks + two sections.
 *   - the draft autosave (PII-stripped) + restore on remount + resume banner.
 *   - a mid-form "refresh" restores non-PII values and shows a PII-cleared hint.
 *   - submit builds the form-decision content (numbers coerced) and clears draft.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INTAKE_FIELD_META, type IntakeFieldName } from "@autobroker/core";

import { SchemaForm } from "./SchemaForm.js";
import { loadDraft, saveDraft } from "../store/drafts.js";
import { change, click, clickRadio, render, submit } from "../test/render.js";

const ALL_FIELDS = Object.keys(INTAKE_FIELD_META) as IntakeFieldName[];
const REQUIRED = ALL_FIELDS.filter((n) => INTAKE_FIELD_META[n].required);

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SchemaForm — field rendering", () => {
  it("renders all 18 fields, the 7 required marks, and both sections", () => {
    const r = render(
      <SchemaForm runId="r1" seedFields={null} submitting={false} onSubmit={() => {}} onDecline={() => {}} />,
    );
    for (const name of ALL_FIELDS) expect(r.query(`intake-field-${name}`)).not.toBeNull();
    for (const name of REQUIRED) expect(r.query(`required-mark-${name}`)).not.toBeNull();
    // a still-optional field has NO required mark (trim is now required — covered by the loop above).
    expect(r.query("required-mark-search_radius_miles")).toBeNull();
    expect(r.query("intake-section-required")).not.toBeNull();
    expect(r.query("intake-section-optional")).not.toBeNull();
    expect(r.get("intake-completeness").textContent).toBe(`0/${REQUIRED.length} required`);
    r.unmount();
  });

  it("seeds initial values from the prefill seedFields", () => {
    const r = render(
      <SchemaForm
        runId="r2"
        seedFields={{ make: "Hyundai", model: "Tucson Hybrid" }}
        submitting={false}
        onSubmit={() => {}}
        onDecline={() => {}}
      />,
    );
    expect((r.get("intake-field-make") as HTMLInputElement).value).toBe("Hyundai");
    expect((r.get("intake-field-model") as HTMLInputElement).value).toBe("Tucson Hybrid");
    r.unmount();
  });

  it("never fabricates an unstated required vehicle field: a make+model-only seed leaves trim+year blank and blocks submit", () => {
    // The buyer named only make+model ("a new honda cr-v"); the prefill must NOT
    // guess a trim or year. Those required fields stay empty, and the form refuses
    // to submit until the buyer enters them explicitly (ask-and-wait, never assume).
    const r = render(
      <SchemaForm
        runId="r2b"
        seedFields={{ make: "Honda", model: "CR-V" }}
        submitting={false}
        onSubmit={() => {}}
        onDecline={() => {}}
      />,
    );
    expect((r.get("intake-field-make") as HTMLInputElement).value).toBe("Honda");
    expect((r.get("intake-field-model") as HTMLInputElement).value).toBe("CR-V");
    // Unstated required fields are blank — no fabricated default.
    expect((r.get("intake-field-trim") as HTMLInputElement).value).toBe("");
    const yearRadios = r.get("intake-field-year").querySelectorAll("input[type=radio]");
    expect([...yearRadios].some((el) => (el as HTMLInputElement).checked)).toBe(false);
    // Submit stays disabled until trim+year (and the other required fields) are filled.
    expect((r.get("intake-submit") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });
});

describe("SchemaForm — draft autosave + restore", () => {
  it("autosaves a PII-stripped draft keyed by runId after the debounce", () => {
    vi.useFakeTimers();
    const r = render(
      <SchemaForm runId="r3" seedFields={null} submitting={false} onSubmit={() => {}} onDecline={() => {}} />,
    );
    change(r.get("intake-field-make") as HTMLInputElement, "Toyota");
    change(r.get("intake-field-follow_up_email") as HTMLInputElement, "me@example.com");
    vi.advanceTimersByTime(200); // past the 120ms debounce.
    const draft = loadDraft("r3");
    expect(draft).not.toBeNull();
    expect(draft!.values["make"]).toBe("Toyota");
    expect(draft!.values["follow_up_email"]).toBeUndefined(); // PII stripped.
    r.unmount();
  });

  it("restores a prior draft on mount with a resume banner; PII comes back cleared with a hint", () => {
    // A prior session persisted a (already PII-stripped) draft for this run.
    saveDraft("r4", { make: "Honda", model: "CR-V", follow_up_email: "leak@example.com" });
    const r = render(
      <SchemaForm runId="r4" seedFields={null} submitting={false} onSubmit={() => {}} onDecline={() => {}} />,
    );
    // Non-PII restored.
    expect((r.get("intake-field-make") as HTMLInputElement).value).toBe("Honda");
    // PII field empty + cleared hint shown.
    expect((r.get("intake-field-follow_up_email") as HTMLInputElement).value).toBe("");
    expect(r.query("pii-cleared-follow_up_email")).not.toBeNull();
    // Resume banner present; "Start fresh" clears the draft + resets.
    expect(r.query("resume-banner")).not.toBeNull();
    click(r.get("resume-start-fresh"));
    expect((r.get("intake-field-make") as HTMLInputElement).value).toBe("");
    expect(loadDraft("r4")).toBeNull();
    r.unmount();
  });
});

describe("SchemaForm — submit", () => {
  it("blocks submit until all required are valid, then emits coerced content + clears draft", () => {
    const onSubmit = vi.fn();
    const r = render(
      <SchemaForm runId="r5" seedFields={null} submitting={false} onSubmit={onSubmit} onDecline={() => {}} />,
    );
    const form = r.get("intake-form") as HTMLFormElement;
    // Empty form: submit is a no-op (required invalid).
    submit(form);
    expect(onSubmit).not.toHaveBeenCalled();

    // Fill the 7 required fields.
    change(r.get("intake-field-make") as HTMLInputElement, "Hyundai");
    change(r.get("intake-field-model") as HTMLInputElement, "Tucson");
    change(r.get("intake-field-trim") as HTMLInputElement, "Limited");
    clickYear(r);
    change(r.get("intake-field-location_query") as HTMLInputElement, "Irvine, CA");
    change(r.get("intake-field-follow_up_email") as HTMLInputElement, "me@example.com");
    clickFinance(r);

    submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const content = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(content["make"]).toBe("Hyundai");
    expect(typeof content["year"]).toBe("number");
    expect(loadDraft("r5")).toBeNull(); // cleared on submit.
    r.unmount();
  });
});

// --- helpers to pick the segmented/year radios deterministically ----------
function clickYear(r: ReturnType<typeof render>): void {
  const radios = r.get("intake-field-year").querySelectorAll("input[type=radio]");
  clickRadio(radios[0] as HTMLInputElement);
}
function clickFinance(r: ReturnType<typeof render>): void {
  clickRadio(r.get("intake-field-financing_preference-finance") as HTMLInputElement);
}
