/**
 * browserEvents — adapter from the tools-layer BrowserEmitter callback surface
 * onto the per-run SSE pubsub. Each emitter callback becomes one frame of the
 * closed EVENT_KINDS set (browser.opened / browser.action / browser.error /
 * browser.closed) on the run's channel, riding the standard {ts,kind,payload}
 * envelope that runPubSub stamps and validates.
 *
 * Resilience: emitter callbacks fire from deep inside browser navigation code,
 * so they must never throw back into it — events for a run with no channel yet
 * (attachInit not called) are dropped here, and post-terminal appends are
 * already discarded by the pubsub itself (wire wins).
 */

import type { BrowserEmitter } from "@autobroker/tools";
import type { RunPubSub } from "./runPubSub.js";

export type { BrowserEmitter };

type BrowserEventKind =
  | "browser.opened"
  | "browser.action"
  | "browser.error"
  | "browser.closed";

/** Build a BrowserEmitter that publishes the four browser.* kinds onto the
 *  given run's SSE channel. */
export function browserEmitterFor(pubsub: RunPubSub, runId: string): BrowserEmitter {
  const append = (kind: BrowserEventKind, payload: Record<string, unknown>): void => {
    // No channel yet → drop rather than throw mid-navigation; once a terminal
    // frame lands the pubsub discards further appends on its own.
    if (!pubsub.has(runId)) return;
    pubsub.append(runId, { kind, payload });
  };

  return {
    opened(url?: string): void {
      append("browser.opened", url === undefined ? {} : { url });
    },
    action(type: string, target: string, screenshotB64?: string): void {
      append(
        "browser.action",
        screenshotB64 === undefined
          ? { type, target }
          : { type, target, screenshot_b64: screenshotB64 },
      );
    },
    error(message: string, screenshotB64?: string): void {
      append(
        "browser.error",
        screenshotB64 === undefined
          ? { message }
          : { message, screenshot_b64: screenshotB64 },
      );
    },
    closed(): void {
      append("browser.closed", {});
    },
  };
}
