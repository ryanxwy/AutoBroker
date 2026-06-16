/**
 * claudeAgent — the `claude -p` spawn wrapper for the soak lane.
 *
 * The soak buyer/dealer/judge roles are pure NL generators driven by the
 * machine's logged-in Claude SUBSCRIPTION (Keychain OAuth), not an api key. This
 * wrapper shells `claude -p --output-format json --model <model>` in a child env
 * with EVERY provider api-key var DELETED (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * ANTHROPIC_BASE_URL, DEEPSEEK_API_KEY, OPENAI_API_KEY) so the CLI falls back to
 * the subscription — zero per-call api cost. (Probed live 2026-06-15: the model
 * replied with keys stripped; this Claude Code session itself runs the same way.)
 *
 * THREE PROBE FINDINGS this module honors (plan-0 §"Confirmed dependency"):
 *  1. `--output-format json` returns a STREAM ARRAY, not a single object:
 *     [system(init), assistant…, rate_limit_event?, result]. The generated text +
 *     session id + cost live on the `type:"result"` element. A naive single-object
 *     parse yields undefined for every field — parseClaudeStreamJson walks the
 *     array and reads off the result element.
 *  2. Throughput is gated by subscription RATE LIMITS, not per-call dollars: a
 *     `rate_limit_event` element can appear and a trivial call takes ~50s. The
 *     wrapper surfaces `rateLimited` so the caller can back off + pace sequentially.
 *  3. The lane is local/owner-run by nature (Keychain OAuth + rate limits) — never
 *     headless cron/CI. cli.ts enforces the OAuth-only precondition.
 *
 * The child NEVER drives a browser — it only EMITS text the orchestrator types.
 * This keeps the buyer/dealer agent-agnostic and the single pinned browser
 * orchestrator-owned (the session-consistency story).
 *
 * Dependency wall: harness layer. Uses node:child_process + node:crypto only —
 * no provider client, no DB, no playwright, no @ai-sdk.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The api-key env vars STRIPPED from the child so `claude -p` uses the
 *  Keychain OAuth subscription (no per-call api cost). Frozen — the OAuth-only
 *  invariant depends on this exact set (cli.ts also refuses to run if any is set). */
export const STRIPPED_KEY_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
] as const;

export type ClaudeModel = "sonnet" | "opus";

export interface SpawnClaudeAgentOpts {
  /** Absolute path to the role prompt (buyer.md / dealer.md / judge.md) — used as
   *  the system prompt via `--append-system-prompt`. */
  rolePromptPath: string;
  /** Which subscription model to drive the role on. */
  model: ClaudeModel;
  /** The per-scenario instruction the role acts on (the user-turn prompt). */
  task: string;
  /** Optional prior transcript text folded into the user prompt for continuity
   *  (e.g. the dealer sees our outbound; the buyer sees the scenario so far). */
  transcriptSoFar?: string;
  /** Wall-clock budget (ms). A trivial call is ~50s on the subscription, so the
   *  default is generous. */
  timeoutMs?: number;
  /** Test seam: inject the spawn so unit tests never shell a real `claude`. */
  execImpl?: ExecImpl;
  /** Test seam: read the role file (defaults to fs.readFileSync). */
  readFileImpl?: (path: string) => string;
}

/** The single result the soak driver consumes. */
export interface ClaudeAgentResult {
  /** The role's emitted text (the `.result` off the type:"result" element). */
  generatedText: string;
  /** The claude session id (replay/audit handle) — off the result element. */
  claudeSessionId: string;
  /** sha256 of generatedText (the ledger's stable content key). */
  contentHash: string;
  /** The notional api-equivalent cost ($), if reported. On a subscription the
   *  usage is plan-covered; this is recorded for the ledger, not billed. */
  costUsd: number | null;
  /** True when a rate_limit_event appeared in the stream — the caller backs off. */
  rateLimited: boolean;
  /** The model the result element reported running (e.g. "claude-sonnet-4-6"). */
  model: string | null;
  /** The raw parsed stream array (replay/forensics). */
  rawStream: unknown[];
}

// ---------------------------------------------------------------------------
// the stream-array parser (pure — unit-tested)
// ---------------------------------------------------------------------------

/** One element of the `--output-format json` stream array (the fields we read;
 *  the CLI carries more we ignore). */
interface ResultElement {
  type: "result";
  result?: unknown;
  session_id?: unknown;
  total_cost_usd?: unknown;
  is_error?: unknown;
  model?: unknown;
  modelUsage?: Record<string, unknown>;
}

export interface ParsedClaudeStream {
  generatedText: string;
  claudeSessionId: string;
  costUsd: number | null;
  rateLimited: boolean;
  model: string | null;
  isError: boolean;
  rawStream: unknown[];
}

/**
 * Parse the `claude -p --output-format json` STREAM ARRAY (finding #1). Walks the
 * array, takes the `type:"result"` element's `.result` as the generated text and
 * reads session_id / total_cost_usd / model off it; flags rate-limited when any
 * element is a `rate_limit_event` (finding #2). Fail-CLOSED: a stream with no
 * result element, or a result element missing the text/session id, throws — the
 * soak must never proceed on an undefined generation (a silent "" would corrupt
 * the ledger + the deterministic verdict).
 */
export function parseClaudeStreamJson(stdout: string): ParsedClaudeStream {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`claudeAgent: stdout is not valid JSON — ${(e as Error).message}`);
  }
  // The probe proved `--output-format json` returns an ARRAY. Tolerate a single
  // result object too (a CLI that ever returns one), but never silently accept a
  // non-array/non-result shape.
  const stream: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  let rateLimited = false;
  let resultEl: ResultElement | null = null;
  for (const el of stream) {
    if (el === null || typeof el !== "object") continue;
    const type = (el as { type?: unknown }).type;
    if (type === "rate_limit_event") rateLimited = true;
    if (type === "result") resultEl = el as ResultElement;
  }

  if (resultEl === null) {
    throw new Error(
      `claudeAgent: stream array carried no type:"result" element (got ${stream.length} elements) — fail-closed`,
    );
  }

  const text = resultEl.result;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error('claudeAgent: result element carried no non-empty .result text — fail-closed');
  }
  const sessionId = resultEl.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("claudeAgent: result element carried no session_id — fail-closed");
  }

  const isError = resultEl.is_error === true;
  const costUsd = typeof resultEl.total_cost_usd === "number" ? resultEl.total_cost_usd : null;
  const model =
    typeof resultEl.model === "string"
      ? resultEl.model
      : resultEl.modelUsage !== undefined && typeof resultEl.modelUsage === "object"
        ? Object.keys(resultEl.modelUsage)[0] ?? null
        : null;

  return {
    generatedText: text,
    claudeSessionId: sessionId,
    costUsd,
    rateLimited,
    model,
    isError,
    rawStream: stream,
  };
}

/** sha256 of the generated text — the ledger's stable content key. */
export function contentHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// the child env construction (pure — unit-tested)
// ---------------------------------------------------------------------------

/**
 * Build the child env for the `claude -p` spawn: a COPY of the parent env with
 * every STRIPPED_KEY_ENV var DELETED so the CLI falls back to the Keychain OAuth
 * subscription (no api-key cost). Pure so a unit test can assert the strip
 * without spawning anything.
 */
export function buildClaudeChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };
  for (const k of STRIPPED_KEY_ENV) delete env[k];
  return env;
}

/** Build the `claude` argv for a role spawn. The role file is the appended
 *  system prompt; the task (+ optional transcript) is the `-p` user prompt. */
export function buildClaudeArgs(opts: {
  rolePrompt: string;
  model: ClaudeModel;
  task: string;
  transcriptSoFar?: string;
}): string[] {
  const prompt =
    opts.transcriptSoFar !== undefined && opts.transcriptSoFar.trim().length > 0
      ? `${opts.task}\n\n--- transcript so far ---\n${opts.transcriptSoFar}`
      : opts.task;
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    opts.model,
    "--append-system-prompt",
    opts.rolePrompt,
  ];
}

// ---------------------------------------------------------------------------
// the spawn (the impure shell — injectable for tests)
// ---------------------------------------------------------------------------

/** The spawn seam: a function that runs `claude` with argv + env and returns its
 *  stdout. Defaults to execFile; unit tests inject a stub (never shell `claude`). */
export type ExecImpl = (
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<string>;

const defaultExec: ExecImpl = (args, env, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "claude",
      args,
      { env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `claude -p spawn failed (${err.message}) — stderr: ${String(stderr).slice(0, 800)}`,
            ),
          );
          return;
        }
        resolve(String(stdout));
      },
    );
  });

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Spawn a `claude -p` role agent: strip the api-key env, shell the CLI with the
 * role file as the system prompt, parse the stream array, return the generated
 * text + session id + content hash + cost + rate-limit flag. Fail-closed on a
 * malformed stream (parseClaudeStreamJson throws) or an is_error result.
 */
export async function spawnClaudeAgent(opts: SpawnClaudeAgentOpts): Promise<ClaudeAgentResult> {
  const readFile = opts.readFileImpl ?? ((p: string) => readFileSync(p, "utf8"));
  const rolePrompt = readFile(opts.rolePromptPath);
  const env = buildClaudeChildEnv(process.env);
  const args = buildClaudeArgs({
    rolePrompt,
    model: opts.model,
    task: opts.task,
    ...(opts.transcriptSoFar !== undefined ? { transcriptSoFar: opts.transcriptSoFar } : {}),
  });
  const exec = opts.execImpl ?? defaultExec;
  const stdout = await exec(args, env, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const parsed = parseClaudeStreamJson(stdout);
  if (parsed.isError) {
    throw new Error(
      `claudeAgent: result element reported is_error=true (model=${parsed.model ?? "?"}) — fail-closed`,
    );
  }
  return {
    generatedText: parsed.generatedText,
    claudeSessionId: parsed.claudeSessionId,
    contentHash: contentHashOf(parsed.generatedText),
    costUsd: parsed.costUsd,
    rateLimited: parsed.rateLimited,
    model: parsed.model,
    rawStream: parsed.rawStream,
  };
}
