/**
 * transport — the ChatTransport binding useChat to the run streams. The chat
 * transport NEVER starts a run and NEVER submits a decision: runs start through
 * POST /api/skill-runs (launch.ts) and HITL decisions go through POST
 * /api/skill-runs/:id/form-decision (useDecision). All this transport does is
 * open the run's /stream-v2 SSE and hand the decoded chunk stream to the chat.
 *
 * The runId rides `options.body.runId` (sendMessage / resumeStream pass it via
 * their ChatRequestOptions body) — a send without one is a programming error
 * and fails LOUD. reconnectToStream maps a 404 (run unknown to the server) to
 * null, the protocol's "no active stream" answer.
 *
 * MID-RUN DROP RECOVERY (the stuck-Running fix): when the live SSE connection
 * drops BEFORE a terminal chunk (finish/abort/error), the stream does not just
 * end (which would freeze the turn on "Running…" forever). It:
 *   1. retries the connection with exponential backoff (bounded attempts). A
 *      successful reconnect REPLAYS the full backlog server-side; chunk
 *      translation is deterministic per logged frame, so the already-delivered
 *      prefix is SKIPPED by count — text parts would otherwise duplicate
 *      (protocol text-start always pushes a new part; only data parts
 *      reconcile by id). Chunks from fan-out-only screenshot frames are
 *      excluded from the count (they exist only on live connections, never in
 *      a replay) and are dropped during catch-up.
 *   2. after the attempts are exhausted, falls back to ONE
 *      client.runStatus() read — statusSummary recovers the terminal state
 *      from Mastra storage — and synthesizes the matching terminal chunks so
 *      the turn LANDS. A non-terminal/unreachable answer lands an explicit
 *      `stream_disconnected` error (pathological: the same server serves both
 *      endpoints, so a reachable status with an unreconnectable stream is a
 *      bug, and an unreachable server has no live run to wait for).
 *
 * Dependency wall: app/ui layer. The typed client owns the fetch; the ai types
 * shape the contract.
 */

import type { ChatTransport, UIMessageChunk } from "ai";

import { ApiError, type ApiClient } from "../api/client.js";
import type { RunUIMessage } from "./messageModel.js";
import { uiChunkStream } from "./uiStream.js";

/** Read the runId off a ChatRequestOptions body. */
function runIdOf(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const runId = (body as { runId?: unknown }).runId;
  return typeof runId === "string" && runId !== "" ? runId : null;
}

/** Bounded reconnect policy (overridable for tests). */
export interface ReconnectPolicy {
  /** Consecutive failed reconnect attempts before the status fallback. */
  maxAttempts: number;
  /** Backoff base: attempt n waits baseDelayMs * 2^n. */
  baseDelayMs: number;
}

const DEFAULT_RECONNECT: ReconnectPolicy = { maxAttempts: 3, baseDelayMs: 1_000 };

/** The chunk types that end a run on the wire (translator terminals). */
function isTerminalChunk(chunk: UIMessageChunk): boolean {
  return chunk.type === "finish" || chunk.type === "abort" || chunk.type === "error";
}

/** A chunk translated from a fan-out-only screenshot frame: present ONLY on a
 *  live connection, never in a replayed backlog — excluded from the
 *  replay-stable chunk count. Pure browser frames (no screenshot_b64) ARE
 *  logged and replayed, so they stay counted. */
function isLiveOnlyScreenshotChunk(chunk: UIMessageChunk): boolean {
  if (chunk.type !== "data-browser") return false;
  const data = (chunk as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return false;
  const payload = (data as { payload?: unknown }).payload;
  return (
    payload !== null &&
    typeof payload === "object" &&
    "screenshot_b64" in (payload as Record<string, unknown>)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Synthesize the terminal chunks for a status-fallback landing. Mirrors the
 *  translator's terminal mapping (a persisted data-frame the projection reads
 *  + the protocol terminal), with a fallback-marked part id that can never
 *  collide with the replay-stable `frame-<n>` ids. */
async function statusFallbackChunks(client: ApiClient, runId: string): Promise<UIMessageChunk[]> {
  let status: string | null = null;
  try {
    status = (await client.runStatus(runId)).status;
  } catch {
    status = null; // unreachable — land the explicit disconnect error below.
  }
  const frame = (kind: string, payload: Record<string, unknown>): UIMessageChunk =>
    ({ type: "data-frame", id: "frame-status-fallback", data: { kind, payload } }) as UIMessageChunk;

  switch (status) {
    case "done":
      return [frame("done", { recovered: "status_fallback" }), { type: "finish" }];
    case "error":
      return [
        frame("error", { reason: "workflow_failed", recovered: "status_fallback" }),
        { type: "error", errorText: "workflow_failed" },
      ];
    case "declined":
      return [
        frame("aborted", { reason: "user_declined", recovered: "status_fallback" }),
        { type: "abort" },
      ];
    case "aborted":
      return [
        frame("aborted", { reason: "canceled", recovered: "status_fallback" }),
        { type: "abort" },
      ];
    default:
      // Unreachable server, or a live run whose stream cannot reconnect —
      // land an explicit error rather than spinning "Running…" forever.
      return [
        frame("error", { reason: "stream_disconnected", recovered: "status_fallback" }),
        { type: "error", errorText: "stream_disconnected" },
      ];
  }
}

/**
 * Open the run's /stream-v2 with mid-run drop recovery. The FIRST connection
 * is opened eagerly, so a start failure (e.g. 404) propagates to the caller
 * before any stream exists (reconnectToStream's 404→null contract).
 */
export async function resilientRunStream(
  client: ApiClient,
  runId: string,
  signal: AbortSignal | undefined,
  policy: ReconnectPolicy = DEFAULT_RECONNECT,
): Promise<ReadableStream<UIMessageChunk>> {
  const first = await client.streamRun(runId, signal);
  let reader: ReadableStreamDefaultReader<UIMessageChunk> = uiChunkStream(first).getReader();

  let delivered = 0; // replay-stable chunks already emitted downstream
  let toSkip = 0; // replay-stable chunks to drop on the current reconnect
  let sawTerminal = false;
  let cancelled = false;

  return new ReadableStream<UIMessageChunk>({
    async pull(controller): Promise<void> {
      for (;;) {
        if (cancelled) return;
        let chunk: UIMessageChunk | null = null;
        try {
          const result = await reader.read();
          if (!result.done) chunk = result.value;
        } catch {
          // A read error (connection torn down mid-frame) is a drop, not an
          // app error — handled by the reconnect branch below.
          chunk = null;
        }

        if (chunk !== null) {
          const replayStable = !isLiveOnlyScreenshotChunk(chunk);
          if (toSkip > 0) {
            // Catch-up phase after a reconnect: drop the already-delivered
            // replay prefix (and any live-only eye-candy that slips in).
            if (replayStable) toSkip -= 1;
            continue;
          }
          if (replayStable) delivered += 1;
          if (isTerminalChunk(chunk)) sawTerminal = true;
          controller.enqueue(chunk);
          return;
        }

        // Upstream ended.
        if (sawTerminal) {
          controller.close();
          return;
        }

        // Mid-run drop: bounded reconnect with backoff.
        let reconnected = false;
        for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
          await sleep(policy.baseDelayMs * 2 ** attempt);
          if (cancelled || signal?.aborted === true) {
            controller.close();
            return;
          }
          try {
            const res = await client.streamRun(runId, signal);
            reader = uiChunkStream(res).getReader();
            toSkip = delivered; // the replay re-sends everything — skip the prefix.
            reconnected = true;
            break;
          } catch {
            // next attempt
          }
        }
        if (reconnected) continue;

        // Attempts exhausted → ONE status read lands the turn.
        const landing = await statusFallbackChunks(client, runId);
        for (const chunk of landing) controller.enqueue(chunk);
        controller.close();
        return;
      }
    },
    cancel(): void {
      cancelled = true;
      void reader.cancel().catch(() => {});
    },
  });
}

export class RunChatTransport implements ChatTransport<RunUIMessage> {
  constructor(
    private readonly client: ApiClient,
    private readonly policy: ReconnectPolicy = DEFAULT_RECONNECT,
  ) {}

  async sendMessages(options: {
    abortSignal: AbortSignal | undefined;
    body?: object;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const runId = runIdOf(options.body);
    if (runId === null) {
      throw new Error(
        "RunChatTransport.sendMessages: options.body.runId is required — the chat " +
          "transport only streams an already-started run (POST /api/skill-runs owns starts).",
      );
    }
    return resilientRunStream(this.client, runId, options.abortSignal, this.policy);
  }

  async reconnectToStream(options: {
    body?: object;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    const runId = runIdOf(options.body);
    if (runId === null) return null;
    try {
      return await resilientRunStream(this.client, runId, undefined, this.policy);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }
}
