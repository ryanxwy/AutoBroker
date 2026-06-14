/**
 * settings/env route integration — drives the REAL Fastify app via inject()
 * against an ISOLATED tmp AUTOBROKER_DATA_DIR. Covers:
 *   GET → the curated vars with live values, incl. the read-only fuse status, and
 *     no secret value; PUT {gmail_backend:"real"} → 200 {ok, vars} with the echoed
 *     value flipped AND process.env mutated in-place (the no-restart keystone);
 *     PUT {gmail_backend:"maybe"} → 400 invalid_value; PUT for the fuse id is
 *     rejected by the schema (proving the L1 fuse var is unreachable via the route).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is the data dir (saved/restored); the
 * Mastra singleton + runtime glue are reset so boot builds against this dir.
 * NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb } from "@autobroker/tools";
import { resetMastraForTests, resetRuntimeGlueForTests } from "@autobroker/workflows";

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

// The operational vars this surface touches — saved/restored so the suite never
// leaks a toggle into a sibling test or the host process.
const ENV_VARS = [
  "AUTOBROKER_GMAIL_BACKEND",
  "AUTOBROKER_CHROME_HEADLESS",
  "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS",
  "AUTOBROKER_DEMO_SEED",
] as const;

let tmpDir: string;
let server: BuiltServer | undefined;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-env-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  for (const v of ENV_VARS) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }

  const db = openDb();
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
  db.$client.close();
  closeDb();

  resetMastraForTests();
  resetRuntimeGlueForTests();
});

afterEach(async () => {
  if (server !== undefined) {
    await server.app.close();
    server = undefined;
  }
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
  for (const v of ENV_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
});

async function build(): Promise<BuiltServer> {
  server = await buildServer({ quiet: true });
  return server;
}

describe("GET /api/settings/env", () => {
  it("returns the curated vars with live values, incl. the read-only fuse status", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/api/settings/env" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vars: { id: string; value: string; editable: boolean }[];
    };
    const byId = new Map(body.vars.map((v) => [v.id, v]));

    // the two editable toggles default sensibly
    expect(byId.get("gmail_backend")?.value).toBe("fake");
    expect(byId.get("chrome_headless")?.value).toBe("1");

    // the L1 fuse appears ONLY as a read-only status row — projected, never raw.
    const fuse = byId.get("block_external_mutations");
    expect(fuse?.editable).toBe(false);
    expect(fuse?.value).toBe("disarmed");
    // never the raw "1"/"0" for the fuse row
    expect(fuse?.value).not.toBe("1");

    // the two test-escape vars never leak into the payload (no descriptor).
    expect(byId.has("test_auto_approve")).toBe(false);
    expect(res.body).not.toContain("AUTOBROKER_TEST_AUTO_APPROVE");
    expect(res.body).not.toContain("AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS");
  });
});

describe("PUT /api/settings/env", () => {
  it("sets gmail_backend → 200 {ok, vars} with the value flipped and env mutated in-place", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/env",
      payload: { id: "gmail_backend", value: "real" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      vars: { id: string; value: string }[];
    };
    expect(body.ok).toBe(true);
    const echoed = body.vars.find((v) => v.id === "gmail_backend");
    expect(echoed?.value).toBe("real");

    // the no-restart keystone — the next gmail-factory call sees real immediately.
    expect(process.env["AUTOBROKER_GMAIL_BACKEND"]).toBe("real");
  });

  it("rejects an out-of-enum value with 400 invalid_value", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/env",
      payload: { id: "gmail_backend", value: "maybe" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_value");
    // the rejected write never touched the live env.
    expect(process.env["AUTOBROKER_GMAIL_BACKEND"]).toBeUndefined();
  });

  it("rejects the fuse id at the schema (the L1 fuse var is unreachable via the route)", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/env",
      payload: { id: "block_external_mutations", value: "disarmed" },
    });
    expect(res.statusCode).toBe(400);
    // the fuse env var is never written by any route, on any path.
    expect(process.env["AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS"]).toBeUndefined();
  });
});
