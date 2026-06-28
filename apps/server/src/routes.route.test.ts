/**
 * In-process integration tests — POST /api/route (the NL skill-router wiring).
 *
 * Drives the REAL Fastify app via inject() with a DETERMINISTIC classifier
 * injected through the route test seam (__setRouteClassifierForTests) — no live
 * model. The classifier's verdict is fixed per test; everything below it (the
 * descriptor.buildInput validation, the intake fork, skillRuns.start, the
 * REAL flat Mastra intake workflow suspending at `collect`, and recordRun) runs
 * for real against an ISOLATED tmp autobroker.db (committed migration applied).
 *
 * Proves the brief's acceptance points:
 *   - LAUNCH calls descriptor.buildInput + skillRuns.start (the SAME path as
 *     POST /api/skill-runs): a 201 with run_id + routing.kind "launch", and the
 *     run is live (GET status is awaiting_approval@collect for intake);
 *   - CLARIFY returns 200 with NO run started (no run_id);
 *   - intake LAUNCH forks a fresh unpinned session when from_session_id is set;
 *   - a non-launch is downstream of every gate (no side effect here — the run
 *     just reaches its own suspend, button-only).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; mastra.db +
 * autobroker.db live there; NEVER ~/.autobroker*. The Mastra singleton + runtime
 * glue are reset between cases. AUTOBROKER_TEST_AUTO_APPROVE is never set.
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
  type RouteDecision,
} from "@autobroker/workflows";

import { buildServer, type BuiltServer } from "./server.js";
import { __resetRouteClassifierForTests, __setRouteClassifierForTests } from "./routes.js";

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
  location: { lat: 33.6695, lng: -117.7669, formattedAddress: "Irvine, CA 92614, USA", postalCode: "92614" },
  traceSpans: [],
};

/** A harness stub: trim-verify always-valid, prefill a fixed seed (so the intake
 *  freeform run reaches the `collect` suspend deterministically). */
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

function locationStub(sequence: GoplacesResult[]): IntakeWorkflowDeps["resolveLocation"] {
  let i = 0;
  const fn: IntakeWorkflowDeps["resolveLocation"] = async () => {
    const r = sequence[Math.min(i, sequence.length - 1)]!;
    i += 1;
    return r;
  };
  return fn;
}

function rowCount(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

beforeEach(async () => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-route-"));
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
  __resetRouteClassifierForTests();
  if (server !== undefined) await server.app.close();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

/** Build a server with the intake deps wired + a fixed classifier verdict. */
async function buildWith(decision: RouteDecision): Promise<BuiltServer> {
  __setIntakeDepsForTests({
    harnessGenerate: harnessStub(),
    resolveLocation: locationStub([RESOLVED]),
    // never let a freeform intake unit test reach the real web trim lookup.
    fetchTrimSources: async () => ({ kind: "none" }),
  });
  __setRouteClassifierForTests(async () => decision);
  server = await buildServer({ quiet: true });
  return server;
}

describe("POST /api/route — LAUNCH path (the same start path as /api/skill-runs)", () => {
  it("an intake LAUNCH builds input + starts the run + forks a fresh session", async () => {
    const s = await buildWith({
      kind: "launch",
      skillId: "search_profile_intake",
      inputData: { input_mode: "freeform", freeform_text: "I want a 2026 Tucson near Irvine" },
      confidence: 0.9,
      reason: "starting a new search",
    });

    const res = await s.app.inject({
      method: "POST",
      url: "/api/route",
      payload: { nl_input: "I want a 2026 Tucson near Irvine", from_session_id: null },
    });

    expect(res.statusCode).toBe(201);
    const ack = res.json<{
      run_id: string;
      session_id: string | null;
      routing: { kind: string; skill_id: string; confidence: number };
    }>();
    expect(ack.routing.kind).toBe("launch");
    expect(ack.routing.skill_id).toBe("search_profile_intake");
    // intake FORKED a fresh session (from_session_id present, even null → fork).
    expect(ack.session_id).not.toBeNull();

    // The run is LIVE and reached intake's own collect suspend (buildInput + start
    // genuinely ran the real workflow) — every gate stays downstream, button-only.
    const status = await s.app.inject({ method: "GET", url: `/api/skill-runs/${ack.run_id}` });
    const summary = status.json<{ status: string; pending: { step: string } | null }>();
    expect(summary.status).toBe("awaiting_approval");
    expect(summary.pending?.step).toBe("collect");

    // No profile written yet (the gate is pending — no side effect from routing).
    expect(rowCount("search_profiles")).toBe(0);
  });

  it("a read-only LAUNCH (dealer_geosearch) starts the run with a 201 launch ack", async () => {
    const s = await buildWith({
      kind: "launch",
      skillId: "dealer_geosearch",
      inputData: {},
      confidence: 0.95,
      reason: "find dealers nearby",
    });

    const res = await s.app.inject({
      method: "POST",
      url: "/api/route",
      payload: { nl_input: "find dealers near Irvine 92614" },
    });

    expect(res.statusCode).toBe(201);
    const ack = res.json<{ run_id: string; routing: { kind: string; skill_id: string } }>();
    expect(ack.routing.kind).toBe("launch");
    expect(ack.routing.skill_id).toBe("dealer_geosearch");
    expect(typeof ack.run_id).toBe("string");
  });
});

describe("POST /api/route — CLARIFY path (no run started)", () => {
  it("a clarify verdict returns 200 with routing.kind 'clarify' and NO run_id", async () => {
    const s = await buildWith({
      kind: "clarify",
      reason: "I'm not sure which action you want.",
      candidates: [],
    });

    const res = await s.app.inject({
      method: "POST",
      url: "/api/route",
      payload: { nl_input: "hello there" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      run_id?: string;
      routing: { kind: string; reason: string };
    }>();
    expect(body.routing.kind).toBe("clarify");
    expect(body.routing.reason).toBe("I'm not sure which action you want.");
    expect(body.run_id).toBeUndefined();
  });

  it("a missing nl_input is a 400 content_invalid (the wire schema rejects it)", async () => {
    const s = await buildWith({ kind: "clarify", reason: "n/a", candidates: [] });
    const res = await s.app.inject({ method: "POST", url: "/api/route", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("content_invalid");
  });
});
