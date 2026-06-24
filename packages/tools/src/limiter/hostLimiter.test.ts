/**
 * Per-host politeness limiter — the PROCESS-GLOBAL throttle shared across every
 * profile's browser scans: per-host min-interval spacing (+ jitter), a per-host
 * concurrency cap, and an honored robots Crawl-delay. Deterministic via an
 * injected VirtualClock + rand + a fake robots fetcher (no network).
 */

import { describe, expect, it } from "vitest";

import { VirtualClock } from "./clock.js";
import { HostPolitenessLimiter } from "./hostLimiter.js";
import { parseCrawlDelaySeconds } from "./robots.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("parseCrawlDelaySeconds — honored (unlike Disallow)", () => {
  it("reads Crawl-delay from the star group", () => {
    expect(parseCrawlDelaySeconds("User-agent: *\nCrawl-delay: 5")).toBe(5);
    expect(parseCrawlDelaySeconds("User-agent: *\nCrawl-delay: 2.5")).toBe(2.5);
  });
  it("ignores a non-star group's crawl-delay", () => {
    expect(parseCrawlDelaySeconds("User-agent: BadBot\nCrawl-delay: 30")).toBeNull();
  });
  it("null when absent or invalid", () => {
    expect(parseCrawlDelaySeconds("User-agent: *\nDisallow: /x")).toBeNull();
    expect(parseCrawlDelaySeconds("User-agent: *\nCrawl-delay: nope")).toBeNull();
  });
});

describe("HostPolitenessLimiter — per-host concurrency cap (shared across callers)", () => {
  it("never runs more than the cap of requests to one host at once", async () => {
    const clock = new VirtualClock(0);
    const limiter = new HostPolitenessLimiter({
      clock,
      rand: () => 0.5, // zero jitter
      minIntervalMs: 0, // isolate the concurrency cap from spacing
      maxConcurrentPerHost: 2,
      fetchRobots: async () => null,
    });
    let active = 0;
    let maxActive = 0;
    const releasers: Array<() => void> = [];
    const fn = () =>
      new Promise<void>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releasers.push(() => {
          active -= 1;
          resolve();
        });
      });

    const url = "https://dealer.example.com/inventory";
    const all = Array.from({ length: 5 }, () => limiter.runHostRequest(url, fn));
    await tick();
    expect(active).toBe(2);
    while (releasers.length > 0) {
      releasers.shift()!();
      await tick();
    }
    await Promise.all(all);
    expect(maxActive).toBe(2);
  });

  it("requests to DIFFERENT hosts do not block each other", async () => {
    const clock = new VirtualClock(0);
    const limiter = new HostPolitenessLimiter({
      clock,
      rand: () => 0.5,
      minIntervalMs: 0,
      maxConcurrentPerHost: 1,
      fetchRobots: async () => null,
    });
    let active = 0;
    let maxActive = 0;
    const releasers: Array<() => void> = [];
    const fn = () =>
      new Promise<void>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releasers.push(() => {
          active -= 1;
          resolve();
        });
      });

    const all = [
      limiter.runHostRequest("https://a.example.com/x", fn),
      limiter.runHostRequest("https://b.example.com/y", fn),
    ];
    await tick();
    expect(maxActive).toBe(2); // distinct hosts → both run despite per-host cap 1
    releasers.forEach((r) => r());
    await Promise.all(all);
  });
});

describe("HostPolitenessLimiter — min-interval spacing (shared across profiles)", () => {
  it("spaces two requests to the same host by the min interval", async () => {
    const clock = new VirtualClock(0);
    const limiter = new HostPolitenessLimiter({
      clock,
      rand: () => 0.5, // zero jitter → exact min interval
      minIntervalMs: 2000,
      maxConcurrentPerHost: 2,
      fetchRobots: async () => null,
    });
    const firedAt: number[] = [];
    const fn = () => {
      firedAt.push(clock.now());
      return Promise.resolve();
    };
    const url = "https://dealer.example.com/srp";
    const all = [limiter.runHostRequest(url, fn), limiter.runHostRequest(url, fn)];
    await tick();
    expect(firedAt).toEqual([0]); // first immediate, second paced
    await clock.advance(2000);
    await Promise.all(all);
    expect(firedAt).toEqual([0, 2000]);
  });

  it("spaces 3+ concurrent same-host requests by the interval (cap admits 2 — no collapse)", async () => {
    // The spacing floor must hold by construction, not only when traffic happens
    // to serialize. With cap 2, a freed slot lets a queued request reuse it while
    // a sibling is still pacing; both must chain off the reserved next-instant,
    // never race the same stale timestamp (the collapse the buggy read-then-write
    // produced: e.g. [0, 2000, 2000, 4000]).
    const clock = new VirtualClock(0);
    const limiter = new HostPolitenessLimiter({
      clock,
      rand: () => 0.5, // zero jitter → exact interval boundaries
      minIntervalMs: 2000,
      maxConcurrentPerHost: 2,
      fetchRobots: async () => null,
    });
    const firedAt: number[] = [];
    const fn = () => {
      firedAt.push(clock.now());
      return Promise.resolve();
    };
    const url = "https://busy.example.com/srp";
    const all = [0, 1, 2, 3].map(() => limiter.runHostRequest(url, fn));
    await tick();
    for (let t = 0; t < 12000; t += 2000) await clock.advance(2000);
    await Promise.all(all);

    const sorted = [...firedAt].sort((a, b) => a - b);
    expect(sorted).toHaveLength(4);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(2000);
    }
  });

  it("honors a robots Crawl-delay as the spacing floor (max with min interval)", async () => {
    const clock = new VirtualClock(0);
    const limiter = new HostPolitenessLimiter({
      clock,
      rand: () => 0.5,
      minIntervalMs: 2000,
      maxConcurrentPerHost: 2,
      fetchRobots: async () => "User-agent: *\nCrawl-delay: 5", // 5s > 2s min
    });
    const firedAt: number[] = [];
    const fn = () => {
      firedAt.push(clock.now());
      return Promise.resolve();
    };
    const url = "https://slow.example.com/page";
    const all = [limiter.runHostRequest(url, fn), limiter.runHostRequest(url, fn)];
    await tick();
    expect(firedAt).toEqual([0]);
    await clock.advance(2000);
    expect(firedAt).toEqual([0]); // still waiting — crawl-delay is 5s, not 2s
    await clock.advance(3000);
    await Promise.all(all);
    expect(firedAt).toEqual([0, 5000]);
  });
});

describe("HostPolitenessLimiter — robots (recorded-only Disallow, cached per origin)", () => {
  it("fetches robots once per origin and answers the Disallow question", async () => {
    const clock = new VirtualClock(0);
    let fetches = 0;
    const limiter = new HostPolitenessLimiter({
      clock,
      fetchRobots: async () => {
        fetches += 1;
        return "User-agent: *\nDisallow: /private";
      },
    });
    expect(await limiter.robotsDisallowed("https://x.example.com/private/page")).toBe(true);
    expect(await limiter.robotsDisallowed("https://x.example.com/public")).toBe(false);
    expect(fetches).toBe(1); // cached per origin
  });

  it("a failed robots fetch is no signal (allow)", async () => {
    const clock = new VirtualClock(0);
    const limiter = new HostPolitenessLimiter({ clock, fetchRobots: async () => null });
    expect(await limiter.robotsDisallowed("https://y.example.com/anything")).toBe(false);
  });
});
