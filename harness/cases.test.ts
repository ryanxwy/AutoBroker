/**
 * cases.test.ts — TOML parse + case loading (task BUILD §7 "TOML parse tests").
 * Parses the committed case files + inline snippets into typed Cases and asserts
 * the anchor specs, resume scripts, and cell_id derivation.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
});
