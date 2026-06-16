/**
 * taxonomy.test.ts — the scenario-taxonomy loader: parse a valid taxonomy TOML
 * into typed ScenarioClass[], the _base.toml seed loads + validates its 9 edge
 * classes (each names real deterministic assertion ids + judge dims), unknown
 * fields fail LOUD (.strict()), the assertion/judge id space is OPEN for extension
 * (per-skill plans declare their own ids), and a duplicate id across the merge
 * fails LOUD.
 */

import { describe, expect, it } from "vitest";

import { DETERMINISTIC_ASSERTION_IDS, JUDGE_DIM_IDS } from "./verdict.js";
import {
  findScenario,
  loadTaxonomy,
  parseTaxonomy,
  scenariosInClass,
} from "./taxonomy.js";

const MINIMAL = `
[[scenarios]]
id = "x1"
surface = "search_profile_intake"
class_name = "cold_start_phrasing"
stresses = "extraction robustness"
buyer_model = "opus"
dealer_needed = false
deterministic_assertions = ["no_external_mutation", "l1_fuse_armed"]
judge_dims = ["buyer_coherence"]
gate_verbs = []
`;

describe("parseTaxonomy", () => {
  it("parses a valid entry into a typed ScenarioClass", () => {
    const [s] = parseTaxonomy(MINIMAL);
    expect(s!.id).toBe("x1");
    expect(s!.surface).toBe("search_profile_intake");
    expect(s!.className).toBe("cold_start_phrasing");
    expect(s!.buyerModel).toBe("opus");
    expect(s!.dealerNeeded).toBe(false);
    expect(s!.deterministicAssertions).toEqual(["no_external_mutation", "l1_fuse_armed"]);
    expect(s!.judgeDims).toEqual(["buyer_coherence"]);
    expect(s!.gateVerbs).toEqual([]);
  });

  it("defaults buyer_model=opus, dealer_needed=false, judge_dims/gate_verbs=[]", () => {
    const [s] = parseTaxonomy(`
[[scenarios]]
id = "x2"
surface = "dealer_geosearch"
class_name = "gate_decline_path"
stresses = "zero write on decline"
deterministic_assertions = ["no_external_mutation"]
`);
    expect(s!.buyerModel).toBe("opus");
    expect(s!.dealerNeeded).toBe(false);
    expect(s!.judgeDims).toEqual([]);
    expect(s!.gateVerbs).toEqual([]);
  });

  it("fails LOUD on an unknown top-level field (.strict)", () => {
    expect(() =>
      parseTaxonomy(`
[[scenarios]]
id = "x3"
surface = "s"
class_name = "c"
stresses = "z"
deterministic_assertions = ["no_external_mutation"]
bogus_field = "nope"
`),
    ).toThrow();
  });

  it("accepts a per-skill assertion id (the id space is OPEN for extension)", () => {
    const [s] = parseTaxonomy(`
[[scenarios]]
id = "x4"
surface = "dealer_reply_extract"
class_name = "c"
stresses = "z"
deterministic_assertions = ["no_external_mutation", "float_dollars"]
`);
    expect(s!.deterministicAssertions).toContain("float_dollars");
  });

  it("fails LOUD on an empty deterministic_assertions array (min 1)", () => {
    expect(() =>
      parseTaxonomy(`
[[scenarios]]
id = "x5"
surface = "s"
class_name = "c"
stresses = "z"
deterministic_assertions = []
`),
    ).toThrow();
  });

  it("accepts a per-skill judge dim id (open for extension)", () => {
    const [s] = parseTaxonomy(`
[[scenarios]]
id = "x6"
surface = "negotiation_followup"
class_name = "c"
stresses = "z"
deterministic_assertions = ["no_external_mutation"]
judge_dims = ["on_strategy"]
`);
    expect(s!.judgeDims).toContain("on_strategy");
  });
});

describe("loadTaxonomy (the _base.toml seed)", () => {
  const all = loadTaxonomy();

  it("loads the 9 plan-0 edge classes", () => {
    expect(all.length).toBeGreaterThanOrEqual(9);
    const ids = all.map((s) => s.id);
    for (const expected of [
      "cold_start_phrasing",
      "profile_ask_branch",
      "gate_decline_path",
      "session_consistency_hazard",
      "irreversible_send_fake",
      "budget_redaction",
      "malformed_extraction_f1",
      "destructive_typed_confirm",
      "full_e2e_journey",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("every loaded scenario names only known assertion + judge ids", () => {
    for (const s of all) {
      for (const a of s.deterministicAssertions) {
        expect(DETERMINISTIC_ASSERTION_IDS as readonly string[]).toContain(a);
      }
      for (const d of s.judgeDims) {
        expect(JUDGE_DIM_IDS as readonly string[]).toContain(d);
      }
      expect(s.deterministicAssertions.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every scenario asserts the keystone + the L1 fuse (the always-on floor)", () => {
    for (const s of all) {
      expect(s.deterministicAssertions).toContain("no_external_mutation");
      expect(s.deterministicAssertions).toContain("l1_fuse_armed");
    }
  });

  it("findScenario resolves a known id and fails LOUD on a miss", () => {
    expect(findScenario(all, "cold_start_phrasing").id).toBe("cold_start_phrasing");
    expect(() => findScenario(all, "nope")).toThrow(/no scenario "nope"/);
  });

  it("scenariosInClass filters by class name", () => {
    const found = scenariosInClass(all, "gate_decline_path");
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.every((s) => s.className === "gate_decline_path")).toBe(true);
  });
});
