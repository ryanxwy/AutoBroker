/**
 * Phase-1 verify gate (resource arbitration, integration): with N concurrent
 * "site scans" hammering OVERLAPPING dealer hosts and a combined Gmail send
 * stream, the shared arbiters hold their invariants together:
 *   - no host ever sees more than the per-host concurrency cap simultaneously;
 *   - the combined Gmail stream never exceeds 60/min (≥ 1s between sends).
 * Both arbiters are driven by ONE VirtualClock so the assertions are exact and
 * never depend on real elapsed time. (The process-global singletons in
 * ./index.ts are these same classes with the system clock.)
 */

import { describe, expect, it } from "vitest";

import { VirtualClock } from "./clock.js";
import { GmailSendLimiter } from "./gmailLimiter.js";
import { HostPolitenessLimiter } from "./hostLimiter.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("Phase 1 — shared-resource arbitration under concurrency", () => {
  it("3 concurrent scans over overlapping hosts never exceed the per-host concurrency cap", async () => {
    const clock = new VirtualClock(0);
    const host = new HostPolitenessLimiter({
      clock,
      rand: () => 0.5,
      minIntervalMs: 0, // isolate the concurrency cap from spacing
      maxConcurrentPerHost: 2,
      fetchRobots: async () => null,
    });

    // Two dealer hosts every scan hits — overlapping across all three scans.
    const HOSTS = ["dealer-a.example.com", "dealer-b.example.com"];
    const inFlight: Record<string, number> = {};
    const maxInFlight: Record<string, number> = {};
    const releasers: Array<() => void> = [];
    const navigate = (h: string) =>
      host.runHostRequest(`https://${h}/inventory`, () =>
        new Promise<void>((resolve) => {
          inFlight[h] = (inFlight[h] ?? 0) + 1;
          maxInFlight[h] = Math.max(maxInFlight[h] ?? 0, inFlight[h]!);
          releasers.push(() => {
            inFlight[h]! -= 1;
            resolve();
          });
        }),
      );

    // 3 scans × 2 hosts = 6 concurrent navigations over 2 overlapping hosts.
    const scans = [0, 1, 2].flatMap(() => HOSTS.map((h) => navigate(h)));
    await tick(); // cap (2) per host acquire; the 3rd per host queues.
    for (const h of HOSTS) expect(inFlight[h]).toBe(2);
    // Release one at a time; each freed slot lets a queued navigation start.
    while (releasers.length > 0) {
      releasers.shift()!();
      await tick();
    }
    await Promise.all(scans);

    for (const h of HOSTS) expect(maxInFlight[h]).toBeLessThanOrEqual(2);
    // The cap was actually exercised (≥1 host reached the cap of 2).
    expect(Math.max(...HOSTS.map((h) => maxInFlight[h] ?? 0))).toBe(2);
  });

  it("the combined Gmail stream of all scans never exceeds 60/min (≥1s apart)", async () => {
    const clock = new VirtualClock(0);
    const gmail = new GmailSendLimiter({ clock, emissionIntervalMs: 1000, burst: 1 });
    const sentAt: number[] = [];
    const send = () => gmail.runGmailSend(() => {
      sentAt.push(clock.now());
      return Promise.resolve("ok");
    });

    // 3 scans each enqueue 2 sends ⇒ 6 concurrent sends sharing one limiter.
    const all = Array.from({ length: 6 }, () => send());
    await tick();
    for (let t = 1000; t <= 5000; t += 1000) await clock.advance(1000);
    await Promise.all(all);

    expect(sentAt).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    // Every adjacent pair is ≥ the 1s emission interval ⇒ ≤ 60/min.
    for (let i = 1; i < sentAt.length; i += 1) {
      expect(sentAt[i]! - sentAt[i - 1]!).toBeGreaterThanOrEqual(1000);
    }
  });
});
