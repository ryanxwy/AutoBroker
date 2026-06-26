/**
 * In-stack tests — the Hybrid skills-popover re-rank (suggestNextSkills).
 *
 * Same real stack as router.test.ts: REAL suggestNextSkills → REAL
 * harness.generate → REAL #1244 Processor → REAL Zod belt against a
 * DETERMINISTIC fake LanguageModel + an ISOLATED tmp DB injected through the
 * harness `_testOverrides` seam. The contract under test:
 *   - a well-formed ranking is returned in order, deduped, and bounded;
 *   - a #1244 malformed output returns NULL (fail-closed → caller keeps the
 *     deterministic order), never a guessed rank;
 *   - empty candidates short-circuit to [] with no model call;
 *   - the conversation summary is budget-redacted before the prompt.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * the committed migration is applied to the throwaway DB. NEVER ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeProseDumpModel, makeStaticToolCallModel } from "@autobroker/model";
import { openDb, type Db } from "@autobroker/tools";

import {
  buildSuggestPrompt,
  redactBudgetText,
  suggestNextSkills,
  type SuggestContext,
} from "./router.js";
import type { HarnessLedgerContext } from "./harness.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = join(here, "..", "..", "db", "drizzle", "0000_military_red_skull.sql");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-suggest-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
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
  runId: "suggest-test-1",
  skill: "chat_route",
  layer: "L2",
  promptVersion: null,
  schemaVersion: null,
};

const CANDIDATES = ["dealer_geosearch", "inventory_site_scan", "inventory_link_scan"];

function ctx(over: Partial<SuggestContext> = {}): SuggestContext {
  return {
    candidateIds: CANDIDATES,
    conversation: "I just ran dealer_geosearch and found 8 dealers.",
    pinnedProfileId: null,
    ledger,
    ...over,
  };
}

/** A fake model emitting a well-formed emit_result with the given suggestions. */
function suggestModel(suggestions: { skill_id: string; reason: string }[]): Parameters<typeof suggestNextSkills>[1] {
  const model = makeStaticToolCallModel({
    toolName: "emit_result",
    args: { suggestions },
    modelId: "deepseek-v4-flash",
  });
  return { model, db };
}

describe("suggestNextSkills — Hybrid LLM re-rank (advisory, fail-closed)", () => {
  it("returns the model's ranking, in order, scoped to the candidates", async () => {
    const out = await suggestNextSkills(
      ctx(),
      suggestModel([
        { skill_id: "inventory_site_scan", reason: "scan the dealers you just found" },
        { skill_id: "inventory_link_scan", reason: "or paste specific listings" },
        { skill_id: "dealer_geosearch", reason: "widen the radius" },
      ]),
    );
    expect(out).not.toBeNull();
    expect(out?.map((s) => s.skillId)).toEqual([
      "inventory_site_scan",
      "inventory_link_scan",
      "dealer_geosearch",
    ]);
    expect(out?.[0]?.reason).toBe("scan the dealers you just found");
  });

  it("de-dupes a repeated candidate (keeps first)", async () => {
    const out = await suggestNextSkills(
      ctx(),
      suggestModel([
        { skill_id: "inventory_site_scan", reason: "scan" },
        { skill_id: "inventory_site_scan", reason: "scan again" },
        { skill_id: "dealer_geosearch", reason: "wider" },
      ]),
    );
    expect(out?.map((s) => s.skillId)).toEqual(["inventory_site_scan", "dealer_geosearch"]);
  });

  it("a partial ranking (model omits one) returns only what it ranked", async () => {
    const out = await suggestNextSkills(
      ctx(),
      suggestModel([{ skill_id: "inventory_site_scan", reason: "scan" }]),
    );
    expect(out?.map((s) => s.skillId)).toEqual(["inventory_site_scan"]);
  });

  it("a #1244 malformed output returns NULL (fail-closed — caller keeps deterministic order)", async () => {
    const model = makeProseDumpModel({
      text: '{"name":"emit_result","arguments":{"suggestions":[{"skill_id":"pipeline_reset","reason":"x"}]}}',
      modelId: "deepseek-v4-flash",
    });
    const out = await suggestNextSkills(ctx(), { model, db });
    expect(out).toBeNull();
  });

  it("empty candidates short-circuit to [] (no model call)", async () => {
    const out = await suggestNextSkills(ctx({ candidateIds: [] }));
    expect(out).toEqual([]);
  });
});

describe("redactBudgetText — inv #9 discipline (the rank never needs a dollar)", () => {
  it("strips $ amounts and grouped numbers from the conversation", () => {
    const red = redactBudgetText("My budget is $41,000 or 41,000 dollars, around $38k.");
    expect(red).not.toContain("41,000");
    expect(red).not.toContain("$41");
    expect(red).not.toContain("$38k");
    expect(red).toContain("[redacted]");
  });

  it("also strips BARE figures (40000), k-shorthand (42k), and 'grand'", () => {
    const red = redactBudgetText("I can spend 40000, maybe 42k, or 35 grand max.");
    expect(red).not.toMatch(/\b40000\b/);
    expect(red).not.toMatch(/\b42k\b/i);
    expect(red).not.toMatch(/35 grand/i);
    expect(red).toContain("[redacted]");
  });

  it("KEEPS a 4-digit model year (the rank legitimately uses it)", () => {
    const red = redactBudgetText("I want a 2026 RAV4.");
    expect(red).toContain("2026");
  });

  it("the prompt embeds the REDACTED conversation, not the raw budget", () => {
    const prompt = buildSuggestPrompt(ctx({ conversation: "I can spend $42,500 max." }));
    expect(prompt).not.toContain("$42,500");
    expect(prompt).toContain("[redacted]");
  });
});
