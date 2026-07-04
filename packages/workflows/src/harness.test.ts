/**
 * In-stack tests — harness.generate (the critical path).
 *
 * These drive the REAL Mastra Agent → REAL ledger writer chain against a
 * DETERMINISTIC fake LanguageModel (from @autobroker/model testSupport) and an
 * ISOLATED tmp DB. No live network. The whole agent→ledger path is genuinely
 * exercised — that is the in-stack evidence we need (the fail-closed boundary
 * must be proven on the real stack, not a hand-rolled fake of it).
 *
 * Coverage:
 *   - clean path: a well-formed emit_result tool call → Zod-validated object,
 *     priced via the real PRICING table, ONE ledger row, fail_reason null;
 *   - fail-closed: the emit_result tool never fires (a prose dump) → typed
 *     EmitResultNotCalledError + ledger fail_reason 'emit_result_not_called';
 *   - Zod authority: a tool call with schema-violating args → ZodError + ledger
 *     fail_reason 'zod_validation' (model output is advisory, Zod is the law);
 *   - NULL-not-$0: usage undefined → costUsd null + pricingSource 'unavailable';
 *   - output_object lane: a useCase routing to a supportsOutputObjectWithTools
 *     provider drives the NATIVE structured-output path → Zod-validated object,
 *     priced, ONE ledger row; Zod authority still rejects drift.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * the committed migration is applied to the throwaway DB; the harness writes
 * through an injected handle to that same DB. NEVER ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  __resetHarnessGenerateFaultForTests,
  __setHarnessGenerateFaultForTests,
  makeProseDumpModel,
  makeStaticToolCallModel,
  makeStructuredObjectModel,
  policy,
  type HarnessGenerateInput,
} from "@autobroker/model";
import { openDb, type Db } from "@autobroker/tools";

import { clearRunSelection, setRunSelection } from "./agentSelection.js";
import { DealerReplyExtractEmitSchema } from "./dealerReplyExtractContracts.js";
import {
  EmitResultNotCalledError,
  harness,
  type HarnessLedgerContext,
} from "./harness.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const AGENT_PROVIDER = "AUTOBROKER_AGENT_PROVIDER";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];
const originalAgentProvider = process.env[AGENT_PROVIDER];

const here = dirname(fileURLToPath(import.meta.url));
// 0000 creates test_run_records; 0005 adds the malformed-evidence columns and
// 0007 drops them (the deleted #1244 apparatus) — the current ledger schema.
const MIGRATION_SQLS = ["0000_military_red_skull.sql", "0005_military_nightshade.sql", "0007_public_thanos.sql"].map((f) =>
  join(here, "..", "..", "db", "drizzle", f),
);

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-harness-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  // Lane-A provider override reads this env default; keep the whole suite on the
  // DeepSeek default (no provider override) so route assertions are deterministic.
  delete process.env[AGENT_PROVIDER];
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
  if (originalAgentProvider === undefined) delete process.env[AGENT_PROVIDER];
  else process.env[AGENT_PROVIDER] = originalAgentProvider;
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

describe("harness.generate — lane-A provider override is OFF by default (DeepSeek identity)", () => {
  it("with no run selection AND no env default, the routed provider/alias == policy(useCase)", async () => {
    // The byte-identity guarantee: empty registry + unset AUTOBROKER_AGENT_PROVIDER
    // (the beforeAll deletes it) ⇒ resolveSelectionForRun returns null ⇒
    // applySelection never fires ⇒ the route IS the untouched policy() default.
    clearRunSelection(ledger.runId);
    expect(process.env[AGENT_PROVIDER]).toBeUndefined();

    const model = makeStaticToolCallModel({
      toolName: "emit_result",
      args: { city: "Tucson", high: 100 },
      modelId: "deepseek-v4-flash",
      usage: { inputTokens: 1000, outputTokens: 250 },
    });

    const out = await harness.generate(probeInput(), ledger, { model, db });
    expect("object" in out).toBe(true);

    const expected = policy("foundation_probe");
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    // The recorded route — what actually served the call — is byte-identical to
    // the policy() default that shipped before the selection seam existed.
    expect(rows[0]?.provider).toBe(expected.provider);
    expect(rows[0]?.model_alias).toBe(expected.alias);
    expect(rows[0]?.provider).toBe("deepseek");
    expect(rows[0]?.model_alias).toBe("deepseek.cheap");
  });
});

describe("harness.generate — in-stack fail-closed (emit_result never fires)", () => {
  it("a prose dump (no tool call) throws EmitResultNotCalledError + ledger 'emit_result_not_called'", async () => {
    // The model answered in prose instead of calling the emit_result tool. The
    // harness refuses to fall through to prose (never regexes a tool name out of
    // content): it fails closed with the typed error and records one ledger row.
    const model = makeProseDumpModel({
      text: "Sorry, I cannot format that as a tool call.",
      modelId: "deepseek-v4-flash",
    });

    await expect(
      harness.generate(probeInput(), ledger, { model, db }),
    ).rejects.toBeInstanceOf(EmitResultNotCalledError);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("emit_result_not_called");
  });
});

describe("harness.generate — Zod is authoritative", () => {
  it("model args that violate the contract throw ZodError + ledger 'zod_validation'", async () => {
    // Mastra validates emit_result's args against input.schema BEFORE execute
    // (live-probed): a contract violation is rejected at the tool boundary as a
    // typed ValidationError (finishReason stays 'tool-calls' — a tool WAS called).
    // The harness detects that rejection via Mastra's isValidationError guard and
    // surfaces it as the Zod-authority failure — a ZodError, ledger
    // 'zod_validation'. Here a refinement (high <= 50) is the contract the model's
    // args (high: 100) violate.
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
  // live-probed 2026-06-05), and result.object is parsed + Zod-validated. No
  // live network.
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
        { useCase: "cross_provider_smoke", schema: strictSchema, prompt: "x" },
        objectLedger,
        { model, db },
      ),
    ).rejects.toBeInstanceOf(z.ZodError);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("zod_validation");
  });

  it("a clean structured `stop` finish succeeds (no false fail-closed)", async () => {
    // The native output_object lane legitimately finishes with `stop` + object
    // (no tool call). The run succeeds, no abort.
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
  // prose `stop` returns { text, usage } + ONE ledger row; a throwing model still
  // writes one NULL-not-$0 row.
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

describe("harness.generate — transport throw (injected llm fault) fails CLOSED", () => {
  it("llm_500: re-throws + writes ONE NULL-not-$0 ledger row (no fabricated success)", async () => {
    // Omit _testOverrides.model so the REAL resolveModel runs and the generate-fault
    // seam fires (the resolved model's doGenerate rejects). The harness .catch() must
    // record one ledger row (NULL-not-$0, fail_reason set) and re-throw — never a
    // success. This is the end-to-end inv #4/#12 proof for an LLM transport fault.
    __setHarnessGenerateFaultForTests("llm_500");
    try {
      await expect(harness.generate(probeInput(), ledger, { db })).rejects.toThrow(/llm_500/);
    } finally {
      __resetHarnessGenerateFaultForTests();
    }
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).not.toBeNull(); // Error.name recorded on the throw.
    expect(rows[0]?.cost_usd).toBeNull(); // NULL-not-$0 (no usage on a failed call).
    expect(rows[0]?.pricing_source).toBe("unavailable");
  });
});

describe("harness.generate — lane B (Claude OAuth) dispatch", () => {
  // A dedicated runId so the per-run selection never leaks into the DeepSeek-default
  // tests above/below; afterEach clears it for total isolation.
  const laneBLedger: HarnessLedgerContext = {
    runId: "run-laneb-1",
    skill: "foundation_probe",
    layer: "L2",
    promptVersion: null,
    schemaVersion: null,
  };

  afterEach(() => clearRunSelection(laneBLedger.runId));

  it("anthropic+oauth selection dispatches to lane B → Zod object + subscription ledger row", async () => {
    setRunSelection(laneBLedger.runId, {
      provider: "anthropic",
      method: "oauth",
      model: null,
      effort: "off",
    });

    const calls: Array<{ prompt: string; jsonSchema?: object; model: string }> = [];
    const fakeOAuth = async (args: { prompt: string; jsonSchema?: object; model: string }) => {
      calls.push(args);
      return {
        structuredOutput: { city: "Tucson", high: 100 },
        usage: { inputTokens: 11, outputTokens: 22 },
      };
    };

    const out = await harness.generate(probeInput(), laneBLedger, {
      db,
      claudeOAuthQuery: fakeOAuth,
    });

    expect("object" in out).toBe(true);
    if (!("object" in out)) return; // narrow
    expect(out.object).toEqual({ city: "Tucson", high: 100 });
    // Subscription is flat-rate ⇒ the RESULT usage is cost-null / 'unavailable'
    // (the ledger column carries the 'subscription' flag instead).
    expect(out.usage.costUsd).toBeNull();
    expect(out.usage.pricingSource).toBe("unavailable");
    expect(out.usage.promptTokens).toBe(11);
    expect(out.usage.completionTokens).toBe(22);

    // lane B re-homes foundation_probe (deepseek.cheap) → anthropic.cheap and
    // passes the concrete claude id + the schema's JSON-Schema to the OAuth query.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("claude-haiku-4-5");
    expect(calls[0]?.jsonSchema).toBeDefined();

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.model_alias).toBe("anthropic.cheap");
    expect(rows[0]?.pricing_source).toBe("subscription");
    expect(rows[0]?.cost_usd).toBeNull();
    expect(rows[0]?.input_tokens).toBe(11);
    expect(rows[0]?.output_tokens).toBe(22);
    expect(rows[0]?.fail_reason).toBeNull();
  });

  it("lane B is Zod-authoritative: a contract-violating structured_output throws ZodError", async () => {
    setRunSelection(laneBLedger.runId, {
      provider: "anthropic",
      method: "oauth",
      model: null,
      effort: "off",
    });
    const strictSchema = z
      .object({ city: z.string(), high: z.number() })
      .refine((v) => v.high <= 50, { message: "high must be <= 50" });
    const fakeOAuth = async () => ({
      structuredOutput: { city: "Tucson", high: 100 }, // passes shape, fails refine.
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await expect(
      harness.generate(
        { useCase: "foundation_probe", schema: strictSchema, prompt: "x" },
        laneBLedger,
        { db, claudeOAuthQuery: fakeOAuth },
      ),
    ).rejects.toBeInstanceOf(z.ZodError);

    // F1 parity: the Zod `.parse` throw still leaves ONE NULL-not-$0 trace row,
    // ledgered under the SAME label lane A uses for a Zod-authority failure.
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("zod_validation");
    expect(rows[0]?.cost_usd).toBeNull();
    expect(rows[0]?.pricing_source).toBe("unavailable");
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.model_alias).toBe("anthropic.cheap");
  });

  it("a $/mo lease-gap dealer-reply emit RESOLVES on lane B (structural boundary; no Rule2 reject)", async () => {
    setRunSelection(laneBLedger.runId, {
      provider: "anthropic",
      method: "oauth",
      model: null,
      effort: "off",
    });
    // A faithful payment-only lease reply: term + monthly payment, but neither
    // money_factor nor residual_pct — a Rule2 gap the JSON-Schema the model saw
    // never forbade. The emit boundary must accept it (reclass + the refined
    // persist belt own Rule1/Rule2 downstream).
    const nulls = Object.fromEntries(
      [
        "vin", "inventory_status", "source_listing_id", "quote_format", "intent",
        "confidence", "quote_received_at", "quote_expires_at", "msrp",
        "selling_price", "dealer_discount", "doc_fee", "dealer_fee", "sales_tax",
        "dmv_fees", "title_fee", "registration_fee", "license_fee", "otd_total",
        "rebates_json", "other_fees_json", "add_ons_json", "taxable_rebates_json",
        "finance_apr", "finance_term_months", "finance_down_payment",
        "finance_monthly_payment", "finance_amount_financed", "lease_money_factor",
        "lease_residual_pct", "lease_residual_value", "lease_due_at_signing",
        "lease_miles_per_year", "lease_acquisition_fee", "lease_disposition_fee",
        "lease_cap_cost_gross", "lease_cap_cost_adjusted", "lease_rent_charge",
      ].map((k) => [k, null]),
    );
    const fakeOAuth = async () => ({
      structuredOutput: {
        quotes: [
          {
            ...nulls,
            financing_mode: "lease",
            lease_term_months: 36,
            lease_monthly_payment: 389,
          },
        ],
        message_intent: "real_quote",
        contact_role: null,
      },
      usage: { inputTokens: 5, outputTokens: 6 },
    });

    const out = await harness.generate(
      {
        useCase: "dealer_reply_extract",
        schema: DealerReplyExtractEmitSchema,
        prompt: "extract",
      },
      laneBLedger,
      { db, claudeOAuthQuery: fakeOAuth },
    );

    expect("object" in out).toBe(true);
    if (!("object" in out)) return; // narrow
    expect(out.object.quotes).toHaveLength(1);
    expect(out.object.quotes[0]?.financing_mode).toBe("lease");
    expect(out.object.quotes[0]?.lease_monthly_payment).toBe(389);

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBeNull();
    expect(rows[0]?.pricing_source).toBe("subscription");
  });

  it("F1 parity: a throwing claudeOAuthQuery writes ONE NULL-not-$0 ledger row + rethrows", async () => {
    setRunSelection(laneBLedger.runId, {
      provider: "anthropic",
      method: "oauth",
      model: null,
      effort: "off",
    });
    // Simulate a non-success / is_error / missing-token throw from inside lane B.
    const boom = new Error("simulated claude oauth non-success");
    boom.name = "ClaudeOAuthError";
    const fakeOAuth = async () => {
      throw boom;
    };

    await expect(
      harness.generate(probeInput(), laneBLedger, { db, claudeOAuthQuery: fakeOAuth }),
    ).rejects.toThrow("simulated claude oauth non-success");

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("ClaudeOAuthError");
    expect(rows[0]?.cost_usd).toBeNull();
    expect(rows[0]?.pricing_source).toBe("unavailable");
    expect(rows[0]?.input_tokens).toBeNull();
    expect(rows[0]?.output_tokens).toBeNull();
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.model_alias).toBe("anthropic.cheap");
  });

  it("F1 parity (draftProse): a throwing claudeOAuthQuery writes ONE NULL-not-$0 row + rethrows", async () => {
    setRunSelection(laneBLedger.runId, {
      provider: "anthropic",
      method: "oauth",
      model: null,
      effort: "off",
    });
    const boom = new Error("simulated claude oauth transport failure");
    boom.name = "ClaudeOAuthError";
    const fakeOAuth = async () => {
      throw boom;
    };

    await expect(
      harness.draftProse({ useCase: "negotiation_followup", prompt: "x" }, laneBLedger, {
        db,
        claudeOAuthQuery: fakeOAuth,
      }),
    ).rejects.toThrow("simulated claude oauth transport failure");

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fail_reason).toBe("ClaudeOAuthError");
    expect(rows[0]?.cost_usd).toBeNull();
    expect(rows[0]?.pricing_source).toBe("unavailable");
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.model_alias).toBe("anthropic.chat");
  });

  it("DeepSeek default path is unchanged when no selection is set (no lane B)", async () => {
    clearRunSelection(laneBLedger.runId);
    const model = makeStaticToolCallModel({
      toolName: "emit_result",
      args: { city: "Tucson", high: 100 },
      modelId: "deepseek-v4-flash",
      usage: { inputTokens: 1000, outputTokens: 250 },
    });

    const out = await harness.generate(probeInput(), laneBLedger, { model, db });

    expect("object" in out).toBe(true);
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("deepseek");
    expect(rows[0]?.model_alias).toBe("deepseek.cheap");
    expect(rows[0]?.pricing_source).not.toBe("subscription");
  });

  it("draftProse lane B: no schema → prose text + subscription ledger row", async () => {
    setRunSelection(laneBLedger.runId, {
      provider: "anthropic",
      method: "oauth",
      model: null,
      effort: "off",
    });
    const calls: Array<{ prompt: string; jsonSchema?: object; model: string }> = [];
    const fakeOAuth = async (args: { prompt: string; jsonSchema?: object; model: string }) => {
      calls.push(args);
      return { text: "Can you beat 31,200 out-the-door?", usage: { inputTokens: 7, outputTokens: 9 } };
    };

    const out = await harness.draftProse(
      { useCase: "negotiation_followup", prompt: "Write an assertive follow-up." },
      laneBLedger,
      { db, claudeOAuthQuery: fakeOAuth },
    );

    expect(out.text).toContain("out-the-door");
    expect(out.usage.costUsd).toBeNull();
    // negotiation_followup (deepseek.chat) re-homes to anthropic.chat → claude-sonnet-4-6.
    expect(calls[0]?.jsonSchema).toBeUndefined();
    expect(calls[0]?.model).toBe("claude-sonnet-4-6");

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.model_alias).toBe("anthropic.chat");
    expect(rows[0]?.pricing_source).toBe("subscription");
    expect(rows[0]?.cost_usd).toBeNull();
    expect(rows[0]?.input_tokens).toBe(7);
    expect(rows[0]?.fail_reason).toBeNull();
  });
});
