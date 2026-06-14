// @vitest-environment happy-dom
/**
 * SkillsPopover.test — the readiness-grouping invariant (the run-button gating
 * as a popover projection): intake is NEVER blocked (it creates the profile),
 * every other skill is blocked without an active profile. The Run control must
 * stay a REAL <button> using the `disabled` attribute (the test driver waits
 * on `:not([disabled])`).
 */

import { describe, expect, it, vi } from "vitest";

import { PIN_REQUIRED_TIP, SkillsPopoverList, groupSkillsByReadiness } from "./SkillsPopover.js";
import type { SkillManifest } from "../api/wire.js";
import { click, render } from "../test/render.js";

const intake: SkillManifest = {
  name: "search_profile_intake",
  version: "1",
  summary: "Create a search profile",
  inputs: ["freeform"],
  outputs: "profile",
  sensitive: false,
  profile_pin: "exempt",
  retries: 1,
};
const other: SkillManifest = {
  ...intake,
  name: "quote_audit",
  summary: "Audit quotes",
  profile_pin: "infer_ok",
};
const pinRequired: SkillManifest = {
  ...intake,
  name: "dealer_inbox_check",
  summary: "Check dealer inbox",
  profile_pin: "pin_required",
};

describe("groupSkillsByReadiness — profile-ASK UI projection", () => {
  it("0-active world (no pin, no profile): intake alone is ready, everything else blocked", () => {
    const groups = groupSkillsByReadiness([intake, other], { pin: null, hasActiveProfile: false });
    expect(groups.ready.map((s) => s.name)).toEqual(["search_profile_intake"]);
    expect(groups.blocked.map((s) => s.name)).toEqual(["quote_audit"]);
  });

  it("with a TRUE session pin: every skill is ready", () => {
    const groups = groupSkillsByReadiness([intake, other], { pin: "p1", hasActiveProfile: true });
    expect(groups.ready).toHaveLength(2);
    expect(groups.blocked).toHaveLength(0);
  });

  it("unpinned but >=1 active profile: infer_ok ready (exactly-1 resolves; 2+ STOPs answerably)", () => {
    const groups = groupSkillsByReadiness([intake, other], { pin: null, hasActiveProfile: true });
    expect(groups.ready.map((s) => s.name)).toEqual(["search_profile_intake", "quote_audit"]);
    expect(groups.blocked).toHaveLength(0);
  });

  it("pin_required: BLOCKED with 1 active + no pin (an active profile is not enough)", () => {
    const groups = groupSkillsByReadiness([pinRequired], { pin: null, hasActiveProfile: true });
    expect(groups.ready).toHaveLength(0);
    expect(groups.blocked.map((s) => s.name)).toEqual(["dealer_inbox_check"]);
  });

  it("pin_required: READY once a pin is set", () => {
    const groups = groupSkillsByReadiness([pinRequired], { pin: "p1", hasActiveProfile: true });
    expect(groups.ready.map((s) => s.name)).toEqual(["dealer_inbox_check"]);
    expect(groups.blocked).toHaveLength(0);
  });

  it("infer_ok: READY with 1 active + no pin (a pin_required sibling stays blocked)", () => {
    const groups = groupSkillsByReadiness([other, pinRequired], {
      pin: null,
      hasActiveProfile: true,
    });
    expect(groups.ready.map((s) => s.name)).toEqual(["quote_audit"]);
    expect(groups.blocked.map((s) => s.name)).toEqual(["dealer_inbox_check"]);
  });

  it("exempt (intake): ready in every state", () => {
    for (const state of [
      { pin: null, hasActiveProfile: false },
      { pin: null, hasActiveProfile: true },
      { pin: "p1", hasActiveProfile: true },
    ]) {
      const groups = groupSkillsByReadiness([intake], state);
      expect(groups.ready.map((s) => s.name)).toEqual(["search_profile_intake"]);
    }
  });
});

describe("SkillsPopoverList — rendered Run buttons", () => {
  it("0-active: intake Run is a real enabled <button>, the other is disabled; intake fires onRun", () => {
    const onRun = vi.fn();
    const r = render(
      <SkillsPopoverList
        skills={[intake, other]}
        pin={null}
        hasActiveProfile={false}
        deepseekReady
        onRun={onRun}
      />,
    );
    const intakeRun = r.get("ledger-run-search_profile_intake") as HTMLButtonElement;
    const otherRun = r.get("ledger-run-quote_audit") as HTMLButtonElement;
    expect(intakeRun.tagName).toBe("BUTTON");
    expect(intakeRun.disabled).toBe(false);
    expect(otherRun.tagName).toBe("BUTTON");
    expect(otherRun.disabled).toBe(true);
    click(intakeRun);
    expect(onRun).toHaveBeenCalledWith(intake);
    r.unmount();
  });

  it("with a pin: the non-intake Run enables and fires onRun", () => {
    const onRun = vi.fn();
    const r = render(
      <SkillsPopoverList skills={[intake, other]} pin="p1" hasActiveProfile deepseekReady onRun={onRun} />,
    );
    const otherRun = r.get("ledger-run-quote_audit") as HTMLButtonElement;
    expect(otherRun.disabled).toBe(false);
    click(otherRun);
    expect(onRun).toHaveBeenCalledWith(other);
    r.unmount();
  });

  it("pin_required with an active search but no pin: Run disabled, the pin hint renders", () => {
    const onRun = vi.fn();
    const r = render(
      <SkillsPopoverList
        skills={[intake, pinRequired]}
        pin={null}
        hasActiveProfile
        deepseekReady
        onRun={onRun}
      />,
    );
    const pinRun = r.get("ledger-run-dealer_inbox_check") as HTMLButtonElement;
    expect(pinRun.disabled).toBe(true);
    expect(pinRun.title).toBe(PIN_REQUIRED_TIP);
    // The blocked-group hint text is rendered.
    expect(r.container.textContent).toContain(PIN_REQUIRED_TIP);
    // intake is still ready.
    const intakeRun = r.get("ledger-run-search_profile_intake") as HTMLButtonElement;
    expect(intakeRun.disabled).toBe(false);
    r.unmount();
  });

  it("first-run gate (no DeepSeek key): EVERY skill is locked with the Settings pointer", () => {
    const onRun = vi.fn();
    const r = render(
      <SkillsPopoverList
        skills={[intake, other]}
        pin="p1"
        hasActiveProfile
        deepseekReady={false}
        onRun={onRun}
      />,
    );
    // The locked notice renders and EVERY row (intake included) is disabled.
    expect(r.query("skills-locked-notice")).not.toBeNull();
    const intakeRun = r.get("ledger-run-search_profile_intake") as HTMLButtonElement;
    const otherRun = r.get("ledger-run-quote_audit") as HTMLButtonElement;
    expect(intakeRun.disabled).toBe(true);
    expect(otherRun.disabled).toBe(true);
    r.unmount();
  });
});
