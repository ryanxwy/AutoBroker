/**
 * LimiterRegistry — process-global resource arbiters that PACE execution of
 * already-approved work, keyed by the contended SHARED resource (not by
 * profile). Every limiter sits BELOW the L2 approval gate: the gate decides
 * whether an action may happen at all; these only decide how fast a stream of
 * already-approved actions drains so N concurrent pipelines don't hammer one
 * Gmail account, one dealer host, or one LLM provider.
 *
 * These are module-level singletons (a single-user local app — no Redis; the
 * GCRA TAT value and bucket counters live fine in-process). Tests construct
 * their own instances with a VirtualClock and never touch these globals.
 *
 * Dependency wall: pure within tools.
 */

import { GmailSendLimiter } from "./gmailLimiter.js";
import { HostPolitenessLimiter } from "./hostLimiter.js";
import { LlmRateLimiter } from "./llmLimiter.js";

export * from "./clock.js";
export * from "./primitives.js";
export * from "./robots.js";
export * from "./gmailLimiter.js";
export * from "./hostLimiter.js";
export * from "./llmLimiter.js";

/** The ONE Gmail account, shared across every profile's sends. */
export const gmailLimiter = new GmailSendLimiter();

/** Per-dealer-HOST politeness, shared across every profile's browser scans. */
export const hostLimiter = new HostPolitenessLimiter();

/** Per-provider LLM pacing (deepseek / anthropic / openai), shared across every
 *  profile's model calls. */
export const llmLimiter = new LlmRateLimiter();
