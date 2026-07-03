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
 *   - first-encounter chain → AUTO-approve (no suspend): the seed source is
 *     recorded (registry file written) and scraped automatically → capture →
 *     extraction → whitelist → DELETE-then-INSERT persist; output contract
 *     round-trip.
 *   - re-run after a first encounter → still no suspend; cache-fresh skip with
 *     ZERO capture (the no-re-navigation behavior).
 *   - resolver branches → 0-active typed STOP; pinned wins exactly one
 *     target; 2+ active are ALL enumerated (the documented exception).
 *   - the missing-zip target gate.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/
 * restored); mastra.db + autobroker.db + incentive_sources.toml all live
 * there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, readIncentiveRegistry, type Db } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import { IncentiveScrapeOutputSchema } from "./incentiveScrapeContracts.js";
import {
  incentiveScrapeWorkflow,
  INCENTIVE_SCRAPE_WORKFLOW_ID,
  __resetIncentiveScrapeDepsForTests,
  __setIncentiveScrapeDepsForTests,
  type IncentiveScrapeWorkflowDeps,
  type OfferCaptureArgs,
  type OfferCaptureOutcome,
} from "./incentiveScrape.js";
import { EmitResultNotCalledError } from "./harness.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = ["0000_military_red_skull.sql", "0001_redundant_ozymandias.sql"].map(
  (f) => join(here, "..", "..", "db", "drizzle", f),
);

// The brand seed is the param-free offers page; the registry remembers it
// verbatim (no {zip} fill), and the capture / persist all use the same URL.
const SEED_TEMPLATE = "https://www.hyundaiusa.com/us/en/offers";
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
// the first-encounter auto-approve chain (READ-ONLY scrape — NO human gate)
// ---------------------------------------------------------------------------

describe("incentive_scrape first-encounter auto-approve chain", () => {
  it("records the seed source automatically (no suspend), scrapes and persists", async () => {
    seedProfile();
    const captures = { calls: [] as OfferCaptureArgs[] };
    installDeps({ captureOffers: captureStub(captures) });

    // No suspend: a first encounter is auto-recorded and scraped in one start.
    const { result } = await startRun("inc-run-1");
    expect((result as { status: string }).status).toBe("success");

    const output = IncentiveScrapeOutputSchema.parse(outputOf(result));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.resolution).toBe("all_active");
    expect(output.targetsTotal).toBe(1);
    expect(output.brandsScraped).toBe(1);
    expect(output.brandsSkipped).toBe(0);
    expect(output.brandsExtractionFailed).toBe(0);
    expect(output.incentivesWritten).toBe(1);
    expect(output.rowsDroppedNonCash).toBe(1);

    // Registry memory: the brand entry was written automatically, holding the
    // SEED template verbatim.
    const registry = readIncentiveRegistry(registryPath());
    expect(registry["hyundai"]).toBeDefined();
    expect(registry["hyundai"]!.url_template).toBe(SEED_TEMPLATE);
    expect(registry["hyundai"]!.added_for_profile).toBe("prof-1");

    // The capture walked exactly the seed URL.
    expect(captures.calls).toHaveLength(1);
    expect(captures.calls[0]!.urls).toEqual([SEED_URL]);

    // The persisted slice carries the run provenance.
    const rows = incentiveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["type"]).toBe("customer_cash");
    expect(rows[0]!["zip"]).toBe("92614");
    expect(rows[0]!["scrape_source_url"]).toBe(SEED_URL);
  });

  it("a re-run never re-records the source (registry) and never navigates (cache skip)", async () => {
    seedProfile();
    installDeps();
    const first = await startRun("inc-run-2a");
    expect((first.result as { status: string }).status).toBe("success");
    expect(incentiveRows()).toHaveLength(1);

    // Second run, same world: NO capture, NO LLM, slice untouched.
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
    const { result } = await startRun("inc-run-6", "prof-a");
    expect((result as { status: string }).status).toBe("success");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(result));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.resolution).toBe("pinned");
    expect(output.targetsTotal).toBe(1);
  });

  it("2+ active unpinned → ALL are targets (never bare newest); the seedless brand fails honestly", async () => {
    seedProfile({ id: "prof-a", accountId: "acct-1" });
    seedProfile({ id: "prof-b", make: "Mazda", model: "CX-50", accountId: "acct-2" });
    installDeps();
    // Hyundai (seeded brand) auto-records + scrapes; Mazda has no seed →
    // no_oem_source — all in one start, no suspend.
    const { result } = await startRun("inc-run-7");
    expect((result as { status: string }).status).toBe("success");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(result));
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

// ---------------------------------------------------------------------------
// step-4 fallback gating — the map documented in the workflow header, PINNED
// ---------------------------------------------------------------------------

import { NULL_EMITTER, type BrowserEmitter } from "@autobroker/tools";

import {
  collectOfferCards,
  findZipInputSelector,
  rooftopSpecialsUrls,
  runOfferLadder,
  setIncentiveScrapeBrowserEmitterFactory,
  weaveOfferCards,
  type OfferLadderSession,
} from "./incentiveScrape.js";

/** A recording emitter (the voiced-trace assertions read .actions). */
function recordingEmitter(): BrowserEmitter & { actions: Array<[string, string]> } {
  const actions: Array<[string, string]> = [];
  return {
    actions,
    opened: () => undefined,
    action: (type: string, target: string) => {
      actions.push([type, target]);
    },
    error: () => undefined,
    closed: () => undefined,
  };
}

/** A fake ladder session scripted per-URL. `zipSelector` (per-URL) makes the
 *  fake page report a location picker; `zipFills` records every fillLocationZip
 *  call so the localization wiring is observable. */
function fakeLadderSession(script: {
  navigate: (url: string) => { blocked: string | null } | Error;
  cards?: Record<string, ReturnType<typeof collectOfferCards>>;
  snapshot?: Record<string, string>;
  zipSelector?: Record<string, string | null>;
}): OfferLadderSession & { navigated: string[]; zipFills: Array<[string, string]> } {
  const navigated: string[] = [];
  const zipFills: Array<[string, string]> = [];
  let currentUrl = "";
  return {
    navigated,
    zipFills,
    newPage: async () => ({
      // The single fake evaluate serves both in-page probes; it discriminates
      // on the function passed (cards vs the zip-selector finder).
      evaluate: (async (fn: unknown) =>
        fn === findZipInputSelector
          ? (script.zipSelector?.[currentUrl] ?? null)
          : (script.cards?.[currentUrl] ?? [])) as never,
      close: async () => undefined,
    }),
    navigate: (async (_page: never, url: string) => {
      navigated.push(url);
      currentUrl = url;
      const out = script.navigate(url);
      if (out instanceof Error) throw out;
      return out;
    }) as OfferLadderSession["navigate"],
    fillLocationZip: async (_page: never, selector: string, zip: string) => {
      zipFills.push([selector, zip]);
    },
    lazyScroll: async () => undefined,
    snapshot: async () => script.snapshot?.[currentUrl] ?? "",
  };
}

describe("runOfferLadder (the capture discipline, session-injected)", () => {
  const U1 = "https://www.rooftop.example/specials";
  const U2 = "https://www.rooftop.example/offers";
  const U3 = "https://www.rooftop.example/new-vehicle-specials";

  it("blocked at first contact stops the WHOLE ladder — later paths never contacted", async () => {
    const session = fakeLadderSession({ navigate: () => ({ blocked: "akamai_block_page" }) });
    const out = await runOfferLadder({ session, emitter: NULL_EMITTER, label: "x", urls: [U1, U2, U3], zip: null });
    expect(out).toEqual({ kind: "blocked", url: U1, marker: "akamai_block_page" });
    expect(session.navigated).toEqual([U1]); // one contact, nothing more
  });

  it("cards captured → woven blocks, NO snapshot_fallback voice", async () => {
    const emitter = recordingEmitter();
    const session = fakeLadderSession({
      navigate: () => ({ blocked: null }),
      cards: { [U1]: [{ offerText: "$1,500 Retail Bonus Cash" }] },
    });
    const out = await runOfferLadder({ session, emitter, label: "x", urls: [U1], zip: null });
    expect(out.kind).toBe("captured");
    if (out.kind !== "captured") throw new Error("unreachable");
    expect(out.snapshotText).toContain("[OFFER 1]");
    expect(out.snapshotFallback).toBe(false);
    expect(emitter.actions).toEqual([]);
  });

  it("card-less thick render → plain snapshot, VOICED snapshot_fallback (never silent)", async () => {
    const emitter = recordingEmitter();
    const session = fakeLadderSession({
      navigate: () => ({ blocked: null }),
      snapshot: { [U1]: "Current offers … ".repeat(40) }, // > the thin bound
    });
    const out = await runOfferLadder({ session, emitter, label: "oem-hyundai", urls: [U1], zip: null });
    expect(out.kind).toBe("captured");
    if (out.kind !== "captured") throw new Error("unreachable");
    expect(out.snapshotFallback).toBe(true);
    expect(emitter.actions).toEqual([["snapshot_fallback", "oem-hyundai"]]);
  });

  it("thin card-less renders fall through to the next path; an exhausted ladder fails", async () => {
    const session = fakeLadderSession({
      navigate: () => ({ blocked: null }),
      snapshot: { [U1]: "404", [U2]: "not found", [U3]: "nope" },
    });
    const out = await runOfferLadder({ session, emitter: NULL_EMITTER, label: "x", urls: [U1, U2, U3], zip: null });
    expect(out.kind).toBe("failed");
    expect(session.navigated).toEqual([U1, U2, U3]);
  });

  it("a navigation ERROR (dead path, not a refusal) tries the next path", async () => {
    const session = fakeLadderSession({
      navigate: (url) => (url === U1 ? new Error("net::ERR_NAME_NOT_RESOLVED") : { blocked: null }),
      cards: { [U2]: [{ offerText: "$500 Loyalty Cash" }] },
    });
    const out = await runOfferLadder({ session, emitter: NULL_EMITTER, label: "x", urls: [U1, U2], zip: null });
    expect(out.kind).toBe("captured");
    if (out.kind !== "captured") throw new Error("unreachable");
    expect(out.url).toBe(U2);
  });

  it("localizes to the profile ZIP when the page exposes a picker (digits only)", async () => {
    const session = fakeLadderSession({
      navigate: () => ({ blocked: null }),
      zipSelector: { [U1]: "#dealer-zip" },
      cards: { [U1]: [{ offerText: "$2,000 Featured Cash on 2026 Tucson Hybrid" }] },
    });
    const out = await runOfferLadder({ session, emitter: NULL_EMITTER, label: "x", urls: [U1], zip: "92614" });
    expect(out.kind).toBe("captured");
    expect(session.zipFills).toEqual([["#dealer-zip", "92614"]]); // the page's own picker, ZIP digits only
  });

  it("skips localization when no picker is present, and never fills with a null ZIP", async () => {
    const noPicker = fakeLadderSession({ navigate: () => ({ blocked: null }), cards: { [U1]: [{ offerText: "$1k Bonus Cash here" }] } });
    await runOfferLadder({ session: noPicker, emitter: NULL_EMITTER, label: "x", urls: [U1], zip: "92614" });
    expect(noPicker.zipFills).toEqual([]); // page reported no picker

    const nullZip = fakeLadderSession({ navigate: () => ({ blocked: null }), zipSelector: { [U1]: "#zip" }, cards: { [U1]: [{ offerText: "$1k Bonus Cash here" }] } });
    await runOfferLadder({ session: nullZip, emitter: NULL_EMITTER, label: "x", urls: [U1], zip: null });
    expect(nullZip.zipFills).toEqual([]); // no zip to localize with
  });
});

describe("findZipInputSelector (the in-page picker finder)", () => {
  it("rehydrated from source (no module scope), it finds a ZIP input by id", () => {
    const rehydrated = new Function(`return (${findZipInputSelector.toString()});`)() as typeof findZipInputSelector;

    interface FakeEl {
      attrs: Record<string, string>;
      getAttribute(name: string): string | null;
      closest(selector: string): unknown;
    }
    const make = (attrs: Record<string, string>): FakeEl => ({
      attrs,
      getAttribute: (n) => attrs[n] ?? null,
      closest: () => null,
    });
    const keyword = make({ type: "search", name: "q", placeholder: "Search models" });
    const zip = make({ type: "text", id: "dealer-zip", placeholder: "ZIP code" });
    const fakeDoc = { querySelectorAll: () => [keyword, zip] };
    const g = globalThis as { document?: unknown; CSS?: unknown };
    const prevDoc = g.document;
    g.document = fakeDoc;
    try {
      expect(rehydrated()).toBe("#dealer-zip"); // skips the keyword search, finds the ZIP field
    } finally {
      if (prevDoc === undefined) delete g.document;
      else g.document = prevDoc;
    }
  });

  it("returns null when there is no ZIP/postal/location input", () => {
    const rehydrated = new Function(`return (${findZipInputSelector.toString()});`)() as typeof findZipInputSelector;
    const make = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => attrs[n] ?? null, closest: () => null });
    const fakeDoc = { querySelectorAll: () => [make({ type: "text", name: "q", placeholder: "Search" })] };
    const g = globalThis as { document?: unknown };
    const prevDoc = g.document;
    g.document = fakeDoc;
    try {
      expect(rehydrated()).toBeNull();
    } finally {
      if (prevDoc === undefined) delete g.document;
      else g.document = prevDoc;
    }
  });
});

describe("collectOfferCards (the in-page collector)", () => {
  it("rehydrated from source (no module scope), it still collects leaf-most offer cards", () => {
    // The function SOURCE ships into the page — module-scope constants do not
    // exist there. Rebuilding from toString() in an empty scope reproduces
    // that boundary: any out-of-scope reference throws.
    const rehydrated = new Function(
      `return (${collectOfferCards.toString()});`,
    )() as typeof collectOfferCards;

    interface FakeEl {
      textContent: string | null;
      contains(other: FakeEl): boolean;
      children?: FakeEl[];
    }
    const leafA: FakeEl = {
      textContent: "  $1,500 Retail Bonus Cash on 2026 Tucson Hybrid. Expires 07/06/2026. ",
      contains: () => false,
    };
    const leafB: FakeEl = {
      textContent: "0.99% APR for 60 months on select models, well-qualified buyers",
      contains: () => false,
    };
    const wrapper: FakeEl = {
      textContent: `${leafA.textContent} ${leafB.textContent}`,
      contains: (other) => other === leafA || other === leafB,
    };
    const noMoney: FakeEl = {
      textContent: "Build your Hyundai. Explore the full lineup and find a dealer near you today.",
      contains: () => false,
    };
    const fakeDoc = { querySelectorAll: () => [wrapper, leafA, leafB, noMoney] };
    const g = globalThis as { document?: unknown };
    const prevDoc = g.document;
    g.document = fakeDoc;
    try {
      const cards = rehydrated({ max: 10 });
      expect(cards).toHaveLength(2); // wrapper dropped (contains leaves), no-money dropped
      expect(cards[0]!.offerText).toContain("$1,500 Retail Bonus Cash");
      expect(cards[1]!.offerText).toContain("0.99% APR");
    } finally {
      if (prevDoc === undefined) delete g.document;
      else g.document = prevDoc;
    }
  });

  it("weaveOfferCards delimits one block per card", () => {
    const woven = weaveOfferCards([{ offerText: "A" }, { offerText: "B" }]);
    expect(woven).toBe("[OFFER 1]\nA\n\n[OFFER 2]\nB");
  });

  it("rooftopSpecialsUrls: canned paths off a usable site; denied/aggregator hosts yield none", () => {
    expect(rooftopSpecialsUrls("https://www.tustinhyundai.com/")).toEqual([
      "https://www.tustinhyundai.com/specials",
      "https://www.tustinhyundai.com/offers",
      "https://www.tustinhyundai.com/new-vehicle-specials",
    ]);
    expect(rooftopSpecialsUrls("https://www.cars.com/dealers/x")).toEqual([]);
    expect(rooftopSpecialsUrls(null)).toEqual([]);
    expect(rooftopSpecialsUrls("not a url")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// workflow-level fallback gating (dual source, discrepancy, fail-closed)
// ---------------------------------------------------------------------------

function seedRooftopDealer(profileId = "prof-1", website = "https://www.tustinhyundai.com/"): void {
  db.$client
    .prepare(
      "INSERT INTO dealers (dealer_id, name, website, country, state, postal_code, city) " +
        "VALUES (?, ?, ?, 'US', 'CA', '92614', 'Irvine')",
    )
    .run("dealer-rooftop-1", "Tustin Hyundai", website);
  db.$client
    .prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')",
    )
    .run(profileId, "dealer-rooftop-1");
}

/** A capture stub that scripts the OEM arm and the rooftop arm separately. */
function dualCaptureStub(script: {
  oem: OfferCaptureOutcome | "record-only";
  rooftop: OfferCaptureOutcome;
  record?: { calls: OfferCaptureArgs[] };
}) {
  return async (args: OfferCaptureArgs): Promise<OfferCaptureOutcome> => {
    script.record?.calls.push(args);
    if (args.label.startsWith("oem-")) {
      if (script.oem === "record-only") throw new Error("unexpected OEM capture");
      return script.oem;
    }
    return script.rooftop;
  };
}

/** A harness stub returning different rows per snapshot marker. */
function perSourceHarnessStub(bySnippet: Record<string, Record<string, unknown>[]>) {
  return (async (input: { prompt: string }) => {
    for (const [snippet, incentives] of Object.entries(bySnippet)) {
      if (input.prompt.includes(snippet)) return { object: { incentives }, usage: NO_USAGE };
    }
    throw new Error("no scripted rows for this prompt");
  }) as unknown as IncentiveScrapeWorkflowDeps["harnessGenerate"];
}

const CASH_1500 = { type: "customer_cash", amount: 1500, expires: "2026-07-06", eligibility: "all" };
const CASH_2500 = { type: "customer_cash", amount: 2500, expires: "2026-07-06", eligibility: "all" };

describe("incentive_scrape dual-source gating (the voiced fallback map)", () => {
  afterEach(() => {
    setIncentiveScrapeBrowserEmitterFactory(() => NULL_EMITTER);
  });

  async function approvedRun(runId: string) {
    // No suspend: the first encounter is auto-recorded and scraped in one start.
    const { result } = await startRun(runId);
    expect((result as { status: string }).status).toBe("success");
    return result;
  }

  it("OEM blocked → rooftop becomes the source: VOICED oem_source_fallback, rooftop provenance persisted", async () => {
    seedProfile();
    seedRooftopDealer();
    const emitter = recordingEmitter();
    setIncentiveScrapeBrowserEmitterFactory(() => emitter);
    installDeps({
      captureOffers: dualCaptureStub({
        oem: { kind: "blocked", url: SEED_URL, marker: "akamai_block_page" },
        rooftop: {
          kind: "captured",
          url: "https://www.tustinhyundai.com/specials",
          snapshotText: "ROOFTOP $1,500 Retail Bonus Cash",
          snapshotFallback: false,
        },
      }),
      harnessGenerate: perSourceHarnessStub({ ROOFTOP: [CASH_1500] }),
    });

    const final = await approvedRun("inc-fb-1");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(final));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.brandsScraped).toBe(1);
    expect(output.sourceFallbacks).toBe(1);
    expect(output.summary).toContain("rooftop only");
    expect(emitter.actions).toContainEqual(["oem_source_fallback", "hyundai"]);
    const rows = incentiveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["scrape_source_url"]).toBe("https://www.tustinhyundai.com/specials");
  });

  it("both arms refused → blocked failure, ONE contact per arm, never escalated, zero writes", async () => {
    seedProfile();
    seedRooftopDealer();
    const record = { calls: [] as OfferCaptureArgs[] };
    installDeps({
      captureOffers: dualCaptureStub({
        oem: { kind: "blocked", url: SEED_URL, marker: "akamai_block_page" },
        rooftop: { kind: "blocked", url: "https://www.tustinhyundai.com/specials", marker: "403" },
        record,
      }),
      harnessGenerate: harnessNeverCalled,
    });

    const final = await approvedRun("inc-fb-2");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(final));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.brandsExtractionFailed).toBe(1);
    expect(output.summary).toContain("blocked");
    expect(record.calls).toHaveLength(2); // one ladder per arm — no retries
    expect(incentiveRows()).toHaveLength(0);
  });

  it("dual capture, same programs → cross-verified (confidence boost), single-source truth persisted", async () => {
    seedProfile();
    seedRooftopDealer();
    installDeps({
      captureOffers: dualCaptureStub({
        oem: { kind: "captured", url: SEED_URL, snapshotText: "OEMPAGE offers", snapshotFallback: false },
        rooftop: {
          kind: "captured",
          url: "https://www.tustinhyundai.com/specials",
          snapshotText: "ROOFTOP specials",
          snapshotFallback: false,
        },
      }),
      harnessGenerate: perSourceHarnessStub({ OEMPAGE: [CASH_1500], ROOFTOP: [CASH_1500] }),
    });

    const final = await approvedRun("inc-fb-3");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(final));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.crossVerifiedBrands).toBe(1);
    expect(output.sourceDiscrepancies).toBe(0);
    const rows = incentiveRows();
    expect(rows).toHaveLength(1); // the OEM truth set, never a union
    expect(rows[0]!["scrape_source_url"]).toBe(SEED_URL);
  });

  it("dual capture, same type different amount → VOICED source_discrepancy + an honest summary note", async () => {
    seedProfile();
    seedRooftopDealer();
    const emitter = recordingEmitter();
    setIncentiveScrapeBrowserEmitterFactory(() => emitter);
    installDeps({
      captureOffers: dualCaptureStub({
        oem: { kind: "captured", url: SEED_URL, snapshotText: "OEMPAGE offers", snapshotFallback: false },
        rooftop: {
          kind: "captured",
          url: "https://www.tustinhyundai.com/specials",
          snapshotText: "ROOFTOP specials",
          snapshotFallback: false,
        },
      }),
      harnessGenerate: perSourceHarnessStub({ OEMPAGE: [CASH_1500], ROOFTOP: [CASH_2500] }),
    });

    const final = await approvedRun("inc-fb-4");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(final));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.crossVerifiedBrands).toBe(0);
    expect(output.sourceDiscrepancies).toBe(1);
    expect(output.summary).toContain("DISAGREE");
    expect(emitter.actions.some(([type]) => type === "source_discrepancy")).toBe(true);
    // The persisted truth is still the OEM set — the rooftop only verifies.
    const rows = incentiveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["amount"]).toBe(1500);
  });

  it("two profiles, ONE brand: a single auto-recorded source covers both targets", async () => {
    seedProfile({ id: "prof-a", accountId: "acct-1", zip: "92614" });
    seedProfile({ id: "prof-b", model: "Elantra", accountId: "acct-2", zip: "90001" });
    installDeps();
    const { result } = await startRun("inc-fb-5");
    expect((result as { status: string }).status).toBe("success");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(result));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.targetsTotal).toBe(2);
    expect(output.brandsScraped).toBe(2); // brand-keyed registry covered both
    const registry = readIncentiveRegistry(registryPath());
    expect(Object.keys(registry)).toEqual(["hyundai"]);
  });
});

describe("incentive_scrape fail-closed (the armed extraction)", () => {
  it("a THROWN EmitResultNotCalledError fails the run — persist never reached, zero rows", async () => {
    seedProfile();
    installDeps({
      harnessGenerate: (async () => {
        throw new EmitResultNotCalledError("incentive_extract");
      }) as unknown as IncentiveScrapeWorkflowDeps["harnessGenerate"],
    });
    const { result } = await startRun("inc-failclosed-a");
    expect((result as { status: string }).status).toBe("failed");
    expect(errorMessageOf(result)).toMatch(/emit_result/);
    expect(incentiveRows()).toHaveLength(0); // capture happened; persist never did
  });

  it("rows that fail the Zod contract drop + count; the run stays honest", async () => {
    seedProfile();
    installDeps({
      harnessGenerate: harnessStub([
        { type: "customer_cash", amount: 1500, expires: "2026-07-06", eligibility: "all" },
        { type: "customer_cash", amount: -5, expires: null, eligibility: "all" }, // ge-0 violated
        { type: "customer_cash", amount: 500, expires: "July 6", eligibility: "all" }, // prose date
      ]),
    });
    const { result } = await startRun("inc-zod-1");
    const output = IncentiveScrapeOutputSchema.parse(outputOf(result));
    if (output.outcome !== "scraped") throw new Error("expected scraped outcome");
    expect(output.rowsInvalidDropped).toBe(2);
    expect(output.incentivesWritten).toBe(1);
  });
});

