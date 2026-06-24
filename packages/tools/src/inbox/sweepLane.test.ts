/**
 * Authoritative inbox sweep lane — serializes + single-flight COALESCES the
 * mailbox-global historyId cursor advance so N concurrent per-profile inbox
 * checks advance it EXACTLY ONCE and every caller receives the full changed set
 * (no leapfrog race that silently drops a profile's reply). Deterministic via a
 * fake sync function (no real Gmail).
 */

import { describe, expect, it } from "vitest";

import type { SyncOptions, SyncResult } from "../gmail/sync.js";
import type { GmailAdapter } from "../gmail/types.js";
import { authoritativeSweep } from "./sweepLane.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const fakeAdapter = {} as GmailAdapter;

function result(over: Partial<SyncResult> = {}): SyncResult {
  return {
    changedMessageIds: ["m1", "m2"],
    historyId: "100",
    fullResync: false,
    fallback: null,
    ...over,
  };
}

describe("authoritativeSweep — coalesces a concurrent burst into ONE cursor advance", () => {
  it("a burst of concurrent callers triggers the sync exactly once; all get the full set", async () => {
    let calls = 0;
    const sync = async (): Promise<SyncResult> => {
      calls += 1;
      await tick();
      return result();
    };
    const opts: SyncOptions = { resyncWindow: "newer_than:2d" };
    const all = await Promise.all([
      authoritativeSweep(sync, fakeAdapter, "mb-burst", opts),
      authoritativeSweep(sync, fakeAdapter, "mb-burst", opts),
      authoritativeSweep(sync, fakeAdapter, "mb-burst", opts),
    ]);
    expect(calls).toBe(1); // cursor advanced ONCE for the whole burst
    expect(all[0]).toEqual(all[1]);
    expect(all[1]).toEqual(all[2]);
    expect(all[0]!.changedMessageIds).toEqual(["m1", "m2"]); // every caller sees the full set
  });

  it("sequential (non-overlapping) calls each run their own sweep", async () => {
    let calls = 0;
    const sync = async (): Promise<SyncResult> => {
      calls += 1;
      return result();
    };
    await authoritativeSweep(sync, fakeAdapter, "mb-seq", { resyncWindow: "newer_than:2d" });
    await authoritativeSweep(sync, fakeAdapter, "mb-seq", { resyncWindow: "newer_than:2d" });
    expect(calls).toBe(2);
  });

  it("a coalesced burst uses the WIDEST resync window among its callers", async () => {
    let received: string | undefined;
    const sync = async (_a: GmailAdapter, _m: string, opts: SyncOptions): Promise<SyncResult> => {
      received = opts.resyncWindow;
      await tick();
      return result();
    };
    await Promise.all([
      authoritativeSweep(sync, fakeAdapter, "mb-window", { resyncWindow: "newer_than:2d" }),
      authoritativeSweep(sync, fakeAdapter, "mb-window", { resyncWindow: "newer_than:5d" }),
      authoritativeSweep(sync, fakeAdapter, "mb-window", { resyncWindow: "newer_than:12h" }),
    ]);
    expect(received).toBe("newer_than:5d"); // widest wins → no profile under-reads
  });

  it("different mailboxes do not coalesce together", async () => {
    let calls = 0;
    const sync = async (): Promise<SyncResult> => {
      calls += 1;
      await tick();
      return result();
    };
    await Promise.all([
      authoritativeSweep(sync, fakeAdapter, "mb-A", { resyncWindow: "newer_than:2d" }),
      authoritativeSweep(sync, fakeAdapter, "mb-B", { resyncWindow: "newer_than:2d" }),
    ]);
    expect(calls).toBe(2); // distinct cursors → distinct sweeps
  });

  it("no profile's message is skipped when concurrent sweeps race the cursor", async () => {
    // A stateful mailbox: a cursor + an ordered log of changed message ids. A
    // real sync reads the delta after the stored cursor, then (after a network
    // yield — where the leapfrog race lived) advances the cursor to the head.
    let cursor = 0;
    let advances = 0;
    const log = ["mA", "mB", "mC"]; // one reply per profile A / B / C
    const syncFn = async (): Promise<SyncResult> => {
      const from = cursor;
      await tick(); // the yield two parallel sweeps used to race across
      cursor = log.length;
      advances += 1;
      return result({ changedMessageIds: log.slice(from), historyId: String(cursor) });
    };
    // Three profiles sweep the same mailbox concurrently.
    const all = await Promise.all([
      authoritativeSweep(syncFn, fakeAdapter, "mb-leap", { resyncWindow: "newer_than:2d" }),
      authoritativeSweep(syncFn, fakeAdapter, "mb-leap", { resyncWindow: "newer_than:2d" }),
      authoritativeSweep(syncFn, fakeAdapter, "mb-leap", { resyncWindow: "newer_than:2d" }),
    ]);
    // The cursor advanced ONCE, and EVERY profile sees the full delta — none of
    // A's, B's, or C's replies were leapfrogged.
    expect(advances).toBe(1);
    for (const r of all) expect(r.changedMessageIds).toEqual(["mA", "mB", "mC"]);
    expect(cursor).toBe(3);
  });

  it("a sweep error rejects every coalesced caller and does not wedge the lane", async () => {
    const boom = async (): Promise<SyncResult> => {
      await tick();
      throw new Error("history fetch failed");
    };
    const both = await Promise.allSettled([
      authoritativeSweep(boom, fakeAdapter, "mb-err", { resyncWindow: "newer_than:2d" }),
      authoritativeSweep(boom, fakeAdapter, "mb-err", { resyncWindow: "newer_than:2d" }),
    ]);
    expect(both[0]!.status).toBe("rejected");
    expect(both[1]!.status).toBe("rejected");
    // The lane is not wedged — a later sweep on the same mailbox runs.
    let ok = false;
    const sync = async (): Promise<SyncResult> => {
      ok = true;
      return result();
    };
    await authoritativeSweep(sync, fakeAdapter, "mb-err", { resyncWindow: "newer_than:2d" });
    expect(ok).toBe(true);
  });
});
