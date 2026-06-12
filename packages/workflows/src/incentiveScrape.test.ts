/**
 * In-stack tests — the incentive_scrape flat workflow.
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start/
 * resume chain (in-process against a tmp mastra.db) → REAL step closures,
 * with the runtime collaborators injected through the test-only deps seam:
 * the capture boundary, the harness call and the SSRF DNS arm are
 * deterministic stubs, while the profile resolver, the FILE REGISTRY, the
 * cache-marker read and the persist writer run REAL against an ISOLATED tmp
 * data dir + autobroker.db (the committed migrations applied). NO real
 * browser, NO live LLM, no network.
 *
 * Coverage (the step-3 core chain; the fallback-gating map has its own
 * suite):
 *   - first-encounter chain → suspend payload shape (approval kind, the seed
 *     candidate URL) BEFORE any capture; approve → registry file written →
 *     capture → extraction → whitelist → DELETE-then-INSERT persist; output
 *     contract round-trip.
 *   - re-run after approve → NO suspend (registry memory), cache-fresh skip
 *     with ZERO capture (the no-re-ask + no-navigation behavioral pair).
 *   - decline → terminal declined, zero capture, zero DB writes, NO registry
 *     entry; a re-run asks AGAIN.
 *   - skip → that brand skipped (run completes 0-scraped), registry NOT
 *     written; per-run only — a fresh run asks again.
 *   - resolver branches → 0-active typed STOP; pinned wins exactly one
 *     target; 2+ active are ALL enumerated (the documented exception).
 *   - the missing-zip target gate.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/
 * restored); mastra.db + autobroker.db + incentive_sources.toml all live
 * there; NEVER ~/.autobroker*.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, readIncentiveRegistry, type Db } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import {
  IncentiveScrapeOutputSchema,
  OemFirstEncounterSuspendSchema,
} from "./incentiveScrapeContracts.js";
import {
  incentiveScrapeWorkflow,
  INCENTIVE_SCRAPE_WORKFLOW_ID,
  __resetIncentiveScrapeDepsForTests,
  __setIncentiveScrapeDepsForTests,
  type IncentiveScrapeWorkflowDeps,
  type OfferCaptureArgs,
  type OfferCaptureOutcome,
} from "./incentiveScrape.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = ["0000_military_red_skull.sql", "0001_redundant_ozymandias.sql"].map(
  (f) => join(here, "..", "..", "db", "drizzle", f),
);

const SEED_URL = "https://www.hyundaiusa.com/us/en/offers";

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-incentive-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb(); // <tmpDir>/autobroker.db
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetIncentiveScrapeDepsForTests();
  db.$client.close();
  closeDb(); // release the shared getDb() handle the steps cached.
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function seedProfile(
  over: Partial<{
    id: string;
    make: string;
    model: string;
    zip: string | null;
    accountId: string;
  }> = {},
): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "search_radius_miles, location_query, postal_code, latitude, longitude, " +
        "follow_up_email, financing_preference, status, brand, account_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      over.id ?? "prof-1",
      2026,
      over.make ?? "Hyundai",
      over.model ?? "Tucson Hybrid",
      "Limited",
      120,
      "Irvine, CA 92614",
      over.zip === undefined ? "92614" : over.zip,
      33.6695,
      -117.7669,
      "buyer@example.com",
      "finance",
      "active",
      over.make ?? "Hyundai",
      over.accountId ?? "acct-test-1",
    );
}

const NO_USAGE = {
  costUsd: null,
  durationMs: 0,
  pricingSource: "unavailable" as const,
  promptTokens: null,
  completionTokens: null,
};

/** A harness stub returning the same incentive rows for every call. */
function harnessStub(
  incentives: Record<string, unknown>[],
  record?: { prompts: string[] },
): IncentiveScrapeWorkflowDeps["harnessGenerate"] {
  return (async (input: { prompt: string }) => {
    record?.prompts.push(input.prompt);
    return { object: { incentives }, usage: NO_USAGE };
  }) as unknown as IncentiveScrapeWorkflowDeps["harnessGenerate"];
}

const harnessNeverCalled = (async () => {
  throw new Error("harness.generate must not be called on this path");
}) as unknown as IncentiveScrapeWorkflowDeps["harnessGenerate"];

/** A capture stub: records the ladders it was asked to walk, returns a
 *  card-woven capture for every URL. */
function captureStub(record?: { calls: OfferCaptureArgs[] }) {
  return async (args: OfferCaptureArgs): Promise<OfferCaptureOutcome> => {
    record?.calls.push(args);
    return {
      kind: "captured",
      url: args.urls[0]!,
      snapshotText: "[OFFER 1]\n$1,500 Retail Bonus Cash. Expires 07/06/2026.",
      snapshotFallback: false,
    };
  };
}

const captureNeverCalled = async (): Promise<OfferCaptureOutcome> => {
  throw new Error("captureOffers must not be called on this path");
};

/** Default deps: REAL resolver/registry/cache/persist on the tmp world;
 *  stubbed capture + harness + DNS-free SSRF. */
function installDeps(partial: Partial<IncentiveScrapeWorkflowDeps> = {}): void {
  __setIncentiveScrapeDepsForTests({
    validateUrl: (async () => undefined) as IncentiveScrapeWorkflowDeps["validateUrl"],
    captureOffers: captureStub(),
    harnessGenerate: harnessStub([
      { type: "customer_cash", amount: 1500, expires: "2026-07-06", eligibility: "all" },
      { type: "other", amount: 0, expires: null, eligibility: "all" }, // APR-ish — whitelist drops
    ]),
    ...partial,
  });
}

function workflow() {
  const mastra = createMastraInstance({
    workflows: { [INCENTIVE_SCRAPE_WORKFLOW_ID]: incentiveScrapeWorkflow as never },
  });
  return mastra.getWorkflow(INCENTIVE_SCRAPE_WORKFLOW_ID);
}

async function startRun(runId: string, searchProfileId: string | null = null) {
  const run = await workflow().createRun({ runId });
  const result = await run.start({ inputData: { search_profile_id: searchProfileId } });
  return { run, result };
}

function suspendPayloadOf(result: unknown): Record<string, unknown> {
  const steps = (result as { steps?: Record<string, { suspendPayload?: Record<string, unknown> }> })
    .steps;
  const payload = steps?.["resolveOemSource"]?.suspendPayload;
  expect(payload).toBeDefined();
  return payload!;
}

function outputOf(result: unknown): Record<string, unknown> {
  return (result as { result: Record<string, unknown> }).result;
}

function errorMessageOf(result: unknown): string {
  const err = (result as { error?: unknown }).error;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err !== null && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return JSON.stringify(err ?? null);
}

function incentiveRows(): Array<Record<string, unknown>> {
  return db.$client
    .prepare("SELECT * FROM manufacturer_incentives ORDER BY id")
    .all() as Array<Record<string, unknown>>;
}

const registryPath = (): string => join(tmpDir, "incentive_sources.toml");

// ---------------------------------------------------------------------------
// the first-encounter approve chain
// ---------------------------------------------------------------------------

describe("incentive_scrape first-encounter approve chain", () => {
  it("suspends the approval BEFORE any capture, writes the registry on save, scrapes and persists", async () => {
    seedProfile();
    const captures = { calls: [] as OfferCaptureArgs[] };
    installDeps({ captureOffers: captureStub(captures) });

    const { run, result } = await startRun("inc-run-1");
    expect((result as { status: string }).status).toBe("suspended");

    // The payload is the typed first-encounter approval: the seed candidate
    // URL, the banner approval kind. NOTHING has been captured or written.
    const payload = OemFirstEncounterSuspendSchema.parse(suspendPayloadOf(result));
    expect(payload.oemUrl).toBe(SEED_URL);
    expect(payload.make).toBe("Hyundai");
    expect(payload.reason).toBe("oem_first_encounter");
    expect(captures.calls).toHaveLength(0);
    expect(incentiveRows()).toHaveLength(0);
    expect(existsSync(registryPath())).toBe(false);

    // Approve the shown candidate → the registry entry lands, the OEM page is
    // captured, the cash row persists (the "other" row is whitelist-dropped).
    const final = await run.resume({
      step: "resolveOemSource",
      resumeData: { action: "save", url: null },
    });
    expect((final as { status: string }).status).toBe("success");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(final));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.resolution).toBe("all_active");
    expect(output.targetsTotal).toBe(1);
    expect(output.brandsScraped).toBe(1);
    expect(output.brandsSkipped).toBe(0);
    expect(output.brandsExtractionFailed).toBe(0);
    expect(output.incentivesWritten).toBe(1);
    expect(output.rowsDroppedNonCash).toBe(1);

    // Registry memory: the brand entry holds the SEED template.
    const registry = readIncentiveRegistry(registryPath());
    expect(registry["hyundai"]).toBeDefined();
    expect(registry["hyundai"]!.url_template).toBe(SEED_URL);
    expect(registry["hyundai"]!.added_for_profile).toBe("prof-1");

    // The capture walked exactly the approved URL.
    expect(captures.calls).toHaveLength(1);
    expect(captures.calls[0]!.urls).toEqual([SEED_URL]);

    // The persisted slice carries the run provenance.
    const rows = incentiveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["type"]).toBe("customer_cash");
    expect(rows[0]!["zip"]).toBe("92614");
    expect(rows[0]!["scrape_source_url"]).toBe(SEED_URL);
  });

  it("a re-run after approve never asks again (registry) and never navigates (cache skip)", async () => {
    seedProfile();
    installDeps();
    const { run } = await startRun("inc-run-2a");
    await run.resume({ step: "resolveOemSource", resumeData: { action: "save", url: null } });
    expect(incentiveRows()).toHaveLength(1);

    // Second run, same world: NO suspend, NO capture, NO LLM, slice untouched.
    installDeps({ captureOffers: captureNeverCalled, harnessGenerate: harnessNeverCalled });
    const second = await startRun("inc-run-2b");
    expect((second.result as { status: string }).status).toBe("success");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(second.result));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.brandsScraped).toBe(0);
    expect(output.brandsSkipped).toBe(1);
    expect(output.summary).toContain("fresh <7d");
    expect(incentiveRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// decline / skip
// ---------------------------------------------------------------------------

describe("incentive_scrape first-encounter decline / skip", () => {
  it("decline → terminal declined, zero capture, zero writes, NO registry; a re-run asks again", async () => {
    seedProfile();
    installDeps({ captureOffers: captureNeverCalled, harnessGenerate: harnessNeverCalled });

    const { run, result } = await startRun("inc-run-3a");
    expect((result as { status: string }).status).toBe("suspended");
    const final = await run.resume({
      step: "resolveOemSource",
      resumeData: { action: "decline", url: null },
    });
    expect((final as { status: string }).status).toBe("success");
    expect(outputOf(final)).toEqual({ outcome: "declined" });
    expect(incentiveRows()).toHaveLength(0);
    expect(existsSync(registryPath())).toBe(false);

    // Nothing was remembered: a fresh run fires the approval AGAIN.
    const again = await startRun("inc-run-3b");
    expect((again.result as { status: string }).status).toBe("suspended");
  });

  it("skip → that brand only: run completes with brandsSkipped, no registry; a fresh run asks again", async () => {
    seedProfile();
    installDeps({ captureOffers: captureNeverCalled, harnessGenerate: harnessNeverCalled });

    const { run, result } = await startRun("inc-run-4a");
    expect((result as { status: string }).status).toBe("suspended");
    const final = await run.resume({
      step: "resolveOemSource",
      resumeData: { action: "skip", url: null },
    });
    expect((final as { status: string }).status).toBe("success");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(final));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.brandsScraped).toBe(0);
    expect(output.brandsSkipped).toBe(1);
    expect(output.summary).toContain("skipped by you");
    expect(existsSync(registryPath())).toBe(false);

    // The skip was per-run: a fresh run asks again.
    const again = await startRun("inc-run-4b");
    expect((again.result as { status: string }).status).toBe("suspended");
  });
});

// ---------------------------------------------------------------------------
// resolver branches (the documented enumerate-all exception)
// ---------------------------------------------------------------------------

describe("incentive_scrape profile resolution", () => {
  it("0 active profiles → typed STOP pointing at intake", async () => {
    installDeps({ captureOffers: captureNeverCalled, harnessGenerate: harnessNeverCalled });
    const { result } = await startRun("inc-run-5");
    expect((result as { status: string }).status).toBe("failed");
    expect(errorMessageOf(result)).toContain("/search_profile_intake");
  });

  it("a pinned id wins exactly one target (resolution=pinned)", async () => {
    seedProfile({ id: "prof-a", accountId: "acct-1" });
    seedProfile({ id: "prof-b", make: "Mazda", model: "CX-50", accountId: "acct-2" });
    installDeps();
    const { run, result } = await startRun("inc-run-6", "prof-a");
    expect((result as { status: string }).status).toBe("suspended");
    const final = await run.resume({
      step: "resolveOemSource",
      resumeData: { action: "save", url: null },
    });
    const output = IncentiveScrapeOutputSchema.parse(outputOf(final));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.resolution).toBe("pinned");
    expect(output.targetsTotal).toBe(1);
  });

  it("2+ active unpinned → ALL are targets (never bare newest); the seedless brand fails honestly", async () => {
    seedProfile({ id: "prof-a", accountId: "acct-1" });
    seedProfile({ id: "prof-b", make: "Mazda", model: "CX-50", accountId: "acct-2" });
    installDeps();
    const { run, result } = await startRun("inc-run-7");
    // Hyundai (seeded brand) suspends; Mazda has no seed → no_oem_source.
    expect((result as { status: string }).status).toBe("suspended");
    const final = await run.resume({
      step: "resolveOemSource",
      resumeData: { action: "save", url: null },
    });
    const output = IncentiveScrapeOutputSchema.parse(outputOf(final));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.resolution).toBe("all_active");
    expect(output.targetsTotal).toBe(2);
    expect(output.brandsScraped).toBe(1);
    expect(output.brandsExtractionFailed).toBe(1);
    expect(output.summary).toContain("no_oem_source");
  });

  it("a profile with no usable US zip fails its target (missing_zip), no suspend, no capture", async () => {
    seedProfile({ zip: null });
    installDeps({ captureOffers: captureNeverCalled, harnessGenerate: harnessNeverCalled });
    const { result } = await startRun("inc-run-8");
    expect((result as { status: string }).status).toBe("success");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(result));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.brandsExtractionFailed).toBe(1);
    expect(output.summary).toContain("missing_zip");
  });
});
