/**
 * cases.test.ts — TOML parse + case loading.
 * Parses the committed case files + inline snippets into typed Cases and asserts
 * the anchor specs, resume scripts, and cell_id derivation.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILLS } from "@autobroker/skills";
import { describe, expect, it } from "vitest";

import { cellIdFor, loadCase, parseCase } from "./cases.js";
import { parseToml } from "./toml.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = join(HERE, "cases");

describe("toml parser (case grammar)", () => {
  it("parses tables, arrays-of-tables, strings, ints, bools, null, arrays", () => {
    const t = parseToml(`
      # comment
      [meta]
      id = "x"
      n = 25
      flag = true
      nothing = null
      list = ["a", "b"]

      [[steps]]
      id = "s1"

      [[steps]]
      id = "s2"
    `);
    expect((t["meta"] as Record<string, unknown>)["id"]).toBe("x");
    expect((t["meta"] as Record<string, unknown>)["n"]).toBe(25);
    expect((t["meta"] as Record<string, unknown>)["flag"]).toBe(true);
    expect((t["meta"] as Record<string, unknown>)["nothing"]).toBeNull();
    expect((t["meta"] as Record<string, unknown>)["list"]).toEqual(["a", "b"]);
    expect((t["steps"] as unknown[]).length).toBe(2);
  });

  it("strips a # inside a string only when it is outside quotes", () => {
    const t = parseToml(`prompt = "buy a car # now"`);
    expect(t["prompt"]).toBe("buy a car # now");
  });

  it("fails LOUD on a multi-line array (unsupported)", () => {
    expect(() => parseToml(`x = [\n 1,\n 2\n]`)).toThrow(/multi-line/);
  });

  it("fails LOUD on a malformed line (no =)", () => {
    expect(() => parseToml(`just some words`)).toThrow(/expected key = value/);
  });
});

describe("case loader", () => {
  it("loads the slash case with the 6+1 anchor subset", () => {
    const c = loadCase(join(CASES, "search_profile_intake.slash.toml"));
    expect(c.id).toBe("search_profile_intake_slash");
    expect(c.inputMode).toBe("slash");
    expect(c.provider).toBe("deepseek");
    const step = c.steps[0]!;
    const kinds = step.anchors.map((a) => a.kind);
    expect(kinds).toContain("run_status");
    expect(kinds).toContain("driver_kind");
    expect(kinds).toContain("table_min_rows");
    expect(kinds).toContain("no_external_mutation");
    expect(kinds).toContain("cost_and_time");
    expect(kinds).toContain("malformed_tool_call");
  });

  it("derives the driver_kind expect from the provider (deepseek → deepseek_apikey)", () => {
    const c = loadCase(join(CASES, "search_profile_intake.slash.toml"));
    const dk = c.steps[0]!.anchors.find((a) => a.kind === "driver_kind");
    expect(dk).toMatchObject({ kind: "driver_kind", expect: "deepseek_apikey" });
  });

  it("loads the cross-provider slash variants (anthropic_apikey / openai_apikey)", () => {
    const a = loadCase(join(CASES, "search_profile_intake.slash_anthropic.toml"));
    expect(a.provider).toBe("anthropic");
    expect(a.steps[0]!.anchors.find((x) => x.kind === "driver_kind")).toMatchObject({
      kind: "driver_kind",
      expect: "anthropic_apikey",
    });
    expect(cellIdFor(a, a.steps[0]!)).toBe("live/search_profile_intake/anthropic/B/slash");

    const o = loadCase(join(CASES, "search_profile_intake.slash_openai.toml"));
    expect(o.provider).toBe("openai");
    expect(o.steps[0]!.anchors.find((x) => x.kind === "driver_kind")).toMatchObject({
      kind: "driver_kind",
      expect: "openai_apikey",
    });
    expect(cellIdFor(o, o.steps[0]!)).toBe("live/search_profile_intake/openai/B/slash");
  });

  it("resolves the collect resume content from narrative.profile (18 strict fields)", () => {
    const c = loadCase(join(CASES, "search_profile_intake.slash.toml"));
    const resume = c.steps[0]!.resume.find((r) => r.on === "data_collection")!;
    expect(resume.action).toBe("accept");
    expect(resume.content).not.toBeNull();
    expect(resume.content!["make"]).toBe("Hyundai");
    // nullable optionals are explicit null (not the string "null").
    expect(resume.content!["preferred_exterior_colors_json"]).toBeNull();
  });

  it("loads the freeform case in a SEPARATE cell_id (input_mode=freeform)", () => {
    const c = loadCase(join(CASES, "search_profile_intake.freeform.toml"));
    expect(c.inputMode).toBe("freeform");
    expect(cellIdFor(c, c.steps[0]!)).toBe("live/search_profile_intake/deepseek/B/freeform");
    expect(c.steps[0]!.inputInline?.["prompt"]).toContain("Tucson");
  });

  it("loads the decline case (run_status declined, exact delta 0)", () => {
    const c = loadCase(join(CASES, "search_profile_intake.decline.toml"));
    const resume = c.steps[0]!.resume[0]!;
    expect(resume.action).toBe("decline");
    expect(resume.content).toBeNull();
    const rs = c.steps[0]!.anchors.find((a) => a.kind === "run_status");
    expect(rs).toMatchObject({ kind: "run_status", expect: ["declined"] });
    const tmr = c.steps[0]!.anchors.find((a) => a.kind === "table_min_rows");
    expect(tmr).toMatchObject({ exact: true, deltaMin: 0 });
  });

  it("loads the force-override case folding force_override into resume content", () => {
    const c = loadCase(join(CASES, "search_profile_intake.force_override.toml"));
    const fo = c.steps[0]!.resume.find((r) => r.on === "force_override")!;
    // The case authored action="force_override"; the loader folds it into content
    // {action:"force_override", reason} with the outer form action = accept.
    expect(fo.action).toBe("accept");
    expect(fo.content).toMatchObject({ action: "force_override", reason: expect.any(String) });
    const gate = c.steps[0]!.anchors.find((a) => a.kind === "approval_gate");
    expect(gate).toBeDefined();
    const audit = c.steps[0]!.anchors.find((a) => a.kind === "table_min_rows" && (a as { table?: string }).table === "audit_log");
    expect(audit).toMatchObject({ scope: "global", action: "intake_verification_forced" });
  });

  it("loads the deferred #1244 case with the fail_closed anchor", () => {
    const c = loadCase(join(CASES, "search_profile_intake.malformed_1244.deferred.toml"));
    const mf = c.steps[0]!.anchors.find((a) => a.kind === "malformed_tool_call");
    expect(mf).toMatchObject({ kind: "malformed_tool_call", expect: "fail_closed" });
  });

  it("defaults lane to api and launch to the input_mode-derived surface", () => {
    const c = loadCase(join(CASES, "search_profile_intake.slash.toml"));
    expect(c.lane).toBe("api");
    expect(c.steps[0]!.launch).toBe("chat_slash");
    const f = loadCase(join(CASES, "search_profile_intake.freeform.toml"));
    expect(f.steps[0]!.launch).toBe("chat_freeform");
  });

  it("loads the UI-lane intake cases (lane=ui; launch surfaces)", () => {
    const s = loadCase(join(CASES, "search_profile_intake.ui_slash.toml"));
    expect(s.lane).toBe("ui");
    expect(s.steps[0]!.launch).toBe("chat_slash");
    const f = loadCase(join(CASES, "search_profile_intake.ui_freeform.toml"));
    expect(f.lane).toBe("ui");
    expect(f.steps[0]!.launch).toBe("chat_freeform");
    const d = loadCase(join(CASES, "search_profile_intake.ui_decline.toml"));
    expect(d.lane).toBe("ui");
    expect(d.steps[0]!.resume[0]!.action).toBe("decline");
  });

  it("loads the geosearch ui_narrative case (two steps; profile_dealers anchor; optional cost)", () => {
    const c = loadCase(join(CASES, "dealer_geosearch.ui_narrative.toml"));
    expect(c.lane).toBe("ui");
    expect(c.steps).toHaveLength(2);
    expect(c.steps[0]!.skill).toBe("search_profile_intake");
    const geo = c.steps[1]!;
    expect(geo.skill).toBe("dealer_geosearch");
    expect(geo.launch).toBe("chat_slash");
    expect(geo.resume).toHaveLength(0); // no-suspend skill — nothing to resume.
    expect(geo.anchors.find((a) => a.kind === "browser_activity")).toBeDefined();
    expect(geo.anchors.find((a) => a.kind === "table_min_rows")).toMatchObject({
      table: "profile_dealers",
      scope: "profile",
      deltaMin: 1,
    });
    expect(geo.anchors.find((a) => a.kind === "cost_and_time")).toMatchObject({ optional: true });
    expect(cellIdFor(c, geo)).toBe("live/dealer_geosearch/deepseek/A/slash");
  });

  it("loads the geosearch ui_button case (step 2 launches from the Skills popover)", () => {
    const c = loadCase(join(CASES, "dealer_geosearch.ui_button.toml"));
    expect(c.steps[1]!.launch).toBe("skills_popover");
    expect(c.steps[1]!.anchors.find((a) => a.kind === "cost_and_time")).toMatchObject({ optional: true });
  });

  it("loads the 0-profile STOP case (expect_stop; error terminal; optional cost)", () => {
    const c = loadCase(join(CASES, "dealer_geosearch.stop_intake_cta.toml"));
    expect(c.lane).toBe("ui");
    expect(c.steps).toHaveLength(1);
    const step = c.steps[0]!;
    expect(step.expectStop).toBe("no_active_profile");
    expect(step.anchors.find((a) => a.kind === "run_status")).toMatchObject({ expect: ["error"] });
    expect(step.anchors.find((a) => a.kind === "cost_and_time")).toMatchObject({ optional: true });
  });

  it("loads the 2-profile STOP→picker case (two intakes; stop_picker launch + scope-from + resolution)", () => {
    const c = loadCase(join(CASES, "dealer_geosearch.stop_picker.toml"));
    expect(c.steps.map((s) => s.id)).toEqual(["intake_a", "intake_b", "geosearch_stop", "geosearch_picked"]);
    // intake_b's content is INLINE (a second vehicle — not narrative.profile).
    const b = c.steps[1]!.resume[0]!;
    expect(b.content).toMatchObject({ make: "Toyota", model: "RAV4 Hybrid" });
    expect(b.content!["preferred_exterior_colors_json"]).toBeNull();
    // the STOP step expects the typed 2+ code with an error terminal.
    const stop = c.steps[2]!;
    expect(stop.expectStop).toBe("multiple_active_profiles");
    expect(stop.anchors.find((a) => a.kind === "run_status")).toMatchObject({ expect: ["error"] });
    // the picked step: stop_picker launch + the pick-by-vehicle-label key +
    // profile scoping pinned to intake_a + the resolution anchor.
    const picked = c.steps[3]!;
    expect(picked.launch).toBe("stop_picker");
    expect(picked.inputInline?.["pick_label"]).toBe("2026 Hyundai Tucson Hybrid Limited");
    expect(picked.profileScopeFrom).toBe("intake_a");
    expect(picked.anchors.find((a) => a.kind === "resolution")).toMatchObject({
      kind: "resolution",
      expect: "pinned",
    });
  });

  it("fails LOUD on a stop_picker step with no pick_label", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["dealer_geosearch"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "dealer_geosearch"
      launch = "stop_picker"
      [[steps.anchors]]
      kind = "run_status"
      expect = ["done"]
    `;
    expect(() => parseCase(src)).toThrow(/pick_label/);
  });

  it("fails LOUD on a profile_scope_from naming no earlier step", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["dealer_geosearch"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "dealer_geosearch"
      profile_scope_from = "ghost_step"
      [[steps.anchors]]
      kind = "run_status"
      expect = ["done"]
    `;
    expect(() => parseCase(src)).toThrow(/does not name an earlier step/);
  });

  it("fails LOUD on a resolution anchor with a bad expect", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["dealer_geosearch"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "dealer_geosearch"
      [[steps.anchors]]
      kind = "resolution"
      expect = "newest"
    `;
    expect(() => parseCase(src)).toThrow(/resolution anchor requires/);
  });

  it("fails LOUD on an unknown anchor kind (a typo never silently skips a check)", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["search_profile_intake"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "search_profile_intake"
      [[steps.anchors]]
      kind = "run_stats"
    `;
    expect(() => parseCase(src)).toThrow(/unknown anchor kind/);
  });

  it("loads the three EDGE cases (rotation pool: reload / double-click / SSE break)", () => {
    const reload = loadCase(join(CASES, "search_profile_intake.ui_reload.toml"));
    expect(reload.id).toBe("search_profile_intake_ui_reload_mid_form");
    expect(reload.lane).toBe("ui");
    expect(reload.steps[0]!.edge).toBe("reload_mid_form");

    const dbl = loadCase(join(CASES, "search_profile_intake.ui_double_click.toml"));
    expect(dbl.steps[0]!.edge).toBe("double_click_submit");
    // The double-click guard: a GLOBAL exact-1 row bound (a duplicate profile
    // would carry a different id and slip past any profile-scoped delta).
    expect(
      dbl.steps[0]!.anchors.find((a) => a.kind === "table_min_rows" && a.scope === "global"),
    ).toMatchObject({ table: "search_profiles", scope: "global", min: 1, exact: true });

    const sse = loadCase(join(CASES, "dealer_geosearch.ui_sse_break.toml"));
    expect(sse.steps.map((s) => s.edge)).toEqual([null, "sse_break"]);
    expect(sse.steps[1]!.skill).toBe("dealer_geosearch");
  });

  it("fails LOUD on an unknown edge value (the closed enum)", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "B"
      skills = ["search_profile_intake"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "search_profile_intake"
      edge = "tab_close"
      [[steps.anchors]]
      kind = "run_status"
      expect = ["done"]
    `;
    expect(() => parseCase(src)).toThrow();
  });
});

describe("B2 batch grammar (max_seconds / pin_label / batch rows / suspend.targets)", () => {
  it("loads the H3 narrative-prefix journey (pin verb + per-step budget + batch select-all + cross-check)", () => {
    const c = loadCase(join(CASES, "dealer_pipeline.ui_prefix.toml"));
    expect(c.sessionOrigin).toBe("reuse_pinned");
    expect(c.steps.map((s) => s.id)).toEqual(["intake_create", "geosearch_run", "scan_run"]);
    // The explicit Pin verb rides the INTAKE step's post-checks.
    expect(c.steps[0]!.pinLabel).toBe("2026 Hyundai Tucson Hybrid Limited");
    // Pinned provenance asserted on BOTH downstream steps.
    expect(c.steps[1]!.anchors.find((a) => a.kind === "resolution")).toMatchObject({ expect: "pinned" });
    const scan = c.steps[2]!;
    expect(scan.anchors.find((a) => a.kind === "resolution")).toMatchObject({ expect: "pinned" });
    // PER-STEP budget: only the scan step carries 1800.
    expect(c.steps[0]!.maxSeconds).toBeNull();
    expect(scan.maxSeconds).toBe(1800);
    // The batch resume: select-all shape (no rows; default approve).
    const batch = scan.resume.find((r) => r.on === "batch_review")!;
    expect(batch.action).toBe("accept");
    expect(batch.rows).toBeNull();
    expect(batch.defaultDecision).toBe("approve");
    // The cross-step row-count check names the geosearch step.
    expect(scan.batchRowsFrom).toBe("geosearch_run");
    // Both inventory tables anchored; cost_and_time REQUIRED (no optional key).
    const tables = scan.anchors.filter((a) => a.kind === "table_min_rows").map((a) => (a as { table: string }).table);
    expect(tables).toEqual(expect.arrayContaining(["inventory_listings", "dealer_inventory_sources"]));
    expect(scan.anchors.find((a) => a.kind === "cost_and_time")).toEqual({ kind: "cost_and_time" });
  });

  it("loads the ui_button case (skills_popover launch; inferred_newest both ways)", () => {
    const c = loadCase(join(CASES, "inventory_site_scan.ui_button.toml"));
    expect(c.sessionOrigin).toBe("fresh_unpinned");
    const scan = c.steps[2]!;
    expect(scan.launch).toBe("skills_popover");
    expect(scan.maxSeconds).toBe(1800);
    expect(scan.anchors.find((a) => a.kind === "resolution")).toMatchObject({ expect: "inferred_newest" });
  });

  it("loads the decline twin (declined terminal; both tables exact-0; browser absent)", () => {
    const c = loadCase(join(CASES, "inventory_site_scan.ui_decline.toml"));
    const scan = c.steps[2]!;
    expect(scan.resume[0]).toMatchObject({ on: "batch_review", action: "decline", content: null });
    expect(scan.anchors.find((a) => a.kind === "run_status")).toMatchObject({ expect: ["declined"] });
    const tables = scan.anchors.filter((a) => a.kind === "table_min_rows");
    expect(tables).toHaveLength(2);
    for (const t of tables) expect(t).toMatchObject({ deltaMin: 0, exact: true, scope: "profile" });
    expect(scan.anchors.find((a) => a.kind === "browser_activity")).toMatchObject({ expect: "absent" });
  });

  it("parses [[steps.resume.rows]] entries + default_decision into the typed resume", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["inventory_site_scan"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "inventory_site_scan"
      [[steps.resume]]
      on = "batch_review"
      action = "accept"
      default_decision = "skip"
      [[steps.resume.rows]]
      match = "Tustin Hyundai"
      decision = "approve"
      [[steps.resume.rows]]
      match = "Anaheim Hyundai"
      decision = "skip"
      [[steps.anchors]]
      kind = "run_status"
      expect = ["done"]
    `;
    const c = parseCase(src);
    const r = c.steps[0]!.resume[0]!;
    expect(r.rows).toEqual([
      { match: "Tustin Hyundai", decision: "approve" },
      { match: "Anaheim Hyundai", decision: "skip" },
    ]);
    expect(r.defaultDecision).toBe("skip");
    // rows/default_decision are STRUCTURAL — never folded into content.
    expect(r.content).toBeNull();
  });

  it("parses content_from=suspend.targets as a DRIVE-TIME source (content stays null)", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["inventory_site_scan"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "inventory_site_scan"
      [[steps.resume]]
      on = "batch_review"
      action = "accept"
      content_from = "suspend.targets"
      [[steps.anchors]]
      kind = "run_status"
      expect = ["done"]
    `;
    const r = parseCase(src).steps[0]!.resume[0]!;
    expect(r.contentFrom).toBe("suspend.targets");
    expect(r.content).toBeNull();
  });

  it("fails LOUD on an unknown content_from source", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["inventory_site_scan"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "inventory_site_scan"
      [[steps.resume]]
      on = "batch_review"
      action = "accept"
      content_from = "suspend.targtes"
      [[steps.anchors]]
      kind = "run_status"
      expect = ["done"]
    `;
    expect(() => parseCase(src)).toThrow(/unknown content_from/);
  });

  it("fails LOUD on a batch_rows_from naming no earlier step", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["inventory_site_scan"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "inventory_site_scan"
      batch_rows_from = "ghost_step"
      [[steps.anchors]]
      kind = "run_status"
      expect = ["done"]
    `;
    expect(() => parseCase(src)).toThrow(/does not name an earlier step/);
  });

  it("fails LOUD on a browser_activity anchor with a bad expect", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["inventory_site_scan"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "inventory_site_scan"
      [[steps.anchors]]
      kind = "browser_activity"
      expect = "none"
    `;
    expect(() => parseCase(src)).toThrow(/browser_activity anchor/);
  });
});

describe("B3 seed grammar ([[seed.dealer_inventory_sources]])", () => {
  const seededCase = (extra = "") => `
    [meta]
    id = "x"
    archetype = "A"
    skills = ["inventory_link_scan"]
    [narrative]
    session_origin = "fresh_unpinned"
    input_mode = "slash"
    provider = "deepseek"
    [[seed.dealer_inventory_sources]]
    dealer = "Tustin Hyundai"
    url = "https://www.tustinhyundai.com/new-inventory/index.htm"
    ${extra}
    [[steps]]
    id = "s"
    skill = "inventory_link_scan"
    [[steps.anchors]]
    kind = "run_status"
    expect = ["done"]
  `;

  it("parses seed rows with the manual default source_type", () => {
    const c = parseCase(seededCase());
    expect(c.seed).toEqual({
      dealerInventorySources: [
        {
          dealer: "Tustin Hyundai",
          url: "https://www.tustinhyundai.com/new-inventory/index.htm",
          sourceType: "manual",
        },
      ],
    });
  });

  it("accepts an explicit source_type and the pending status literal", () => {
    const c = parseCase(seededCase('source_type = "reply_link"\n    status = "pending"'));
    expect(c.seed?.dealerInventorySources[0]?.sourceType).toBe("reply_link");
  });

  it("rejects a non-pending status (the seeder writes nothing else)", () => {
    expect(() => parseCase(seededCase('status = "scanned"'))).toThrow();
  });

  it("a case with no seed section parses with seed null", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["inventory_link_scan"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "inventory_link_scan"
      [[steps.anchors]]
      kind = "run_status"
      expect = ["done"]
    `;
    expect(parseCase(src).seed).toBeNull();
  });
});

describe("case skill ids ∈ registry", () => {
  const REGISTRY_IDS = new Set(SKILLS.map((s) => s.id));
  const files = readdirSync(CASES).filter((f) => f.endsWith(".toml"));

  it("has case files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f}: every meta.skills[] and step.skill is a registry id`, () => {
      const c = loadCase(join(CASES, f));
      for (const id of c.skills) expect(REGISTRY_IDS).toContain(id);
      for (const step of c.steps) expect(REGISTRY_IDS).toContain(step.skill);
    });
  }
});

describe("B4 incentive_scrape cases (first-encounter approval + decline twin)", () => {
  it("loads the first-encounter case: approve step then the behavioral no-ask step", () => {
    const c = loadCase(join(CASES, "incentive_scrape.ui_first_encounter.toml"));
    expect(c.lane).toBe("ui");
    expect(c.seed).toBeNull(); // targets derive from the profile — no seeds.

    const first = c.steps[1]!;
    expect(first.skill).toBe("incentive_scrape");
    expect(first.maxSeconds).toBe(1200);
    expect(first.resume[0]).toMatchObject({ on: "oem_first_encounter", action: "accept" });
    expect(first.anchors.find((a) => a.kind === "approval_gate")).toEqual({ kind: "approval_gate" });
    expect(first.anchors.find((a) => a.kind === "table_min_rows")).toMatchObject({
      table: "manufacturer_incentives",
      scope: "profile",
      deltaMin: 1,
    });

    const noAsk = c.steps[2]!;
    expect(noAsk.resume).toHaveLength(0); // nothing suspends on the re-run.
    expect(noAsk.anchors.find((a) => a.kind === "approval_gate")).toMatchObject({ expect: "absent" });
    expect(noAsk.anchors.find((a) => a.kind === "browser_activity")).toMatchObject({ expect: "absent" });
    expect(noAsk.anchors.find((a) => a.kind === "table_min_rows")).toMatchObject({
      table: "manufacturer_incentives",
      deltaMin: 0,
      exact: true,
    });
    expect(noAsk.anchors.find((a) => a.kind === "cost_and_time")).toMatchObject({ optional: true });
  });

  it("loads the decline twin: declined terminal, zero nav, slice exact-0, asks AGAIN on the re-run", () => {
    const c = loadCase(join(CASES, "incentive_scrape.ui_decline.toml"));
    for (const stepIdx of [1, 2]) {
      const step = c.steps[stepIdx]!;
      expect(step.resume[0]).toMatchObject({ on: "oem_first_encounter", action: "decline", content: null });
      expect(step.anchors.find((a) => a.kind === "run_status")).toMatchObject({ expect: ["declined"] });
      // The gate RENDERED on every decline round (the re-run still asking is
      // the behavioral proof no registry entry was written).
      expect(step.anchors.find((a) => a.kind === "approval_gate")).toEqual({ kind: "approval_gate" });
      expect(step.anchors.find((a) => a.kind === "browser_activity")).toMatchObject({ expect: "absent" });
      expect(step.anchors.find((a) => a.kind === "table_min_rows")).toMatchObject({
        table: "manufacturer_incentives",
        deltaMin: 0,
        exact: true,
      });
      // The decline path is zero-LLM by construction — no cost anchor at all.
      expect(step.anchors.find((a) => a.kind === "cost_and_time")).toBeUndefined();
    }
  });

  it("fails LOUD on an approval_gate anchor with a bad expect", () => {
    const src = `
      [meta]
      id = "x"
      archetype = "A"
      skills = ["incentive_scrape"]
      [narrative]
      session_origin = "fresh_unpinned"
      input_mode = "slash"
      provider = "deepseek"
      [[steps]]
      id = "s"
      skill = "incentive_scrape"
      [[steps.anchors]]
      kind = "approval_gate"
      expect = "never"
    `;
    expect(() => parseCase(src)).toThrow(/approval_gate anchor/);
  });
});
