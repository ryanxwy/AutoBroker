/**
 * /stream-v2 integration — the UI-message-stream surface over the REAL stack
 * (real Fastify inject → real run service → real Mastra suspend/resume →
 * real pubsub), same scaffolding as server.integration.test.ts. Covers:
 *
 *   (a) accept path: start → collect gate → submit → done; the v2 stream
 *       yields start{messageId:runId} → data-frame init(driver_kind) →
 *       data-gate{id:decision_id} → text triple → finish, [DONE]-terminated,
 *       with EXACTLY one terminal chunk.
 *   (b) F′3 acceptance: force a suspend → DECLINE → NO resume happens (zero
 *       profile/audit rows, status 'declined') and EXACTLY ONE terminal
 *       abort{reason:'user_declined'} reaches the client — subscribed LIVE
 *       (before the decline), so the decline flows down an open stream.
 *   (c) coexistence: legacy /stream remains live and untouched alongside the
 *       v2 route; an unknown run 404s on both.
 *
 * ISOLATION: fresh tmp AUTOBROKER_DATA_DIR per case; never ~/.autobroker*;
 * AUTOBROKER_TEST_AUTO_APPROVE is never set.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db, type GoplacesResult } from "@autobroker/tools";
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

function harnessStub(): IntakeWorkflowDeps["harnessGenerate"] {
  const fn = async (_input: { useCase: string }) => {
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

function locationStub(): IntakeWorkflowDeps["resolveLocation"] {
  const fn: IntakeWorkflowDeps["resolveLocation"] = async () => RESOLVED;
  return fn;
}

function validFields(): Record<string, unknown> {
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
  };
}

function rowCount(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

/** Parse the v2 SSE body into ordered protocol chunks + whether [DONE] closed it. */
function parseV2(body: string): { chunks: Array<Record<string, unknown>>; done: boolean } {
  const datas = body.split("\n").filter((l) => l.startsWith("data: "));
  const done = datas.some((l) => l === "data: [DONE]");
  const chunks = datas
    .filter((l) => l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice("data: ".length)) as Record<string, unknown>);
  return { chunks, done };
}

beforeEach(async () => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-streamv2-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];

  db = openDb();
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-1", "a@e.com");

  resetMastraForTests();
  resetRuntimeGlueForTests();
});

afterEach(async () => {
  __resetIntakeDepsForTests();
  if (server !== undefined) await server.app.close();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

async function buildWith(): Promise<BuiltServer> {
  __setIntakeDepsForTests({ harnessGenerate: harnessStub(), resolveLocation: locationStub(), fetchTrimSources: async () => ({ kind: "none" }) });
  server = await buildServer({ quiet: true });
  return server;
}

async function startSlashToCollect(s: BuiltServer): Promise<{ runId: string; decisionId: string }> {
  const start = await s.app.inject({
    method: "POST",
    url: "/api/skill-runs",
    payload: { skill: "search_profile_intake", input_mode: "slash" },
  });
  expect(start.statusCode).toBe(201);
  const runId = start.json<{ run_id: string }>().run_id;
  const status = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
  const summary = status.json<{ pending: { step: string; decision_id: string } | null }>();
  expect(summary.pending?.step).toBe("collect");
  return { runId, decisionId: summary.pending!.decision_id };
}

// ---------------------------------------------------------------------------
// (a) accept path — the full chunk sequence
// ---------------------------------------------------------------------------

describe("GET /api/skill-runs/:id/stream-v2 — accept path", () => {
  it("start(messageId=runId) → init data-frame → data-gate(decision_id) → text → finish, [DONE]", async () => {
    const s = await buildWith();
    const { runId, decisionId } = await startSlashToCollect(s);

    await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "accept", content: validFields() } },
    });
    // The unconditional buyer-confirmation suspends before persist — accept it so
    // the run reaches done before the stream is read.
    const cv = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
    const cvPending = cv.json<{ pending: { decision_id: string } | null }>().pending!;
    await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: cvPending.decision_id, decision: { action: "accept", content: { action: "accept" } } },
    });

    const res = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}/stream-v2` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-vercel-ai-ui-message-stream"]).toBe("v1");

    const { chunks, done } = parseV2(res.body);
    expect(done).toBe(true);

    // First chunk binds the assistant message to the runId.
    expect(chunks[0]).toEqual({ type: "start", messageId: runId });

    // init carried through verbatim with driver_kind.
    const init = chunks.find(
      (c) => c["type"] === "data-frame" && (c["data"] as { kind: string }).kind === "init",
    );
    expect(init).toBeDefined();
    expect((init!["data"] as { payload: Record<string, unknown> }).payload).toMatchObject({
      driver_kind: "deepseek_apikey",
      skill: "search_profile_intake",
    });

    // The collect gate rides data-gate with id = decision_id (reconcile key).
    const gate = chunks.find((c) => c["type"] === "data-gate");
    expect(gate).toBeDefined();
    expect(gate!["id"]).toBe(decisionId);
    expect((gate!["data"] as Record<string, unknown>)["step"]).toBe("collect");

    // The summary text triple, then finish — exactly one terminal chunk.
    const types = chunks.map((c) => c["type"]);
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
    const terminals = types.filter((t) => t === "finish" || t === "abort" || t === "error");
    expect(terminals).toEqual(["finish"]);
    expect(types[types.length - 1]).toBe("finish");

    // The fresh-by-default pulse rides a data.changed data-frame, emitted by the
    // REAL stack BEFORE the terminal finish — proof the single-terminal
    // invariant did NOT discard it. A created intake run touches profiles +
    // sessions; profile_id names the row it wrote.
    const pulseIdx = chunks.findIndex(
      (c) => c["type"] === "data-frame" && (c["data"] as { kind: string }).kind === "data.changed",
    );
    expect(pulseIdx).toBeGreaterThan(-1);
    const finishIdx = chunks.findIndex((c) => c["type"] === "finish");
    expect(pulseIdx).toBeLessThan(finishIdx); // emit-before-done ordering, end to end.
    const pulsePayload = (chunks[pulseIdx]!["data"] as { payload: Record<string, unknown> }).payload;
    expect(pulsePayload["kinds"]).toEqual(["profiles", "sessions"]);
    expect(typeof pulsePayload["profile_id"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// (b) F′3 acceptance — suspend → decline → no resume + exactly one abort
// ---------------------------------------------------------------------------

describe("F′3 — decline over a LIVE v2 stream", () => {
  it("forced suspend → decline → NO resume; EXACTLY ONE abort{user_declined} reaches the client", async () => {
    const s = await buildWith();
    const { runId, decisionId } = await startSlashToCollect(s);

    // Subscribe LIVE while suspended (the inject promise resolves only when the
    // stream ends), then decline through the kept POST /form-decision path.
    const streamP = s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}/stream-v2` });
    const decline = await s.app.inject({
      method: "POST",
      url: `/api/skill-runs/${runId}/form-decision`,
      payload: { decision_id: decisionId, decision: { action: "decline" } },
    });
    expect(decline.statusCode).toBe(200);

    const res = await streamP;
    const { chunks, done } = parseV2(res.body);
    expect(done).toBe(true);

    // EXACTLY ONE terminal chunk, and it is the abort with the decline reason.
    const terminals = chunks.filter(
      (c) => c["type"] === "finish" || c["type"] === "abort" || c["type"] === "error",
    );
    expect(terminals).toEqual([{ type: "abort", reason: "user_declined" }]);

    // The declined-vs-aborted distinction is PERSISTED in the message parts.
    const abortedFrame = chunks.find(
      (c) => c["type"] === "data-frame" && (c["data"] as { kind: string }).kind === "aborted",
    );
    expect(abortedFrame).toBeDefined();
    expect((abortedFrame!["data"] as { payload: Record<string, unknown> }).payload).toEqual({
      reason: "user_declined",
    });

    // NO resume happened: zero writes, and the projection says declined.
    expect(rowCount("search_profiles")).toBe(0);
    expect(rowCount("audit_log")).toBe(0);
    const after = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
    expect(after.json<{ status: string }>().status).toBe("declined");

    // The run stays terminal: no later frame ever re-opens the gate.
    const replay = await s.app.inject({ method: "GET", url: `/api/skill-runs/${runId}/stream-v2` });
    const replayed = parseV2(replay.body);
    const replayTerminals = replayed.chunks.filter(
      (c) => c["type"] === "finish" || c["type"] === "abort" || c["type"] === "error",
    );
    expect(replayTerminals).toEqual([{ type: "abort", reason: "user_declined" }]);
  });
});

// ---------------------------------------------------------------------------
// (c) flag + legacy coexistence
// ---------------------------------------------------------------------------

describe("coexistence with the legacy /stream", () => {
  it("unknown run → 404 envelope on BOTH stream routes (legacy stays live)", async () => {
    const s = await buildWith();
    const v2 = await s.app.inject({ method: "GET", url: "/api/skill-runs/ghost/stream-v2" });
    expect(v2.statusCode).toBe(404);
    expect(v2.json<{ error: { code: string } }>().error.code).toBe("no_skill_run");

    const legacy = await s.app.inject({ method: "GET", url: "/api/skill-runs/ghost/stream" });
    expect(legacy.statusCode).toBe(404);
    expect(legacy.json<{ error: { code: string } }>().error.code).toBe("no_skill_run");
  });
});
