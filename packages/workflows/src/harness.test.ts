/**
 * In-stack tests — harness.generate (the critical path).
 *
 * These drive the REAL Mastra Agent → REAL #1244 output Processor → REAL ledger
 * writer chain against a DETERMINISTIC fake LanguageModel (from @autobroker/model
 * testSupport) and an ISOLATED tmp DB. No live network. The whole
 * agent→processor→tripwire→ledger path is genuinely exercised — that is the
 * in-stack evidence we need (the #1244 fail-closed boundary must be proven on
 * the real stack, not a hand-rolled fake of it).
 *
 * Coverage:
 *   - clean path: a well-formed emit_result tool call → Zod-validated object,
 *     priced via the real PRICING table, ONE ledger row, fail_reason null;
 *   - in-stack #1244 (a simulated malformed tool call → typed abort): a
 *     prose/tool-blob dump
 *     → no HITL: typed MalformedToolCallAbort + ledger fail_reason
 *     'malformed_tool_call'; HITL: HarnessSuspend + ledger row;
 *   - Zod authority: a tool call with schema-violating args → ZodError + ledger
 *     fail_reason 'zod_validation' (model output is advisory, Zod is the law);
 *   - NULL-not-$0: usage undefined → costUsd null + pricingSource 'unavailable';
 *   - output_object lane: a useCase routing to a supportsOutputObjectWithTools
 *     provider drives the NATIVE structured-output path → Zod-validated object,
 *     priced, ONE ledger row; the #1244 processor (expectsToolCall:false) stays
 *     harmless on the clean `stop` finish; Zod authority still rejects drift.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * the committed migration is applied to the throwaway DB; the harness writes
 * through an injected handle to that same DB. NEVER ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  MalformedToolCallAbort,
  makeProseDumpModel,
  makeStaticToolCallModel,
  makeStructuredObjectModel,
  type HarnessGenerateInput,
} from "@autobroker/model";
import { openDb, type Db } from "@autobroker/tools";

import { harness, type HarnessLedgerContext } from "./harness.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = join(here, "..", "..", "db", "drizzle", "0000_military_red_skull.sql");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-harness-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb(); // resolves <tmpDir>/autobroker.db
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

/** The schema every skill-shaped test contract uses (flat, all-required). */
const quoteSchema = z.object({ city: z.string(), high: z.number() });

/** A foundation_probe input (routes to deepseek.cheap → emit_result strategy). */
function probeInput(
  over: Partial<HarnessGenerateInput<typeof quoteSchema>> = {},
): HarnessGenerateInput<typeof quoteSchema> {
  return {
    useCase: "foundation_probe",
    schema: quoteSchema,
    prompt: "Return the Tucson high temperature as a structured result.",
    hitlAvailable: false,
    ...over,
  };
}

const ledger: HarnessLedgerContext = {
  runId: "run-harness-1",
  skill: "foundation_probe",
  layer: "L2",
  promptVersion: null,
  schemaVersion: null,
};

/** Read every ledger row (newest first not needed — one row per call). */
function ledgerRows(): Array<{
  provider: string;
  model_alias: string;
  cost_usd: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  pricing_source: string;
  price_input_per_mtok: unknown;
  fail_reason: string | null;
  latency_ms: unknown;
}> {
  return db.$client
    .prepare(
      "SELECT provider, model_alias, cost_usd, input_tokens, output_tokens, pricing_source, price_input_per_mtok, fail_reason, latency_ms FROM test_run_records",
    )
    .all() as ReturnType<typeof ledgerRows>;
}

describe("harness.generate — clean emit_result path", () => {
  it("returns the Zod-validated object, prices it, writes ONE ledger row (fail_reason null)", async () => {
    const model = makeStaticToolCallModel({
      toolName: "emit_result",
      args: { city: "Tucson", high: 100 },
      // a modelId present in the PRICING table so cost is computed, not NULL.
      modelId: "deepseek-v4-flash",
      usage: { inputTokens: 1000, outputTokens: 250 },
    });

    const out = await harness.generate(probeInput(), ledger, { model, db });

    expect("object" in out).toBe(true);
    if (!("object" in out)) return; // narrow
    expect(out.object).toEqual({ city: "Tucson", high: 100 });
    expect(out.usage.pricingSource).toBe("computed");
    expect(out.usage.costUsd).not.toBeNull();
    expect(out.usage.durationMs).toBeGreaterThanOrEqual(0);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBeNull();
    expect(rows[0]?.pricing_source).toBe("deepseek-2026-06");
    expect(rows[0]?.cost_usd).not.toBeNull();
    expect(rows[0]?.price_input_per_mtok).toBe(0.14); // flash cache-miss input rate.
    // provider/model_alias are derived from policy(useCase) at the generate
    // seam (foundation_probe routes to deepseek.cheap) — not caller strings.
    expect(rows[0]?.provider).toBe("deepseek");
    expect(rows[0]?.model_alias).toBe("deepseek.cheap");
  });
});

describe("harness.generate — in-stack #1244 fail-closed", () => {
  it("no HITL: a tool-shaped prose dump throws MalformedToolCallAbort + ledger 'malformed_tool_call'", async () => {
    const model = makeProseDumpModel({
      text: '{"name":"emit_result","arguments":{"city":"Tucson"}}',
      modelId: "deepseek-v4-flash",
    });

    await expect(
      harness.generate(probeInput({ hitlAvailable: false }), ledger, { model, db }),
    ).rejects.toBeInstanceOf(MalformedToolCallAbort);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("malformed_tool_call");
  });

  it("HITL: the same dump resolves to a HarnessSuspend + ledger 'malformed_tool_call'", async () => {
    const model = makeProseDumpModel({
      text: '{"name":"emit_result","arguments":{"city":"Tucson"}}',
      modelId: "deepseek-v4-flash",
    });

    const out = await harness.generate(probeInput({ hitlAvailable: true }), ledger, { model, db });

    expect("suspended" in out).toBe(true);
    if (!("suspended" in out)) return; // narrow
    expect(out.suspended).toBe(true);
    expect(out.reason).toBe("malformed_tool_call");
    expect(out.signals.length).toBeGreaterThan(0);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("malformed_tool_call");
  });
});

describe("harness.generate — Zod is authoritative", () => {
  it("model args that violate the contract throw ZodError + ledger 'zod_validation'", async () => {
    // Mastra validates emit_result's args against input.schema BEFORE execute
    // (live-probed): a contract violation is rejected at the tool boundary as a
    // typed ValidationError (finishReason stays 'tool-calls', so #1244 correctly
    // does NOT trip). The harness detects that rejection via Mastra's
    // isValidationError guard and surfaces it as the Zod-authority failure — a
    // ZodError, ledger 'zod_validation'. Here a refinement (high <= 50) is the
    // contract the model's args (high: 100) violate.
    const strictSchema = z
      .object({ city: z.string(), high: z.number() })
      .refine((v) => v.high <= 50, { message: "high must be <= 50" });

    const model = makeStaticToolCallModel({
      toolName: "emit_result",
      args: { city: "Tucson", high: 100 }, // passes shape, fails the refinement.
      modelId: "deepseek-v4-flash",
    });

    await expect(
      harness.generate(
        {
          useCase: "foundation_probe",
          schema: strictSchema,
          prompt: "x",
          hitlAvailable: false,
        },
        ledger,
        { model, db },
      ),
    ).rejects.toBeInstanceOf(z.ZodError);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("zod_validation");
  });
});

describe("harness.generate — NULL-not-$0", () => {
  it("usage undefined → costUsd null + pricing_source 'unavailable' in the ledger row", async () => {
    const model = makeStaticToolCallModel({
      toolName: "emit_result",
      args: { city: "Tucson", high: 100 },
      // Unknown-to-PRICING model id so cost is unavailable even if usage exists;
      // and zero the usage so promptTokens/completionTokens read as 0 (the
      // unpriced path is asserted via pricing_source 'unavailable').
      modelId: "mystery-model-not-in-table",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const out = await harness.generate(probeInput(), ledger, { model, db });
    expect("object" in out).toBe(true);
    if (!("object" in out)) return;
    expect(out.usage.costUsd).toBeNull();
    expect(out.usage.pricingSource).toBe("unavailable");

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost_usd).toBeNull();
    expect(rows[0]?.pricing_source).toBe("unavailable");
    expect(rows[0]?.price_input_per_mtok).toBeNull();
  });
});

describe("harness.generate — native output_object lane (cross-provider)", () => {
  // The `cross_provider_smoke` useCase routes to anthropic.chat
  // (supportsOutputObjectWithTools:true), so harness.generate takes the NATIVE
  // structured-output path: Mastra drives `structuredOutput:{schema}`, the fake
  // model returns a JSON-text response (the v3 shape the path consumes,
  // live-probed 2026-06-05), and result.object is parsed + Zod-validated. The
  // #1244 processor is attached with expectsToolCall:false so the clean `stop`
  // finish does NOT false-trip. No live network.
  const objectLedger: HarnessLedgerContext = {
    runId: "run-output-object-1",
    skill: "cross_provider_smoke",
    layer: "L2",
    promptVersion: null,
    schemaVersion: null,
  };

  function objectInput(
    over: Partial<HarnessGenerateInput<typeof quoteSchema>> = {},
  ): HarnessGenerateInput<typeof quoteSchema> {
    return {
      useCase: "cross_provider_smoke",
      schema: quoteSchema,
      prompt: "Return the Tucson high temperature as a structured result.",
      hitlAvailable: false,
      ...over,
    };
  }

  it("clean native object → Zod-validated result, priced, ONE ledger row (fail_reason null)", async () => {
    const model = makeStructuredObjectModel({
      object: { city: "Tucson", high: 100 },
      modelId: "claude-sonnet-4-6",
      usage: { inputTokens: 1000, outputTokens: 250 },
    });

    const out = await harness.generate(objectInput(), objectLedger, { model, db });

    expect("object" in out).toBe(true);
    if (!("object" in out)) return;
    expect(out.object).toEqual({ city: "Tucson", high: 100 });
    expect(out.usage.pricingSource).toBe("computed");
    expect(out.usage.costUsd).not.toBeNull();

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBeNull();
    expect(rows[0]?.pricing_source).toBe("deepseek-2026-06");
    expect(rows[0]?.price_input_per_mtok).toBe(3.0); // sonnet-4-6 base input rate.
    // provider/model_alias derived from policy(cross_provider_smoke) →
    // anthropic.chat (the routed alias, not the concrete model id).
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.model_alias).toBe("anthropic.chat");
  });

  it("Zod authority: a native object that violates the contract → ZodError + ledger 'zod_validation'", async () => {
    const strictSchema = z
      .object({ city: z.string(), high: z.number() })
      .refine((v) => v.high <= 50, { message: "high must be <= 50" });

    const model = makeStructuredObjectModel({
      object: { city: "Tucson", high: 100 }, // passes shape, fails the refinement.
      modelId: "claude-sonnet-4-6",
    });

    await expect(
      harness.generate(
        { useCase: "cross_provider_smoke", schema: strictSchema, prompt: "x", hitlAvailable: false },
        objectLedger,
        { model, db },
      ),
    ).rejects.toBeInstanceOf(z.ZodError);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("zod_validation");
  });

  it("#1244 stays harmless: a clean structured `stop` finish does NOT false-trip", async () => {
    // The processor runs with expectsToolCall:false on this lane, so the
    // finish_reason/empty-tool-call signals are gated off (live-probed: with
    // expectsToolCall:true the same turn WOULD trip). The run succeeds, no abort.
    const model = makeStructuredObjectModel({
      object: { city: "Tucson", high: 88 },
      modelId: "claude-sonnet-4-6",
    });

    const out = await harness.generate(objectInput(), objectLedger, { model, db });
    expect("object" in out).toBe(true);
    if (!("object" in out)) return;
    expect(out.object).toEqual({ city: "Tucson", high: 88 });
    expect(ledgerRows()[0]?.fail_reason).toBeNull();
  });
});

describe("harness.draftProse — no-tool prose facade", () => {
  // draftProse is a strict subset of generate: NO tools, NO structuredOutput, NO
  // toolChoice, NO Zod. negotiation_followup routes to deepseek.chat. A clean
  // prose `stop` returns { text, usage } + ONE ledger row; a tool-shaped blob in
  // the content fails CLOSED (typed MalformedToolCallAbort) so the blob is never
  // returned as prose; a throwing model still writes one NULL-not-$0 row.
  const proseLedger: HarnessLedgerContext = {
    runId: "run-prose-1",
    skill: "negotiation_followup",
    layer: "L2",
    promptVersion: null,
    schemaVersion: null,
  };

  it("returns the prose text + usage and writes ONE ledger row (fail_reason null)", async () => {
    const model = makeProseDumpModel({
      text: "Thanks for the quote. Another dealer is at 31,200 out-the-door — can you match or beat that on the same trim? Happy to move quickly if the numbers work.",
      modelId: "deepseek-v4-flash",
      usage: { inputTokens: 800, outputTokens: 120 },
    });

    const out = await harness.draftProse(
      { useCase: "negotiation_followup", prompt: "Write an assertive follow-up." },
      proseLedger,
      { model, db },
    );

    expect(out.text).toContain("out-the-door");
    expect(out.usage.pricingSource).toBe("computed");
    expect(out.usage.costUsd).not.toBeNull();
    expect(out.usage.durationMs).toBeGreaterThanOrEqual(0);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBeNull();
    // negotiation_followup routes to deepseek.chat (the prose lane).
    expect(rows[0]?.provider).toBe("deepseek");
    expect(rows[0]?.model_alias).toBe("deepseek.chat");
  });

  it("fails CLOSED on a tool-shaped blob in the prose (typed abort + ledger 'malformed_tool_call')", async () => {
    // A real escape: the model dumped a tool-call shape as text. expectsToolCall
    // is false on this lane, so finish_reason/empty-tool signals are gated off —
    // but the tool_shaped_blob signal still fires. Never return the blob as prose.
    const model = makeProseDumpModel({
      text: '{"name":"emit_result","arguments":{"body":"x"}}',
      modelId: "deepseek-v4-flash",
    });

    await expect(
      harness.draftProse({ useCase: "negotiation_followup", prompt: "x" }, proseLedger, {
        model,
        db,
      }),
    ).rejects.toBeInstanceOf(MalformedToolCallAbort);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("malformed_tool_call");
  });

  it("NULL-not-$0: an unknown model id → costUsd null + pricing_source 'unavailable'", async () => {
    const model = makeProseDumpModel({
      text: "A short, clean follow-up reply.",
      modelId: "mystery-model-not-in-table",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const out = await harness.draftProse(
      { useCase: "negotiation_followup", prompt: "x" },
      proseLedger,
      { model, db },
    );
    expect(out.usage.costUsd).toBeNull();
    expect(out.usage.pricingSource).toBe("unavailable");

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost_usd).toBeNull();
    expect(rows[0]?.pricing_source).toBe("unavailable");
  });

  it("a model call that THROWS still writes ONE NULL-not-$0 ledger row and propagates", async () => {
    const boom = new Error("simulated provider transport failure");
    boom.name = "SimulatedProviderError";
    const throwingModel = {
      specificationVersion: "v3",
      provider: "test",
      modelId: "throwing-model",
      supportedUrls: {},
      doGenerate: async () => {
        throw boom;
      },
      doStream: async () => {
        throw boom;
      },
    };

    await expect(
      harness.draftProse({ useCase: "negotiation_followup", prompt: "x" }, proseLedger, {
        model: throwingModel,
        db,
      }),
    ).rejects.toThrow();

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).not.toBeNull();
    expect(rows[0]?.cost_usd).toBeNull();
    expect(rows[0]?.pricing_source).toBe("unavailable");
  });
});

describe("harness.generate — adversarial-review fixes (2026-06-05)", () => {
  it("F1: a model call that THROWS still writes ONE ledger row and propagates", async () => {
    // A structural v3 model whose doGenerate/doStream reject — a thrown model
    // call is a run that HAPPENED and must be recorded (usage unknown ⇒
    // NULL-not-$0). Typed `unknown` through the test seam, so no `ai` import.
    const boom = new Error("simulated provider transport failure");
    boom.name = "SimulatedProviderError";
    const throwingModel = {
      specificationVersion: "v3",
      provider: "test",
      modelId: "throwing-model",
      supportedUrls: {},
      doGenerate: async () => {
        throw boom;
      },
      doStream: async () => {
        throw boom;
      },
    };

    await expect(
      harness.generate(probeInput(), ledger, { model: throwingModel, db }),
    ).rejects.toThrow();

    // Exactly ONE row regardless of any internal framework retries (the
    // failure ledger wraps the whole agent.generate promise, not a step).
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).not.toBeNull();
    expect(rows[0]?.cost_usd).toBeNull();
    expect(rows[0]?.pricing_source).toBe("unavailable");
  });

  it("F3 (draftProse): the _testOverrides seam is refused when no test-runner env is present", async () => {
    const vitestVal = process.env["VITEST"];
    const nodeEnvVal = process.env["NODE_ENV"];
    delete process.env["VITEST"];
    delete process.env["NODE_ENV"];
    try {
      await expect(
        harness.draftProse({ useCase: "negotiation_followup", prompt: "x" }, ledger, { db }),
      ).rejects.toThrow(/test-only seam/);
    } finally {
      if (vitestVal === undefined) delete process.env["VITEST"];
      else process.env["VITEST"] = vitestVal;
      if (nodeEnvVal === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = nodeEnvVal;
    }
    expect(ledgerRows()).toHaveLength(0);
  });

  it("F3: the _testOverrides seam is refused when no test-runner env is present", async () => {
    const vitestVal = process.env["VITEST"];
    const nodeEnvVal = process.env["NODE_ENV"];
    delete process.env["VITEST"];
    delete process.env["NODE_ENV"];
    try {
      await expect(harness.generate(probeInput(), ledger, { db })).rejects.toThrow(
        /test-only seam/,
      );
    } finally {
      if (vitestVal === undefined) delete process.env["VITEST"];
      else process.env["VITEST"] = vitestVal;
      if (nodeEnvVal === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = nodeEnvVal;
    }
    // The guard fires before any model call — nothing ran, zero rows (same
    // no-fake-provenance rule as the output_object gate).
    expect(ledgerRows()).toHaveLength(0);
  });
});
