/**
 * claudeAgent.test.ts — the OAuth spawn wrapper's PURE pieces (no real `claude`):
 *   - parseClaudeStreamJson: feed a sample [system, assistant, rate_limit_event,
 *     result] stream ARRAY → assert it extracts the result text + session id +
 *     cost AND flags rate-limited; fail-closed on a missing/empty result.
 *   - buildClaudeChildEnv: the api-key env vars are DELETED from the child env
 *     (the OAuth-subscription acceptance criterion).
 *   - spawnClaudeAgent: with an injected exec stub, returns the parsed result +
 *     contentHash and never shells a real CLI.
 */

import { describe, expect, it } from "vitest";

import {
  STRIPPED_KEY_ENV,
  buildClaudeArgs,
  buildClaudeChildEnv,
  contentHashOf,
  parseClaudeStreamJson,
  spawnClaudeAgent,
} from "./claudeAgent.js";

/** The proven stream shape (finding #1): an ARRAY whose result element carries
 *  the text + session id + cost; a rate_limit_event element appears (finding #2). */
const SAMPLE_STREAM = JSON.stringify([
  { type: "system", subtype: "init", session_id: "sess-abc" },
  { type: "assistant", message: { content: [{ type: "text", text: "intermediate" }] } },
  { type: "rate_limit_event", retry_after_s: 5 },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "lookin for a tucson hybrid around irvine maybe 41k tops",
    session_id: "sess-abc",
    total_cost_usd: 0.014,
    model: "claude-sonnet-4-6",
  },
]);

describe("parseClaudeStreamJson (the stream-array parser)", () => {
  it("extracts the result text + session id + cost off the result element", () => {
    const parsed = parseClaudeStreamJson(SAMPLE_STREAM);
    expect(parsed.generatedText).toBe("lookin for a tucson hybrid around irvine maybe 41k tops");
    expect(parsed.claudeSessionId).toBe("sess-abc");
    expect(parsed.costUsd).toBe(0.014);
    expect(parsed.model).toBe("claude-sonnet-4-6");
    expect(parsed.isError).toBe(false);
  });

  it("flags rate-limited when a rate_limit_event element is present", () => {
    expect(parseClaudeStreamJson(SAMPLE_STREAM).rateLimited).toBe(true);
  });

  it("does NOT flag rate-limited when no rate_limit_event is present", () => {
    const stream = JSON.stringify([
      { type: "system" },
      { type: "result", is_error: false, result: "hi there", session_id: "s1" },
    ]);
    expect(parseClaudeStreamJson(stream).rateLimited).toBe(false);
  });

  it("reads the model off modelUsage when no top-level model field", () => {
    const stream = JSON.stringify([
      { type: "result", is_error: false, result: "ok", session_id: "s2", modelUsage: { "claude-opus-4-8": {} } },
    ]);
    expect(parseClaudeStreamJson(stream).model).toBe("claude-opus-4-8");
  });

  it("fail-closed: throws when there is no result element", () => {
    const stream = JSON.stringify([{ type: "system" }, { type: "assistant" }]);
    expect(() => parseClaudeStreamJson(stream)).toThrow(/no type:"result"/);
  });

  it("fail-closed: throws when the result text is empty", () => {
    const stream = JSON.stringify([{ type: "result", result: "  ", session_id: "s3" }]);
    expect(() => parseClaudeStreamJson(stream)).toThrow(/non-empty .result/);
  });

  it("fail-closed: throws when the session id is missing", () => {
    const stream = JSON.stringify([{ type: "result", result: "text" }]);
    expect(() => parseClaudeStreamJson(stream)).toThrow(/session_id/);
  });

  it("fail-closed: throws on non-JSON stdout", () => {
    expect(() => parseClaudeStreamJson("not json {")).toThrow(/not valid JSON/);
  });

  it("tolerates a single result object (not wrapped in an array)", () => {
    const single = JSON.stringify({ type: "result", result: "solo", session_id: "s4" });
    expect(parseClaudeStreamJson(single).generatedText).toBe("solo");
  });
});

describe("buildClaudeChildEnv (the OAuth-subscription env strip)", () => {
  it("deletes EVERY provider api-key var from the child env", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_BASE_URL: "https://example",
      DEEPSEEK_API_KEY: "ds-xxx",
      OPENAI_API_KEY: "oa-xxx",
      HOME: "/home/x",
    };
    const child = buildClaudeChildEnv(parent);
    for (const k of STRIPPED_KEY_ENV) {
      expect(child[k]).toBeUndefined();
    }
    // Non-key env is preserved (the CLI still needs PATH/HOME for the Keychain).
    expect(child["PATH"]).toBe("/usr/bin");
    expect(child["HOME"]).toBe("/home/x");
    // The parent is not mutated.
    expect(parent["ANTHROPIC_API_KEY"]).toBe("sk-ant-xxx");
  });
});

describe("buildClaudeArgs", () => {
  it("builds the -p / json / model / system-prompt argv", () => {
    const args = buildClaudeArgs({ rolePrompt: "ROLE", model: "opus", task: "TASK" });
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("ROLE");
    expect(args).toContain("TASK");
  });

  it("folds the transcript into the user prompt when given", () => {
    const args = buildClaudeArgs({ rolePrompt: "R", model: "sonnet", task: "T", transcriptSoFar: "PRIOR" });
    const prompt = args[args.indexOf("-p") + 1]!;
    expect(prompt).toContain("T");
    expect(prompt).toContain("PRIOR");
  });
});

describe("contentHashOf", () => {
  it("is a stable sha256 hex of the text", () => {
    const h = contentHashOf("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHashOf("hello")).toBe(h);
    expect(contentHashOf("hello!")).not.toBe(h);
  });
});

describe("spawnClaudeAgent (with an injected exec stub — never a real CLI)", () => {
  it("returns the parsed result + contentHash and strips the api-key env", async () => {
    let capturedEnv: NodeJS.ProcessEnv | null = null;
    let capturedArgs: string[] | null = null;
    process.env["ANTHROPIC_API_KEY"] = "sk-should-be-stripped";
    try {
      const result = await spawnClaudeAgent({
        rolePromptPath: "/unused/buyer.md",
        model: "opus",
        task: "generate a buyer cold-start",
        readFileImpl: () => "BUYER ROLE",
        execImpl: async (args, env) => {
          capturedArgs = args;
          capturedEnv = env;
          return SAMPLE_STREAM;
        },
      });
      expect(result.generatedText).toContain("tucson hybrid");
      expect(result.claudeSessionId).toBe("sess-abc");
      expect(result.contentHash).toBe(contentHashOf(result.generatedText));
      expect(result.rateLimited).toBe(true);
      expect(result.costUsd).toBe(0.014);
      // The child env handed to exec had the key stripped.
      expect(capturedEnv).not.toBeNull();
      expect((capturedEnv as unknown as NodeJS.ProcessEnv)["ANTHROPIC_API_KEY"]).toBeUndefined();
      // The role file was the appended system prompt.
      expect((capturedArgs as unknown as string[]).join(" ")).toContain("BUYER ROLE");
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("fail-closed: throws when the result element reports is_error=true", async () => {
    const errStream = JSON.stringify([
      { type: "result", is_error: true, result: "boom", session_id: "s5", model: "claude-x" },
    ]);
    await expect(
      spawnClaudeAgent({
        rolePromptPath: "/unused.md",
        model: "sonnet",
        task: "x",
        readFileImpl: () => "ROLE",
        execImpl: async () => errStream,
      }),
    ).rejects.toThrow(/is_error=true/);
  });
});
