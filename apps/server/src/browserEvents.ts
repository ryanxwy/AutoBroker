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
 *
 * SCREENSHOTS NEVER ENTER THE LOG: a frame carrying a screenshot is published
 * as TWO frames — the pure {type,target}/{message} twin goes through the normal
 * logged append (the activity trail stays replayable), and the screenshot-
 * bearing frame goes through the fan-out-only appendTransient (live readers
 * only, never the backlog). That closes every replay surface for the base64
 * payload at the source; the legacy /stream live writer additionally strips
 * any screenshot field as a belt (routes.ts).
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

  /** Publish a frame whose payload may carry a screenshot: the pure payload is
   *  appended (logged + fanned out, replayable), and when a screenshot is
   *  present its full payload ADDITIONALLY rides the fan-out-only path — live
   *  subscribers see the screenshot once; no replay surface ever does. */
  const appendWithScreenshot = (
    kind: BrowserEventKind,
    pure: Record<string, unknown>,
    screenshotB64: string | undefined,
  ): void => {
    if (!pubsub.has(runId)) return;
    pubsub.append(runId, { kind, payload: pure });
    if (screenshotB64 !== undefined) {
      pubsub.appendTransient(runId, {
        kind,
        payload: { ...pure, screenshot_b64: screenshotB64 },
      });
    }
  };

  return {
    opened(url?: string): void {
      append("browser.opened", url === undefined ? {} : { url });
    },
    action(type: string, target: string, screenshotB64?: string): void {
      appendWithScreenshot("browser.action", { type, target }, screenshotB64);
    },
    error(message: string, screenshotB64?: string): void {
      appendWithScreenshot("browser.error", { message }, screenshotB64);
    },
    closed(): void {
      append("browser.closed", {});
    },
  };
}
