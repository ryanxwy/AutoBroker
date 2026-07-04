// @vitest-environment happy-dom
/**
 * IntakeGates.test — the semantic gate components. Covers
 * the ambiguous-location candidate radio list + pick dispatch, the location
 * failure banner (flagged field + reason + retry dispatch), and the buyer
 * confirmation card (accept/edit/decline dispatch; vehicle-only display).
 */

import { describe, expect, it, vi } from "vitest";

import {
  AmbiguousLocationPicker,
  DataCollectionProse,
  IntakeConfirmCard,
  LocationFailureBanner,
  TrimSuggestionPicker,
} from "./IntakeGates.js";
import { change, click, clickRadio, render } from "../test/render.js";

const noop = (): void => {};

describe("DataCollectionProse (form gate lead-in)", () => {
  const ask = "Which exact trim do you want? The trim field is required — pick the trim before submitting.";

  it("renders the verbal ask as the emphasized lead-in line", () => {
    const r = render(<DataCollectionProse prose={ask} />);
    expect(r.get("intake-form-prose").textContent).toBe(ask);
    r.unmount();
  });

  it("renders NOTHING for null prose (slash path — backward compatible)", () => {
    const r = render(<DataCollectionProse prose={null} />);
    expect(r.query("intake-form-prose")).toBeNull();
    r.unmount();
  });

  it("renders NOTHING for empty/whitespace prose", () => {
    const r = render(<DataCollectionProse prose="   " />);
    expect(r.query("intake-form-prose")).toBeNull();
    r.unmount();
  });
});

describe("AmbiguousLocationPicker", () => {
  it("renders one radio per candidate; pick dispatches {action:'pick', picked_index}", () => {
    const onResume = vi.fn();
    const gate = {
      kind: "ambiguous_location" as const,
      candidates: [
        { index: 0, label: "Irvine, CA, USA" },
        { index: 1, label: "Irvine, KY, USA" },
      ],
      effectiveQuery: "Irvine",
    };
    const r = render(
      <AmbiguousLocationPicker gate={gate} submitting={false} onResume={onResume} onDecline={noop} />,
    );
    expect(r.query("gate-location-candidate-0")).not.toBeNull();
    expect(r.query("gate-location-candidate-1")).not.toBeNull();
    // Pick the second candidate, then confirm.
    clickRadio(r.get("gate-location-candidate-1") as HTMLInputElement);
    click(r.get("gate-location-pick"));
    expect(onResume).toHaveBeenCalledWith({ action: "pick", picked_index: 1 });
    r.unmount();
  });
});

describe("TrimSuggestionPicker", () => {
  const gate = {
    kind: "trim_suggestion" as const,
    make: "Honda",
    model: "Civic",
    year: 2026,
    candidates: [
      { index: 0, name: "LX", summary: "base 2.0L" },
      { index: 1, name: "Sport", summary: "sport styling + leather" },
    ],
  };

  it("starts UNSELECTED (no auto-pick); pick enables after a deliberate selection and dispatches {action:'pick'}", () => {
    const onResume = vi.fn();
    const r = render(
      <TrimSuggestionPicker gate={gate} submitting={false} onResume={onResume} onDecline={noop} />,
    );
    expect(r.query("gate-trim-option-0")).not.toBeNull();
    expect(r.query("gate-trim-option-1")).not.toBeNull();
    // Product-rule #1: Pick is DISABLED until the buyer deliberately selects a trim.
    expect((r.get("gate-trim-pick") as HTMLButtonElement).disabled).toBe(true);
    clickRadio(r.get("gate-trim-option-1") as HTMLInputElement);
    expect((r.get("gate-trim-pick") as HTMLButtonElement).disabled).toBe(false);
    click(r.get("gate-trim-pick"));
    expect(onResume).toHaveBeenCalledWith({ action: "pick", picked_index: 1 });
    r.unmount();
  });

  it("'enter it myself' is an ACCEPT-style skip (NOT decline) → {action:'skip'}", () => {
    const onResume = vi.fn();
    const onDecline = vi.fn();
    const r = render(
      <TrimSuggestionPicker gate={gate} submitting={false} onResume={onResume} onDecline={onDecline} />,
    );
    click(r.get("gate-trim-skip"));
    expect(onResume).toHaveBeenCalledWith({ action: "skip" });
    expect(onDecline).not.toHaveBeenCalled();
    r.unmount();
  });

  it("cancel → onDecline (terminal); retry dispatches the refine query (null when empty)", () => {
    const onResume = vi.fn();
    const onDecline = vi.fn();
    const r = render(
      <TrimSuggestionPicker gate={gate} submitting={false} onResume={onResume} onDecline={onDecline} />,
    );
    click(r.get("gate-trim-retry"));
    expect(onResume).toHaveBeenCalledWith({ action: "retry", refine_query: null });
    change(r.get("gate-trim-retry-input") as HTMLInputElement, "hatchback");
    click(r.get("gate-trim-retry"));
    expect(onResume).toHaveBeenCalledWith({ action: "retry", refine_query: "hatchback" });
    click(r.get("gate-trim-decline"));
    expect(onDecline).toHaveBeenCalled();
    r.unmount();
  });
});

describe("LocationFailureBanner (coordinate-resolution invariant)", () => {
  it("flags the location field, shows the failure reason, and retry dispatches retry_query", () => {
    const onResume = vi.fn();
    const gate = {
      kind: "location_failure" as const,
      failureReason: "no_result",
      effectiveQuery: "asdfghjkl",
    };
    const r = render(
      <LocationFailureBanner gate={gate} submitting={false} onResume={onResume} onDecline={noop} />,
    );
    // failure reason shown.
    expect(r.get("gate-location-failure-reason").textContent).toContain("no_result");
    // location field flagged invalid.
    const input = r.get("gate-location-failure-input") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    // re-fill + retry.
    change(input, "Irvine, CA 92614");
    click(r.get("gate-location-failure-retry"));
    expect(onResume).toHaveBeenCalledWith({ action: "retry", retry_query: "Irvine, CA 92614" });
    r.unmount();
  });
});

describe("IntakeConfirmCard", () => {
  const gate = { kind: "intake_confirm" as const, year: 2026, make: "Hyundai", model: "Tucson", trim: "SEL" };

  it("shows the resolved vehicle and dispatches accept", () => {
    const onResume = vi.fn();
    const r = render(
      <IntakeConfirmCard gate={gate} submitting={false} onResume={onResume} onDecline={noop} />,
    );
    expect(r.get("gate-intake-confirm-vehicle").textContent).toContain("2026 Hyundai Tucson SEL");
    click(r.get("gate-intake-confirm-accept"));
    expect(onResume).toHaveBeenCalledWith({ action: "accept" });
    r.unmount();
  });

  it("dispatches edit and decline", () => {
    const onResume = vi.fn();
    const onDecline = vi.fn();
    const r = render(
      <IntakeConfirmCard gate={gate} submitting={false} onResume={onResume} onDecline={onDecline} />,
    );
    click(r.get("gate-intake-confirm-edit"));
    expect(onResume).toHaveBeenCalledWith({ action: "edit" });
    click(r.get("gate-intake-confirm-decline"));
    expect(onDecline).toHaveBeenCalled();
    r.unmount();
  });
});
