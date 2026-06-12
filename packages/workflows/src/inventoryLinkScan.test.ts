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
import { BatchReviewResumeSchema } from "./inventorySiteScan.js";
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
const MIGRATION_SQLS = ["0000_military_red_skull.sql", "0001_redundant_ozymandias.sql"].map(
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
  over: Partial<{ id: string; make: string; model: string }> = {},
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
      "SEL",
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
