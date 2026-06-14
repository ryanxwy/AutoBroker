/**
 * client.test — zod decode of the typed client against CAPTURED wire fixtures.
 * The fixtures are literal JSON shapes copied from the server integration tests
 * (server.integration.test.ts) + the route/service source — fixed INPUT fixtures
 * of OUR OWN wire (per the task brief: capturing the wire envelope, not an LLM
 * trace). A mock fetch returns each fixture; we assert the client decodes it (or
 * throws the typed ApiError on a non-2xx / schema-mismatch).
 *
 * Pure (node env) — no DOM. The stream decode tests live in chat/uiStream.test.ts.
 */

import { describe, expect, it } from "vitest";

import { ApiClient, ApiError } from "./client.js";
import { EVENT_KINDS, EnvConfigResponseSchema } from "./wire.js";

/** Build a mock fetch that returns one canned Response for any URL. */
function mockFetch(status: number, body: unknown): typeof fetch {
  const fn = async (): Promise<Response> =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return fn as unknown as typeof fetch;
}

/** A fetch that records the request it received, for body/URL assertions. */
function spyFetch(status: number, body: unknown): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

// ---------------------------------------------------------------------------
// Captured fixtures — literal shapes the server emits (cited inline).
// ---------------------------------------------------------------------------

/** GET /api/skills → [SKILL_MANIFEST] (routes.ts:78-86, returned at :279). */
const SKILLS_FIXTURE = [
  {
    name: "search_profile_intake",
    version: "m1-v1",
    summary: "Create a new-car search profile from a slash form or freeform prose.",
    inputs: ["input_mode", "freeform_text", "seed_fields"],
    outputs: "search_profile",
    sensitive: false,
    profile_pin: "exempt",
    retries: 0,
  },
];

/** GET /api/mode → { active_db, data_dir, demo } (routes.ts:287). */
const MODE_FIXTURE = {
  active_db: "/tmp/autobroker-xyz/autobroker.db",
  data_dir: "/tmp/autobroker-xyz",
  demo: false,
};

/** GET /api/skill-runs/:id → status summary (intakeRuns.ts:569-575). The
 *  awaiting_user@collect state captured from startSlashToCollect. */
const STATUS_AWAITING_FIXTURE = {
  run_id: "run-1",
  skill: "search_profile_intake",
  status: "awaiting_approval",
  pending: { step: "collect", decision_id: "dec-1" },
  events: [
    {
      ts: "2026-06-05T00:00:00.000Z",
      kind: "init",
      payload: { run_id: "run-1", skill: "search_profile_intake", driver_kind: "deepseek_apikey" },
    },
    {
      ts: "2026-06-05T00:00:00.100Z",
      kind: "awaiting_user",
      payload: { form_kind: "data_collection", spec_inline: {}, decision_id: "dec-1", step: "collect" },
    },
  ],
};

/** POST /api/skill-runs → 201 { run_id, session_id, scope_notice } (routes.ts:204-208).
 *  Headless/unpinned start → session_id + scope_notice null (nothing to confuse). */
const START_ACK_FIXTURE = { run_id: "run-1", session_id: null, scope_notice: null };

/** form-decision accept ack (intakeRuns.ts:403). */
const ACCEPT_ACK_FIXTURE = { action: "accept", content: { make: "Hyundai" } };
/** form-decision decline ack (intakeRuns.ts:386-388). */
const DECLINE_ACK_FIXTURE = { action: "decline", content: null };

/** GET /api/profiles/:id → a snake_case row (routes.ts:268; columns vary). */
const PROFILE_ROW_FIXTURE = {
  search_profile_id: "sp-1",
  make: "Hyundai",
  model: "Tucson",
  year: 2026,
  latitude: 33.6695,
  longitude: -117.7669,
  status: "active",
};

/** The unified error envelope (server.ts:38-52). */
const ERROR_ENVELOPE_FIXTURE = {
  error: { code: "decision_conflict", message: "decision already consumed", run_id: "run-1" },
};

/** GET /api/settings/env → { vars: EnvVarState[] } — one curated row per id, the
 *  editable enum/bool + a read-only fuse status row carrying value "armed". */
const ENV_CONFIG_FIXTURE = {
  vars: [
    {
      id: "gmail_backend",
      envVar: "AUTOBROKER_GMAIL_BACKEND",
      classification: "editable-enum",
      editable: true,
      allowedValues: ["fake", "real"],
      default: "fake",
      label: "Email mode",
      tooltip: "Email mode.",
      value: "fake",
    },
    {
      id: "block_external_mutations",
      envVar: "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS",
      classification: "read-only-status",
      editable: false,
      allowedValues: null,
      default: null,
      label: "Safety fuse",
      tooltip: "Safety fuse.",
      value: "armed",
    },
  ],
};

/** PUT /api/settings/env → { ok:true, vars } echo after a stored value. */
const SET_ENV_ACK_FIXTURE = {
  ok: true,
  vars: [{ ...ENV_CONFIG_FIXTURE.vars[0], value: "real" }, ENV_CONFIG_FIXTURE.vars[1]],
};

describe("ApiClient decode — captured wire fixtures", () => {
  it("listSkills decodes the manifest array", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(200, SKILLS_FIXTURE) });
    const skills = await client.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("search_profile_intake");
    expect(skills[0]!.sensitive).toBe(false);
  });

  it("getMode decodes { active_db, data_dir }", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(200, MODE_FIXTURE) });
    const mode = await client.getMode();
    expect(mode.data_dir).toBe("/tmp/autobroker-xyz");
  });

  it("runStatus decodes the awaiting_approval summary incl. pending + events", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(200, STATUS_AWAITING_FIXTURE) });
    const summary = await client.runStatus("run-1");
    expect(summary.status).toBe("awaiting_approval");
    expect(summary.pending?.step).toBe("collect");
    expect(summary.pending?.decision_id).toBe("dec-1");
    expect(summary.events[0]!.kind).toBe("init");
    expect(summary.events[0]!.payload["driver_kind"]).toBe("deepseek_apikey");
  });

  it("runStatus decodes a null pending (running/terminal)", async () => {
    const fixture = { ...STATUS_AWAITING_FIXTURE, status: "running", pending: null };
    const client = new ApiClient({ fetchImpl: mockFetch(200, fixture) });
    const summary = await client.runStatus("run-1");
    expect(summary.pending).toBeNull();
  });

  it("startRun decodes the 201 { run_id } and posts the snake_case body", async () => {
    const { fetch, calls } = spyFetch(201, START_ACK_FIXTURE);
    const client = new ApiClient({ fetchImpl: fetch });
    const ack = await client.startRun({ skill: "search_profile_intake", input_mode: "slash" });
    expect(ack.run_id).toBe("run-1");
    expect(calls[0]!.url).toBe("/api/skill-runs");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      skill: "search_profile_intake",
      input_mode: "slash",
    });
  });

  it("formDecision decodes the accept ack", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(200, ACCEPT_ACK_FIXTURE) });
    const ack = await client.formDecision("run-1", {
      decision_id: "dec-1",
      decision: { action: "accept", content: { make: "Hyundai" } },
    });
    expect(ack.action).toBe("accept");
    expect(ack.content).toEqual({ make: "Hyundai" });
  });

  it("formDecision decodes the decline ack (content null)", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(200, DECLINE_ACK_FIXTURE) });
    const ack = await client.formDecision("run-1", {
      decision_id: "dec-1",
      decision: { action: "decline" },
    });
    expect(ack.action).toBe("decline");
    expect(ack.content).toBeNull();
  });

  it("getProfile decodes an open snake_case row", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(200, PROFILE_ROW_FIXTURE) });
    const row = await client.getProfile("sp-1");
    expect(row["make"]).toBe("Hyundai");
    expect(row["search_profile_id"]).toBe("sp-1");
  });

  it("listProfiles decodes an array and threads the status query", async () => {
    const { fetch, calls } = spyFetch(200, [PROFILE_ROW_FIXTURE]);
    const client = new ApiClient({ fetchImpl: fetch });
    const rows = await client.listProfiles("active");
    expect(rows).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/profiles?status=active");
  });
});

describe("ApiClient — sessions (pin + scope_notice in one fetch)", () => {
  /** GET /api/sessions/:id → SessionResponse (sessions.ts toSessionResponse),
   *  the persisted-notice shape off the fork integration test. */
  const SESSION_FIXTURE = {
    id: "sess-fork-1",
    title: "New search_profile_intake",
    created_at: "2026-06-12T00:00:00.000Z",
    last_activity_at: "2026-06-12T00:00:01.000Z",
    pinned_profile_id: null,
    scope_notice: {
      kind: "intake_scope_notice",
      source_pinned_profile_id: "prof-existing",
      forked_session_id: "sess-fork-1",
      points: ["a", "b", "c"],
    },
    last_run_id: null,
    archived: false,
  };

  it("getSession decodes pin + persisted scope notice from the ONE fetch", async () => {
    const { fetch, calls } = spyFetch(200, SESSION_FIXTURE);
    const client = new ApiClient({ fetchImpl: fetch });
    const s = await client.getSession("sess-fork-1");
    expect(calls[0]!.url).toBe("/api/sessions/sess-fork-1");
    expect(s.pinned_profile_id).toBeNull();
    expect(s.scope_notice?.source_pinned_profile_id).toBe("prof-existing");
  });

  it("patchSession sends the camelCase pin body (null clears; omitted leaves)", async () => {
    const { fetch, calls } = spyFetch(200, { ...SESSION_FIXTURE, pinned_profile_id: "prof-2" });
    const client = new ApiClient({ fetchImpl: fetch });
    const s = await client.patchSession("sess-fork-1", { pinnedProfileId: "prof-2" });
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ pinnedProfileId: "prof-2" });
    expect(s.pinned_profile_id).toBe("prof-2");
  });

  it("listSessions hits /api/sessions (optional pin filter on the query)", async () => {
    const { fetch, calls } = spyFetch(200, [SESSION_FIXTURE]);
    const client = new ApiClient({ fetchImpl: fetch });
    const list = await client.listSessions();
    expect(calls[0]!.url).toBe("/api/sessions");
    expect(list).toHaveLength(1);
  });
});

describe("ApiClient error decode — error envelope → ApiError", () => {
  it("a 409 envelope decodes into a typed ApiError with code + envelope", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(409, ERROR_ENVELOPE_FIXTURE) });
    await expect(client.formDecision("run-1", { decision_id: "d", decision: { action: "decline" } }))
      .rejects.toMatchObject({ status: 409, code: "decision_conflict", name: "ApiError" });
  });

  it("a 400 content_invalid envelope carries the field pointer", async () => {
    const envelope = {
      error: { code: "content_invalid", message: "request body invalid", field: "/input_mode" },
    };
    const client = new ApiClient({ fetchImpl: mockFetch(400, envelope) });
    try {
      await client.startRun({ skill: "search_profile_intake", input_mode: "slash" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).field).toBe("/input_mode");
    }
  });

  it("a non-envelope gateway error → synthetic http_<status> code", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(502, undefined) });
    await expect(client.getMode()).rejects.toMatchObject({ status: 502, code: "http_502" });
  });

  it("a 2xx body that fails the wire schema → decode_error ApiError", async () => {
    // skills array with a manifest missing required fields.
    const client = new ApiClient({ fetchImpl: mockFetch(200, [{ name: "x" }]) });
    await expect(client.listSkills()).rejects.toMatchObject({ code: "decode_error" });
  });
});

describe("ApiClient — settings / environment", () => {
  it("getEnvConfig decodes { vars: EnvVarState[] } incl. the armed fuse row", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(200, ENV_CONFIG_FIXTURE) });
    const cfg = await client.getEnvConfig();
    expect(cfg.vars).toHaveLength(2);
    expect(cfg.vars[0]!.id).toBe("gmail_backend");
    expect(cfg.vars[0]!.allowedValues).toEqual(["fake", "real"]);
    const fuse = cfg.vars.find((v) => v.id === "block_external_mutations");
    expect(fuse?.editable).toBe(false);
    expect(fuse?.value).toBe("armed");
    expect(fuse?.allowedValues).toBeNull();
  });

  it("setEnvConfig issues a PUT with { id, value } and tolerates the { ok, vars } echo", async () => {
    const { fetch, calls } = spyFetch(200, SET_ENV_ACK_FIXTURE);
    const client = new ApiClient({ fetchImpl: fetch });
    await client.setEnvConfig("gmail_backend", "real");
    expect(calls[0]!.url).toBe("/api/settings/env");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      id: "gmail_backend",
      value: "real",
    });
  });

  it("EnvConfigResponseSchema rejects a row missing a required field", () => {
    const bad = { vars: [{ ...ENV_CONFIG_FIXTURE.vars[0], value: undefined }] };
    expect(EnvConfigResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("EVENT_KINDS includes browser.acquire.progress", () => {
    expect((EVENT_KINDS as readonly string[]).includes("browser.acquire.progress")).toBe(true);
  });
});
