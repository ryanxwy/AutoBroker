/**
 * In-process integration tests — the sessions backend. Drives the REAL Fastify
 * app via inject(): REAL session routes → REAL SessionService → REAL
 * workflows-layer
 * RailSessionStore → REAL @mastra/memory Memory threads on an ISOLATED tmp
 * mastra.db. Covers:
 *   - sessions CRUD (POST/GET/GET:id/PATCH/DELETE) + the camelCase-req /
 *     snake_case-resp wire-case invariant.
 *   - PATCH pin null-vs-omitted: omitted → unchanged; present null/"" → cleared.
 *   - list-by-pin (?pinned_profile_id) + the 0/1/2+ count via result length.
 *   - intake from a PINNED session forks a NEW UNPINNED session, carries an
 *     IntakeScopeNotice (3 points), and leaves the original session UNTOUCHED.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db (+ autobroker.db when the intake harness runs) live there; NEVER
 * ~/.autobroker*. The Mastra singleton + runtime glue ownership are reset.
 * No live LLM: the intake fork test stubs the harness/location deps and OM is
 * configured-not-exercised. AUTOBROKER_TEST_AUTO_APPROVE is never set.
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
  location: { lat: 33.66, lng: -117.76, formattedAddress: "Irvine, CA 92602, USA", postalCode: "92602" },
  traceSpans: [],
};

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

function locationStub(): IntakeWorkflowDeps["resolveLocation"] {
  const fn: IntakeWorkflowDeps["resolveLocation"] = async () => RESOLVED;
  return fn;
}

beforeEach(async () => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-sessions-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];

  db = openDb();
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-1", "a@e.com");

  resetMastraForTests();
  resetRuntimeGlueForTests();
  __setIntakeDepsForTests({ harnessGenerate: harnessStub(), resolveLocation: locationStub() });
  server = await buildServer({ quiet: true });
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

interface SessionResp {
  id: string;
  title: string | null;
  created_at: string;
  last_activity_at: string;
  pinned_profile_id: string | null;
  archived: boolean;
}

async function createSession(body: Record<string, unknown>): Promise<SessionResp> {
  const r = await server.app.inject({ method: "POST", url: "/api/sessions", payload: body });
  expect(r.statusCode).toBe(201);
  return r.json<SessionResp>();
}

// ---------------------------------------------------------------------------
// CRUD + wire-case
// ---------------------------------------------------------------------------

describe("sessions CRUD + wire-case", () => {
  it("POST create (camelCase req) → snake_case SessionResponse; pin lands", async () => {
    const created = await createSession({ title: "Tucson hunt", pinnedProfileId: "prof-1" });
    // snake_case response shape, verbatim.
    expect(created).toMatchObject({
      title: "Tucson hunt",
      pinned_profile_id: "prof-1",
      archived: false,
    });
    expect(typeof created.id).toBe("string");
    expect(typeof created.created_at).toBe("string");
    expect(typeof created.last_activity_at).toBe("string");
    // No camelCase leakage on the wire.
    expect((created as unknown as Record<string, unknown>).pinnedProfileId).toBeUndefined();
  });

  it("POST create with no pin → unpinned (null)", async () => {
    const created = await createSession({ title: "fresh" });
    expect(created.pinned_profile_id).toBeNull();
  });

  it("GET /:id reads it back; unknown → 404", async () => {
    const created = await createSession({ title: "x", pinnedProfileId: "prof-9" });
    const got = await server.app.inject({ method: "GET", url: `/api/sessions/${created.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<SessionResp>().pinned_profile_id).toBe("prof-9");

    const missing = await server.app.inject({ method: "GET", url: "/api/sessions/ghost" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("not_found");
  });

  it("DELETE → 204; subsequent GET → 404; DELETE unknown → 404", async () => {
    const created = await createSession({ title: "to-delete" });
    const del = await server.app.inject({ method: "DELETE", url: `/api/sessions/${created.id}` });
    expect(del.statusCode).toBe(204);
    const after = await server.app.inject({ method: "GET", url: `/api/sessions/${created.id}` });
    expect(after.statusCode).toBe(404);

    const delGhost = await server.app.inject({ method: "DELETE", url: "/api/sessions/ghost" });
    expect(delGhost.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH pin null-vs-omitted (load-bearing)
// ---------------------------------------------------------------------------

describe("PATCH pin null-vs-omitted", () => {
  async function patch(id: string, body: Record<string, unknown>): Promise<SessionResp> {
    const r = await server.app.inject({ method: "PATCH", url: `/api/sessions/${id}`, payload: body });
    expect(r.statusCode).toBe(200);
    return r.json<SessionResp>();
  }

  it("present null → clears the pin", async () => {
    const s = await createSession({ title: "t", pinnedProfileId: "prof-1" });
    const cleared = await patch(s.id, { pinnedProfileId: null });
    expect(cleared.pinned_profile_id).toBeNull();
  });

  it("present empty string → clears the pin", async () => {
    const s = await createSession({ title: "t", pinnedProfileId: "prof-1" });
    const cleared = await patch(s.id, { pinnedProfileId: "" });
    expect(cleared.pinned_profile_id).toBeNull();
  });

  it("OMITTED pin (title-only patch) → pin UNCHANGED (never silently cleared)", async () => {
    const s = await createSession({ title: "t", pinnedProfileId: "prof-keep" });
    const titleOnly = await patch(s.id, { title: "renamed" });
    expect(titleOnly.title).toBe("renamed");
    expect(titleOnly.pinned_profile_id).toBe("prof-keep"); // KEPT
  });

  it("present new id → sets the pin (title untouched when omitted)", async () => {
    const s = await createSession({ title: "keep-title", pinnedProfileId: null });
    const set = await patch(s.id, { pinnedProfileId: "prof-2" });
    expect(set.pinned_profile_id).toBe("prof-2");
    expect(set.title).toBe("keep-title");
  });

  it("PATCH unknown session → 404", async () => {
    const r = await server.app.inject({
      method: "PATCH",
      url: "/api/sessions/ghost",
      payload: { pinnedProfileId: "x" },
    });
    expect(r.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// list-by-pin (?pinned_profile_id) + 0/1/2+ counts
// ---------------------------------------------------------------------------

describe("list-by-pin + 0/1/2+ counts", () => {
  it("GET ?pinned_profile_id filters; counts drive the 0/1/2+ branch", async () => {
    await createSession({ title: "a", pinnedProfileId: "prof-A" });
    await createSession({ title: "b", pinnedProfileId: "prof-A" });
    await createSession({ title: "c", pinnedProfileId: "prof-B" });
    await createSession({ title: "d", pinnedProfileId: null });

    const all = await server.app.inject({ method: "GET", url: "/api/sessions" });
    expect(all.statusCode).toBe(200);
    expect(all.json<SessionResp[]>().length).toBe(4);

    // 2+ branch.
    const byA = await server.app.inject({ method: "GET", url: "/api/sessions?pinned_profile_id=prof-A" });
    expect(byA.json<SessionResp[]>().length).toBe(2);

    // 1 branch.
    const byB = await server.app.inject({ method: "GET", url: "/api/sessions?pinned_profile_id=prof-B" });
    expect(byB.json<SessionResp[]>().length).toBe(1);

    // 0 branch (no session pinned to prof-Z).
    const byZ = await server.app.inject({ method: "GET", url: "/api/sessions?pinned_profile_id=prof-Z" });
    expect(byZ.json<SessionResp[]>().length).toBe(0);
  });

  it("a cleared pin drops out of its prior list-by-pin", async () => {
    const s = await createSession({ title: "a", pinnedProfileId: "prof-A" });
    await server.app.inject({ method: "PATCH", url: `/api/sessions/${s.id}`, payload: { pinnedProfileId: null } });
    const byA = await server.app.inject({ method: "GET", url: "/api/sessions?pinned_profile_id=prof-A" });
    expect(byA.json<SessionResp[]>().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// intake from a PINNED session → forks NEW unpinned + IntakeScopeNotice
// ---------------------------------------------------------------------------

describe("intake fork from pinned session", () => {
  it("pinned source → NEW unpinned session + IntakeScopeNotice (3 points); source UNTOUCHED", async () => {
    const pinned = await createSession({ title: "Tucson workspace", pinnedProfileId: "prof-existing" });

    const start = await server.app.inject({
      method: "POST",
      url: "/api/skill-runs",
      payload: {
        skill: "search_profile_intake",
        input_mode: "slash",
        from_session_id: pinned.id,
      },
    });
    expect(start.statusCode).toBe(201);
    const body = start.json<{
      run_id: string;
      session_id: string;
      scope_notice: {
        kind: string;
        source_pinned_profile_id: string;
        forked_session_id: string;
        points: string[];
      } | null;
    }>();

    // A NEW session id, different from the source.
    expect(body.session_id).toBeTruthy();
    expect(body.session_id).not.toBe(pinned.id);

    // The forked session is UNPINNED (intake never inherits the pin).
    const fork = await server.app.inject({ method: "GET", url: `/api/sessions/${body.session_id}` });
    expect(fork.json<SessionResp>().pinned_profile_id).toBeNull();

    // The IntakeScopeNotice is present, non-skippable, with exactly 3 points and
    // the source pin echoed.
    expect(body.scope_notice).not.toBeNull();
    expect(body.scope_notice!.kind).toBe("intake_scope_notice");
    expect(body.scope_notice!.source_pinned_profile_id).toBe("prof-existing");
    expect(body.scope_notice!.forked_session_id).toBe(body.session_id);
    expect(body.scope_notice!.points).toHaveLength(3);

    // The ORIGINAL pinned session is UNTOUCHED — still pinned to its profile.
    const sourceAfter = await server.app.inject({ method: "GET", url: `/api/sessions/${pinned.id}` });
    expect(sourceAfter.json<SessionResp>().pinned_profile_id).toBe("prof-existing");

    // The run is linked to the FORK, not the source (run↔session association).
    const runStatus = await server.app.inject({ method: "GET", url: `/api/skill-runs/${body.run_id}` });
    expect(runStatus.json<{ session_id: string | null }>().session_id).toBe(body.session_id);
  });

  it("UNPINNED source → forks a fresh unpinned session, NO scope notice", async () => {
    const unpinned = await createSession({ title: "blank", pinnedProfileId: null });

    const start = await server.app.inject({
      method: "POST",
      url: "/api/skill-runs",
      payload: { skill: "search_profile_intake", input_mode: "slash", from_session_id: unpinned.id },
    });
    expect(start.statusCode).toBe(201);
    const body = start.json<{ session_id: string; scope_notice: unknown }>();
    expect(body.session_id).not.toBe(unpinned.id);
    expect(body.scope_notice).toBeNull();
  });

  it("headless start (no from_session_id) → no session link, no scope notice", async () => {
    const start = await server.app.inject({
      method: "POST",
      url: "/api/skill-runs",
      payload: { skill: "search_profile_intake", input_mode: "slash" },
    });
    expect(start.statusCode).toBe(201);
    const body = start.json<{ run_id: string; session_id: string | null; scope_notice: unknown }>();
    expect(body.session_id).toBeNull();
    expect(body.scope_notice).toBeNull();
  });

  it("explicit session_id (already-unpinned rail) → run links to it directly, no fork", async () => {
    const rail = await createSession({ title: "rail", pinnedProfileId: null });
    const start = await server.app.inject({
      method: "POST",
      url: "/api/skill-runs",
      payload: { skill: "search_profile_intake", input_mode: "slash", session_id: rail.id },
    });
    expect(start.statusCode).toBe(201);
    const body = start.json<{ session_id: string | null; scope_notice: unknown }>();
    expect(body.session_id).toBe(rail.id);
    expect(body.scope_notice).toBeNull();
  });
});
