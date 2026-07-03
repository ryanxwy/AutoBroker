/**
 * static — single-port production serving of the dashboard SPA. In prod one Node
 * process on 127.0.0.1:8100 serves both the JSON/SSE API and the built React SPA;
 * in dev the SPA is served by Vite on :5173, which proxies /api → :8100.
 *
 * This module registers @fastify/static over `apps/ui/dist` for real asset files
 * (JS/CSS/images, correct content-types via `send`), and exposes an SPA-fallback
 * helper the server's notFoundHandler calls so a client-side route (e.g.
 * /sessions/abc) returns index.html instead of a 404 — WITHOUT shadowing /api
 * (those 404 as the JSON error envelope).
 *
 * DEV note (documented, not wired here): the dev Vite proxy lives in the UI
 * package's Vite config. This module only matters for the single-port prod build,
 * and is a NO-OP when `apps/ui/dist` is absent (no build artifact yet) so dev/test
 * boots are unaffected.
 *
 * Dependency wall: app layer. Imports @fastify/static (an app-layer HTTP dep) +
 * node fs/path. Never @mastra, never the product DB.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Resolve `apps/ui/dist` relative to this compiled module. At runtime this file
 *  lives in `apps/server/dist/static.js`; the UI dist is `apps/ui/dist`. The
 *  override env (`AUTOBROKER_UI_DIST`) lets a test point at a tmp dist fixture. */
function resolveUiDist(): string {
  const override = process.env.AUTOBROKER_UI_DIST;
  if (override !== undefined && override.length > 0) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url)); // apps/server/dist (prod) or src (vitest)
  // ../../../apps/ui/dist from apps/server/{dist,src}/static.*
  return resolve(here, "..", "..", "ui", "dist");
}

/** What resolveStaticServing resolved: the served dist dir + its index.html, or
 *  null when no build artifact exists (the SPA fallback then stays off). */
export interface StaticServing {
  distDir: string;
  indexPath: string;
}

/**
 * Resolve the serving info WITHOUT registering anything (sync, no side effect).
 * Returns null when no build artifact exists (dev/test, UI not built).
 *
 * SPLIT RATIONALE (2026-06-05 regression fix): `await app.register(...)` BOOTS
 * the Fastify instance up to that point; a `setErrorHandler`/`setNotFoundHandler`
 * installed AFTER an awaited register is silently ignored, so API error
 * envelopes degraded to Fastify's default serialization whenever apps/ui/dist
 * existed (production shape!). The server must resolve serving info first, set
 * its handlers, and register the plugin LAST.
 */
export function resolveStaticServing(): StaticServing | null {
  const distDir = resolveUiDist();
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) return null;
  return { distDir, indexPath };
}

/**
 * Register @fastify/static for an already-resolved serving. MUST be the LAST
 * registration on the instance (see {@link resolveStaticServing} rationale).
 * `wildcard: false` keeps the plugin from claiming a catch-all route — an
 * unmatched non-/api GET falls through to the server's notFoundHandler, which
 * calls {@link sendSpaFallback}. Real asset requests (/assets/app.js) are served
 * by the plugin directly; only client-side routes reach the fallback.
 */
export async function registerStaticPlugin(
  app: FastifyInstance,
  serving: StaticServing,
): Promise<void> {
  await app.register(fastifyStatic, {
    root: serving.distDir,
    // No `prefix` → assets serve at their natural paths (/assets/..., /favicon).
    // `wildcard: false` registers per-file routes (a `/*` glob match) without a
    // catch-all, so /api/* and unmatched client routes are NOT swallowed here.
    wildcard: false,
    // index.html is served for "/" by the plugin; deeper client routes use the
    // notFoundHandler fallback (sendSpaFallback) instead.
    index: ["index.html"],
  });
}

/**
 * SPA fallback for the server's notFoundHandler: serve index.html for a non-/api
 * GET so a client-side route resolves to the SPA shell. Returns true when it
 * handled the request (sent index.html); false when the caller should emit the
 * normal 404 envelope (an /api path, a non-GET, or no dist).
 */
export function sendSpaFallback(
  serving: StaticServing | null,
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (serving === null) return false;
  // Never shadow the API surface — /api/* 404s stay JSON envelopes.
  if (req.url.startsWith("/api/") || req.url === "/api") return false;
  // Only GET/HEAD navigations get the SPA shell; other verbs 404 normally.
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  // @fastify/static decorates reply.sendFile when registered. Serve the SPA shell.
  (reply as unknown as { sendFile: (p: string) => FastifyReply }).sendFile("index.html");
  return true;
}
