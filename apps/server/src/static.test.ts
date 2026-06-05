/**
 * static serving tests — single-port prod serving of the dashboard SPA
 * (BACKEND_SERVICES §3 全局前置). Builds a TINY dist fixture in a tmp dir, points
 * AUTOBROKER_UI_DIST at it, and drives the REAL Fastify app via inject() to
 * assert:
 *   - index.html served at "/".
 *   - a real asset (/assets/app.js) served with its content.
 *   - SPA fallback: a non-/api client route (/sessions/abc) → index.html (200).
 *   - /api/* unknown → the JSON 404 envelope (the SPA fallback NEVER shadows API).
 *   - a non-GET unknown route → JSON 404 (no SPA shell for POST/PATCH/etc.).
 *   - with NO dist (the override cleared) the server boots and /any 404s JSON
 *     (the fallback stays off — dev/test default).
 *
 * ISOLATION: a fresh tmp data dir (AUTOBROKER_DATA_DIR) for mastra.db; a fresh
 * tmp dist dir (AUTOBROKER_UI_DIST). Both saved/restored; never ~/.autobroker*.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetMastraForTests, resetRuntimeGlueForTests } from "@autobroker/workflows";

import { buildServer, type BuiltServer } from "./server.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const UI_DIST = "AUTOBROKER_UI_DIST";

const INDEX_HTML = "<!doctype html><html><head><title>AutoBroker</title></head><body><div id=root></div></body></html>";
const APP_JS = "console.log('autobroker-spa');";

let dataDir: string;
let distDir: string;
let server: BuiltServer;
let origData: string | undefined;
let origDist: string | undefined;

beforeEach(() => {
  origData = process.env[DATA_DIR];
  origDist = process.env[UI_DIST];
  dataDir = mkdtempSync(join(tmpdir(), "autobroker-static-data-"));
  distDir = mkdtempSync(join(tmpdir(), "autobroker-static-dist-"));
  process.env[DATA_DIR] = dataDir;
  process.env[UI_DIST] = distDir;

  // Build the tiny dist fixture: index.html + assets/app.js.
  writeFileSync(join(distDir, "index.html"), INDEX_HTML);
  mkdirSync(join(distDir, "assets"));
  writeFileSync(join(distDir, "assets", "app.js"), APP_JS);

  resetMastraForTests();
  resetRuntimeGlueForTests();
});

afterEach(async () => {
  if (server !== undefined) await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(distDir, { recursive: true, force: true });
  if (origData === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = origData;
  if (origDist === undefined) delete process.env[UI_DIST];
  else process.env[UI_DIST] = origDist;
});

describe("single-port SPA serving (dist present)", () => {
  it('serves index.html at "/"', async () => {
    server = await buildServer({ quiet: true });
    const r = await server.app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("<div id=root>");
  });

  it("serves a real asset at /assets/app.js", async () => {
    server = await buildServer({ quiet: true });
    const r = await server.app.inject({ method: "GET", url: "/assets/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("autobroker-spa");
  });

  it("SPA fallback: a non-/api client route → index.html (200)", async () => {
    server = await buildServer({ quiet: true });
    const r = await server.app.inject({ method: "GET", url: "/sessions/abc" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("<div id=root>");
  });

  it("NEVER shadows /api: an unknown /api route → JSON 404 envelope", async () => {
    server = await buildServer({ quiet: true });
    const r = await server.app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("not_found");
  });

  it("REGRESSION 2026-06-05: typed RouteError envelopes survive static registration", async () => {
    // An awaited @fastify/static register() BOOTS the instance; handlers set
    // after that are silently ignored, degrading API errors to Fastify's flat
    // default shape ({statusCode, code, error, message}) whenever a dist
    // existed — i.e. exactly the production shape. The fix registers the plugin
    // LAST. This pins the §13.2 nested envelope WITH static serving active.
    server = await buildServer({ quiet: true });
    const r = await server.app.inject({ method: "GET", url: "/api/sessions/no-such-id" });
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error?: { code?: string }; statusCode?: number }>();
    expect(body.error).toBeTypeOf("object"); // nested envelope, not Fastify default
    expect(body.error?.code).toBe("not_found");
    expect(body.statusCode).toBeUndefined(); // the flat default shape is absent
  });

  it("a non-GET unknown route → JSON 404 (no SPA shell for POST)", async () => {
    server = await buildServer({ quiet: true });
    const r = await server.app.inject({ method: "POST", url: "/sessions/abc" });
    expect(r.statusCode).toBe(404);
    expect(r.json<{ error: { code: string } }>().error.code).toBe("not_found");
  });

  it("known API routes still work alongside static serving", async () => {
    server = await buildServer({ quiet: true });
    const r = await server.app.inject({ method: "GET", url: "/api/mode" });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ data_dir: string }>().data_dir).toBe(dataDir);
  });
});

describe("no dist → fallback off (dev/test default)", () => {
  it("boots without a dist and 404s a client route as JSON", async () => {
    // Point the override at a dir with NO index.html → registerStatic no-ops.
    const emptyDir = mkdtempSync(join(tmpdir(), "autobroker-static-empty-"));
    process.env[UI_DIST] = emptyDir;
    try {
      server = await buildServer({ quiet: true });
      const r = await server.app.inject({ method: "GET", url: "/sessions/abc" });
      expect(r.statusCode).toBe(404);
      expect(r.json<{ error: { code: string } }>().error.code).toBe("not_found");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
