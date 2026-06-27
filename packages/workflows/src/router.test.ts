/**
 * In-stack tests — the NL skill-router (classifySkillFromText).
 *
 * These drive the REAL classifier → REAL harness.generate → REAL Mastra Agent →
 * REAL #1244 output Processor → REAL Zod belt → REAL ledger writer against a
 * DETERMINISTIC fake LanguageModel (from @autobroker/model testSupport) and an
 * ISOLATED tmp DB injected through the harness `_testOverrides` seam. No live
 * LLM, no network — the whole fail-closed boundary is exercised on the real
 * stack, never a hand-rolled fake of it.
 *
 * Coverage (every fail-closed branch must degrade to clarify, never a guessed
 * launch):
 *   - a clear NL routes to the right skill (LAUNCH) — high confidence;
 *   - intake mapping: the launch inputData is { input_mode:"freeform",
 *     freeform_text: nl };
 *   - vague / low-confidence (< 0.6) → clarify;
 *   - skill "none" → clarify;
 *   - a #1244 malformed output → clarify (NEVER regex a skill out of content);
 *   - a destructive route under the 0.85 bar → clarify (extra caution).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * the committed migration is applied to the throwaway DB; the harness writes its
 * ledger row through an injected handle to that same DB. NEVER ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  makeProseDumpModel,
  makeStaticToolCallModel,
} from "@autobroker/model";
import { openDb, type Db } from "@autobroker/tools";

import { classifySkillFromText, type RouterContext } from "./router.js";
import type { HarnessLedgerContext } from "./harness.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
// 0000 creates test_run_records; 0005 adds the #1244 malformed-evidence columns
// the ledger writer (reached here via the LLM router) now always emits.
const MIGRATION_SQLS = ["0000_military_red_skull.sql", "0005_military_nightshade.sql"].map((f) =>
  join(here, "..", "..", "db", "drizzle", f),
);

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-router-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb(); // resolves <tmpDir>/autobroker.db
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  db.$client.exec("DELETE FROM test_run_records;");
});

const ledger: HarnessLedgerContext = {
  runId: "route-test-1",
  skill: "chat_route",
  layer: "L2",
  promptVersion: null,
  schemaVersion: null,
};

const ctx: RouterContext = { pinnedProfileId: null, ledger };

/** A fake model that emits a well-formed emit_result with the given decision. */
function decisionModel(args: {
  skill: string;
  confidence: number;
  reason?: string;
  params?: Record<string, string> | null;
}): Parameters<typeof classifySkillFromText>[2] {
  const model = makeStaticToolCallModel({
    toolName: "emit_result",
    args: {
      skill: args.skill,
      confidence: args.confidence,
      reason: args.reason ?? "test",
      params: args.params ?? null,
    },
    modelId: "deepseek-v4-flash",
  });
  return { model, db };
}

function ledgerRowCount(): number {
  const r = db.$client.prepare("SELECT COUNT(*) AS n FROM test_run_records").get() as { n: number };
  return r.n;
}

describe("classifySkillFromText — a clear NL routes to a LAUNCH", () => {
  it("'find dealers near Irvine 92614' → dealer_geosearch launch (high confidence)", async () => {
    const out = await classifySkillFromText(
      "find dealers near Irvine 92614",
      ctx,
      decisionModel({ skill: "dealer_geosearch", confidence: 0.95, reason: "wants nearby dealers" }),
    );
    expect(out.kind).toBe("launch");
    if (out.kind !== "launch") return; // narrow
    expect(out.skillId).toBe("dealer_geosearch");
    expect(out.confidence).toBe(0.95);
    // A non-intake skill carries minimal input (its own descriptor resolves scope).
    expect(out.inputData).toEqual({});
    // Exactly ONE ledger row was written for the classify call.
    expect(ledgerRowCount()).toBe(1);
  });

  it("intake mapping: 'I want a 2026 Tucson near Irvine' → intake with the freeform seed", async () => {
    const nl = "I want a 2026 Tucson near Irvine";
    const out = await classifySkillFromText(
      nl,
      ctx,
      decisionModel({ skill: "intake", confidence: 0.9, reason: "starting a new search" }),
    );
    expect(out.kind).toBe("launch");
    if (out.kind !== "launch") return; // narrow
    expect(out.skillId).toBe("search_profile_intake");
    expect(out.inputData).toEqual({ input_mode: "freeform", freeform_text: nl });
  });
});

describe("classifySkillFromText — fail-closed → clarify (never a guessed launch)", () => {
  it("low confidence (< 0.6) → clarify, no run", async () => {
    const out = await classifySkillFromText(
      "do the thing",
      ctx,
      decisionModel({ skill: "dealer_geosearch", confidence: 0.4, reason: "unsure" }),
    );
    expect(out.kind).toBe("clarify");
    if (out.kind !== "clarify") return; // narrow
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]?.skillId).toBe("dealer_geosearch");
  });

  it("skill 'none' → clarify", async () => {
    const out = await classifySkillFromText(
      "hello there",
      ctx,
      decisionModel({ skill: "none", confidence: 0.99, reason: "just a greeting" }),
    );
    expect(out.kind).toBe("clarify");
  });

  it("a #1244 malformed output → clarify (a tool-shaped prose dump is NOT parsed into a launch)", async () => {
    // A prose dump that LOOKS like a tool call — the #1244 detector must catch it
    // and the harness throws MalformedToolCallAbort (hitlAvailable:false) → clarify.
    const model = makeProseDumpModel({
      text: '{"name":"emit_result","arguments":{"skill":"pipeline_reset","confidence":1}}',
      modelId: "deepseek-v4-flash",
    });
    const out = await classifySkillFromText("reset everything", ctx, { model, db });
    expect(out.kind).toBe("clarify");
    // The malformed call still wrote ONE ledger row (fail_reason malformed_tool_call).
    expect(ledgerRowCount()).toBe(1);
    const row = db.$client
      .prepare("SELECT fail_reason FROM test_run_records LIMIT 1")
      .get() as { fail_reason: string | null };
    expect(row.fail_reason).toBe("malformed_tool_call");
  });

  it("a destructive route under the 0.85 bar → clarify (extra caution on dangerous routes)", async () => {
    const out = await classifySkillFromText(
      "maybe clean up my dealers",
      ctx,
      decisionModel({ skill: "dealer_hygiene", confidence: 0.7, reason: "might want hygiene" }),
    );
    // 0.7 clears the generic 0.6 floor but NOT the 0.85 destructive floor.
    expect(out.kind).toBe("clarify");
    if (out.kind !== "clarify") return; // narrow
    expect(out.candidates[0]?.skillId).toBe("dealer_hygiene");
  });

  it("a destructive route AT the 0.85 bar DOES launch (it only reaches the skill's own typed-YES gate)", async () => {
    const out = await classifySkillFromText(
      "reset my whole pipeline now",
      ctx,
      decisionModel({ skill: "pipeline_reset", confidence: 0.9, reason: "explicit reset" }),
    );
    expect(out.kind).toBe("launch");
    if (out.kind !== "launch") return; // narrow
    expect(out.skillId).toBe("pipeline_reset");
    // The router builds NO approval/confirmation — the launch only brings the
    // user to pipeline_reset's own typed-YES second-confirm gate downstream.
    expect(out.inputData).toEqual({});
  });
});

describe("classifySkillFromText — confidence boundaries + params discard", () => {
  // The decision logic is `confidence < FLOOR` (strict), so the floor itself
  // LAUNCHES and the value just below it clarifies — pin both sides.
  it("EXACTLY at the 0.6 floor (non-destructive) launches (< is exclusive)", async () => {
    const out = await classifySkillFromText(
      "compare my quotes",
      ctx,
      decisionModel({ skill: "quote_compare", confidence: 0.6, reason: "wants a comparison" }),
    );
    expect(out.kind).toBe("launch");
    if (out.kind !== "launch") return; // narrow
    expect(out.skillId).toBe("quote_compare");
  });

  it("just BELOW the 0.6 floor (0.59) → clarify", async () => {
    const out = await classifySkillFromText(
      "compare my quotes",
      ctx,
      decisionModel({ skill: "quote_compare", confidence: 0.59, reason: "maybe a comparison" }),
    );
    expect(out.kind).toBe("clarify");
  });

  it("a destructive route EXACTLY at the 0.85 floor launches (only reaches its own gate)", async () => {
    const out = await classifySkillFromText(
      "reset my whole pipeline now",
      ctx,
      decisionModel({ skill: "pipeline_reset", confidence: 0.85, reason: "explicit reset" }),
    );
    expect(out.kind).toBe("launch");
    if (out.kind !== "launch") return; // narrow
    expect(out.skillId).toBe("pipeline_reset");
  });

  it("a destructive route just BELOW 0.85 (0.84) → clarify", async () => {
    const out = await classifySkillFromText(
      "maybe reset everything",
      ctx,
      decisionModel({ skill: "pipeline_reset", confidence: 0.84, reason: "might reset" }),
    );
    expect(out.kind).toBe("clarify");
    if (out.kind !== "clarify") return; // narrow
    expect(out.candidates[0]?.skillId).toBe("pipeline_reset");
  });

  it("an out-of-range confidence (2, fails the [0,1] Zod belt) → clarify, never a launch", async () => {
    const out = await classifySkillFromText(
      "find dealers near Irvine 92614",
      ctx,
      decisionModel({ skill: "dealer_geosearch", confidence: 2, reason: "over-confident" }),
    );
    expect(out.kind).toBe("clarify");
  });

  it("model-extracted params are DISCARDED on a non-intake launch (never fed to buildInput)", async () => {
    const out = await classifySkillFromText(
      "find dealers within 50 miles of 92614",
      ctx,
      decisionModel({
        skill: "dealer_geosearch",
        confidence: 0.95,
        reason: "wants nearby dealers",
        params: { radius: "50", zip: "92614" },
      }),
    );
    expect(out.kind).toBe("launch");
    if (out.kind !== "launch") return; // narrow
    // params are a model scratch slot only — inputData stays the minimal {}.
    expect(out.inputData).toEqual({});
  });

  it("intake launch carries ONLY the freeform seed even when the model emits params", async () => {
    const nl = "looking for a tucson around irvine maybe 41k";
    const out = await classifySkillFromText(
      nl,
      ctx,
      decisionModel({
        skill: "intake",
        confidence: 0.9,
        reason: "new search",
        params: { make: "Hyundai", budget: "41000" },
      }),
    );
    expect(out.kind).toBe("launch");
    if (out.kind !== "launch") return; // narrow
    // budget/make params must NOT leak into inputData (only the prose seed).
    expect(out.inputData).toEqual({ input_mode: "freeform", freeform_text: nl });
  });
});
