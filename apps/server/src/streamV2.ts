/**
 * streamV2 — the /stream-v2 frame translator: maps the run's wire frames
 * (runPubSub {ts,kind,payload} envelopes) onto the AI SDK UI-message-stream
 * protocol (UIMessageChunk JSON over SSE), so an @ai-sdk/react useChat client
 * can render a run as one assistant message. The server stays a PURE frame
 * translator — no model calls, no DB; it reads the same pubsub channel the
 * legacy /stream route reads, which remains untouched as the default surface.
 *
 * THE MAPPING (one wire frame → one-or-more protocol chunks, in order):
 *   - first, once per connection: start{messageId: runId} — the assistant
 *     message id IS the server runId (drafts/forms key off it).
 *   - text          → text-start / text-delta / text-end (one closed text part
 *                     per frame; intake emits whole-summary text frames).
 *   - awaiting_user → data-gate{id: decision_id, data: payload}. The id makes a
 *                     re-emitted gate RECONCILE (update-in-place) client-side,
 *                     never append a duplicate card.
 *   - browser.*     → data-browser{data: {kind, payload}, transient: true} —
 *                     transient parts are delivered live but NEVER persisted
 *                     into the message history.
 *   - done          → data-frame{kind:'done'} + finish.
 *   - error         → data-frame{kind:'error', payload} + error{errorText}.
 *   - aborted       → data-frame{kind:'aborted', payload} + abort{reason} —
 *                     the declined-vs-aborted distinction rides the persisted
 *                     data-frame payload.reason ('user_declined' vs 'canceled')
 *                     exactly as it rides the legacy aborted frame.
 *   - everything else (init, tool_call, tool_result, the SDK-lane kinds,
 *     reasoning_*, refusal, runs.*) → data-frame{id, data:{kind, payload}} —
 *     carried through VERBATIM. init.driver_kind delivery, the tool milestone
 *     frames, and the terminal vocabulary are NOT redesigned here.
 *
 * Part ids are derived from the frame's backlog position (`text-<n>` /
 * `frame-<n>`), so a replayed backlog produces identical ids — reconcile-safe.
 *
 * Dependency wall: app layer. Imports the `ai` package for the UIMessageChunk
 * TYPE only (the wire contract); the chunks themselves are plain JSON.
 */

import type { UIMessageChunk } from "ai";

import type { SseEvent } from "./runPubSub.js";

/** The SSE response headers for the UI-message-stream protocol (the standard
 *  event-stream set + the protocol marker header the AI SDK clients send). */
export const STREAM_V2_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "x-vercel-ai-ui-message-stream": "v1",
};

/** The stream terminator sentinel (protocol-standard). */
export const STREAM_V2_DONE = "[DONE]";

/** Flag-parallel rollout: the legacy /stream stays the default; /stream-v2
 *  registers only when AUTOBROKER_STREAM_V2=1 (the repo's env-flag idiom). */
export function streamV2Enabled(): boolean {
  return process.env.AUTOBROKER_STREAM_V2 === "1";
}

/** Serialize one protocol chunk as an SSE frame (`data: <json>\n\n`). */
export function chunkFrame(chunk: UIMessageChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Per-connection stateful translator. The index counts frames seen on THIS
 * connection from the top of the backlog, so replayed frames yield the same
 * part ids on every (re)subscribe.
 */
export class UiStreamTranslator {
  private index = 0;

  /** The mandatory first chunk: bind the assistant message to the runId. */
  start(runId: string): UIMessageChunk[] {
    return [{ type: "start", messageId: runId }];
  }

  /** Translate one wire frame into its ordered protocol chunks. */
  translate(ev: SseEvent): UIMessageChunk[] {
    const i = this.index;
    this.index += 1;
    const kind: string = ev.kind;
    const payload = ev.payload;

    if (kind === "text") {
      const id = `text-${i}`;
      const text = typeof payload["text"] === "string" ? (payload["text"] as string) : "";
      return [
        { type: "text-start", id },
        { type: "text-delta", id, delta: text },
        { type: "text-end", id },
      ];
    }

    if (kind === "awaiting_user") {
      const decisionId = payload["decision_id"];
      return [
        {
          type: "data-gate",
          id: typeof decisionId === "string" ? decisionId : `gate-${i}`,
          data: payload,
        },
      ];
    }

    if (kind.startsWith("browser.")) {
      return [{ type: "data-browser", data: { kind, payload }, transient: true }];
    }

    if (kind === "done") {
      return [
        { type: "data-frame", id: `frame-${i}`, data: { kind, payload } },
        { type: "finish" },
      ];
    }

    if (kind === "error") {
      const reason = payload["reason"];
      return [
        { type: "data-frame", id: `frame-${i}`, data: { kind, payload } },
        { type: "error", errorText: typeof reason === "string" ? reason : "workflow_failed" },
      ];
    }

    if (kind === "aborted") {
      const reason = payload["reason"];
      return [
        { type: "data-frame", id: `frame-${i}`, data: { kind, payload } },
        { type: "abort", ...(typeof reason === "string" ? { reason } : {}) },
      ];
    }

    // Everything else rides through verbatim as a persisted data-frame part.
    return [{ type: "data-frame", id: `frame-${i}`, data: { kind, payload } }];
  }
}
