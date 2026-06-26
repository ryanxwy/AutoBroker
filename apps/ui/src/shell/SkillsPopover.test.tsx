// @vitest-environment happy-dom
/**
 * SkillsPopover.test — the readiness-grouping invariant (the run-button gating
 * as a popover projection): intake is NEVER blocked (it creates the profile),
 * every other skill is blocked without an active profile. The Run control must
 * stay a REAL <button> using the `disabled` attribute (the test driver waits
 * on `:not([disabled])`).
 */

import { describe, expect, it, vi } from "vitest";

import {
  PIN_REQUIRED_TIP,
  PIPELINE_STAGES,
  SkillsPopoverList,
  applyServerSuggestions,
  defaultSuggestionReason,
  groupSkillsByReadiness,
  nextSuggestedSkills,
} from "./SkillsPopover.js";
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

/** A manifest for any pipeline skill. intake is `exempt`; everything else is
 *  `infer_ok` so a pin/active profile satisfies the posture (keeps these tests
 *  focused on the STAGE windowing, not the pin gate). */
function skill(name: string): SkillManifest {
  return {
    ...intake,
    name,
    summary: `run ${name}`,
    profile_pin: name === "search_profile_intake" ? "exempt" : "infer_ok",
  };
}
/** Every pipeline skill, in stage order — the realistic 17-skill manifest. */
const ALL_SKILLS: SkillManifest[] = PIPELINE_STAGES.flat().map(skill);

describe("nextSuggestedSkills — top-3 of the pipeline-stage sliding window", () => {
  it("no profile, no pin: only search_profile_intake is suggested", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: null,
      hasActiveProfile: false,
      lastSkill: null,
    });
    expect(got.map((s) => s.name)).toEqual(["search_profile_intake"]);
  });

  it("no lastSkill but an active profile: window opens from the FIRST stage (intake + geosearch)", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: null,
      hasActiveProfile: true,
      lastSkill: null,
    });
    expect(got.map((s) => s.name)).toEqual(["search_profile_intake", "dealer_geosearch"]);
  });

  it("lastSkill=search_profile_intake (stage 0): window = stage 0 + stage 1", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: "p1",
      hasActiveProfile: true,
      lastSkill: "search_profile_intake",
    });
    expect(got.map((s) => s.name)).toEqual(["search_profile_intake", "dealer_geosearch"]);
  });

  it("lastSkill=dealer_geosearch (stage 1): top-3 of [stage 1 + the scan stage]", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: "p1",
      hasActiveProfile: true,
      lastSkill: "dealer_geosearch",
    });
    expect(got.map((s) => s.name)).toEqual([
      "dealer_geosearch",
      "inventory_site_scan",
      "inventory_link_scan",
    ]);
  });

  it("lastSkill=inventory_compare (stage 2): top-3 of [the scan stage + lead-submit]", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: "p1",
      hasActiveProfile: true,
      lastSkill: "inventory_compare",
    });
    expect(got.map((s) => s.name)).toEqual([
      "inventory_site_scan",
      "inventory_link_scan",
      "incentive_scrape",
    ]);
  });

  it("lastSkill=dealer_web_lead_submit (stage 3): top-3 of [lead-submit + the reply stage]", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: "p1",
      hasActiveProfile: true,
      lastSkill: "dealer_web_lead_submit",
    });
    expect(got.map((s) => s.name)).toEqual([
      "dealer_web_lead_submit",
      "dealer_inbox_check",
      "dealer_reply_extract",
    ]);
  });

  it("lastSkill=quote_audit (stage 4): top-3 of [the reply stage + the negotiate stage]", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: "p1",
      hasActiveProfile: true,
      lastSkill: "quote_audit",
    });
    expect(got.map((s) => s.name)).toEqual([
      "dealer_inbox_check",
      "dealer_reply_extract",
      "quote_audit",
    ]);
  });

  it("lastSkill=daily_digest (stage 5): top-3 of [the negotiate stage + the closeout stage]", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: "p1",
      hasActiveProfile: true,
      lastSkill: "daily_digest",
    });
    expect(got.map((s) => s.name)).toEqual([
      "negotiation_followup",
      "quote_pipeline",
      "daily_digest",
    ]);
  });

  it("never suggests more than MAX_SUGGESTED (3) for any state", () => {
    for (const lastSkill of [null, ...PIPELINE_STAGES.flat(), "not_a_real_skill"]) {
      const got = nextSuggestedSkills(ALL_SKILLS, { pin: "p1", hasActiveProfile: true, lastSkill });
      expect(got.length).toBeLessThanOrEqual(3);
    }
  });

  it("lastSkill=pipeline_reset (last stage 6): window = the last stage alone (no next stage)", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: "p1",
      hasActiveProfile: true,
      lastSkill: "pipeline_reset",
    });
    expect(got.map((s) => s.name)).toEqual([
      "dealer_hygiene",
      "dealer_closeout_email",
      "pipeline_reset",
    ]);
  });

  it("lastSkill unknown but window non-empty falls through to stage 0; an out-of-pipeline lastSkill opens stage 0", () => {
    const got = nextSuggestedSkills(ALL_SKILLS, {
      pin: "p1",
      hasActiveProfile: true,
      lastSkill: "not_a_real_skill",
    });
    expect(got.map((s) => s.name)).toEqual(["search_profile_intake", "dealer_geosearch"]);
  });

  it("empty window → falls back to the full ready list (always actionable)", () => {
    // A skill set whose only ready member is in NO stage window for the chosen
    // lastSkill: with just pipeline_reset present and lastSkill=intake, the
    // stage-0/1 window is empty, so we fall back to the full ready list.
    const got = nextSuggestedSkills([skill("pipeline_reset")], {
      pin: "p1",
      hasActiveProfile: true,
      lastSkill: "search_profile_intake",
    });
    expect(got.map((s) => s.name)).toEqual(["pipeline_reset"]);
  });
});

describe("applyServerSuggestions — Hybrid LLM re-rank of the deterministic top-3", () => {
  const a = skill("dealer_geosearch");
  const b = skill("inventory_site_scan");
  const c = skill("inventory_link_scan");

  it("no server suggestions: deterministic order + curated default reasons", () => {
    const got = applyServerSuggestions([a, b, c], undefined);
    expect(got.map((x) => x.skill.name)).toEqual([a.name, b.name, c.name]);
    expect(got[0]?.reason).toBe(defaultSuggestionReason(a));
  });

  it("re-orders the SAME candidates by the server order and uses server reasons", () => {
    const got = applyServerSuggestions([a, b, c], [
      { skillId: "inventory_site_scan", reason: "you just found dealers — scan them" },
      { skillId: "dealer_geosearch", reason: "widen the radius first" },
    ]);
    expect(got.map((x) => x.skill.name)).toEqual([
      "inventory_site_scan",
      "dealer_geosearch",
      "inventory_link_scan", // omitted by server → trails with its default reason
    ]);
    expect(got[0]?.reason).toBe("you just found dealers — scan them");
    expect(got[2]?.reason).toBe(defaultSuggestionReason(c));
  });

  it("IGNORES any server skill outside the deterministic candidate set (safety/reachability)", () => {
    const got = applyServerSuggestions([a, b], [
      { skillId: "pipeline_reset", reason: "nuke everything" }, // NOT a candidate
      { skillId: "inventory_site_scan", reason: "scan" },
    ]);
    expect(got.map((x) => x.skill.name)).toEqual(["inventory_site_scan", "dealer_geosearch"]);
    expect(got.some((x) => x.skill.name === "pipeline_reset")).toBe(false);
  });
});

describe("SkillsPopoverList — suggested set + 'More skills' disclosure", () => {
  it("each suggested row renders a 'why this next' reason", () => {
    const onRun = vi.fn();
    const r = render(
      <SkillsPopoverList
        skills={ALL_SKILLS}
        pin="p1"
        hasActiveProfile
        deepseekReady
        lastSkill="dealer_geosearch"
        onRun={onRun}
      />,
    );
    // The top-3 after geosearch each carry a reason node.
    expect(r.query("skills-reason-dealer_geosearch")).not.toBeNull();
    expect(r.query("skills-reason-inventory_site_scan")).not.toBeNull();
    expect(r.query("skills-reason-inventory_link_scan")).not.toBeNull();
    r.unmount();
  });

  it("a server (LLM) re-rank re-orders + re-words the visible top-3 without widening it", () => {
    const onRun = vi.fn();
    const r = render(
      <SkillsPopoverList
        skills={ALL_SKILLS}
        pin="p1"
        hasActiveProfile
        deepseekReady
        lastSkill="dealer_geosearch"
        serverSuggested={[
          { skillId: "inventory_site_scan", reason: "scan the dealers you just found" },
        ]}
        onRun={onRun}
      />,
    );
    const reasonNode = r.get("skills-reason-inventory_site_scan");
    expect(reasonNode.textContent).toContain("scan the dealers you just found");
    // The visible set is still the deterministic 3 — a non-candidate stays in More.
    expect(r.query("skills-reason-pipeline_reset")).toBeNull();
    r.unmount();
  });

  it("renders only the suggested ready skills under Ready; the rest go behind 'More skills'", () => {
    const onRun = vi.fn();
    const r = render(
      <SkillsPopoverList
        skills={ALL_SKILLS}
        pin="p1"
        hasActiveProfile
        deepseekReady
        lastSkill="search_profile_intake"
        onRun={onRun}
      />,
    );
    // The suggested window (stage 0 + 1) renders directly enabled.
    const intakeRun = r.get("ledger-run-search_profile_intake") as HTMLButtonElement;
    const geoRun = r.get("ledger-run-dealer_geosearch") as HTMLButtonElement;
    expect(intakeRun.disabled).toBe(false);
    expect(geoRun.disabled).toBe(false);
    // The "More skills" disclosure exists and holds a NON-suggested ready skill.
    expect(r.query("skills-more")).not.toBeNull();
    expect(r.query("skills-more-toggle")).not.toBeNull();
    const moreRun = r.get("ledger-run-quote_audit") as HTMLButtonElement;
    expect(moreRun.disabled).toBe(false);
    // A "More skills" row still fires onRun when clicked (it is fully reachable).
    click(moreRun);
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ name: "quote_audit" }));
    r.unmount();
  });

  it("no profile, no pin: only intake is suggested and there is NO 'More skills' (every other skill is blocked)", () => {
    const onRun = vi.fn();
    const r = render(
      <SkillsPopoverList
        skills={ALL_SKILLS}
        pin={null}
        hasActiveProfile={false}
        deepseekReady
        lastSkill={null}
        onRun={onRun}
      />,
    );
    const intakeRun = r.get("ledger-run-search_profile_intake") as HTMLButtonElement;
    expect(intakeRun.disabled).toBe(false);
    // The non-intake skills are all BLOCKED (0-active world), so none are in the
    // ready group → no "More skills" disclosure.
    expect(r.query("skills-more")).toBeNull();
    r.unmount();
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
