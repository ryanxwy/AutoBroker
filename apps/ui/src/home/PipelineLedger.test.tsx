// @vitest-environment happy-dom
/**
 * PipelineLedger.test — the run-button gating invariant (FRONTEND_LAYOUT §6.1):
 * intake's Run button is NEVER disabled (it creates the profile), every other
 * skill's Run is disabled without a pinned profile.
 */

import { describe, expect, it, vi } from "vitest";

import { PipelineLedger, runDisabled } from "./PipelineLedger.js";
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

describe("runDisabled — profile-ASK UI projection", () => {
  it("intake is never disabled, even with no pin", () => {
    expect(runDisabled("search_profile_intake", null).disabled).toBe(false);
  });
  it("a non-intake skill is disabled without a pin, enabled with one", () => {
    expect(runDisabled("quote_audit", null).disabled).toBe(true);
    expect(runDisabled("quote_audit", "p1").disabled).toBe(false);
  });
});

describe("PipelineLedger — rendered Run buttons", () => {
  it("with no pin: intake Run enabled, other Run disabled; intake Run fires onRun", () => {
    const onRun = vi.fn();
    const r = render(<PipelineLedger skills={[intake, other]} activePin={null} onRun={onRun} />);
    const intakeRun = r.get("ledger-run-search_profile_intake") as HTMLButtonElement;
    const otherRun = r.get("ledger-run-quote_audit") as HTMLButtonElement;
    expect(intakeRun.disabled).toBe(false);
    expect(otherRun.disabled).toBe(true);
    click(intakeRun);
    expect(onRun).toHaveBeenCalledWith(intake);
    r.unmount();
  });
});
