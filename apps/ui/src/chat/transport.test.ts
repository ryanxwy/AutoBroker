/**
 * transport.test — the ChatTransport contract: runId is REQUIRED on send (the
 * transport never starts runs), reconnect maps a 404 to null (no active
 * stream), and both paths decode the /stream-v2 SSE into chunks.
 */

import { describe, expect, it } from "vitest";

import { ApiClient } from "../api/client.js";
import { RunChatTransport } from "./transport.js";

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
