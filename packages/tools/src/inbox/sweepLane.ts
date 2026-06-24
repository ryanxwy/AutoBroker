/**
 * The ONE authoritative inbox sweep lane. The mailbox historyId cursor
 * (`gmail.history_id.<mailbox>`) is a SINGLE shared resource: when N per-profile
 * inbox checks ran in parallel, each advanced it independently and the cursor
 * could LEAPFROG — silently dropping a dealer reply that one run consumed from
 * the delta but another never saw.
 *
 * This lane serializes + single-flight COALESCES the advance per mailbox: a
 * concurrent burst of callers shares ONE sweep (the cursor advances exactly
 * once) and every caller receives the same full changed set, so no profile is
 * skipped. The widest `resyncWindow` among the coalesced callers is used so a
 * full-resync never under-reads for a profile with a longer look-back. Back-to-
 * back (non-overlapping) sweeps each run their own advance, serialized.
 *
 * It deliberately does NOT write thread_routing on discovery — the per-profile
 * binding still rides the approve-time applyInboxBatch transaction (decline =
 * zero-write, and the single-profile path stays byte-identical). The "fan-out to
 * per-profile thread_routing" is the existing per-profile route+approve, now fed
 * correctly because every profile sees the full set from one cursor advance.
 *
 * Dependency wall: tools-only (wraps ../gmail/sync.js).
 */

import { syncMailbox, type SyncOptions, type SyncResult } from "../gmail/sync.js";
import type { GmailAdapter } from "../gmail/types.js";

export type SyncFn = (
  adapter: GmailAdapter,
  mailbox: string,
  opts: SyncOptions,
) => Promise<SyncResult>;

/** Parse a `newer_than:<N><h|d>` resync window to milliseconds (0 when absent /
 *  unparseable, so it never wins the widest-window comparison). */
function resyncWindowMs(resyncWindow: string): number {
  const m = /newer_than:(\d+)([hd])/.exec(resyncWindow);
  if (m === null) return 0;
  const n = Number(m[1]);
  return m[2] === "d" ? n * 86_400_000 : n * 3_600_000;
}

interface PendingBatch {
  promise: Promise<SyncResult>;
  resolve: (r: SyncResult) => void;
  reject: (e: unknown) => void;
  windowMs: number;
  syncFn: SyncFn;
  adapter: GmailAdapter;
  opts: SyncOptions;
}

interface Lane {
  /** The batch accumulating callers that will share the NEXT advance. */
  pending: PendingBatch | null;
  /** Tail of the serialized advances — the next batch runs after it settles. */
  running: Promise<unknown>;
}

const lanes = new Map<string, Lane>();

function getLane(mailbox: string): Lane {
  let lane = lanes.get(mailbox);
  if (lane === undefined) {
    lane = { pending: null, running: Promise.resolve() };
    lanes.set(mailbox, lane);
  }
  return lane;
}

/**
 * Advance the `mailbox` cursor through the lane. `syncFn` is the actual sync
 * (the real `syncMailbox`, or a test fake). Concurrent callers for the same
 * mailbox coalesce onto one advance; the widest window wins.
 */
export function authoritativeSweep(
  syncFn: SyncFn,
  adapter: GmailAdapter,
  mailbox: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const lane = getLane(mailbox);
  const windowMs = resyncWindowMs(opts.resyncWindow);

  if (lane.pending !== null) {
    // Join the forming batch; widen to the larger look-back if ours is bigger.
    if (windowMs > lane.pending.windowMs) {
      lane.pending.windowMs = windowMs;
      lane.pending.syncFn = syncFn;
      lane.pending.adapter = adapter;
      lane.pending.opts = opts;
    }
    return lane.pending.promise;
  }

  // Open a new batch.
  let resolve!: (r: SyncResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<SyncResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const batch: PendingBatch = { promise, resolve, reject, windowMs, syncFn, adapter, opts };
  lane.pending = batch;

  const prior = lane.running;
  lane.running = (async () => {
    // Serialize behind any in-flight advance for this mailbox.
    await prior.catch(() => undefined);
    // Let synchronous siblings finish joining this batch before we snapshot it.
    await Promise.resolve();
    lane.pending = null; // close the batch — later callers open the next one.
    try {
      const out = await batch.syncFn(batch.adapter, mailbox, batch.opts);
      batch.resolve(out);
    } catch (err) {
      batch.reject(err);
    }
  })();

  return promise;
}

/** Production entry: the real `syncMailbox`, lane-coalesced. Drop-in for the
 *  raw `syncMailbox` signature (so callers swap one for the other). */
export function sweepMailbox(
  adapter: GmailAdapter,
  mailbox: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  return authoritativeSweep(syncMailbox, adapter, mailbox, opts);
}
