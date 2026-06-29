/**
 * claudeOAuth — lane B: Claude via the official Agent SDK on a subscription
 * OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`). This is the ONLY file in the repo that
 * imports `@anthropic-ai/claude-agent-sdk`; the ownership wall keeps the raw SDK
 * invisible to every other layer (workflows reaches lane B through this seam, via
 * the `@autobroker/model` surface, never the SDK directly).
 *
 * SAFETY (load-bearing — do not weaken):
 *   - Tools fail-closed DISABLED three independent ways: `allowedTools: []` +
 *     `disallowedTools: BUILTINS` + a deny-all `canUseTool` (every request is
 *     denied with `interrupt`). The subprocess can never reach Bash / WebFetch /
 *     Read / Write / etc. (live-verified: a prompt-injected fetch produced zero
 *     outbound requests). Three locks so a single config regression cannot
 *     re-enable a tool.
 *   - The subprocess env is the MINIMUM `{ CLAUDE_CODE_OAUTH_TOKEN, PATH, HOME }`.
 *     `process.env` is NEVER spread, so DEEPSEEK_API_KEY / GOOGLE_PLACES_API_KEY /
 *     Gmail tokens cannot leak into the child process.
 *   - Fail-CLOSED at auth AND at result: a missing token throws before any call;
 *     no result message, a non-success subtype, an `is_error` result, or a
 *     success that carries no `structured_output` when a schema was requested all
 *     THROW a typed `ClaudeOAuthError` — never a fabricated empty/partial object.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The Agent SDK's default built-in tools, listed in `disallowedTools` as a belt
 * on top of `allowedTools: []` and the deny-all `canUseTool`. Three independent
 * locks so no single regression re-enables a side-effecting tool.
 */
const BUILTINS = [
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
] as const;

/** Typed fail-closed failure for the lane-B OAuth path (auth + result). */
export class ClaudeOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeOAuthError";
  }
}

/** The normalized result of one lane-B query. */
export interface ClaudeOAuthResult {
  /** Present (and Zod-validated by the caller) when a `jsonSchema` was requested. */
  structuredOutput?: unknown;
  /** The prose text when no schema was requested. */
  text?: string;
  /** Token usage for the ledger (null when the SDK omits a field). */
  usage: { inputTokens: number | null; outputTokens: number | null };
}

/**
 * Run one single-turn, tool-disabled Claude query over the subscription OAuth
 * token. Returns a structured object (when `jsonSchema` is given) or prose text.
 * Throws `ClaudeOAuthError` on missing auth or any non-success result
 * (fail-closed) — never a fabricated object.
 */
export async function claudeOAuthQuery(args: {
  prompt: string;
  jsonSchema?: object;
  model: string;
}): Promise<ClaudeOAuthResult> {
  const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (token === undefined || token === "") {
    throw new ClaudeOAuthError(
      "CLAUDE_CODE_OAUTH_TOKEN is absent — lane B (Claude OAuth) fails closed without auth",
    );
  }

  // SAFETY: tools fail-closed three ways + the MINIMUM subprocess env. Never
  // spread process.env (would leak DeepSeek / Maps / Gmail secrets into the child).
  const options: Options = {
    model: args.model,
    maxTurns: 1,
    allowedTools: [],
    disallowedTools: [...BUILTINS],
    canUseTool: async () => ({
      behavior: "deny",
      message: "tools disabled on lane B",
      interrupt: true,
    }),
    permissionMode: "default",
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: token,
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
    },
  };
  if (args.jsonSchema !== undefined) {
    // The Agent SDK's outputFormat:{type:"json_schema",schema} REJECTS the
    // top-level "$schema" meta key that zod's toJSONSchema() emits — with it
    // present the model returns SUCCESS with NO structured_output every time
    // (deterministic, live-proven). Strip the meta key (shallow copy — never
    // mutate the caller's object); the field constraints are unchanged.
    const schemaForSdk = { ...(args.jsonSchema as Record<string, unknown>) };
    delete schemaForSdk["$schema"];
    options.outputFormat = { type: "json_schema", schema: schemaForSdk };
  }

  let result: SDKResultMessage | null = null;
  for await (const message of query({ prompt: args.prompt, options })) {
    if (message.type === "result") result = message;
  }

  if (result === null) {
    throw new ClaudeOAuthError(
      "Claude Agent SDK produced no result message — lane B fails closed",
    );
  }
  if (result.subtype !== "success" || result.is_error === true) {
    throw new ClaudeOAuthError(
      `Claude Agent SDK returned a non-success result (subtype=${String(
        result.subtype,
      )}, is_error=${String(result.is_error)}) — lane B fails closed`,
    );
  }

  const usage = {
    inputTokens: result.usage?.input_tokens ?? null,
    outputTokens: result.usage?.output_tokens ?? null,
  };

  // Structured lane: with the $schema meta key stripped above, a clean success
  // carries structured_output. An empty structured_output is now a genuine,
  // non-recoverable failure → throw (fail closed, ONE attempt, no retry).
  if (args.jsonSchema !== undefined) {
    if (result.structured_output === undefined || result.structured_output === null) {
      throw new ClaudeOAuthError(
        "Claude Agent SDK success carried no structured_output despite a json_schema request — lane B fails closed",
      );
    }
    return { structuredOutput: result.structured_output, usage };
  }

  return { text: result.result, usage };
}
