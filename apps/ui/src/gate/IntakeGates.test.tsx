// @vitest-environment happy-dom
/**
 * IntakeGates.test — the semantic gate components (FRONTEND_LAYOUT §8.2). Covers
 * the ambiguous-location candidate radio list + pick dispatch, the 裁定⑨ location
 * failure banner (flagged field + reason + retry dispatch), and the force-override
 * confirm bar (reason required → force_override resume).
 */

import { describe, expect, it, vi } from "vitest";

import {
  AmbiguousLocationPicker,
  ForceOverrideBar,
  LocationFailureBanner,
} from "./IntakeGates.js";
import { change, click, clickRadio, render } from "../test/render.js";

const noop = (): void => {};

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
      <AmbiguousLocationPicker gate={gate} decisionId="d1" submitting={false} onResume={onResume} onDecline={noop} />,
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

describe("LocationFailureBanner (裁定⑨)", () => {
  it("flags the location field, shows the failure reason, and retry dispatches retry_query", () => {
    const onResume = vi.fn();
    const gate = {
      kind: "location_failure" as const,
      failureReason: "no_result",
      effectiveQuery: "asdfghjkl",
    };
    const r = render(
      <LocationFailureBanner gate={gate} decisionId="d1" submitting={false} onResume={onResume} onDecline={noop} />,
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

describe("ForceOverrideBar", () => {
  it("requires a reason; confirm dispatches force_override with the reason (audited)", () => {
    const onResume = vi.fn();
    const gate = { kind: "force_override" as const, question: "Keep it?", trim: "GT-X", reason: "" };
    const r = render(
      <ForceOverrideBar gate={gate} decisionId="d1" submitting={false} onResume={onResume} onDecline={noop} />,
    );
    const confirm = r.get("gate-force-override-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // empty reason blocks.
    change(r.get("gate-force-override-reason") as HTMLInputElement, "I know this trim exists");
    expect((r.get("gate-force-override-confirm") as HTMLButtonElement).disabled).toBe(false);
    click(r.get("gate-force-override-confirm"));
    expect(onResume).toHaveBeenCalledWith({ action: "force_override", reason: "I know this trim exists" });
    r.unmount();
  });
});
