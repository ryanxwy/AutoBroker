// @vitest-environment happy-dom
/**
 * StopCard.test — the pin_required arm renders the same ProfileStopPicker as
 * multiple_active_profiles (a pin-required skill launched with no pin), and
 * picking a vehicle re-launches pinned via the onPickProfile path. The
 * intake-CTA codes (no_active_profile / profile_missing_fields) stay the CTA.
 */

import { describe, expect, it, vi } from "vitest";

import { StopCard } from "./StopCard.js";
import { ApiClient } from "../api/client.js";
import { click, render } from "../test/render.js";

/** A client whose fetch answers the picker's GET /api/profiles?status=active. */
function stubClient(profiles: unknown[] = []): ApiClient {
  return new ApiClient({
    fetchImpl: (async () =>
      new Response(JSON.stringify(profiles), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
}

/** Flush microtasks so the picker's profile fetch resolves. */
async function flush(): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("StopCard — pin_required arm", () => {
  it("pin_required renders the ProfileStopPicker with the active candidates", async () => {
    const profiles = [
      { search_profile_id: "prof-a", year: 2026, make: "Hyundai", model: "Tucson Hybrid", trim: "Limited" },
      { search_profile_id: "prof-b", year: 2026, make: "Hyundai", model: "Santa Fe Hybrid", trim: "Limited" },
    ];
    const onPick = vi.fn();
    const r = render(
      <StopCard
        code="pin_required"
        client={stubClient(profiles)}
        onStartIntake={() => {}}
        onPickProfile={onPick}
      />,
    );
    await flush();
    const options = r.container.querySelectorAll('[data-testid="stop-pick-option"]');
    expect(options).toHaveLength(2);
    expect(options[0]!.textContent).toBe("2026 Hyundai Tucson Hybrid Limited");
    // No intake CTA on the pin_required arm — it picks, not creates.
    expect(r.query("stop-intake-cta")).toBeNull();
    r.unmount();
  });

  it("picking a vehicle re-launches pinned via onPickProfile", async () => {
    const profiles = [
      { search_profile_id: "prof-a", year: 2026, make: "Hyundai", model: "Tucson Hybrid", trim: "Limited" },
    ];
    const onPick = vi.fn();
    const r = render(
      <StopCard
        code="pin_required"
        client={stubClient(profiles)}
        onStartIntake={() => {}}
        onPickProfile={onPick}
      />,
    );
    await flush();
    const option = r.get("stop-pick-option");
    click(option);
    expect(onPick).toHaveBeenCalledWith("prof-a");
    r.unmount();
  });

  it("the stop-card carries the pin_required code for styling/diagnostics", async () => {
    const r = render(
      <StopCard
        code="pin_required"
        client={stubClient([])}
        onStartIntake={() => {}}
        onPickProfile={() => {}}
      />,
    );
    await flush();
    expect(r.get("stop-card").getAttribute("data-stop-code")).toBe("pin_required");
    r.unmount();
  });

  it("the intake-CTA codes still render the create-a-search CTA (regression)", () => {
    const onStartIntake = vi.fn();
    const r = render(
      <StopCard
        code="no_active_profile"
        client={stubClient([])}
        onStartIntake={onStartIntake}
        onPickProfile={() => {}}
      />,
    );
    const cta = r.get("stop-intake-cta");
    click(cta);
    expect(onStartIntake).toHaveBeenCalledTimes(1);
    expect(r.query("stop-pick-list")).toBeNull();
    r.unmount();
  });
});

describe("StopCard — inbox precondition arms", () => {
  it("no_lead_submitted renders the friendly message arm — NOT the picker, NOT a CTA", () => {
    const msg = "Submit a lead to a dealer first (run /dealer_web_lead_submit), then check the inbox.";
    const r = render(
      <StopCard
        code="no_lead_submitted"
        client={stubClient([])}
        message={msg}
        onStartIntake={() => {}}
        onPickProfile={() => {}}
      />,
    );
    const friendly = r.get("stop-no-lead-submitted");
    expect(friendly.textContent).toBe(msg);
    // Calm, not an alert: a precondition pointer, not an error.
    expect(r.get("stop-card").getAttribute("role")).toBe("status");
    // No picker and no intake CTA on this arm.
    expect(r.query("stop-pick-list")).toBeNull();
    expect(r.query("stop-intake-cta")).toBeNull();
    r.unmount();
  });

  it("no_active_profile points at intake (the create-a-search CTA, not the picker)", () => {
    const onStartIntake = vi.fn();
    const r = render(
      <StopCard
        code="no_active_profile"
        client={stubClient([])}
        onStartIntake={onStartIntake}
        onPickProfile={() => {}}
      />,
    );
    click(r.get("stop-intake-cta"));
    expect(onStartIntake).toHaveBeenCalledTimes(1);
    expect(r.query("stop-pick-list")).toBeNull();
    r.unmount();
  });

  it("pin_required and multiple_active_profiles both render the picker", async () => {
    const profiles = [
      { search_profile_id: "prof-a", year: 2026, make: "Hyundai", model: "Tucson Hybrid", trim: "Limited" },
    ];
    for (const code of ["pin_required", "multiple_active_profiles"] as const) {
      const r = render(
        <StopCard code={code} client={stubClient(profiles)} onStartIntake={() => {}} onPickProfile={() => {}} />,
      );
      await flush();
      expect(r.query("stop-pick-list")).not.toBeNull();
      expect(r.query("stop-intake-cta")).toBeNull();
      r.unmount();
    }
  });
});
