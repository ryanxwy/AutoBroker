/**
 * The serialized product-DB write lane — a process-global single-slot async
 * mutex (the "dedicated writer" the Phase-1 plan calls for).
 *
 * HONEST SCOPE (why this is narrow): a single better-sqlite3 `.run()` /
 * `.transaction()` is SYNCHRONOUS, so two of them can never interleave inside
 * one Node process (the event loop serializes them) and a transaction is atomic
 * — those writes need no lane. WAL + a generous `busy_timeout` (client.ts)
 * already handle a SEPARATE process/connection contending for the file.
 *
 * What a single connection can NOT make atomic on its own is a write SEQUENCE
 * that yields the event loop mid-way — `read → await (something async) → write`
 * — because a second such sequence can slip in at the await. `withWriteLane`
 * is the one funnel those multi-step async writes route through so the
 * concurrent multi-profile world (Phase 2) can't interleave them. It is
 * deliberately NOT wrapped around the existing ~25 synchronous write sites
 * (that would be redundant ceremony).
 *
 * Dependency wall: pure within tools.
 */

/** Tail of the write chain. Each queued write runs after the previous resolves
 *  (success OR failure — a rejection is swallowed HERE so one failed write never
 *  wedges the lane; the original rejection still propagates to its own caller). */
let tail: Promise<unknown> = Promise.resolve();

/** Run `fn` as the sole writer: it begins only after every previously-queued
 *  write sequence has fully settled, and the next queued write begins only after
 *  this one settles. FIFO. */
export function withWriteLane<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = tail.then(() => fn());
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
