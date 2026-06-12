// @vitest-environment happy-dom
/**
 * SkillsPopover.test — the readiness-grouping invariant (the run-button gating
 * as a popover projection): intake is NEVER blocked (it creates the profile),
 * every other skill is blocked without an active profile. The Run control must
 * stay a REAL <button> using the `disabled` attribute (the test driver waits
 * on `:not([disabled])`).
 */

import { describe, expect, it, vi } from "vitest";

import { SkillsPopoverList, groupSkillsByReadiness } from "./SkillsPopover.js";
import type { SkillManifest } from "../api/wire.js";
import { click, render } from "../test/render.js";

const intake: SkillManifest = {
  name: "search_profile_intake",
  version: "1",
  summary: "Create a search profile",
  inputs: ["freeform"],
  outputs: "profile",
  sensitive: false,
  retries: 1,
};
const other: SkillManifest = { ...intake, name: "quote_audit", summary: "Audit quotes" };

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

  it("unpinned but >=1 active profile: ready (exactly-1 resolves; 2+ STOPs answerably)", () => {
    const groups = groupSkillsByReadiness([intake, other], { pin: null, hasActiveProfile: true });
    expect(groups.ready).toHaveLength(2);
    expect(groups.blocked).toHaveLength(0);
  });
});

describe("SkillsPopoverList — rendered Run buttons", () => {
  it("0-active: intake Run is a real enabled <button>, the other is disabled; intake fires onRun", () => {
    const onRun = vi.fn();
    const r = render(
      <SkillsPopoverList skills={[intake, other]} pin={null} hasActiveProfile={false} onRun={onRun} />,
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
      <SkillsPopoverList skills={[intake, other]} pin="p1" hasActiveProfile onRun={onRun} />,
    );
    const otherRun = r.get("ledger-run-quote_audit") as HTMLButtonElement;
    expect(otherRun.disabled).toBe(false);
    click(otherRun);
    expect(onRun).toHaveBeenCalledWith(other);
    r.unmount();
  });
});
