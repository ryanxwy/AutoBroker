/**
 * settings/keys route integration — drives the REAL Fastify app via inject()
 * against an ISOLATED tmp AUTOBROKER_DATA_DIR. Covers:
 *   GET presence; POST save (presence flips to present + env var set in-place);
 *   DELETE clear (presence flips back + env var gone); POST test pass + fail via
 *   the STUBBED probe (zero real external calls); a bad id / body → 400.
 * Asserts no secret value is ever returned in any response body.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is the data dir (saved/restored); the
 * Mastra singleton + runtime glue are reset so boot builds against this dir.
 * NEVER ~/.autobroker*. The probe seam is stubbed → no provider is ever hit.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, __resetSecretsProbeForTests, __setSecretsProbeForTests } from "@autobroker/tools";
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

const PROVIDER_VARS = [
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_PLACES_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

let tmpDir: string;
let server: BuiltServer | undefined;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;
let originalCwd: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-keys-"));
  // boot() now seeds keys from a data-dir-INDEPENDENT repo `.env` (walked up from
  // cwd); chdir into the isolated tmpdir so that walk finds nothing and these
  // clean-slate presence assertions stay hermetic on a machine that has a `.env`.
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  for (const v of PROVIDER_VARS) {
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
  __resetSecretsProbeForTests();
  if (server !== undefined) {
    await server.app.close();
    server = undefined;
  }
  closeDb();
  // Restore cwd before removing tmpDir (it was the working directory).
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
  for (const v of PROVIDER_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
});

async function build(): Promise<BuiltServer> {
  server = await buildServer({ quiet: true });
  return server;
}

describe("GET /api/settings/keys", () => {
  it("returns presence-only for the five managed keys + a gmail placeholder", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/api/settings/keys" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      deepseek: { present: false },
      anthropic: { present: false },
      openai: { present: false },
      google_places: { present: false },
      claude_oauth: { present: false },
      gmail: { connected: false },
      // The effective default provider selection (AUTOBROKER_AGENT_PROVIDER); unset in
      // this test → null. The AgentBar reflects it so its boxes show what will run.
      agentDefault: null,
    });
  });
});

describe("POST /api/settings/keys", () => {
  it("stores a key → presence flips to present and the env var is set in-place", async () => {
    const { app } = await build();
    const save = await app.inject({
      method: "POST",
      url: "/api/settings/keys",
      payload: { id: "deepseek", value: "sk-live-candidate" },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({ ok: true });

    // live env mutation (keystone) — next provider call sees it without restart.
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("sk-live-candidate");

    // presence flips; no secret value echoed anywhere.
    const after = await app.inject({ method: "GET", url: "/api/settings/keys" });
    expect(after.json().deepseek).toEqual({ present: true });
    expect(after.body).not.toContain("sk-live-candidate");
  });

  it("stores claude_oauth (the 5th, presence-only key) → present + CLAUDE_CODE_OAUTH_TOKEN set", async () => {
    const { app } = await build();
    const save = await app.inject({
      method: "POST",
      url: "/api/settings/keys",
      payload: { id: "claude_oauth", value: "tok-oauth-candidate" },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({ ok: true });

    // The OAuth subscription token maps to CLAUDE_CODE_OAUTH_TOKEN (presence-only;
    // never network-probed) and the Settings UI can save it like any other key.
    expect(process.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-oauth-candidate");

    const after = await app.inject({ method: "GET", url: "/api/settings/keys" });
    expect(after.json().claude_oauth).toEqual({ present: true });
    expect(after.body).not.toContain("tok-oauth-candidate");
  });

  it("rejects an unknown id with 400", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/keys",
      payload: { id: "gemini", value: "x" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/settings/keys/:id", () => {
  it("clears a stored key → 204, presence false, env var gone", async () => {
    const { app } = await build();
    await app.inject({
      method: "POST",
      url: "/api/settings/keys",
      payload: { id: "openai", value: "sk-openai" },
    });
    expect(process.env["OPENAI_API_KEY"]).toBe("sk-openai");

    const del = await app.inject({ method: "DELETE", url: "/api/settings/keys/openai" });
    expect(del.statusCode).toBe(204);
    expect(process.env["OPENAI_API_KEY"]).toBeUndefined();

    const after = await app.inject({ method: "GET", url: "/api/settings/keys" });
    expect(after.json().openai).toEqual({ present: false });
  });

  it("clears a stored claude_oauth token → 204, presence false, env var gone", async () => {
    const { app } = await build();
    await app.inject({
      method: "POST",
      url: "/api/settings/keys",
      payload: { id: "claude_oauth", value: "tok-oauth" },
    });
    expect(process.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-oauth");

    const del = await app.inject({ method: "DELETE", url: "/api/settings/keys/claude_oauth" });
    expect(del.statusCode).toBe(204);
    expect(process.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();

    const after = await app.inject({ method: "GET", url: "/api/settings/keys" });
    expect(after.json().claude_oauth).toEqual({ present: false });
  });

  it("rejects an unknown id with 400", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "DELETE", url: "/api/settings/keys/PORT" });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/settings/keys/:id/test (stubbed probe — no real external call)", () => {
  it("a passing probe → 200 {ok:true}", async () => {
    __setSecretsProbeForTests({ probeLlm: async () => ({ ok: true, detail: "accepted" }) });
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/keys/anthropic/test",
      payload: { value: "sk-candidate" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, detail: "accepted" });
    // a test NEVER mutates the saved/live key.
    expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("a failing probe is STILL a 200 carrying {ok:false, detail}", async () => {
    __setSecretsProbeForTests({ probeGeocode: async () => ({ ok: false, detail: "geocode api_error: 401" }) });
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/keys/google_places/test",
      payload: { value: "bad-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, detail: "geocode api_error: 401" });
  });

  it("rejects an unknown id with 400 (a malformed request, not a probe result)", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/keys/gemini/test",
      payload: { value: "x" },
    });
    expect(res.statusCode).toBe(400);
  });
});
