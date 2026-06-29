/**
 * Unit tests — claudeOAuthQuery (lane B), with the Agent SDK MOCKED.
 *
 * `@anthropic-ai/claude-agent-sdk`'s `query` is mocked to a deterministic
 * async-iterable: NO live subprocess, NO network. We assert the SAFETY contract
 * (tools fail-closed three ways, MINIMUM subprocess env with no secret leak,
 * fail-closed on missing auth / non-success / missing structured_output) and the
 * success-path normalization. The controller runs the live probe separately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

import { claudeOAuthQuery, ClaudeOAuthError } from "./claudeOAuth.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const mockedQuery = vi.mocked(query);

/** Wrap zero or more result messages in a fake async-iterable `Query`. */
function fakeQuery(...messages: ReadonlyArray<Record<string, unknown>>): Query {
  async function* gen(): AsyncGenerator<unknown, void> {
    for (const m of messages) yield m;
  }
  return gen() as unknown as Query;
}

/** A canonical structured-success result message (the SDK's `type:'result'` shape). */
const SUCCESS_STRUCTURED = {
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: { city: "Tucson", high: 100 },
  result: "ignored on the structured path",
  usage: { input_tokens: 1, output_tokens: 2 },
} as const;

const SCHEMA = { type: "object", properties: { city: { type: "string" } } };

let saved: Record<string, string | undefined>;

beforeEach(() => {
  mockedQuery.mockReset();
  saved = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env["CLAUDE_CODE_OAUTH_TOKEN"],
    DEEPSEEK_API_KEY: process.env["DEEPSEEK_API_KEY"],
    GOOGLE_PLACES_API_KEY: process.env["GOOGLE_PLACES_API_KEY"],
  };
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "oauth-tok-test";
  // Secrets that MUST NOT leak into the subprocess env.
  process.env["DEEPSEEK_API_KEY"] = "ds-secret-should-not-leak";
  process.env["GOOGLE_PLACES_API_KEY"] = "gp-secret-should-not-leak";
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("claudeOAuthQuery — SAFETY: tools fail-closed + min-env", () => {
  it("passes allowedTools:[] + disallowedTools(builtins) + a deny-all canUseTool", async () => {
    mockedQuery.mockReturnValue(fakeQuery(SUCCESS_STRUCTURED));

    await claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" });

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const opts = mockedQuery.mock.calls[0]?.[0].options;
    expect(opts?.allowedTools).toEqual([]);
    expect(opts?.disallowedTools).toEqual(
      expect.arrayContaining([
        "Bash",
        "BashOutput",
        "KillShell",
        "WebFetch",
        "WebSearch",
        "Read",
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "Glob",
        "Grep",
        "Task",
        "TodoWrite",
        "Skill",
      ]),
    );
    // deny-all canUseTool: every request is denied with interrupt.
    const decision = await opts?.canUseTool?.("Bash", {}, {} as never);
    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("passes ONLY {CLAUDE_CODE_OAUTH_TOKEN, PATH, HOME} into env — no DeepSeek/Maps secrets leak", async () => {
    mockedQuery.mockReturnValue(fakeQuery(SUCCESS_STRUCTURED));

    await claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" });

    const env = mockedQuery.mock.calls[0]?.[0].options?.env ?? {};
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-tok-test");
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"]);
    expect(env).not.toHaveProperty("DEEPSEEK_API_KEY");
    expect(env).not.toHaveProperty("GOOGLE_PLACES_API_KEY");
  });

  it("requests the json_schema outputFormat when a schema is given", async () => {
    mockedQuery.mockReturnValue(fakeQuery(SUCCESS_STRUCTURED));
    await claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" });
    expect(mockedQuery.mock.calls[0]?.[0].options?.outputFormat).toEqual({
      type: "json_schema",
      schema: SCHEMA,
    });
  });

  it("strips the top-level $schema meta key from outputFormat (Agent SDK rejects it)", async () => {
    mockedQuery.mockReturnValue(fakeQuery(SUCCESS_STRUCTURED));
    // zod's toJSONSchema() emits this meta key; the SDK chokes on it (returns
    // success with NO structured_output). claudeOAuthQuery must strip it.
    const schemaWithMeta = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { city: { type: "string" }, high: { type: "number" } },
      required: ["city", "high"],
      additionalProperties: false,
    };

    await claudeOAuthQuery({ prompt: "hi", jsonSchema: schemaWithMeta, model: "claude-opus-4-8" });

    const sentSchema = mockedQuery.mock.calls[0]?.[0].options?.outputFormat?.schema as
      | Record<string, unknown>
      | undefined;
    expect(sentSchema).toBeDefined();
    expect(sentSchema).not.toHaveProperty("$schema");
    // Every other key is preserved unchanged.
    expect(sentSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" }, high: { type: "number" } },
      required: ["city", "high"],
      additionalProperties: false,
    });
    // The caller's object is NOT mutated (shallow copy).
    expect(schemaWithMeta).toHaveProperty("$schema");
  });

  it("omits outputFormat on the prose lane (no schema)", async () => {
    mockedQuery.mockReturnValue(fakeQuery({ ...SUCCESS_STRUCTURED, structured_output: undefined }));
    await claudeOAuthQuery({ prompt: "hi", model: "claude-sonnet-4-6" });
    expect(mockedQuery.mock.calls[0]?.[0].options?.outputFormat).toBeUndefined();
  });
});

describe("claudeOAuthQuery — success normalization", () => {
  it("returns structuredOutput + usage on a schema success", async () => {
    mockedQuery.mockReturnValue(fakeQuery(SUCCESS_STRUCTURED));
    const r = await claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" });
    expect(r.structuredOutput).toEqual({ city: "Tucson", high: 100 });
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(r.text).toBeUndefined();
  });

  it("returns text (result) + usage when no schema is requested", async () => {
    mockedQuery.mockReturnValue(
      fakeQuery({ ...SUCCESS_STRUCTURED, structured_output: undefined, result: "hello prose" }),
    );
    const r = await claudeOAuthQuery({ prompt: "hi", model: "claude-sonnet-4-6" });
    expect(r.text).toBe("hello prose");
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(r.structuredOutput).toBeUndefined();
    // (d) prose lane is unaffected by the structured retry — exactly one call.
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("maps missing usage fields to null (NULL-not-$0 friendly)", async () => {
    mockedQuery.mockReturnValue(fakeQuery({ ...SUCCESS_STRUCTURED, usage: {} }));
    const r = await claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" });
    expect(r.usage).toEqual({ inputTokens: null, outputTokens: null });
  });
});

describe("claudeOAuthQuery — fail-closed", () => {
  it("throws ClaudeOAuthError when the token is absent (no call made)", async () => {
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    await expect(
      claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" }),
    ).rejects.toBeInstanceOf(ClaudeOAuthError);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("throws ClaudeOAuthError when the token is the empty string", async () => {
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "";
    await expect(
      claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" }),
    ).rejects.toBeInstanceOf(ClaudeOAuthError);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("(c) throws on a non-success subtype (error_during_execution) WITHOUT a retry", async () => {
    mockedQuery.mockReturnValue(
      fakeQuery({ type: "result", subtype: "error_during_execution", is_error: true, usage: {} }),
    );
    await expect(
      claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" }),
    ).rejects.toBeInstanceOf(ClaudeOAuthError);
    // A real error is NOT the intermittent-empty case — no retry, exactly one call.
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("throws on is_error:true even with subtype 'success'", async () => {
    mockedQuery.mockReturnValue(fakeQuery({ ...SUCCESS_STRUCTURED, is_error: true }));
    await expect(
      claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" }),
    ).rejects.toBeInstanceOf(ClaudeOAuthError);
  });

  it("throws when no result message is produced", async () => {
    mockedQuery.mockReturnValue(fakeQuery());
    await expect(
      claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" }),
    ).rejects.toBeInstanceOf(ClaudeOAuthError);
  });

  it("(c) throws when a schema success carries no structured_output — ONE attempt, no retry", async () => {
    mockedQuery.mockReturnValue(fakeQuery({ ...SUCCESS_STRUCTURED, structured_output: undefined }));
    await expect(
      claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" }),
    ).rejects.toBeInstanceOf(ClaudeOAuthError);
    // The $schema strip is the real, deterministic fix; an empty structured_output
    // is now a genuine failure — fail closed on a single attempt, never retried.
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });
});

describe("claudeOAuthQuery — structured success (no retry path)", () => {
  it("(b) returns the object on a single successful call (query called exactly once)", async () => {
    mockedQuery.mockReturnValue(fakeQuery(SUCCESS_STRUCTURED));
    const r = await claudeOAuthQuery({ prompt: "hi", jsonSchema: SCHEMA, model: "claude-opus-4-8" });
    expect(r.structuredOutput).toEqual({ city: "Tucson", high: 100 });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });
});
