/**
 * In-process integration tests — the backend vertical ("headless intake GREEN").
 * Drives the REAL Fastify app via inject():
 * REAL routes → REAL intake run service → REAL flat Mastra workflow → REAL
 * suspend/resume → REAL persist (tools profileService + openDb) against an
 * ISOLATED tmp autobroker.db (committed migration applied). The harness.generate
 * and goplaces.resolveLocation collaborators are injected through the workflows
 * test-deps seam; EVERYTHING else (engine, suspend/resume serialization, DB write
 * + audit row, the three-phase form-decision claim, SSE pubsub) is genuinely
 * exercised.
 *
 * Covers the headless-intake exit criteria + the SSE/claim invariants:
 *   (a) start(slash, no trim) → awaiting_user@collect → submit → done →
 *       exactly 1 search_profiles row + 1 audit row; GET /api/profiles/:id back.
 *   (b) start → collect → decline → declined → ZERO rows.
 *   (c) ambiguous: stub ambiguous → awaiting_user@resolveLocation → pick(1) →
 *       done; coords match the picked candidate.
 *   (d) double form-decision on the same suspend → idempotent 200 replay (no
 *       second resume), still exactly 1 row.
 *   (e) SSE replay: subscribe AFTER completion → full ordered backlog incl.
 *       init(driver_kind='deepseek_apikey') + a single terminal frame.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db both live there; NEVER ~/.autobroker*. The Mastra
 * singleton + runtime glue ownership set are reset between cases.
 * AUTOBROKER_TEST_AUTO_APPROVE is never set.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDb,
  create as createProfile,
  openDb,
  type Db,
  type GoplacesResult,
} from "@autobroker/tools";
import type { SearchProfileIntakeInput } from "@autobroker/core";
import {
  __resetIntakeDepsForTests,
  __setIntakeDepsForTests,
  __resetNegotiationSummaryDepsForTests,
  __setNegotiationSummaryDepsForTests,
  resetMastraForTests,
  resetRuntimeGlueForTests,
  type IntakeWorkflowDeps,
} from "@autobroker/workflows";

import { buildServer, type BuiltServer } from "./server.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "db",
  "drizzle",
  "0000_military_red_skull.sql",
);

let tmpDir: string;
let db: Db;
let server: BuiltServer;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const NO_USAGE = {
  costUsd: null,
  durationMs: 0,
  pricingSource: "unavailable" as const,
  promptTokens: null,
  completionTokens: null,
};

const RESOLVED: GoplacesResult = {
  kind: "resolved",
  location: {
    lat: 33.6695,
    lng: -117.7669,
    formattedAddress: "Irvine, CA 92602, USA",
    postalCode: "92602",
  },
  traceSpans: [],
};

/** A harness stub: trim-verify always-valid, prefill a fixed seed. */
function harnessStub(): IntakeWorkflowDeps["harnessGenerate"] {
  const fn = async (input: { useCase: string }) => {
    if (input.useCase === "intake_trim_verify") {
      return { object: { valid: true, attestation: "ok", suggested_trims: [] }, usage: NO_USAGE };
    }
    return {
      object: {
        make: "Hyundai",
        model: "Tucson",
        year: 2026,
        trim: null,
        location_query: "Irvine, CA",
        search_radius_miles: null,
        financing_preference: "finance",
      },
      usage: NO_USAGE,
    };
  };
  return fn as unknown as IntakeWorkflowDeps["harnessGenerate"];
}

/** A resolveLocation stub returning a fixed sequence (last repeats). */
function locationStub(sequence: GoplacesResult[]): IntakeWorkflowDeps["resolveLocation"] {
  let i = 0;
  const fn: IntakeWorkflowDeps["resolveLocation"] = async () => {
    const r = sequence[Math.min(i, sequence.length - 1)]!;
    i += 1;
    return r;
  };
  return fn;
}

/** A complete, valid 18-field submitted form. */
function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    make: "Hyundai",
    model: "Tucson",
    year: 2026,
    location_query: "Irvine, CA 92602",
    follow_up_email: "buyer@example.com",
    financing_preference: "finance",
    trim: "SEL",
    search_radius_miles: null,
    budget_max: null,
    follow_up_phone: null,
    phone_policy: null,
    preferred_exterior_colors_json: null,
    preferred_interior_colors_json: null,
    acceptable_trims_json: null,
    feature_preferences_json: null,
    trade_in_description: null,
    military_first_responder: null,
    current_brand_owner: null,
    ...over,
  };
}

function rowCount(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}
function auditCount(action: string): number {
  const r = db.$client
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
    .get(action) as { n: number };
  return r.n;
}

/** Parse the SSE body (data: lines) into the ordered event frames. */
function parseSse(body: string): Array<{ kind: string; payload: Record<string, unknown> }> {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice("data: ".length)) as { kind: string; payload: Record<string, unknown> });
}

beforeEach(async () => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-server-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];

  db = openDb(); // <tmpDir>/autobroker.db
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-1", "a@e.com");

  // Reset the Mastra singleton + runtime glue ownership BEFORE building so the
  // server constructs a fresh instance pointed at this tmp data dir.
  resetMastraForTests();
  resetRuntimeGlueForTests();
});

afterEach(async () => {
  __resetIntakeDepsForTests();
  if (server !== undefined) await server.app.close();
  db.$client.close();
  closeDb(); // release the shared getDb() handle the routes/steps cached.
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

/** Build a server with the intake deps wired (must set deps BEFORE start). */
async function buildWith(over: Partial<IntakeWorkflowDeps>): Promise<BuiltServer> {
  // default the web trim lookup to {none} so no freeform unit test reaches the
  // real web (a case may still override it explicitly).
  __setIntakeDepsForTests({ fetchTrimSources: async () => ({ kind: "none" }), ...over });
  server = await buildServer({ quiet: true });
  return server;
}

/** POST start (slash, no trim) and return {runId, decisionId@collect}. */
async function startSlashToCollect(s: BuiltServer): Promise<{ runId: string; decisionId: string }> {
  const start = await s.app.inject({
    method: "POST",
    url: "/api/skill-runs",
    payload: { skill: "search_profile_intake", input_mode: "slash" },
  });
  expect(start.statusCode).toBe(201);
  const runId = start.json<{ run_id: string }>().run_id;

  const status = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
  expect(status.statusCode).toBe(200);
  const summary = status.json<{
    status: string;
    pending: { step: string; decision_id: string } | null;
  }>();
  expect(summary.status).toBe("awaiting_approval");
  expect(summary.pending?.step).toBe("collect");
  return { runId, decisionId: summary.pending!.decision_id };
}

// ---------------------------------------------------------------------------
// (a) start → submit → done → exactly 1 profile + 1 audit
// ---------------------------------------------------------------------------

describe("headless intake GREEN", () => {
  it("GET /api/approvals lists the parked gate keyed by (runId, decisionId) over the wire", async () => {
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });
    const { runId, decisionId } = await startSlashToCollect(s);

    const approvals = await s.app.inject({ method: "GET", url: "/api/approvals" });
    expect(approvals.statusCode).toBe(200);
    const items = approvals.json<
      Array<{ kind: string; runId: string; decisionId: string; skill: string }>
    >();
    const item = items.find((i) => i.runId === runId);
    expect(item).toMatchObject({ kind: "gate", runId, decisionId, skill: "search_profile_intake" });
  });

  it("slash start → awaiting_user@collect → submit → done → 1 profile + 1 audit; GET /profiles/:id", async () => {
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });

    const { runId, decisionId } = await startSlashToCollect(s);

    const submit = await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "accept", content: validFields() } },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json<{ action: string }>().action).toBe("accept");

    // Exactly 1 profile row + 1 audit row.
    expect(rowCount("search_profiles")).toBe(1);
    expect(auditCount("search_profile_intake")).toBe(1);

    // Status is now done.
    const after = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
    expect(after.json<{ status: string }>().status).toBe("done");

    // GET /api/profiles/:id returns the created row.
    const profileId = db.$client
      .prepare("SELECT search_profile_id FROM search_profiles LIMIT 1")
      .get() as { search_profile_id: string };
    const view = await s.app.inject({ method: "GET", url: `/api/profiles/${profileId.search_profile_id}` });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ make: string }>().make).toBe("Hyundai");

    // GET /api/profiles list returns exactly the one.
    const list = await s.app.inject({ method: "GET", url: "/api/profiles" });
    expect(list.json<unknown[]>()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (b) decline → declined → ZERO rows
// ---------------------------------------------------------------------------

describe("decline at collect", () => {
  it("start → collect → decline → declined → ZERO profile + audit rows", async () => {
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });
    const { runId, decisionId } = await startSlashToCollect(s);

    const decline = await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "decline" } },
    });
    expect(decline.statusCode).toBe(200);
    expect(decline.json<{ action: string; content: unknown }>()).toEqual({
      action: "decline",
      content: null,
    });

    expect(rowCount("search_profiles")).toBe(0);
    expect(rowCount("audit_log")).toBe(0);

    const after = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
    expect(after.json<{ status: string }>().status).toBe("declined");
  });
});

// ---------------------------------------------------------------------------
// (c) ambiguous location → pick(1) → done; coords match
// ---------------------------------------------------------------------------

describe("ambiguous location ask-pick", () => {
  it("ambiguous → awaiting_user@resolveLocation → pick(1) → done; picked coords land", async () => {
    const ambiguous: GoplacesResult = {
      kind: "ambiguous",
      candidates: [
        { lat: 1, lng: 1, formattedAddress: "Irvine, CA, USA", postalCode: "92602" },
        { lat: 2, lng: 2, formattedAddress: "Irvine, KY, USA", postalCode: "40336" },
      ],
      traceSpans: [],
    };
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([ambiguous]),
    });
    const { runId, decisionId } = await startSlashToCollect(s);

    // submit → resolveLocation suspends ambiguous.
    const submit = await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "accept", content: validFields() } },
    });
    expect(submit.statusCode).toBe(200);

    const atLocation = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
    const loc = atLocation.json<{
      status: string;
      pending: { step: string; decision_id: string } | null;
    }>();
    expect(loc.status).toBe("awaiting_approval");
    expect(loc.pending?.step).toBe("resolveLocation");

    // pick index 1 → coords (2,2).
    const pick = await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: {
        decision_id: loc.pending!.decision_id,
        decision: { action: "accept", content: { action: "pick", picked_index: 1 } },
      },
    });
    expect(pick.statusCode).toBe(200);

    expect(rowCount("search_profiles")).toBe(1);
    const row = db.$client
      .prepare("SELECT latitude, longitude FROM search_profiles LIMIT 1")
      .get() as { latitude: number; longitude: number };
    expect(row.latitude).toBe(2);
    expect(row.longitude).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (d) double form-decision → idempotent replay (no second resume), 1 row
// ---------------------------------------------------------------------------

describe("form-decision idempotency (three-phase claim)", () => {
  it("a duplicate accept on the same suspend → 200 idempotent replay, still exactly 1 row", async () => {
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });
    const { runId, decisionId } = await startSlashToCollect(s);

    const first = await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "accept", content: validFields() } },
    });
    expect(first.statusCode).toBe(200);
    expect(rowCount("search_profiles")).toBe(1);

    // Re-POST the SAME decision_id + SAME body → idempotent replay of the prior
    // ack (NOT a second Mastra resume, which would throw "not suspended").
    const second = await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "accept", content: validFields() } },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    // Still exactly one row — no second persist.
    expect(rowCount("search_profiles")).toBe(1);
    expect(auditCount("search_profile_intake")).toBe(1);
  });

  it("a different body for an already-consumed decision → 409 decision_conflict", async () => {
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });
    const { runId, decisionId } = await startSlashToCollect(s);

    await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "accept", content: validFields() } },
    });

    const conflict = await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "decline" } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe("decision_conflict");
  });

  it("a form-decision for an unknown decision_id → 404 decision_not_found", async () => {
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });
    const { runId } = await startSlashToCollect(s);
    const bad = await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: "not-the-pending-one", decision: { action: "decline" } },
    });
    expect(bad.statusCode).toBe(404);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe("decision_not_found");
  });
});

// ---------------------------------------------------------------------------
// (e) SSE replay — subscribe AFTER completion → full ordered backlog
// ---------------------------------------------------------------------------

describe("SSE replay-on-subscribe", () => {
  it("subscribe after done → init(driver_kind) … text … done; single terminal", async () => {
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });
    const { runId, decisionId } = await startSlashToCollect(s);
    await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "accept", content: validFields() } },
    });

    const stream = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}/stream` });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");

    const frames = parseSse(stream.body);
    const kinds = frames.map((f) => f.kind);
    // First frame = init with driver_kind injected.
    expect(kinds[0]).toBe("init");
    expect(frames[0]!.payload).toMatchObject({ driver_kind: "deepseek_apikey", skill: "search_profile_intake" });
    // The backlog contains awaiting_user@collect then text then done, in order.
    expect(kinds).toContain("awaiting_user");
    expect(kinds[kinds.length - 1]).toBe("done");
    // Exactly one terminal frame.
    const terminals = kinds.filter((k) => k === "done" || k === "error" || k === "aborted");
    expect(terminals).toHaveLength(1);
  });

  it("decline run replays a single aborted terminal frame", async () => {
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });
    const { runId, decisionId } = await startSlashToCollect(s);
    await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "decline" } },
    });

    const stream = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}/stream` });
    const kinds = parseSse(stream.body).map((f) => f.kind);
    expect(kinds[0]).toBe("init");
    expect(kinds[kinds.length - 1]).toBe("aborted");
    expect(kinds.filter((k) => k === "done" || k === "error" || k === "aborted")).toHaveLength(1);
  });

  it("stream for an unknown run → 404", async () => {
    const s = await buildWith({
      harnessGenerate: harnessStub(),
      resolveLocation: locationStub([RESOLVED]),
    });
    const stream = await s.app.inject({ method: "GET", url: "/api/skill-runs/ghost/stream" });
    expect(stream.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// read-only routes (skills / mode / profiles error face)
// ---------------------------------------------------------------------------

describe("read-only routes", () => {
  it("GET /api/skills → the implemented-skill manifest (intake first, geosearch second)", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const r = await s.app.inject({ method: "GET", url: "/api/skills" });
    expect(r.statusCode).toBe(200);
    const manifest = r.json<Array<{ name: string; profile_pin: string }>>();
    const names = manifest.map((m) => m.name);
    expect(names[0]).toBe("search_profile_intake");
    expect(names).toContain("dealer_geosearch");
    // profile_pin rides every manifest entry (the pre-launch pin gate). Intake is
    // exempt; the inbox-check skill is pin_required.
    const intake = manifest.find((m) => m.name === "search_profile_intake");
    expect(intake?.profile_pin).toBe("exempt");
    const inbox = manifest.find((m) => m.name === "dealer_inbox_check");
    expect(inbox?.profile_pin).toBe("pin_required");
    for (const m of manifest) {
      expect(["exempt", "pin_required", "infer_ok"]).toContain(m.profile_pin);
    }
  });

  it("GET /api/mode → {active_db, data_dir, mode} pointed at the tmp data dir", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const r = await s.app.inject({ method: "GET", url: "/api/mode" });
    expect(r.statusCode).toBe(200);
    const mode = r.json<{ active_db: string; data_dir: string; mode: string }>();
    expect(mode.data_dir).toBe(tmpDir);
    expect(mode.active_db).toContain(tmpDir);
    expect(mode.active_db).not.toContain("/.autobroker/"); // never production
    // The harness host forces test mode, so the posture reports "test" here.
    expect(mode.mode).toBe("test");
  });

  it("GET /api/profiles/:id for a missing profile → 404", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const r = await s.app.inject({ method: "GET", url: "/api/profiles/nope" });
    expect(r.statusCode).toBe(404);
  });

  it("POST start with a bad body → 400 content_invalid envelope", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const r = await s.app.inject({
      method: "POST",
      url: "/api/skill-runs",
      payload: { skill: "search_profile_intake", input_mode: "bogus" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: { code: string } }>().error.code).toBe("content_invalid");
  });

  it("POST start with an unknown skill → 400 unknown_skill envelope", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const r = await s.app.inject({
      method: "POST",
      url: "/api/skill-runs",
      payload: { skill: "no_such_skill", input_mode: "slash" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: { code: string } }>().error.code).toBe("unknown_skill");
  });
});

// ---------------------------------------------------------------------------
// dealers projection + profile preference write-through
// ---------------------------------------------------------------------------

/** Create a profile directly through the tools service (the same write path the
 *  workflow persist step delegates to) so the route tests don't re-run intake. */
function seedProfileRow(): string {
  const { profile } = createProfile(db, validFields() as unknown as SearchProfileIntakeInput, {
    coordinates: { latitude: 33.6695, longitude: -117.7669 },
  });
  return profile.id;
}

function seedDealerForProfile(profileId: string, dealerId: string, distance: number | null): void {
  db.$client
    .prepare(
      "INSERT INTO dealers (dealer_id, name, address, distance_miles) VALUES (?, ?, ?, ?)",
    )
    .run(dealerId, `Dealer ${dealerId}`, "1 Auto Center Dr", distance);
  db.$client
    .prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')",
    )
    .run(profileId, dealerId);
}

describe("GET /api/profiles/:id/dealers", () => {
  it("404 for a missing profile; [] for a profile with no dealers", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const missing = await s.app.inject({ method: "GET", url: "/api/profiles/nope/dealers" });
    expect(missing.statusCode).toBe(404);

    const id = seedProfileRow();
    const empty = await s.app.inject({ method: "GET", url: `/api/profiles/${id}/dealers` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<unknown[]>()).toEqual([]);
  });

  it("returns the bound dealer rows nearest-first with candidate_status", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();
    seedDealerForProfile(id, "d-far", 22.7);
    seedDealerForProfile(id, "d-near", 6.4);
    seedDealerForProfile(id, "d-unknown", null);

    const r = await s.app.inject({ method: "GET", url: `/api/profiles/${id}/dealers` });
    expect(r.statusCode).toBe(200);
    const rows = r.json<Array<Record<string, unknown>>>();
    expect(rows.map((row) => row["dealer_id"])).toEqual(["d-near", "d-far", "d-unknown"]);
    expect(rows[0]!["candidate_status"]).toBe("candidate");
    expect(rows[0]!["name"]).toBe("Dealer d-near");
  });
});

describe("GET /api/profiles/:id/dealer-negotiations", () => {
  it("404 for a missing profile; [] for a profile with no dealers", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const missing = await s.app.inject({
      method: "GET",
      url: "/api/profiles/nope/dealer-negotiations",
    });
    expect(missing.statusCode).toBe(404);

    const id = seedProfileRow();
    const empty = await s.app.inject({
      method: "GET",
      url: `/api/profiles/${id}/dealer-negotiations`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<unknown[]>()).toEqual([]);
  });

  it("returns the per-dealer negotiation grid rows (budget-free)", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();
    seedDealerForProfile(id, "d-near", 6.4);

    const r = await s.app.inject({
      method: "GET",
      url: `/api/profiles/${id}/dealer-negotiations`,
    });
    expect(r.statusCode).toBe(200);
    const rows = r.json<Array<Record<string, unknown>>>();
    expect(rows.map((row) => row["dealer_id"])).toEqual(["d-near"]);
    expect(rows[0]!["name"]).toBe("Dealer d-near");
    expect(rows[0]!["email_count"]).toBe(0);
    expect(rows[0]!["quote_sent"]).toBe(false);
    expect("budget_max" in rows[0]!).toBe(false);
  });
});

describe("GET /api/profiles/:id/dealer-negotiations/:dealerId", () => {
  it("404 for a missing profile and 404 for a foreign dealer", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const missingProfile = await s.app.inject({
      method: "GET",
      url: "/api/profiles/nope/dealer-negotiations/d-x",
    });
    expect(missingProfile.statusCode).toBe(404);

    const id = seedProfileRow();
    const foreignDealer = await s.app.inject({
      method: "GET",
      url: `/api/profiles/${id}/dealer-negotiations/d-unbound`,
    });
    expect(foreignDealer.statusCode).toBe(404);
  });

  it("returns the one-dealer negotiation detail (200)", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();
    seedDealerForProfile(id, "d-near", 6.4);

    const r = await s.app.inject({
      method: "GET",
      url: `/api/profiles/${id}/dealer-negotiations/d-near`,
    });
    expect(r.statusCode).toBe(200);
    const detail = r.json<Record<string, unknown>>();
    expect(detail["name"]).toBe("Dealer d-near");
  });
});

describe("GET /api/profiles/:id/dealer-negotiations/:dealerId/summary", () => {
  afterEach(() => {
    __resetNegotiationSummaryDepsForTests();
  });

  it("404 for a missing profile", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const r = await s.app.inject({
      method: "GET",
      url: "/api/profiles/nope/dealer-negotiations/d-x/summary",
    });
    expect(r.statusCode).toBe(404);
  });

  it("returns {summary:null} (200, NEVER 404) when generation fails", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();
    seedDealerForProfile(id, "d-near", 6.4);
    // Force the workflow fn down its degrade path: a non-empty body set + a
    // throwing generate resolves {summary:null} — the route must still answer 200.
    __setNegotiationSummaryDepsForTests({
      readBodies: (() => ["A real quote body."]) as never,
      generate: (async () => {
        throw new Error("transport boom");
      }) as never,
    });

    const r = await s.app.inject({
      method: "GET",
      url: `/api/profiles/${id}/dealer-negotiations/d-near/summary`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ summary: string | null }>()).toEqual({ summary: null });
  });
});

/** Seed a 'succeeded'-extraction message + its dealer_quote bound to a profile
 *  (the same write shape the dealer_reply_extract skill produces). */
function seedQuoteForProfile(
  profileId: string,
  dealerId: string,
  quoteId: string,
  mode: string,
  otd: number | null,
  receivedAt: string,
): void {
  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?, ?) ON CONFLICT(dealer_id) DO NOTHING").run(
    dealerId,
    `Dealer ${dealerId}`,
  );
  const messageId = `qm-${quoteId}`;
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, search_profile_id, quote_extraction_status, quote_extraction_intent) " +
      "VALUES (?, NULL, 'inbound', ?, 'succeeded', 'quote')",
  ).run(messageId, profileId);
  c.prepare(
    "INSERT INTO dealer_quotes " +
      "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, " +
      " otd_total, selling_price, vin, quote_format, intent, extractor_provider, extraction_method, quote_received_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'VIN999', 'otd', 'quote', 'deepseek', 'ocr', ?)",
  ).run(quoteId, dealerId, messageId, `g-${quoteId}`, profileId, mode, otd, otd, receivedAt);
}

describe("GET /api/profiles/:id/quotes", () => {
  it("404 for a missing profile; [] for a profile with no quotes", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const missing = await s.app.inject({ method: "GET", url: "/api/profiles/nope/quotes" });
    expect(missing.statusCode).toBe(404);

    const id = seedProfileRow();
    const empty = await s.app.inject({ method: "GET", url: `/api/profiles/${id}/quotes` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<unknown[]>()).toEqual([]);
  });

  it("returns the profile's raw quote rows (all modes) newest-first with provenance, no budget", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();
    seedQuoteForProfile(id, "d-alpha", "q-finance", "finance", 44540, "2026-06-10T10:00:00.000Z");
    seedQuoteForProfile(id, "d-bravo", "q-cash", "cash", 39500, "2026-06-12T10:00:00.000Z");

    const r = await s.app.inject({ method: "GET", url: `/api/profiles/${id}/quotes` });
    expect(r.statusCode).toBe(200);
    const rows = r.json<Array<Record<string, unknown>>>();
    expect(rows.map((row) => row["quote_id"])).toEqual(["q-cash", "q-finance"]);
    // The cash quote is present — what the ranked /quote-compare finance/lease
    // buckets would omit.
    expect(rows[0]!["financing_mode"]).toBe("cash");
    expect(rows[0]!["dealer_name"]).toBe("Dealer d-bravo");
    expect(rows[0]!["extractor_provider"]).toBe("deepseek");
  });
});

describe("PATCH /api/profiles/:id — preference write-through", () => {
  it("writes a preference patch and returns the snake_case row view", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();
    const r = await s.app.inject({
      method: "PATCH",
      url: `/api/profiles/${id}`,
      payload: { searchRadiusMiles: 120, preferredExteriorColorsJson: '["Amazon Gray"]' },
    });
    expect(r.statusCode).toBe(200);
    const row = r.json<Record<string, unknown>>();
    expect(row["search_radius_miles"]).toBe(120);
    expect(row["preferred_exterior_colors_json"]).toBe('["Amazon Gray"]');
  });

  it("rejects an out-of-bound radius with 400 content_invalid (1–500 miles)", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();
    for (const bad of [0, 501]) {
      const r = await s.app.inject({
        method: "PATCH",
        url: `/api/profiles/${id}`,
        payload: { searchRadiusMiles: bad },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json<{ error: { code: string } }>().error.code).toBe("content_invalid");
    }
  });

  it("rejects an identity field with 409 identity_locked (confirm freezes identity)", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();
    const r = await s.app.inject({
      method: "PATCH",
      url: `/api/profiles/${id}`,
      payload: { make: "Honda" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { code: string } }>().error.code).toBe("identity_locked");
  });

  it("404 for a missing profile; unknown body key → 400 content_invalid", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const missing = await s.app.inject({
      method: "PATCH",
      url: "/api/profiles/nope",
      payload: { searchRadiusMiles: 50 },
    });
    expect(missing.statusCode).toBe(404);

    const id = seedProfileRow();
    const bad = await s.app.inject({
      method: "PATCH",
      url: `/api/profiles/${id}`,
      payload: { status: "closed" },
    });
    expect(bad.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/profiles/:id (soft-delete) + POST /api/profiles/:id/restore
// ---------------------------------------------------------------------------

/** Create a SECOND active profile sharing the brand of an existing one — used to
 *  occupy the (account, brand) active slot so a restore conflicts. The two share
 *  the same make (brand) but differ in model so their synth ids differ; the
 *  first must be closed before the second can be created (the slot). */
function statusOf(id: string): string | null {
  const r = db.$client
    .prepare("SELECT status FROM search_profiles WHERE search_profile_id = ?")
    .get(id) as { status: string | null } | undefined;
  return r?.status ?? null;
}

describe("DELETE /api/profiles/:id — soft-delete (status→'closed')", () => {
  it("closes the profile, writes the profile_close audit, and frees the active slot", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();

    const del = await s.app.inject({ method: "DELETE", url: `/api/profiles/${id}` });
    expect(del.statusCode).toBe(204);
    expect(statusOf(id)).toBe("closed");
    expect(auditCount("profile_close")).toBe(1);

    // It drops out of the active list and into the closed list.
    const active = await s.app.inject({ method: "GET", url: "/api/profiles?status=active" });
    expect(active.json<unknown[]>()).toHaveLength(0);
    const closed = await s.app.inject({ method: "GET", url: "/api/profiles?status=closed" });
    const closedRows = closed.json<Array<Record<string, unknown>>>();
    expect(closedRows.map((r) => r["search_profile_id"])).toEqual([id]);
  });

  it("404 for a missing profile (no audit)", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const del = await s.app.inject({ method: "DELETE", url: "/api/profiles/nope" });
    expect(del.statusCode).toBe(404);
    expect(auditCount("profile_close")).toBe(0);
  });

});

describe("POST /api/profiles/:id/restore — bring a closed profile back active", () => {
  it("restores a closed profile to active and writes the profile_restore audit", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();
    await s.app.inject({ method: "DELETE", url: `/api/profiles/${id}` });
    expect(statusOf(id)).toBe("closed");

    const restore = await s.app.inject({ method: "POST", url: `/api/profiles/${id}/restore` });
    expect(restore.statusCode).toBe(200);
    expect(restore.json<{ status: string }>().status).toBe("active");
    expect(statusOf(id)).toBe("active");
    expect(auditCount("profile_restore")).toBe(1);
  });

  it("404 for a missing profile", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const restore = await s.app.inject({ method: "POST", url: "/api/profiles/nope/restore" });
    expect(restore.statusCode).toBe(404);
  });

  it("409 active_slot_conflict (carrying the brand) when the slot is already taken", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    // Seed → close a Hyundai, then create a NEW active Hyundai (takes the slot).
    const closedId = seedProfileRow();
    await s.app.inject({ method: "DELETE", url: `/api/profiles/${closedId}` });
    // A second Hyundai with a different model → a distinct synth id, active slot.
    createProfile(db, validFields({ model: "Santa Fe" }) as unknown as SearchProfileIntakeInput, {
      coordinates: { latitude: 33.6695, longitude: -117.7669 },
    });

    const restore = await s.app.inject({ method: "POST", url: `/api/profiles/${closedId}/restore` });
    expect(restore.statusCode).toBe(409);
    const env = restore.json<{ error: { code: string; brand?: string } }>().error;
    expect(env.code).toBe("active_slot_conflict");
    expect(env.brand).toBe("Hyundai");
    // The closed row stayed closed (rollback) and no restore audit landed.
    expect(statusOf(closedId)).toBe("closed");
    expect(auditCount("profile_restore")).toBe(0);
  });
});

describe("POST /api/profiles/:id/purge — HARD-DELETE (irreversible)", () => {
  it("erases the profile + writes the profile_purge tombstone; it drops from every list", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const id = seedProfileRow();

    const res = await s.app.inject({ method: "POST", url: `/api/profiles/${id}/purge` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    expect(auditCount("profile_purge")).toBe(1);

    // Hard delete: gone from the active list AND not fetchable (unlike soft-close,
    // which moves it to 'closed'). The prior intake audit was erased.
    const active = await s.app.inject({ method: "GET", url: "/api/profiles?status=active" });
    expect(active.json<unknown[]>()).toHaveLength(0);
    const one = await s.app.inject({ method: "GET", url: `/api/profiles/${id}` });
    expect(one.statusCode).toBe(404);
  });

  it("404 for a missing profile (no audit)", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const res = await s.app.inject({ method: "POST", url: "/api/profiles/nope/purge" });
    expect(res.statusCode).toBe(404);
    expect(auditCount("profile_purge")).toBe(0);
  });
});
