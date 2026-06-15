/**
 * Listing-freshness bucketing — the pure classifier the digest's inventory
 * section reads. A listing's `last_seen_at` (epoch-ms) is compared to "now":
 *
 *   - fresh   — last seen within the last 24 hours.
 *   - stale   — last seen within the last 7 days (but older than 24h).
 *   - missing — last seen more than 7 days ago, OR never seen (null).
 *
 * Window edges are INCLUSIVE on the fresh/stale side (exactly 24h old is still
 * fresh; exactly 7d old is still stale) — the boundary belongs to the tighter
 * bucket. No SQLite, no clock read — `nowMs` is always passed in so the same
 * input always classifies the same way (deterministic, test-friendly).
 */

/** 24 hours in ms — the fresh window. */
export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 7 days in ms — the stale window (older than this, or null, is missing). */
export const STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type FreshnessBucket = "fresh" | "stale" | "missing";

/**
 * Bucket one listing's last-seen timestamp against `nowMs`. A null/absent
 * timestamp is "missing" (the listing fell out of every scan). A future
 * timestamp (clock skew) classifies as "fresh" — age is clamped at zero.
 */
export function bucketFreshness(lastSeenAtMs: number | null, nowMs: number): FreshnessBucket {
  if (lastSeenAtMs === null) return "missing";
  const ageMs = nowMs - lastSeenAtMs;
  if (ageMs <= FRESH_WINDOW_MS) return "fresh";
  if (ageMs <= STALE_WINDOW_MS) return "stale";
  return "missing";
}
