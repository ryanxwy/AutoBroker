/**
 * In-stack tests — the inventory_link_scan flat workflow.
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start/
 * resume chain (in-process against a tmp mastra.db) → REAL step closures,
 * with the runtime collaborators injected through the test-only deps seam:
 * the capture boundary and the harness call are deterministic stubs, while
 * the profile resolver, the pending-source loader and the persist writer run
 * REAL against an ISOLATED tmp autobroker.db (the committed migrations
 * applied). NO real browser, NO live LLM, no network.
 *
 * Coverage:
 *   - contracts            → suspend payload shape (shared batch_review card
 *                            wire, source-id rows, closed skip enum), resume
 *                            schema identity with the site scan, output
 *                            round-trip, typed STOP error.
 *   - loadSources/filters  → pending-only rows; junk rule + US gate skips
 *                            surface on the card and NEVER write pre-gate.
 *   - reviewGate           → suspend-before-navigation; approve subset (only
 *                            approved links reach capture + DB; card-skipped
 *                            links stay PENDING); decline = terminal declined,
 *                            zero writes, capture never invoked; zero pending
 *                            = 0/0 done with no suspend.
 *   - visitExtract         → VIN provenance drops, URL provenance (collected
 *                            hrefs ∪ the link itself), match classification +
 *                            filterForProfile rejects, per-link counts.
 *   - persist              → scanned link flips ITS seeded row to 'scanned',
 *                            junk/US rows marked 'skipped' (post-approval
 *                            only), listings written profile-scoped through
 *                            the dual-arm writer.
 *   - resolver STOPs       → 0 / 2+ / pinned / inferred-newest branches.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/
 * restored); mastra.db + autobroker.db both live there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, seedInventorySource, type Db } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import { BatchReviewResumeSchema } from "./batchReviewContracts.js";
import {
  inventoryLinkScanWorkflow,
  InventoryLinkScanStopError,
  INVENTORY_LINK_SCAN_WORKFLOW_ID,
  LINK_SCAN_REVIEW_QUESTION,
  LinkScanOutputSchema,
  LinkScanReviewResumeSchema,
  LinkScanReviewSuspendSchema,
  __resetInventoryLinkScanDepsForTests,
  __setInventoryLinkScanDepsForTests,
  type InventoryLinkScanWorkflowDeps,
  type LinkScanCaptureArgs,
  type SourceCaptureOutcome,
} from "./inventoryLinkScan.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0004_empty_celestials.sql",
].map(
  (f) => join(here, "..", "..", "db", "drizzle", f),
);

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-linkscan-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb(); // <tmpDir>/autobroker.db
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetInventoryLinkScanDepsForTests();
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

/** A 17-char VIN with none of I/O/Q. */
const VIN_A = "5NMJFCDE8RH123456";

const URL_A = "https://www.d-a.com/new-inventory/index.htm?model=Tucson";
const URL_B = "https://www.d-b.com/new-inventory/";
const CARD_HREF = "https://www.d-a.com/new/Hyundai-Tucson-1.htm";

function seedProfile(
  over: Partial<{ id: string; make: string; model: string; trim: string | null }> = {},
): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "search_radius_miles, location_query, latitude, longitude, follow_up_email, " +
        "financing_preference, status, brand, account_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      over.id ?? "prof-1",
      2026,
      over.make ?? "Hyundai",
      over.model ?? "Tucson",
      over.trim === undefined ? "SEL" : over.trim,
      120,
      "Irvine, CA 92602",
      33.6695,
      -117.7669,
      "buyer@example.com",
      "finance",
      "active",
      over.make ?? "Hyundai",
      "acct-test-1",
    );
}

function seedDealer(over: {
  id: string;
  name: string;
  website?: string | null;
  country?: string;
  profileId?: string;
}): void {
  db.$client
    .prepare(
      "INSERT INTO dealers (dealer_id, name, website, country, state, postal_code, city) " +
        "VALUES (?, ?, ?, ?, 'CA', '92602', 'Irvine')",
    )
    .run(
      over.id,
      over.name,
      over.website === undefined ? `https://www.${over.id}.com` : over.website,
      over.country ?? "US",
    );
  db.$client
    .prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')",
    )
    .run(over.profileId ?? "prof-1", over.id);
}

/** Seed one pending link through the REAL tools seeder (frozen-id space). */
function seedLink(dealerId: string, url: string, profileId = "prof-1"): string {
  return seedInventorySource({
    searchProfileId: profileId,
    dealerId,
    sourceUrl: url,
    db,
  }).sourceId;
}

function rowCount(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

function sourceStatus(sourceId: string): string | undefined {
  const r = db.$client
    .prepare("SELECT last_status FROM dealer_inventory_sources WHERE source_id = ?")
    .get(sourceId) as { last_status: string } | undefined;
  return r?.last_status;
}

const NO_USAGE = {
  costUsd: null,
  durationMs: 0,
  pricingSource: "unavailable" as const,
  promptTokens: null,
  completionTokens: null,
};

/** A valid 11-field listing row matching the Tucson profile. */
function listing(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    year: 2026,
    make: "Hyundai",
    model: "Tucson",
    trim: "SEL",
    vin: null,
    stock_number: "H12345",
    price: 33999,
    exterior_color: "White",
    interior_color: "Gray",
    inventory_status: "in_stock",
    listing_url: CARD_HREF,
    ...over,
  };
}

/** A scanned capture outcome for a link. */
function scannedLink(
  sourceId: string,
  over: Partial<SourceCaptureOutcome> = {},
): SourceCaptureOutcome {
  return {
    sourceId,
    status: "scanned",
    errorJson: null,
    snapshotText: `New 2026 Hyundai Tucson SEL ${VIN_A} $33,999`,
    cardHrefs: [CARD_HREF],
    snapshotFallback: false,
    ...over,
  };
}

/** Build a capture stub that records the targets it was handed. */
function captureStub(
  record: { calls: LinkScanCaptureArgs[] },
  outcomesFor: (args: LinkScanCaptureArgs) => SourceCaptureOutcome[],
): InventoryLinkScanWorkflowDeps["captureLinks"] {
  return async (args) => {
    record.calls.push(args);
    return outcomesFor(args);
  };
}

/** A capture stub that must NEVER fire (pre-scan STOP/decline paths). */
const captureNeverCalled: InventoryLinkScanWorkflowDeps["captureLinks"] = async () => {
  throw new Error("captureLinks must not be called on this path");
};

/** A harness stub that must NEVER fire (zero-LLM paths). */
const harnessNeverCalled = (async () => {
  throw new Error("harness.generate must not be called on this path");
}) as unknown as InventoryLinkScanWorkflowDeps["harnessGenerate"];

/** A harness stub returning the same listings for every link. */
function harnessStub(
  listings: Record<string, unknown>[],
  record?: { prompts: string[] },
): InventoryLinkScanWorkflowDeps["harnessGenerate"] {
  return (async (input: { prompt: string }) => {
    record?.prompts.push(input.prompt);
    return { object: { listings }, usage: NO_USAGE };
  }) as unknown as InventoryLinkScanWorkflowDeps["harnessGenerate"];
}

function linkWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [INVENTORY_LINK_SCAN_WORKFLOW_ID]: inventoryLinkScanWorkflow as never },
  });
  return mastra.getWorkflow(INVENTORY_LINK_SCAN_WORKFLOW_ID);
}

async function startRun(runId: string, searchProfileId: string | null = null) {
  const wf = linkWorkflow();
  const run = await wf.createRun({ runId });
  const result = await run.start({ inputData: { search_profile_id: searchProfileId } });
  return { run, result };
}

/** The reviewGate suspend payload off a suspended WorkflowResult. */
function suspendPayloadOf(result: unknown): Record<string, unknown> {
  const steps = (result as { steps?: Record<string, { suspendPayload?: Record<string, unknown> }> })
    .steps;
  const payload = steps?.["reviewGate"]?.suspendPayload;
  expect(payload).toBeDefined();
  return payload!;
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

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

describe("inventory_link_scan contract", () => {
  it("the suspend payload parses the shared batch_review card shape (source-id rows)", () => {
    const payload = {
      kind: "batch_review",
      question: LINK_SCAN_REVIEW_QUESTION,
      targets: [
        {
          dealer_id: "src_aaaaaaaaaaaaaaaa", // the SOURCE id is the row identity
          name: "Tustin Hyundai",
          website: "https://www.tustinhyundai.com/new-inventory/index.htm?model=Tucson",
        },
      ],
      skipped: [
        { dealer_id: "src_bbbbbbbbbbbbbbbb", name: "Tustin Hyundai", reason: "bare_homepage" },
        { dealer_id: "src_cccccccccccccccc", name: "Maple Toronto", reason: "non_us_dealer" },
      ],
      total_targets: 1,
      total_in_radius: 3,
    };
    expect(LinkScanReviewSuspendSchema.parse(payload)).toEqual(payload);
  });

  it("rejects a skip reason outside the closed vocabulary (a typo never renders)", () => {
    const bad = {
      kind: "batch_review",
      question: LINK_SCAN_REVIEW_QUESTION,
      targets: [],
      skipped: [{ dealer_id: "src_x", name: "X", reason: "not_a_reason" }],
      total_targets: 0,
      total_in_radius: 1,
    };
    expect(() => LinkScanReviewSuspendSchema.parse(bad)).toThrow();
  });

  it("the resume schema IS the shared batch_review resume (same object, same vocabulary)", () => {
    expect(LinkScanReviewResumeSchema).toBe(BatchReviewResumeSchema);
    expect(() =>
      LinkScanReviewResumeSchema.parse({ action: "approve", approved_dealer_ids: [] }),
    ).toThrow(); // min-1: an empty approve list never reaches the workflow.
  });

  it("the output contract carries the typed counts and the declined member", () => {
    expect(LinkScanOutputSchema.parse({ outcome: "declined" })).toEqual({ outcome: "declined" });
  });

  it("the typed STOP error carries its code and name", () => {
    const err = new InventoryLinkScanStopError("no_active_profile", "No active search profile.");
    expect(err.code).toBe("no_active_profile");
    expect(err.name).toBe("InventoryLinkScanStopError");
  });
});

// ---------------------------------------------------------------------------
// load + filter + gate: the suspend renders BEFORE any navigation
// ---------------------------------------------------------------------------

describe("inventory_link_scan — load/filter/usGate/reviewGate", () => {
  it("junk + non-US links surface on the card's skipped section; nothing writes pre-gate", async () => {
    seedProfile();
    seedDealer({ id: "d-a", name: "Dealer A" });
    seedDealer({ id: "d-b", name: "Dealer B" });
    seedDealer({ id: "d-ca", name: "Maple Toronto", country: "CA", website: "https://www.maple.ca" });
    const srcA = seedLink("d-a", URL_A);
    const srcJunk = seedLink("d-b", "https://www.d-b.com/"); // bare homepage → junk
    const srcCa = seedLink("d-ca", "https://www.maple.ca/inventory/new/");

    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessNeverCalled,
      captureLinks: captureNeverCalled,
    });

    const { result } = await startRun("link-gate-1");
    expect(result.status).toBe("suspended");
    const payload = LinkScanReviewSuspendSchema.parse(suspendPayloadOf(result));
    expect(payload.question).toBe(LINK_SCAN_REVIEW_QUESTION);
    expect(payload.targets).toEqual([
      { dealer_id: srcA, name: "Dealer A", website: URL_A },
    ]);
    expect(payload.skipped).toEqual([
      { dealer_id: srcJunk, name: "Dealer B", reason: "bare_homepage" },
      { dealer_id: srcCa, name: "Maple Toronto", reason: "non_us_dealer" },
    ]);
    expect(payload.total_targets).toBe(1);
    expect(payload.total_in_radius).toBe(3);

    // PRE-GATE ZERO WRITES: every seeded row is still pending while suspended.
    for (const id of [srcA, srcJunk, srcCa]) expect(sourceStatus(id)).toBe("pending");
    expect(rowCount("inventory_listings")).toBe(0);
  });

  it("zero pending links → 0/0 done with NO suspend (a normal outcome, not a STOP)", async () => {
    seedProfile();
    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessNeverCalled,
      captureLinks: captureNeverCalled,
    });
    const { result } = await startRun("link-empty-1");
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as Record<string, unknown>;
    expect(out["outcome"]).toBe("scanned");
    expect(out["urlsScanned"]).toBe(0);
    expect(out["listingsMatched"]).toBe(0);
    expect(String(out["summary"])).toContain("No pending inventory links");
  });

  it("resolver STOPs: 0 active and 2+ active are typed STOPs", async () => {
    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessNeverCalled,
      captureLinks: captureNeverCalled,
    });
    const { result: none } = await startRun("link-stop-none");
    expect(none.status).toBe("failed");
    expect(errorMessageOf(none)).toContain("No active search profile");

    // Two brands: the active-slot uniqueness is per (account, brand).
    seedProfile({ id: "prof-1" });
    seedProfile({ id: "prof-2", make: "Toyota", model: "RAV4" });
    const { result: ambiguous } = await startRun("link-stop-ambiguous");
    expect(ambiguous.status).toBe("failed");
    expect(errorMessageOf(ambiguous)).toContain("Multiple active search profiles");
  });

  it("a null-trim profile → typed STOP before any capture (no blank-trim matching)", async () => {
    seedProfile({ trim: null });
    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessNeverCalled,
      captureLinks: captureNeverCalled,
    });
    const { result } = await startRun("link-notrim-1");
    expect(result.status).toBe("failed");
    const msg = errorMessageOf(result);
    expect(msg).toContain("trim is required before");
    expect(msg).toContain("Start a new search");
  });
});

// ---------------------------------------------------------------------------
// approve subset / decline
// ---------------------------------------------------------------------------

describe("inventory_link_scan — approve subset and decline", () => {
  it("approve a SUBSET → only those links reach capture + DB; card-skipped links stay PENDING", async () => {
    seedProfile();
    seedDealer({ id: "d-a", name: "Dealer A" });
    seedDealer({ id: "d-b", name: "Dealer B" });
    const srcA = seedLink("d-a", URL_A);
    const srcB = seedLink("d-b", URL_B);

    const record = { calls: [] as LinkScanCaptureArgs[] };
    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessStub([listing()]),
      captureLinks: captureStub(record, (args) =>
        args.targets.map((t) => scannedLink(t.sourceId)),
      ),
    });

    const { run, result } = await startRun("link-approve-1");
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "reviewGate",
      resumeData: { action: "approve", approved_dealer_ids: [srcA] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;

    // Only the approved link reached the capture boundary.
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]!.targets).toEqual([{ sourceId: srcA, url: URL_A }]);

    const out = LinkScanOutputSchema.parse(final.result);
    if (out.outcome !== "scanned") throw new Error("expected scanned outcome");
    expect(out.resolution).toBe("inferred_newest");
    expect(out.sourcesApproved).toBe(1);
    expect(out.urlsScanned).toBe(1);
    expect(out.listingsFound).toBe(1);
    expect(out.listingsMatched).toBe(1);
    expect(out.listingsWritten).toBe(1);

    // The scanned link's OWN seeded row flipped (frozen id space — no second
    // row was minted); the card-skipped link stays pending for the next run.
    expect(sourceStatus(srcA)).toBe("scanned");
    expect(sourceStatus(srcB)).toBe("pending");
    expect(rowCount("dealer_inventory_sources")).toBe(2);
    expect(rowCount("inventory_listings")).toBe(1);
  });

  it("decline → terminal declined, ZERO writes (even junk skip marks), capture never invoked", async () => {
    seedProfile();
    seedDealer({ id: "d-a", name: "Dealer A" });
    seedDealer({ id: "d-b", name: "Dealer B" });
    const srcA = seedLink("d-a", URL_A);
    const srcJunk = seedLink("d-b", "https://www.d-b.com/"); // junk → card's skipped section

    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessNeverCalled,
      captureLinks: captureNeverCalled,
    });

    const { run, result } = await startRun("link-decline-1");
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "reviewGate",
      resumeData: { action: "decline" },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect((final.result as { outcome: string }).outcome).toBe("declined");

    // ZERO writes: both rows still pending (not even the junk skip mark — the
    // persist step is the only writer and a decline never reaches it).
    expect(sourceStatus(srcA)).toBe("pending");
    expect(sourceStatus(srcJunk)).toBe("pending");
    expect(rowCount("inventory_listings")).toBe(0);
  });

  it("an explicit search_profile_id resolves pinned and threads to the output", async () => {
    seedProfile();
    seedDealer({ id: "d-a", name: "Dealer A" });
    const srcA = seedLink("d-a", URL_A);
    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessStub([listing()]),
      captureLinks: captureStub({ calls: [] }, (args) =>
        args.targets.map((t) => scannedLink(t.sourceId)),
      ),
    });
    const { run, result } = await startRun("link-pinned-1", "prof-1");
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "reviewGate",
      resumeData: { action: "approve", approved_dealer_ids: [srcA] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect((final.result as { resolution: string }).resolution).toBe("pinned");
  });
});

// ---------------------------------------------------------------------------
// visitExtract: provenance guards + the deterministic profile filter
// ---------------------------------------------------------------------------

describe("inventory_link_scan — extract guards + profile filter + persist marks", () => {
  it("VIN provenance, URL provenance (hrefs ∪ the link itself), match filter, junk skip marks", async () => {
    seedProfile();
    seedDealer({ id: "d-a", name: "Dealer A" });
    seedDealer({ id: "d-b", name: "Dealer B" });
    const srcA = seedLink("d-a", URL_A);
    const srcJunk = seedLink("d-b", "https://www.d-b.com/"); // junk → skipped mark at persist

    const rows = [
      listing(), // in-set URL, matches profile → accepted (URL arm)
      listing({ vin: VIN_A, listing_url: null }), // VIN verbatim in snapshot → accepted (VIN arm)
      listing({ vin: "5NMJFCDE8RH999999", listing_url: null }), // VIN NOT in snapshot → dropped
      listing({ listing_url: "https://www.evil.example/invented" }), // out-of-set URL → cleared → no key → droppedNoKey
      listing({ model: "Elantra" }), // wrong model → mismatch → rejected by the profile filter
      listing({ model: null, listing_url: null, vin: VIN_A }), // identity missing → unknown → rejected
    ];
    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessStub(rows),
      captureLinks: captureStub({ calls: [] }, (args) =>
        args.targets.map((t) => scannedLink(t.sourceId)),
      ),
    });

    const { run, result } = await startRun("link-guards-1");
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "reviewGate",
      resumeData: { action: "approve", approved_dealer_ids: [srcA] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;

    const out = LinkScanOutputSchema.parse(final.result);
    if (out.outcome !== "scanned") throw new Error("expected scanned outcome");
    expect(out.vinProvenanceDropped).toBe(1);
    expect(out.urlProvenanceStripped).toBe(1);
    expect(out.listingsFound).toBe(5); // 6 emitted - 1 VIN-provenance drop
    expect(out.rowsRejected).toBe(2); // mismatch + unknown
    expect(out.listingsMatched).toBe(3); // URL-arm + VIN-arm + stripped-URL row
    // The stripped-URL row has NO key left → the writer drops it (counted
    // inside the writer); the two keyed rows landed.
    expect(out.listingsWritten).toBe(2);
    expect(rowCount("inventory_listings")).toBe(2);

    // Status transitions landed at persist: scanned link flipped, junk marked.
    expect(sourceStatus(srcA)).toBe("scanned");
    expect(sourceStatus(srcJunk)).toBe("skipped");
    const junkRow = db.$client
      .prepare("SELECT error_json FROM dealer_inventory_sources WHERE source_id = ?")
      .get(srcJunk) as { error_json: string };
    expect(JSON.parse(junkRow.error_json)).toEqual({
      reason: "non_inventory_url",
      rule: "bare_homepage",
    });
  });

  it("model/trim boundary drift ('Tucson' + 'Hybrid Limited') resegments to 'Tucson Hybrid' → near, persisted (not rejected as mismatch)", async () => {
    seedProfile({ model: "Tucson Hybrid" });
    seedDealer({ id: "d-a", name: "Dealer A" });
    const srcA = seedLink("d-a", URL_A);
    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessStub([listing({ model: "Tucson", trim: "Hybrid Limited" })]),
      captureLinks: captureStub({ calls: [] }, (args) =>
        args.targets.map((t) => scannedLink(t.sourceId)),
      ),
    });
    const { run, result } = await startRun("link-reseg-1");
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "reviewGate",
      resumeData: { action: "approve", approved_dealer_ids: [srcA] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const row = db.$client
      .prepare("SELECT match_status, model, trim FROM inventory_listings")
      .get() as { match_status: string; model: string; trim: string };
    // Without the resegment, model "Tucson" ≠ profile "Tucson Hybrid" → mismatch → rejected.
    // Resegmented: model "Tucson Hybrid" matches; trim SEL ≠ Limited → near → persisted.
    expect(row.match_status).toBe("near");
    expect(row.model).toBe("Tucson Hybrid");
    expect(row.trim).toBe("Limited");
  });

  it("a card-less capture accepts the LINK's own URL as listing_url provenance", async () => {
    seedProfile();
    seedDealer({ id: "d-a", name: "Dealer A" });
    const vdpUrl = "https://www.d-a.com/vehicle/2026-hyundai-tucson-sel";
    const srcA = seedLink("d-a", vdpUrl);

    __setInventoryLinkScanDepsForTests({
      // The page IS the listing: the model copies the page's own URL.
      harnessGenerate: harnessStub([listing({ listing_url: vdpUrl, vin: null })]),
      captureLinks: captureStub({ calls: [] }, (args) =>
        args.targets.map((t) =>
          scannedLink(t.sourceId, {
            cardHrefs: [], // card-less (VDP) capture
            snapshotFallback: true,
            snapshotText: "2026 Hyundai Tucson SEL $33,999 — one owner page text",
          }),
        ),
      ),
    });

    const { run, result } = await startRun("link-vdp-1");
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "reviewGate",
      resumeData: { action: "approve", approved_dealer_ids: [srcA] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = LinkScanOutputSchema.parse(final.result);
    if (out.outcome !== "scanned") throw new Error("expected scanned outcome");
    expect(out.urlProvenanceStripped).toBe(0); // the link itself vouched for the URL
    expect(out.listingsWritten).toBe(1);
    expect(out.summary).toContain("plain-text snapshot fallback");
  });
});

// ---------------------------------------------------------------------------
// step-④ fallback gating: blocked-at-first-contact, voiced snapshot fallback,
// per-link isolation, whole-bucket degrade, fail-closed hard-abort.
// ---------------------------------------------------------------------------

import type { BrowserEmitter, BrowserSession } from "@autobroker/tools";
import {
  bucketLinksByHost,
  captureLinksParallelImpl,
  captureOneLink,
  runLinkBucket,
  type LinkBucketRunner,
} from "./inventoryLinkScan.js";

/** Recording emitter (the voiced-trace assertions read `actions`). */
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

/** A fake session whose navigate is scripted per URL. Pages record evaluate/
 *  close; lazyScroll and snapshot are counted. */
function fakeSession(script: {
  navigate: (url: string) => { blocked: string | null } | Error;
  cards?: Array<{ href: string; cardText: string }>;
  snapshotText?: string;
}) {
  const calls = { navigate: [] as string[], lazyScroll: 0, snapshot: 0, evaluate: 0 };
  const page = {
    evaluate: async () => {
      calls.evaluate += 1;
      return script.cards ?? [];
    },
    close: async () => undefined,
  };
  const session = {
    newPage: async () => page,
    navigate: async (_page: unknown, url: string) => {
      calls.navigate.push(url);
      const r = script.navigate(url);
      if (r instanceof Error) throw r;
      return { robotsDisallowed: false, blocked: r.blocked };
    },
    lazyScroll: async () => {
      calls.lazyScroll += 1;
    },
    snapshot: async () => {
      calls.snapshot += 1;
      return script.snapshotText ?? "plain page text";
    },
  } as unknown as BrowserSession;
  return { session, calls };
}

describe("inventory_link_scan — capture fallback gating (fake session)", () => {
  it("blocked at FIRST CONTACT: recorded, nothing scrolled or snapshotted, never escalated", async () => {
    const { session, calls } = fakeSession({ navigate: () => ({ blocked: "http_403" }) });
    const emitter = recordingEmitter();
    const target = { sourceId: "src-1", url: "https://www.d-a.com/new/" };
    const queueNav: Parameters<typeof captureOneLink>[0]["queueNav"] = (page, url) =>
      session.navigate(page, url);

    const outcome = await captureOneLink({ session, queueNav, emitter, target, host: "www.d-a.com" });
    expect(outcome.status).toBe("blocked");
    expect(JSON.parse(outcome.errorJson ?? "{}")).toEqual({ reason: "blocked", marker: "http_403" });
    expect(calls.navigate).toEqual(["https://www.d-a.com/new/"]); // exactly ONE contact
    expect(calls.lazyScroll).toBe(0);
    expect(calls.snapshot).toBe(0);
    expect(calls.evaluate).toBe(0);
  });

  it("card-less DOM → plain snapshot, VOICED as snapshot_fallback (auto-allowed, never silent)", async () => {
    const { session, calls } = fakeSession({
      navigate: () => ({ blocked: null }),
      cards: [],
      snapshotText: "VDP page text 2026 Hyundai Tucson",
    });
    const emitter = recordingEmitter();
    const target = { sourceId: "src-1", url: "https://www.d-a.com/vehicle/1" };
    const queueNav: Parameters<typeof captureOneLink>[0]["queueNav"] = (page, url) =>
      session.navigate(page, url);

    const outcome = await captureOneLink({ session, queueNav, emitter, target, host: "www.d-a.com" });
    expect(outcome.status).toBe("scanned");
    expect(outcome.snapshotFallback).toBe(true);
    expect(outcome.snapshotText).toBe("VDP page text 2026 Hyundai Tucson");
    expect(calls.snapshot).toBe(1);
    expect(emitter.actions).toContainEqual(["snapshot_fallback", "www.d-a.com"]);
  });

  it("a card-bearing DOM weaves URL-tailed blocks and does NOT voice the fallback", async () => {
    const { session } = fakeSession({
      navigate: () => ({ blocked: null }),
      cards: [{ href: "https://www.d-a.com/new/1.htm", cardText: "2026 Hyundai Tucson SEL $33,999" }],
    });
    const emitter = recordingEmitter();
    const target = { sourceId: "src-1", url: "https://www.d-a.com/new/" };
    const queueNav: Parameters<typeof captureOneLink>[0]["queueNav"] = (page, url) =>
      session.navigate(page, url);

    const outcome = await captureOneLink({ session, queueNav, emitter, target, host: "www.d-a.com" });
    expect(outcome.snapshotFallback).toBe(false);
    expect(outcome.snapshotText).toContain("URL: https://www.d-a.com/new/1.htm");
    expect(outcome.cardHrefs).toEqual(["https://www.d-a.com/new/1.htm"]);
    expect(emitter.actions.filter(([t]) => t === "snapshot_fallback")).toHaveLength(0);
  });

  it("runLinkBucket: once the host refuses, the REST of the bucket is blocked WITHOUT re-contact", async () => {
    const { session, calls } = fakeSession({ navigate: () => ({ blocked: "http_429" }) });
    const emitter = recordingEmitter();
    const bucket = {
      host: "www.d-a.com",
      targets: [
        { sourceId: "src-1", url: "https://www.d-a.com/new/" },
        { sourceId: "src-2", url: "https://www.d-a.com/used/" },
      ],
    };
    const outcomes = await runLinkBucket({ session, emitter, bucket });
    expect(outcomes.map((o) => o.status)).toEqual(["blocked", "blocked"]);
    expect(calls.navigate).toEqual(["https://www.d-a.com/new/"]); // ONE contact total
    expect(JSON.parse(outcomes[1]!.errorJson ?? "{}")).toEqual({
      reason: "blocked",
      marker: "http_429",
      propagated: true,
    });
  });

  it("runLinkBucket: one link's navigation ERROR degrades that link only — siblings proceed", async () => {
    let first = true;
    const { session, calls } = fakeSession({
      navigate: () => {
        if (first) {
          first = false;
          return new Error("net::ERR_NAME_NOT_RESOLVED");
        }
        return { blocked: null };
      },
      cards: [{ href: "https://www.d-a.com/new/1.htm", cardText: "2026 Hyundai Tucson SEL" }],
    });
    const emitter = recordingEmitter();
    const bucket = {
      host: "www.d-a.com",
      targets: [
        { sourceId: "src-1", url: "https://www.d-a.com/dead/" },
        { sourceId: "src-2", url: "https://www.d-a.com/new/" },
      ],
    };
    const outcomes = await runLinkBucket({ session, emitter, bucket });
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "scanned"]);
    expect(JSON.parse(outcomes[0]!.errorJson ?? "{}")).toMatchObject({ reason: "capture_error" });
    expect(calls.navigate).toHaveLength(2);
  });

  it("captureLinksParallelImpl: a whole-bucket failure degrades to per-link failed outcomes, input order kept", async () => {
    const targets = [
      { sourceId: "src-1", url: "https://www.d-a.com/new/" },
      { sourceId: "src-2", url: "https://www.d-b.com/new/" },
      { sourceId: "src-3", url: "https://www.d-a.com/used/" },
    ];
    // Same-host links share ONE bucket (d-a twice), preserving first-seen order.
    expect(bucketLinksByHost(targets).map((b) => b.host)).toEqual(["www.d-a.com", "www.d-b.com"]);

    const runBucket: LinkBucketRunner = async (_args, bucket) => {
      if (bucket.host === "www.d-b.com") throw new Error("browser never launched");
      return bucket.targets.map((t) => ({
        sourceId: t.sourceId,
        status: "scanned" as const,
        errorJson: null,
        snapshotText: "ok",
        cardHrefs: [],
        snapshotFallback: false,
      }));
    };
    const outcomes = await captureLinksParallelImpl(
      { runId: "r-pool", targets, emitter: recordingEmitter() },
      runBucket,
    );
    expect(outcomes.map((o) => `${o.sourceId}:${o.status}`)).toEqual([
      "src-1:scanned",
      "src-2:failed",
      "src-3:scanned",
    ]);
    expect(JSON.parse(outcomes[1]!.errorJson ?? "{}")).toMatchObject({ reason: "scan_task_error" });
  });
});

describe("inventory_link_scan — hard-abort (fail-closed, zero writes)", () => {
  it("a fail-closed structured call aborts the run typed; persist is never reached", async () => {
    seedProfile();
    seedDealer({ id: "d-a", name: "Dealer A" });
    const srcA = seedLink("d-a", URL_A);

    __setInventoryLinkScanDepsForTests({
      // The emit_result tool never fires → the facade THROWS the typed error.
      harnessGenerate: (async () => {
        const { EmitResultNotCalledError } = await import("./harness.js");
        throw new EmitResultNotCalledError("inventory_extract");
      }) as unknown as InventoryLinkScanWorkflowDeps["harnessGenerate"],
      captureLinks: captureStub({ calls: [] }, (args) =>
        args.targets.map((t) => scannedLink(t.sourceId)),
      ),
    });

    const { run, result } = await startRun("link-failclosed-1");
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "reviewGate",
      resumeData: { action: "approve", approved_dealer_ids: [srcA] },
    });
    expect(final.status).toBe("failed");
    expect(errorMessageOf(final)).toContain("emit_result tool was not called");

    // Fail-closed = ZERO writes: the source row stays pending, no listings.
    expect(sourceStatus(srcA)).toBe("pending");
    expect(rowCount("inventory_listings")).toBe(0);
  });
});

describe("inventory_link_scan — the suspend payload stays renderable (<8KB, schema-bound)", () => {
  it("a realistic 25-link batch suspends under the 8KB card bound and parses the card schema", async () => {
    seedProfile();
    for (let i = 0; i < 25; i += 1) {
      const id = `d-${String(i).padStart(2, "0")}`;
      seedDealer({ id, name: `Citywide Hyundai Superstore ${i} of Greater Orange County` });
      seedLink(id, `https://www.${id}-hyundai-of-orange-county.example/new-inventory/index.htm?make=Hyundai&model=Tucson&year=2026&page=${i}`);
    }
    __setInventoryLinkScanDepsForTests({
      harnessGenerate: harnessNeverCalled,
      captureLinks: captureNeverCalled,
    });
    const { result } = await startRun("link-8kb-1");
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result);
    expect(LinkScanReviewSuspendSchema.parse(payload).targets).toHaveLength(25);
    expect(JSON.stringify(payload).length).toBeLessThan(8 * 1024);
  });
});
