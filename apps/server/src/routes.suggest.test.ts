/**
 * In-process integration tests — POST /api/suggest-next-skills (the Hybrid
 * skills-popover re-rank wiring).
 *
 * Drives the REAL Fastify app via inject() with a DETERMINISTIC re-ranker
 * injected through the test seam (__setSuggestNextForTests) — no live model. The
 * contract under test:
 *   - the ranked {skill_id, reason}[] is returned in order;
 *   - candidate ids NOT in the registry are dropped before the re-ranker sees
 *     them (defense-in-depth — the server never trusts arbitrary ids);
 *   - all-unknown / empty candidates short-circuit to {suggestions:[]} with NO
 *     re-ranker call;
 *   - a null (fail-closed) re-rank returns {suggestions:[]};
 *   - an identical repeat request is served from cache (the re-ranker is called
 *     once) — no duplicate model spend.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/tools";
import { resetMastraForTests, resetRuntimeGlueForTests, type SuggestContext } from "@autobroker/workflows";

import { buildServer, type BuiltServer } from "./server.js";
import { __resetSuggestNextForTests, __setSuggestNextForTests } from "./routes.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = join(here, "..", "..", "..", "packages", "db", "drizzle", "0000_military_red_skull.sql");

let tmpDir: string;
let db: Db;
let server: BuiltServer;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-suggest-route-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
  resetMastraForTests();
  resetRuntimeGlueForTests();
});

afterEach(async () => {
  __resetSuggestNextForTests();
  if (server !== undefined) await server.app.close();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

describe("POST /api/suggest-next-skills", () => {
  it("returns the re-ranker's ordered {skill_id, reason}[]", async () => {
    __setSuggestNextForTests(async (ctx: SuggestContext) =>
      ctx.candidateIds.map((id) => ({ skillId: id, reason: `do ${id}` })).reverse(),
    );
    server = await buildServer({ quiet: true });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/suggest-next-skills",
      payload: {
        candidate_ids: ["dealer_geosearch", "inventory_site_scan"],
        conversation: "I just ran intake.",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ suggestions: { skill_id: string; reason: string }[] }>();
    expect(body.suggestions.map((s) => s.skill_id)).toEqual(["inventory_site_scan", "dealer_geosearch"]);
    expect(body.suggestions[0]?.reason).toBe("do inventory_site_scan");
  });

  it("drops candidate ids that are not registry skills before the re-ranker sees them", async () => {
    let seen: string[] = [];
    __setSuggestNextForTests(async (ctx: SuggestContext) => {
      seen = ctx.candidateIds;
      return ctx.candidateIds.map((id) => ({ skillId: id, reason: "x" }));
    });
    server = await buildServer({ quiet: true });

    await server.app.inject({
      method: "POST",
      url: "/api/suggest-next-skills",
      payload: { candidate_ids: ["dealer_geosearch", "not_a_real_skill"], conversation: "" },
    });
    expect(seen).toEqual(["dealer_geosearch"]);
  });

  it("all-unknown candidates short-circuit to [] with NO re-ranker call", async () => {
    let called = 0;
    __setSuggestNextForTests(async () => {
      called += 1;
      return [];
    });
    server = await buildServer({ quiet: true });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/suggest-next-skills",
      payload: { candidate_ids: ["nope", "also_nope"], conversation: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ suggestions: unknown[] }>().suggestions).toEqual([]);
    expect(called).toBe(0);
  });

  it("a null (fail-closed) re-rank returns an empty suggestion list", async () => {
    __setSuggestNextForTests(async () => null);
    server = await buildServer({ quiet: true });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/suggest-next-skills",
      payload: { candidate_ids: ["dealer_geosearch"], conversation: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ suggestions: unknown[] }>().suggestions).toEqual([]);
  });

  it("an identical repeat request is served from cache (the re-ranker runs once)", async () => {
    let called = 0;
    __setSuggestNextForTests(async (ctx: SuggestContext) => {
      called += 1;
      return ctx.candidateIds.map((id) => ({ skillId: id, reason: "x" }));
    });
    server = await buildServer({ quiet: true });

    const payload = { candidate_ids: ["dealer_geosearch"], conversation: "same convo" };
    const a = await server.app.inject({ method: "POST", url: "/api/suggest-next-skills", payload });
    const b = await server.app.inject({ method: "POST", url: "/api/suggest-next-skills", payload });
    expect(a.json<{ suggestions: unknown[] }>().suggestions).toEqual(
      b.json<{ suggestions: unknown[] }>().suggestions,
    );
    expect(called).toBe(1);
  });
});
