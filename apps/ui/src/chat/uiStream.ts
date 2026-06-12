/**
 * uiStream — decode a /stream-v2 SSE Response into a ReadableStream of AI SDK
 * UIMessageChunk objects (the stream the chat transport hands to useChat).
 *
 * Wire facts it mirrors (apps/server streamV2.ts):
 *   - frames are `data: <json>\n\n` with NO `event:` line; `: heartbeat`
 *     comment lines keep proxies warm and are ignored here.
 *   - the protocol terminator is `data: [DONE]` — the chunk stream closes there.
 *   - a malformed data line is skipped defensively (never thrown into render).
 *
 * Framework-thin: no React; the Response body reader is the only I/O handle.
 * Dependency wall: app/ui layer. Imports the `ai` chunk TYPE only.
 */

import type { UIMessageChunk } from "ai";

/** The protocol terminator sentinel. */
const DONE = "[DONE]";

/**
 * Parse the SSE body of `res` into UIMessageChunk objects. The returned stream
 * closes at `[DONE]` or at upstream end; cancelling it cancels the body reader
 * (which aborts the underlying fetch read).
 */
export function uiChunkStream(res: Response): ReadableStream<UIMessageChunk> {
  const body = res.body;
  if (body === null) {
    throw new Error("uiChunkStream: response has no body to stream");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  return new ReadableStream<UIMessageChunk>({
    async pull(controller): Promise<void> {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line.
        let sep = buffer.indexOf("\n\n");
        let emitted = false;
        while (sep !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of rawEvent.split("\n")) {
            if (!line.startsWith("data: ")) continue; // comments/heartbeats.
            const data = line.slice("data: ".length);
            if (data === DONE) {
              finished = true;
              controller.close();
              void reader.cancel().catch(() => {});
              return;
            }
            try {
              controller.enqueue(JSON.parse(data) as UIMessageChunk);
              emitted = true;
            } catch {
              // Malformed frame — skip defensively, never throw into render.
            }
          }
          sep = buffer.indexOf("\n\n");
        }
        if (emitted) return; // satisfied this pull; back-pressure friendly.
      }
    },
    cancel(): void {
      finished = true;
      void reader.cancel().catch(() => {});
    },
  });
}
