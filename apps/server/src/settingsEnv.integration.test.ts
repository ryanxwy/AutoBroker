/**
 * settings/env route integration — drives the REAL Fastify app via inject()
 * against an ISOLATED tmp AUTOBROKER_DATA_DIR. Covers:
 *   GET → the curated vars with live values, incl. the read-only demo status, and
 *     no secret value; PUT {app_mode:"buyer"} → 200 {ok, vars} with the echoed
 *     value flipped AND process.env mutated in-place (the no-restart keystone);
 *     PUT {app_mode:"maybe"} → 400 invalid_value; PUT for a read-only status id is
 *     rejected by the schema (proving a non-editable var is unreachable via the route).
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
  "AUTOBROKER_MODE",
  "AUTOBROKER_PORTFOLIO_SCHEDULER",
  "AUTOBROKER_GMAIL_ACCOUNT",
  "AUTOBROKER_CHROME_HEADLESS",
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
  it("returns the curated vars with live values, incl. the read-only demo status", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/api/settings/env" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vars: { id: string; value: string; editable: boolean }[];
    };
    const byId = new Map(body.vars.map((v) => [v.id, v]));

    // the two editable toggles project sensibly. boot runs in a harness context
    // (NODE_ENV=test) so forceTestMode() pins AUTOBROKER_MODE="test" → app_mode
    // projects "test" (not the descriptor default "buyer").
    expect(byId.get("app_mode")?.value).toBe("test");
    expect(byId.get("chrome_headless")?.value).toBe("1");

    // the demo seed appears ONLY as a read-only status row — projected, never raw.
    const demo = byId.get("demo_seed");
    expect(demo?.editable).toBe(false);
    expect(demo?.value).toBe("off");
    // never the raw "1"/"0" for the demo status row
    expect(demo?.value).not.toBe("1");

    // the two test-escape vars never leak into the payload (no descriptor).
    expect(byId.has("test_auto_approve")).toBe(false);
    expect(res.body).not.toContain("AUTOBROKER_TEST_AUTO_APPROVE");
    expect(res.body).not.toContain("AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS");
  });
});

describe("PUT /api/settings/env", () => {
  it("sets app_mode → 200 {ok, vars} with the value flipped and env mutated in-place", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/env",
      payload: { id: "app_mode", value: "buyer" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      vars: { id: string; value: string }[];
    };
    expect(body.ok).toBe(true);
    const echoed = body.vars.find((v) => v.id === "app_mode");
    expect(echoed?.value).toBe("buyer");

    // the no-restart keystone — the next mode read sees buyer immediately.
    expect(process.env["AUTOBROKER_MODE"]).toBe("buyer");
  });

  it("sets auto_run_searches → 200 with the bool echoed and env mutated live", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/env",
      payload: { id: "auto_run_searches", value: "1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { vars: { id: string; value: string }[] };
    expect(body.vars.find((v) => v.id === "auto_run_searches")?.value).toBe("1");
    expect(process.env["AUTOBROKER_PORTFOLIO_SCHEDULER"]).toBe("1");
  });

  it("sets gmail_account (free-text email) → 200 with the value echoed and env mutated", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/env",
      payload: { id: "gmail_account", value: "person@example.com" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; vars: { id: string; value: string }[] };
    expect(body.ok).toBe(true);
    expect(body.vars.find((v) => v.id === "gmail_account")?.value).toBe("person@example.com");
    expect(process.env["AUTOBROKER_GMAIL_ACCOUNT"]).toBe("person@example.com");
  });

  it("rejects a malformed gmail_account address with 400 invalid_value (no env mutation)", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/env",
      payload: { id: "gmail_account", value: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_value");
    expect(process.env["AUTOBROKER_GMAIL_ACCOUNT"]).toBeUndefined();
  });

  it("rejects an out-of-enum value with 400 invalid_value", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/env",
      payload: { id: "app_mode", value: "maybe" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_value");
    // the rejected write never changed the mode away from the boot-pinned "test".
    expect(process.env["AUTOBROKER_MODE"]).toBe("test");
  });

  it("rejects a read-only status id at the schema (a non-editable var is unreachable via the route)", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/env",
      payload: { id: "demo_seed", value: "on" },
    });
    expect(res.statusCode).toBe(400);
    // a read-only status env var is never written by any route, on any path.
    expect(process.env["AUTOBROKER_DEMO_SEED"]).toBeUndefined();
  });
});
