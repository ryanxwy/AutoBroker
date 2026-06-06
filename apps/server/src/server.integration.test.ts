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

import { openDb, type Db, type GoplacesResult } from "@autobroker/tools";
import {
  __resetIntakeDepsForTests,
  __setIntakeDepsForTests,
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
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

/** Build a server with the intake deps wired (must set deps BEFORE start). */
async function buildWith(over: Partial<IntakeWorkflowDeps>): Promise<BuiltServer> {
  __setIntakeDepsForTests(over);
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
  it("GET /api/skills → the single registered skill manifest", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const r = await s.app.inject({ method: "GET", url: "/api/skills" });
    expect(r.statusCode).toBe(200);
    expect(r.json<Array<{ name: string }>>()[0]!.name).toBe("search_profile_intake");
  });

  it("GET /api/mode → {active_db, data_dir} pointed at the tmp data dir", async () => {
    const s = await buildWith({ harnessGenerate: harnessStub(), resolveLocation: locationStub([RESOLVED]) });
    const r = await s.app.inject({ method: "GET", url: "/api/mode" });
    expect(r.statusCode).toBe(200);
    const mode = r.json<{ active_db: string; data_dir: string }>();
    expect(mode.data_dir).toBe(tmpDir);
    expect(mode.active_db).toContain(tmpDir);
    expect(mode.active_db).not.toContain("/.autobroker/"); // never production
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
});
