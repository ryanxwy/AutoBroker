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

export class RunChatTransport implements ChatTransport<RunUIMessage> {
  constructor(private readonly client: ApiClient) {}

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
    const res = await this.client.streamRun(runId, options.abortSignal);
    return uiChunkStream(res);
  }

  async reconnectToStream(options: {
    body?: object;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    const runId = runIdOf(options.body);
    if (runId === null) return null;
    try {
      const res = await this.client.streamRun(runId, undefined);
      return uiChunkStream(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }
}
