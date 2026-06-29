/**
 * In-process integration tests — the AgentSelection threading at BOTH server
 * entry points (POST /api/skill-runs + POST /api/route).
 *
 * Proves the envelope-level wiring: the UI's raw `agent` payload is parsed ONCE
 * (parseAgentSelection — "claude" → anthropic) and registered run-scoped so the
 * harness reads it via resolveSelectionForRun(runId). An absent/garbage `agent`
 * registers nothing → the DeepSeek default is byte-identical to before.
 *
 *   - POST /api/skill-runs with `agent` → resolveSelectionForRun(run_id) returns
 *     the mapped {provider:"anthropic",...} after start (intake suspends at
 *     collect, so the run is non-terminal and the selection persists).
 *   - POST /api/skill-runs without `agent` → nothing registered for that run.
 *   - POST /api/route with `agent` → the selection is registered against the
 *     router's synthetic ledger runId DURING classify, and cleared after.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; mastra.db +
 * autobroker.db live there; NEVER ~/.autobroker*. The Mastra singleton + runtime
 * glue (incl. the selection registry) are reset between cases.
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
  getRunSelection,
  resetMastraForTests,
  resetRuntimeGlueForTests,
  resolveSelectionForRun,
  type IntakeWorkflowDeps,
  type RouteDecision,
  type RouterContext,
} from "@autobroker/workflows";
import type { AgentSelection } from "@autobroker/core";

import { buildServer, type BuiltServer } from "./server.js";
import { __resetRouteClassifierForTests, __setRouteClassifierForTests } from "./routes.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const AGENT_PROVIDER_ENV = "AUTOBROKER_AGENT_PROVIDER";

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

/** The UI's raw payload (provider:"claude") and the parsed/mapped form. */
const CLAUDE_OAUTH_RAW = {
  provider: "claude",
  method: "oauth",
  model: "claude-opus-4-8",
  effort: "off",
} as const;
const CLAUDE_OAUTH_MAPPED: AgentSelection = {
  provider: "anthropic",
  method: "oauth",
  model: "claude-opus-4-8",
  effort: "off",
};

let tmpDir: string;
let db: Db;
let server: BuiltServer | undefined;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;
let originalAgentProvider: string | undefined;

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

/** A harness stub: prefill a fixed seed so a freeform intake reaches `collect`. */
function harnessStub(): IntakeWorkflowDeps["harnessGenerate"] {
  const fn = async (_input: { useCase: string }) => ({
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
  });
  return fn as unknown as IntakeWorkflowDeps["harnessGenerate"];
}

function locationStub(): IntakeWorkflowDeps["resolveLocation"] {
  const fn: IntakeWorkflowDeps["resolveLocation"] = async () => RESOLVED;
  return fn;
}

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  originalAgentProvider = process.env[AGENT_PROVIDER_ENV];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-agentsel-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  // Keep resolveSelectionForRun deterministic: no env default in scope.
  delete process.env[AGENT_PROVIDER_ENV];

  db = openDb();
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-1", "a@e.com");

  resetMastraForTests();
  resetRuntimeGlueForTests();

  __setIntakeDepsForTests({
    harnessGenerate: harnessStub(),
    resolveLocation: locationStub(),
    fetchTrimSources: async () => ({ kind: "none" }),
  });
});

afterEach(async () => {
  __resetIntakeDepsForTests();
  __resetRouteClassifierForTests();
  if (server !== undefined) {
    await server.app.close();
    server = undefined;
  }
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
  if (originalAgentProvider === undefined) delete process.env[AGENT_PROVIDER_ENV];
  else process.env[AGENT_PROVIDER_ENV] = originalAgentProvider;
});

describe("POST /api/skill-runs — AgentSelection threading", () => {
  it("registers the parsed selection for the created run (claude → anthropic)", async () => {
    server = await buildServer({ quiet: true });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/skill-runs",
      payload: {
        skill: "search_profile_intake",
        input_mode: "freeform",
        freeform_text: "I want a 2026 Tucson near Irvine",
        agent: CLAUDE_OAUTH_RAW,
      },
    });

    expect(res.statusCode).toBe(201);
    const ack = res.json<{ run_id: string }>();

    // The intake run suspends at `collect` (non-terminal), so the run-scoped
    // selection persists and the harness would read the mapped anthropic route.
    expect(resolveSelectionForRun(ack.run_id)).toEqual(CLAUDE_OAUTH_MAPPED);
  });

  it("registers NOTHING when `agent` is absent (DeepSeek default unchanged)", async () => {
    server = await buildServer({ quiet: true });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/skill-runs",
      payload: {
        skill: "search_profile_intake",
        input_mode: "freeform",
        freeform_text: "I want a 2026 Tucson near Irvine",
      },
    });

    expect(res.statusCode).toBe(201);
    const ack = res.json<{ run_id: string }>();
    expect(getRunSelection(ack.run_id)).toBeUndefined();
    // No env default in scope → resolveSelectionForRun is null (the policy default).
    expect(resolveSelectionForRun(ack.run_id)).toBeNull();
  });

  it("registers NOTHING when `agent` is garbage (parseAgentSelection → null)", async () => {
    server = await buildServer({ quiet: true });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/skill-runs",
      payload: {
        skill: "search_profile_intake",
        input_mode: "freeform",
        freeform_text: "I want a 2026 Tucson near Irvine",
        agent: { provider: "gemini" },
      },
    });

    expect(res.statusCode).toBe(201);
    const ack = res.json<{ run_id: string }>();
    expect(getRunSelection(ack.run_id)).toBeUndefined();
  });
});

describe("POST /api/route — AgentSelection threading (router's synthetic runId)", () => {
  it("registers the selection against the router ledger runId DURING classify, then clears it", async () => {
    let seenRunId: string | null = null;
    let seenDuringClassify: AgentSelection | null | undefined = undefined;
    const classifier = async (_nl: string, ctx: RouterContext): Promise<RouteDecision> => {
      seenRunId = ctx.ledger.runId;
      // The harness reads resolveSelectionForRun(ledger.runId) at the generate seam.
      seenDuringClassify = resolveSelectionForRun(ctx.ledger.runId);
      return { kind: "clarify", reason: "n/a", candidates: [] };
    };
    __setRouteClassifierForTests(classifier);
    server = await buildServer({ quiet: true });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/route",
      payload: { nl_input: "hello", agent: CLAUDE_OAUTH_RAW },
    });

    expect(res.statusCode).toBe(200);
    // The classifier (the chat_route harness call) saw the mapped selection.
    expect(seenDuringClassify).toEqual(CLAUDE_OAUTH_MAPPED);
    // …and it is cleared once the classify call returns.
    expect(seenRunId).not.toBeNull();
    expect(getRunSelection(seenRunId!)).toBeUndefined();
  });

  it("registers NOTHING during classify when `agent` is absent", async () => {
    let seenDuringClassify: AgentSelection | null | undefined = undefined;
    const classifier = async (_nl: string, ctx: RouterContext): Promise<RouteDecision> => {
      seenDuringClassify = resolveSelectionForRun(ctx.ledger.runId);
      return { kind: "clarify", reason: "n/a", candidates: [] };
    };
    __setRouteClassifierForTests(classifier);
    server = await buildServer({ quiet: true });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/route",
      payload: { nl_input: "hello" },
    });

    expect(res.statusCode).toBe(200);
    // No env default in scope → the router classify sees the policy default (null).
    expect(seenDuringClassify).toBeNull();
  });
});
