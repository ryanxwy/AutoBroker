/**
 * serve.mjs — the e2e harness host.
 *
 * Boots the REAL @autobroker/server buildServer() on an ephemeral 127.0.0.1 port
 * and serves the REAL built apps/ui/dist via the committed single-port static
 * serving (static.ts → @fastify/static + SPA fallback). The ONLY things stubbed
 * are the two external collaborators the workflow reaches through the committed,
 * test-guarded DI seam (__setIntakeDepsForTests in @autobroker/workflows):
 *
 *   - resolveLocation  — the goplaces geocoder (a Geocoding API entitlement is a
 *                        known env blocker; NO live geocode).
 *   - harnessGenerate  — the DeepSeek harness.generate (NO live LLM).
 *
 * Everything else is real: the Fastify app, all /api routes, the SSE pubsub +
 * replay, the three-phase form-decision claim, the flat Mastra workflow engine
 * (suspend/resume against a tmp mastra.db), the REAL profileService.create +
 * REAL openDb writing an ISOLATED tmp autobroker.db (the committed migration
 * applied), and the REAL audit_log writes.
 *
 * Per-scenario stub control: a single mutable `scenario` object drives both
 * stubs; the runner flips it via a test-only control route (POST /__e2e/scenario)
 * registered on the SAME app OUTSIDE /api (so the /api wall is untouched). The
 * stubs read it per-call, so a single long-lived process serves all five
 * scenarios deterministically (a `failed → resolved` retry is just a flip).
 *
 * AUTOBROKER_TEST_AUTO_APPROVE is NEVER set: the suspend/approval gate stays live
 * (the decline path is real). The product DB lives in a throwaway AUTOBROKER_DATA_DIR.
 *
 * Run directly: `node apps/ui/e2e/serve.mjs` (prints a JSON line with the port +
 * tmp dir on stdout once listening). The runner (run.mjs) spawns it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildServer } from "@autobroker/server";
import { openDb } from "@autobroker/tools";
import {
  __setIntakeDepsForTests,
  resetMastraForTests,
  resetRuntimeGlueForTests,
} from "@autobroker/workflows";

const here = dirname(fileURLToPath(import.meta.url));
// apps/ui/e2e → repo-root packages/db/drizzle/<migration>.sql
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

// ---------------------------------------------------------------------------
// isolation: a throwaway data dir (NEVER ~/.autobroker*); migration + seed acct.
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "autobroker-e2e-"));
process.env.AUTOBROKER_DATA_DIR = tmpDir;
delete process.env.AUTOBROKER_DB;
// NODE_ENV=test arms the workflows test-only deps seam guard; never auto-approve.
process.env.NODE_ENV = "test";
delete process.env.AUTOBROKER_TEST_AUTO_APPROVE;
// This lane must NEVER really send. The product is buyer-by-default, so force the
// internal posture EXPLICITLY here (not via NODE_ENV alone, an overloaded flag) —
// pin test mode (the sole send-control floor; the Gmail backend projects to fake
// from it) — so a buyer-by-default global can never let a func/Playwright run
// reach a real dealer. boot's assertTestModeSafe tripwire re-asserts this
// fail-closed.
process.env.AUTOBROKER_MODE = "test";
// The DeepSeek provider registry is CONSTRUCTED at boot (createRailMemory pins OM
// to deepseek.chat) but NEVER exercised — give it a dummy key so construction
// never trips on a missing env, while no live call is ever made.
process.env.DEEPSEEK_API_KEY ??= "e2e-dummy-not-used";

const db = openDb(); // <tmpDir>/autobroker.db (tools closure; the only DB owner)
db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
db.$client
  .prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)")
  .run("acct-e2e-1", "e2e@example.com");
db.$client.close();

// ---------------------------------------------------------------------------
// the mutable scenario the stubs read (flipped by the control route)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Scenario
 * @property {"resolved"|"ambiguous"|"failed"} location  geocode outcome
 * @property {boolean} trimValid                          trim_verify verdict
 */

/** @type {Scenario} */
const scenario = { location: "resolved", trimValid: true };

const NO_USAGE = {
  costUsd: null,
  durationMs: 0,
  pricingSource: "unavailable",
  promptTokens: null,
  completionTokens: null,
};

const RESOLVED = {
  kind: "resolved",
  location: {
    lat: 33.6695,
    lng: -117.7669,
    formattedAddress: "Irvine, CA 92602, USA",
    postalCode: "92602",
  },
  traceSpans: [],
};

const AMBIGUOUS = {
  kind: "ambiguous",
  candidates: [
    { lat: 31.7619, lng: -106.485, formattedAddress: "El Paso, TX, USA", postalCode: "79901" },
    { lat: 33.0801, lng: -83.2321, formattedAddress: "El Paso, GA, USA", postalCode: "31097" },
  ],
  traceSpans: [],
};

const FAILED = {
  kind: "failed",
  reason: "no_result",
  detail: "ZERO_RESULTS (e2e stub)",
  traceSpans: [],
};

/** resolveLocation stub: returns the current scenario's outcome (NO live geocode). */
const resolveLocationStub = async () => {
  switch (scenario.location) {
    case "ambiguous":
      return AMBIGUOUS;
    case "failed":
      return FAILED;
    default:
      return RESOLVED;
  }
};

/** harnessGenerate stub: trim_verify verdict from scenario.trimValid; a fixed
 *  freeform-prefill seed otherwise (NO live LLM). */
const harnessGenerateStub = async (input) => {
  if (input.useCase === "intake_trim_verify") {
    return {
      object: {
        valid: scenario.trimValid,
        attestation: scenario.trimValid ? "trim exists" : "trim not found in catalog",
        suggested_trims: scenario.trimValid ? [] : ["SE", "Limited"],
      },
      usage: NO_USAGE,
    };
  }
  // intake_freeform_prefill — a fixed nullable subset seed (PII/budget absent).
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

// ---------------------------------------------------------------------------
// boot the REAL server with the stubs injected, then add the control route.
// ---------------------------------------------------------------------------

/** fetchTrimSources stub: NEVER hit the real web in the deterministic func lane.
 *  Returning {kind:'none'} makes the trimSuggestion step pass straight through to
 *  the data_collection form (no trim_suggestion suspend), so the existing freeform
 *  func cases (whose prefill seeds trim:null) stay byte-identical. */
const fetchTrimSourcesStub = async () => ({ kind: "none" });

resetMastraForTests();
resetRuntimeGlueForTests();
__setIntakeDepsForTests({
  harnessGenerate: harnessGenerateStub,
  resolveLocation: resolveLocationStub,
  fetchTrimSources: fetchTrimSourcesStub,
});

const built = await buildServer({ quiet: true });

// Test-only control route, OUTSIDE /api (the /api wall is untouched). The runner
// POSTs { location?, trimValid? } to flip the scenario between/within runs.
built.app.post("/__e2e/scenario", async (req, reply) => {
  const body = (req.body ?? {}) /** @type {Partial<Scenario>} */;
  if (typeof body.location === "string") scenario.location = body.location;
  if (typeof body.trimValid === "boolean") scenario.trimValid = body.trimValid;
  reply.code(200);
  return { ok: true, scenario };
});

// Test-only audit read, OUTSIDE /api: count REAL audit_log rows for an action,
// through the tools openDb closure (the only DB owner). Lets scenario B prove the
// force-override forced-audit row physically landed in the product DB.
built.app.get("/__e2e/audit", async (req, reply) => {
  const action = (req.query ?? {}).action;
  const adb = openDb();
  try {
    const sql =
      typeof action === "string" && action.length > 0
        ? "SELECT COUNT(*) AS n FROM audit_log WHERE action = ?"
        : "SELECT COUNT(*) AS n FROM audit_log";
    const stmt = adb.$client.prepare(sql);
    const row = typeof action === "string" && action.length > 0 ? stmt.get(action) : stmt.get();
    reply.code(200);
    return { action: action ?? null, count: row.n };
  } finally {
    adb.$client.close();
  }
});

const listenAddr = await built.app.listen({ host: "127.0.0.1", port: 0 });
const addr = built.app.server.address();
const port = typeof addr === "object" && addr !== null ? addr.port : 0;

// A single machine-readable line the runner parses to learn the port.
console.log(JSON.stringify({ e2e: "listening", url: listenAddr, port, dataDir: tmpDir }));

// Graceful teardown on signal (the runner sends SIGTERM).
const shutdown = async () => {
  try {
    await built.app.close();
  } catch {
    /* ignore */
  }
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
