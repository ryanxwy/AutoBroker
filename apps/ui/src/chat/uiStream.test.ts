/**
 * uiStream.test — the SSE → UIMessageChunk decoder. Frames split on blank
 * lines, comments/heartbeats ignored, [DONE] closes, malformed data skipped,
 * split-across-reads frames reassembled.
 */

import { describe, expect, it } from "vitest";

import { uiChunkStream } from "./uiStream.js";

function sseResponse(pieces: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

async function collect(res: Response): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = uiChunkStream(res).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

describe("uiChunkStream", () => {
  it("decodes data frames, ignores heartbeats, and closes at [DONE]", async () => {
    const chunks = await collect(
      sseResponse([
        'data: {"type":"start","messageId":"run-1"}\n\n',
        ": heartbeat\n\n",
        'data: {"type":"finish"}\n\n',
        "data: [DONE]\n\n",
        'data: {"type":"never-reached"}\n\n',
      ]),
    );
    expect(chunks).toEqual([{ type: "start", messageId: "run-1" }, { type: "finish" }]);
  });

  it("reassembles a frame split across reads", async () => {
    const chunks = await collect(
      sseResponse(['data: {"type":"text-delta","id":"t0","del', 'ta":"hi"}\n\ndata: [DONE]\n\n']),
    );
    expect(chunks).toEqual([{ type: "text-delta", id: "t0", delta: "hi" }]);
  });

  it("skips a malformed data line without throwing", async () => {
    const chunks = await collect(
      sseResponse(["data: {not-json\n\n", 'data: {"type":"finish"}\n\n', "data: [DONE]\n\n"]),
    );
    expect(chunks).toEqual([{ type: "finish" }]);
  });

  it("closes when the upstream body ends without [DONE] (disconnect)", async () => {
    const chunks = await collect(sseResponse(['data: {"type":"start","messageId":"r"}\n\n']));
    expect(chunks).toEqual([{ type: "start", messageId: "r" }]);
  });
});
