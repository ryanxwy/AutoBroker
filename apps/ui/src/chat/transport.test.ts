/**
 * transport.test — the ChatTransport contract: runId is REQUIRED on send (the
 * transport never starts runs), reconnect maps a 404 to null (no active
 * stream), both paths decode the /stream-v2 SSE into chunks, and the mid-run
 * drop recovery (the stuck-Running fix): reconnect-with-replay-skip and the
 * runStatus terminal fallback.
 */

import { describe, expect, it } from "vitest";

import { ApiClient } from "../api/client.js";
import { resilientRunStream, RunChatTransport, type ReconnectPolicy } from "./transport.js";

function sseFetch(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.includes("/ghost/")) {
      return new Response(
        JSON.stringify({ error: { code: "no_skill_run", message: "no skill run ghost" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      'data: {"type":"start","messageId":"run-1"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
}

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe("RunChatTransport", () => {
  it("sendMessages streams the run named by options.body.runId", async () => {
    const calls: string[] = [];
    const transport = new RunChatTransport(new ApiClient({ fetchImpl: sseFetch(calls) }));
    const stream = await transport.sendMessages({ abortSignal: undefined, body: { runId: "run-1" } });
    expect(calls[0]).toContain("/api/skill-runs/run-1/stream-v2");
    expect(await drain(stream)).toEqual([{ type: "start", messageId: "run-1" }, { type: "finish" }]);
  });

  it("sendMessages without a runId fails LOUD (transport never starts runs)", async () => {
    const transport = new RunChatTransport(new ApiClient({ fetchImpl: sseFetch([]) }));
    await expect(transport.sendMessages({ abortSignal: undefined, body: {} })).rejects.toThrow(
      /runId is required/,
    );
  });

  it("reconnectToStream maps an unknown run (404) to null", async () => {
    const transport = new RunChatTransport(new ApiClient({ fetchImpl: sseFetch([]) }));
    expect(await transport.reconnectToStream({ body: { runId: "ghost" } })).toBeNull();
    expect(await transport.reconnectToStream({ body: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mid-run drop recovery (the stuck-Running fix)
// ---------------------------------------------------------------------------

const FAST: ReconnectPolicy = { maxAttempts: 2, baseDelayMs: 1 };

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
}

const START = { type: "start", messageId: "run-1" };
const TEXT0 = [
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "hello" },
  { type: "text-end", id: "text-1" },
];
const SHOT = {
  type: "data-browser",
  data: { kind: "browser.action", payload: { type: "navigate", target: "https://x/", screenshot_b64: "QUJD" } },
  transient: true,
};
const TERMINAL = [
  { type: "data-frame", id: "frame-9", data: { kind: "done", payload: {} } },
  { type: "finish" },
];

/** A fetch whose /stream-v2 answers are scripted per call: each entry is either
 *  an SSE body string (200) or "FAIL" (network error). /:id status answers
 *  with the given summary. */
function scriptedFetch(streams: Array<string | "FAIL">, status?: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  streamCalls: () => number;
  statusCalls: () => number;
} {
  let streamCalls = 0;
  let statusCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/stream-v2")) {
      const script = streams[Math.min(streamCalls, streams.length - 1)]!;
      streamCalls += 1;
      if (script === "FAIL") throw new TypeError("fetch failed");
      return new Response(script, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    // GET /api/skill-runs/:id — the status fallback read.
    statusCalls += 1;
    if (status === undefined) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(status), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, streamCalls: () => streamCalls, statusCalls: () => statusCalls };
}

describe("resilientRunStream — mid-run drop recovery", () => {
  it("a clean terminal stream passes through once, no retries, no status read", async () => {
    const s = scriptedFetch([sse([START, ...TEXT0, ...TERMINAL]) + "data: [DONE]\n\n"]);
    const stream = await resilientRunStream(new ApiClient({ fetchImpl: s.fetchImpl }), "run-1", undefined, FAST);
    const chunks = (await drain(stream)) as Array<{ type: string }>;
    expect(chunks.map((c) => c.type)).toEqual([
      "start", "text-start", "text-delta", "text-end", "data-frame", "finish",
    ]);
    expect(s.streamCalls()).toBe(1);
    expect(s.statusCalls()).toBe(0);
  });

  it("a mid-run drop reconnects and SKIPS the replayed prefix (no duplicated text parts)", async () => {
    // Connection 1: start + a text part + a LIVE-ONLY screenshot chunk, then
    // drops without a terminal. Connection 2 replays the logged backlog (start
    // + the same text — NO screenshot, fan-out-only frames are never replayed)
    // plus the rest of the run.
    const s = scriptedFetch([
      sse([START, ...TEXT0, SHOT]), // drop (no [DONE], no terminal)
      sse([START, ...TEXT0, ...TERMINAL]) + "data: [DONE]\n\n",
    ]);
    const stream = await resilientRunStream(new ApiClient({ fetchImpl: s.fetchImpl }), "run-1", undefined, FAST);
    const chunks = (await drain(stream)) as Array<{ type: string }>;
    // The replayed start/text were skipped: text parts appear exactly once.
    expect(chunks.map((c) => c.type)).toEqual([
      "start", "text-start", "text-delta", "text-end", "data-browser", "data-frame", "finish",
    ]);
    expect(s.streamCalls()).toBe(2);
    expect(s.statusCalls()).toBe(0);
  });

  it("after maxAttempts failures the runStatus fallback LANDS the terminal (done)", async () => {
    const s = scriptedFetch(
      [sse([START, ...TEXT0]), "FAIL"],
      { run_id: "run-1", skill: "dealer_geosearch", status: "done", pending: null, events: [] },
    );
    const stream = await resilientRunStream(new ApiClient({ fetchImpl: s.fetchImpl }), "run-1", undefined, FAST);
    const chunks = (await drain(stream)) as Array<Record<string, unknown>>;
    const types = chunks.map((c) => c["type"]);
    expect(types.slice(-2)).toEqual(["data-frame", "finish"]);
    const landing = chunks[chunks.length - 2] as { data: { kind: string } };
    expect(landing.data.kind).toBe("done");
    expect(s.streamCalls()).toBe(1 + FAST.maxAttempts);
    expect(s.statusCalls()).toBe(1);
  });

  it("a declined status lands as aborted{user_declined} (projects to declined)", async () => {
    const s = scriptedFetch(
      [sse([START]), "FAIL"],
      { run_id: "run-1", skill: "search_profile_intake", status: "declined", pending: null, events: [] },
    );
    const stream = await resilientRunStream(new ApiClient({ fetchImpl: s.fetchImpl }), "run-1", undefined, FAST);
    const chunks = (await drain(stream)) as Array<Record<string, unknown>>;
    const landing = chunks[chunks.length - 2] as { data: { kind: string; payload: { reason: string } } };
    expect(landing.data.kind).toBe("aborted");
    expect(landing.data.payload.reason).toBe("user_declined");
    expect((chunks[chunks.length - 1] as { type: string }).type).toBe("abort");
  });

  it("an unreachable status endpoint lands an explicit stream_disconnected error", async () => {
    const s = scriptedFetch([sse([START]), "FAIL"]); // status fetch also throws
    const stream = await resilientRunStream(new ApiClient({ fetchImpl: s.fetchImpl }), "run-1", undefined, FAST);
    const chunks = (await drain(stream)) as Array<Record<string, unknown>>;
    expect((chunks[chunks.length - 1] as { errorText?: string }).errorText).toBe("stream_disconnected");
  });
});
