/**
 * SPIKE-1 (LIVE HALF) — real-key DeepSeek foundation probe.
 *
 * Foundation goal #1: a real .env-key DeepSeek probe returns a Zod-valid object.
 * Deliverable: the FIRST `test_run_records` row, written through the real
 * production ledger path into the REAL parity DB (~/.autobroker-ts/autobroker.db).
 *
 * Two LIVE probes, DeepSeek ONLY, gated behind AUTOBROKER_SPIKE_LIVE=1 so they
 * never run in CI / a normal `pnpm test`:
 *
 *   PROBE A — emit_result through harness.generate (the real foundation goal).
 *     useCase 'foundation_probe' → policy routes to deepseek.cheap
 *     (deepseek-v4-flash). A small flat all-required Zod object is requested. The
 *     run goes through the COMMITTED harness.generate facade: real Agent → real
 *     #1244 output Processor → real ledger writer.
 *
 *     DELIBERATE CARVE-OUT (the ONE place this spike writes to the parity dir):
 *       we do NOT inject a test DB and do NOT override AUTOBROKER_DATA_DIR, so the
 *       single ledger row lands in the REAL ~/.autobroker-ts/autobroker.db through
 *       the production openDb() path — that landed row IS the first-ever
 *       test_run_records deliverable. Everything else about the parity DB is
 *       read-only; we add exactly ONE row per probe-run (a bounded retry may add
 *       up to 2). We NEVER touch the legacy production ~/.autobroker.
 *
 *       The parity DB is a cold-copied LEGACY snapshot that predates the
 *       TS-repo-only `test_run_records` table (the table is hand-authored, not
 *       from drizzle-kit pull — see packages/db/src/testRunRecords.ts). So before
 *       the carve-out write we idempotently ensure ONLY that one table exists, by
 *       extracting its exact committed CREATE statement from the migration file
 *       (0000_*.sql) and running it with IF NOT EXISTS. We never run the whole
 *       migration against the parity DB (that would collide with the legacy
 *       tables already present).
 *
 *   PROBE B — thinking-ON tool loop reasoning_content round-trip.
 *     NOT through harness.generate (that lane forces thinking DISABLED by design).
 *     We build a Mastra Agent directly (resolveModel('deepseek.chat') →
 *     deepseek-v4-flash), give it ONE trivial tool, and call agent.generate with
 *     toolChoice AUTO and providerOptions { deepseek: { thinking: { type:
 *     'enabled' }, reasoningEffort: 'high' } }. The prompt forces a tool call then
 *     a final answer, so the loop is multi-turn — turn 2 must round-trip the
 *     turn-1 reasoning_content back to the API or DeepSeek hard-400s
 *     ('reasoning_content' error). PASS = no 400, tool called >=1, final text
 *     non-empty. This is the IN-STACK (Mastra-loop) evidence to go with the
 *     28/28-clean API-layer probe from 2026-06-04. This probe writes NO ledger row
 *     (it is not a harness.generate call).
 *
 * Run live:
 *   set -a; . <repo>/.env; set +a; \
 *   AUTOBROKER_SPIKE_LIVE=1 MASTRA_TELEMETRY_DISABLED=1 \
 *   AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1 \
 *   pnpm --filter @autobroker/workflows exec vitest run \
 *     spikes/spike1.foundationProbe.live.test.ts
 *
 * API surface (researched in node_modules .d.ts this session, not guessed):
 *   - harness.generate(input, ledger)  — the committed facade (src/harness.ts);
 *     called with NO _testOverrides so it uses resolveModel + production openDb().
 *   - @ai-sdk/deepseek deepseekLanguageModelOptions:
 *       { thinking?: { type?: 'enabled'|'disabled'|'adaptive' },
 *         reasoningEffort?: 'low'|'medium'|'high'|'xhigh'|'max' }  (dist/index.d.ts).
 *   - Agent.generate(messages, opts): FullOutput — opts has toolChoice
 *     ('auto'|'none'|'required'|{...}), providerOptions, modelSettings, maxSteps
 *     (AgentExecutionOptionsBase, agent.types.d.ts). FullOutput exposes
 *     text:string, steps:LLMStepResult[], toolCalls[], finishReason, usage,
 *     tripwire (stream/base/output.d.ts).
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { resolveModel, type HarnessGenerateInput } from "@autobroker/model";
import { openDb } from "@autobroker/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { harness, type HarnessLedgerContext } from "../src/harness.js";

const LIVE = process.env["AUTOBROKER_SPIKE_LIVE"] === "1";

// The committed AI-SDK-v6 ↔ Mastra provider-version cast (harness.ts uses the
// identical one): resolveModel() returns an `ai@6` LanguageModel, structurally
// valid at runtime but compile-time-distinct from Mastra's bundled provider
// types. This is the EXACT Mastra model-config type, not an any-escape.
type AgentModelConfig = ConstructorParameters<typeof Agent>[0]["model"];

const here = dirname(fileURLToPath(import.meta.url));
// The committed migration carrying the test_run_records DDL (same file the
// in-stack harness.test.ts applies to its tmp DB).
const MIGRATION_SQL = join(
  here,
  "..",
  "..",
  "db",
  "drizzle",
  "0000_military_red_skull.sql",
);
const PARITY_DB = join(homedir(), ".autobroker-ts", "autobroker.db");

/** Today's run-window id for the ledger row (deliverable provenance). */
function todayStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Extract the exact, committed `CREATE TABLE test_run_records (...)` statement
 * from the migration file and return it rewritten with IF NOT EXISTS. We use the
 * canonical DDL verbatim (only inserting IF NOT EXISTS) rather than hand-authoring
 * a divergent copy — the migration is the single source of truth for the shape.
 */
function testRunRecordsCreateIfNotExists(): string {
  const sql = readFileSync(MIGRATION_SQL, "utf8");
  const start = sql.indexOf("CREATE TABLE `test_run_records`");
  if (start === -1) {
    throw new Error(
      "spike1: could not find the test_run_records CREATE statement in the migration",
    );
  }
  // The statement is self-contained and terminated by the first ");" at column 0.
  const end = sql.indexOf("\n);", start);
  if (end === -1) {
    throw new Error("spike1: malformed test_run_records CREATE statement (no terminator)");
  }
  const stmt = sql.slice(start, end + 3); // include the "\n);"
  return stmt.replace(
    "CREATE TABLE `test_run_records`",
    "CREATE TABLE IF NOT EXISTS `test_run_records`",
  );
}

// ---------------------------------------------------------------------------
// PROBE A — emit_result through harness.generate, row lands in the parity DB.
// ---------------------------------------------------------------------------

/** Flat, all-required Zod contract (the emit_result discipline; corpus-adjacent
 *  content — Irvine CA + Hyundai — but the content is irrelevant to the probe). */
const probeSchema = z.object({
  city: z.string(),
  state: z.string(),
  brand: z.string(),
});

interface ProbeAResult {
  object: z.infer<typeof probeSchema>;
  usage: {
    costUsd: number | null;
    durationMs: number;
    pricingSource: "computed" | "unavailable";
    promptTokens: number | null;
    completionTokens: number | null;
  };
  runId: string;
  // The row read back from the REAL parity DB (verbatim columns).
  row: {
    run_id: string;
    skill: string;
    layer: string;
    provider: string;
    model_alias: string;
    cost_usd: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    pricing_source: string;
    fail_reason: string | null;
  } | null;
}

let probeA: ProbeAResult | undefined;

describe.skipIf(!LIVE)("spike1 PROBE A — foundation_probe → ledger row in the parity DB", () => {
  beforeAll(async () => {
    // Ensure ONLY the test_run_records table exists in the legacy-snapshot parity
    // DB (idempotent; never the whole migration). Use the same production openDb()
    // the harness writes through, so the table is created on the very connection
    // family the ledger writer opens.
    const ensureDb = openDb(PARITY_DB);
    ensureDb.$client.exec(testRunRecordsCreateIfNotExists());
    ensureDb.$client.close();

    const runId = `m0-spike1-${todayStamp()}`;

    const input: HarnessGenerateInput<typeof probeSchema> = {
      useCase: "foundation_probe",
      schema: probeSchema,
      prompt:
        "Hyundai is a car brand. The user is shopping in Irvine, California. " +
        "Return the city, the two-letter US state code, and the car brand as a " +
        "structured result by calling the emit_result tool exactly once.",
      hitlAvailable: false,
    };

    const ledger: HarnessLedgerContext = {
      runId,
      skill: "foundation_probe",
      // L2 = a single skill driven live through harness.generate; L1 is the
      // zero-LLM floor (does not apply to a live LLM call).
      layer: "L2",
      provider: "deepseek",
      modelAlias: "deepseek.cheap",
      promptVersion: null,
      schemaVersion: null,
    };

    // DELIBERATE CARVE-OUT: no _testOverrides → resolveModel() picks the real
    // DeepSeek model, and writeTestRunRecord() opens the production parity DB.
    // Bounded retry: each harness.generate attempt legitimately writes its OWN
    // ledger row (success or typed failure), so we cap at 2 attempts to keep the
    // parity-dir footprint small while tolerating a transient provider blip.
    let out: Awaited<ReturnType<typeof harness.generate<typeof probeSchema>>> | undefined;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        out = await harness.generate(input, ledger);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (out === undefined) {
      throw new Error(
        `spike1 PROBE A: harness.generate failed after 2 attempts: ${String(lastErr)}`,
      );
    }
    if (!("object" in out)) {
      // hitlAvailable is false, so a #1244 trip would have THROWN, not suspended;
      // a suspend object here would be a contract break. Surface it loudly.
      throw new Error(
        `spike1 PROBE A: expected a structured object, got a suspend: ${JSON.stringify(out)}`,
      );
    }

    // Read the row back from the REAL parity DB (read-only) by run_id.
    const readDb = openDb(PARITY_DB);
    const row = readDb.$client
      .prepare(
        "SELECT run_id, skill, layer, provider, model_alias, cost_usd, input_tokens, " +
          "output_tokens, pricing_source, fail_reason FROM test_run_records " +
          "WHERE run_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(runId) as ProbeAResult["row"];
    readDb.$client.close();

    probeA = { object: out.object, usage: out.usage, runId, row };

    // eslint-disable-next-line no-console
    console.log(
      "\n[spike1·A] ===== foundation_probe → parity-DB ledger row =====\n" +
        `  runId: ${runId}\n` +
        `  returned object: ${JSON.stringify(out.object)}\n` +
        `  usage: pricingSource=${out.usage.pricingSource} costUsd=${out.usage.costUsd} ` +
        `prompt=${out.usage.promptTokens} completion=${out.usage.completionTokens} ` +
        `durationMs=${out.usage.durationMs}\n` +
        `  ledger row (parity DB): ${JSON.stringify(row)}\n` +
        "[spike1·A] ===========================================================\n",
    );
  }, 120_000);

  afterAll(() => {
    // No teardown: the carve-out row is the deliverable and is intentionally
    // KEPT in the parity DB. We never delete it and never drop the table.
  });

  it("returns a Zod-valid object", () => {
    expect(probeA).toBeDefined();
    // The harness already Zod-parsed it; assert the shape anyway.
    const parsed = probeSchema.safeParse(probeA!.object);
    expect(parsed.success).toBe(true);
    expect(typeof probeA!.object.city).toBe("string");
    expect(typeof probeA!.object.state).toBe("string");
    expect(typeof probeA!.object.brand).toBe("string");
  });

  it("landed the ledger row in the REAL parity DB (first-ever test_run_records row)", () => {
    expect(probeA!.row).not.toBeNull();
    expect(probeA!.row!.run_id).toBe(probeA!.runId);
    expect(probeA!.row!.skill).toBe("foundation_probe");
    expect(probeA!.row!.layer).toBe("L2");
    expect(probeA!.row!.provider).toBe("deepseek");
    expect(probeA!.row!.model_alias).toBe("deepseek.cheap");
    // A clean run records no fail_reason.
    expect(probeA!.row!.fail_reason).toBeNull();
  });

  it("priced the run off the DeepSeek table (flash reports usage → non-null cost)", () => {
    // deepseek-v4-flash is in the PRICING table and reports usage, so the row is
    // priced (pricing_source 'deepseek-2026-06', cost non-null). If DeepSeek ever
    // drops usage this would flip to 'unavailable' / null — which the row would
    // record honestly (NULL-not-$0), and this assertion would surface that change.
    expect(probeA!.row!.pricing_source).toBe("deepseek-2026-06");
    expect(probeA!.row!.cost_usd).not.toBeNull();
    expect(probeA!.row!.input_tokens).not.toBeNull();
    expect(probeA!.row!.output_tokens).not.toBeNull();
    expect(probeA!.usage.pricingSource).toBe("computed");
    expect(probeA!.usage.costUsd).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PROBE B — thinking-ON Mastra tool loop, reasoning_content round-trip
// ---------------------------------------------------------------------------

interface ProbeBResult {
  finishReason: string | undefined;
  turnCount: number;
  toolCallCount: number;
  finalText: string;
  wallMs: number;
}

let probeB: ProbeBResult | undefined;

describe.skipIf(!LIVE)("spike1 PROBE B — thinking-ON tool loop round-trips reasoning_content", () => {
  beforeAll(async () => {
    // resolveModel('deepseek.chat') → deepseek-v4-flash LanguageModel. Thinking is
    // turned ON per-request below; we do NOT force a named tool_choice (DeepSeek
    // thinking mode rejects a forced/named tool_choice), only AUTO, so the model
    // is free to reason then call the tool.
    const model = resolveModel("deepseek.chat");

    let toolCalls = 0;
    const lookupCityFact = createTool({
      id: "lookup_city_fact",
      description:
        "Look up a one-line trivia fact about a US city. Call this with the city name to get a fact you must then use to answer.",
      inputSchema: z.object({ city: z.string() }),
      execute: async () => {
        toolCalls += 1;
        // Canned fact — deterministic; the point is the round-trip, not the data.
        return { fact: "Irvine, California is home to a large master-planned community and UC Irvine." };
      },
    });

    const agent = new Agent({
      id: "spike1-thinking-probe",
      name: "spike1-thinking-probe",
      instructions:
        "You answer questions about US cities. When asked about a city, you MUST " +
        "first call the lookup_city_fact tool to retrieve a fact, then write a " +
        "one-sentence answer that incorporates the fact. Do not answer from memory.",
      model: model as AgentModelConfig,
      tools: { lookup_city_fact: lookupCityFact },
    });

    const t0 = performance.now();
    // thinking ENABLED + reasoningEffort high. With a tool in the loop this forces
    // turn 1 (reason → tool call), tool feed-back, turn 2 (reason → final text).
    // If Mastra does NOT round-trip turn-1 reasoning_content into the turn-2
    // request, DeepSeek hard-400s with a 'reasoning_content' error and this
    // generate() REJECTS — which is exactly the failure this probe asserts against.
    const result = await agent.generate(
      "Tell me one interesting fact about Irvine, California.",
      {
        toolChoice: "auto",
        maxSteps: 5,
        providerOptions: {
          deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" },
        },
        modelSettings: { temperature: 0 },
      },
    );
    const wallMs = Math.round(performance.now() - t0);

    probeB = {
      finishReason: result.finishReason,
      turnCount: result.steps.length,
      toolCallCount: toolCalls,
      finalText: result.text ?? "",
      wallMs,
    };

    // eslint-disable-next-line no-console
    console.log(
      "\n[spike1·B] ===== thinking-ON tool loop (reasoning_content round-trip) =====\n" +
        `  finishReason: ${result.finishReason}\n` +
        `  turns (steps): ${result.steps.length}\n` +
        `  tool calls: ${toolCalls}\n` +
        `  wall-clock: ${wallMs} ms\n` +
        `  final text: ${(result.text ?? "").slice(0, 400)}\n` +
        "[spike1·B] ===============================================================\n",
    );
  }, 120_000);

  it("completed with no HTTP 400 reasoning_content error (the round-trip held)", () => {
    // Reaching here at all means agent.generate() RESOLVED — a DeepSeek
    // 'reasoning_content' 400 would have rejected the promise in beforeAll and
    // failed the suite before any assertion. We additionally assert a real finish.
    expect(probeB).toBeDefined();
    expect(probeB!.finishReason).toBeDefined();
    // A 'tripwire'/'error' finishReason would mean the loop did not cleanly finish.
    expect(["stop", "tool-calls", "tool_calls", "length"]).toContain(
      probeB!.finishReason,
    );
  });

  it("called the tool at least once (multi-turn loop actually fired the tool)", () => {
    expect(probeB!.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(probeB!.turnCount).toBeGreaterThanOrEqual(2);
  });

  it("produced a non-empty final answer", () => {
    expect(probeB!.finalText.trim().length).toBeGreaterThan(0);
  });
});
