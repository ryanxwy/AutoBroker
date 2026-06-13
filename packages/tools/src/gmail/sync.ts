/**
 * Gmail incremental sync — the historyId watermark + history.list polling +
 * stale-404 → full-resync mechanics. This is the engine the inbox skill (E1)
 * drives to learn "which messages changed since I last looked" cheaply, without
 * re-listing the whole mailbox every poll.
 *
 * C1 (the disjoint-arm boundary): this module operates ONLY on the injected
 * `GmailAdapter` interface — it `import type`s the contract from ./types.js and
 * NEVER value-imports a concrete backend (adapter.ts / fakeAdapter.ts). The
 * adapter is always passed in. That keeps sync orthogonal to whichever backend
 * is live, so the real arm, the fake arm, and this arm build in parallel and the
 * unit test can drive a bare in-memory stub.
 *
 * SQLITE INVARIANT (CLAUDE.md "The SQLite / external-API invariant"):
 *   The per-mailbox historyId watermark is one pipeline_state row reached through
 *   the raw better-sqlite3 client (db.$client), exactly like the scheduler
 *   watermark — tools never imports drizzle-orm. The product DB is touched only
 *   here in the tools layer; consumers above call these accessors.
 *
 * FALLBACK CLASSIFICATION: a 404 on a stale start historyId is EXPECTED (Gmail
 * expires history after a window) and the documented recovery is a full resync.
 * That is a TRANSIENT / equivalent-read fallback — auto-allowed, never a suspend,
 * never an error — but it MUST be voiced. Sync is a pure tools-layer engine with
 * no emitter, so it RETURNS the fallback span in its result; the workflow
 * consumer voices it through its own emitter (the gate-renders-before-prose
 * rule). Silent recovery is forbidden.
 *
 * WATERMARK SCOPE: the store is keyed per mailbox so the schema is ready for a
 * per-mailbox watermark, but the inbox skill currently passes a single mailbox
 * key (global watermark). Sync just advances/returns the value — it makes no
 * assumption about how many mailboxes the caller tracks.
 */

import { getDb, type Db } from "@autobroker/db";

import type { GmailAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// historyId watermark store — one pipeline_state row per mailbox
// ---------------------------------------------------------------------------

/** The pipeline_state key for a mailbox's last-synced historyId watermark. */
export function historyWatermarkKey(mailbox: string): string {
  return `gmail.history_id.${mailbox}`;
}

const SELECT_WATERMARK = "SELECT value FROM pipeline_state WHERE key = ?";
// pipeline_state.key is the PRIMARY KEY — upsert so each advance overwrites the
// prior watermark (exactly one historyId row per mailbox).
const UPSERT_WATERMARK =
  "INSERT INTO pipeline_state (key, value) VALUES (?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value";

/** Read a mailbox's stored historyId watermark. A missing row is `null`
 *  ("never synced") — the caller must full-resync to learn the starting floor. */
export function readHistoryWatermark(mailbox: string, db: Db = getDb()): string | null {
  const row = db.$client.prepare(SELECT_WATERMARK).get(historyWatermarkKey(mailbox)) as
    | { value: string | null }
    | undefined;
  const raw = row?.value;
  return raw === undefined || raw === null || raw === "" ? null : raw;
}

/** Persist a mailbox's historyId watermark. Upsert on the mailbox key so a later
 *  sync overwrites the earlier value — one watermark row per mailbox. */
export function writeHistoryWatermark(mailbox: string, historyId: string, db: Db = getDb()): void {
  db.$client.prepare(UPSERT_WATERMARK).run(historyWatermarkKey(mailbox), historyId);
}

// ---------------------------------------------------------------------------
// computeWindow — the search-window predicate E1 consumes on a resync
// ---------------------------------------------------------------------------

/**
 * The Gmail-search relative window string for "everything since the last check".
 * Pure: no clock, both endpoints passed in (epoch-ms).
 *
 *   - never checked (lastCheckMs === null) → "2d" (a fixed first-run lookback);
 *   - else: the elapsed delta + a 1h safety buffer, rounded UP to whole hours,
 *     expressed as "Nh" when ≤ 24h else ceil-to-days "Nd".
 *
 * The buffer + round-up guarantee the window never undershoots the true gap
 * (Gmail's `newer_than` is whole-unit and inclusive-leaning), so a message that
 * arrived right at the boundary is never missed. Microsecond precision is
 * irrelevant here — the unit floor is the hour.
 */
export function computeWindow(lastCheckMs: number | null, nowMs: number): string {
  if (lastCheckMs === null) return "2d";
  const MS_PER_HOUR = 3_600_000;
  const MS_PER_DAY = 86_400_000;
  const deltaMs = Math.max(0, nowMs - lastCheckMs);
  const bufferedMs = deltaMs + MS_PER_HOUR;
  const hours = Math.ceil(bufferedMs / MS_PER_HOUR);
  if (hours <= 24) return `${hours}h`;
  const days = Math.ceil(bufferedMs / MS_PER_DAY);
  return `${days}d`;
}

// ---------------------------------------------------------------------------
// syncMailbox — incremental history + 404 → full resync
// ---------------------------------------------------------------------------

/** The transient fallback the sync recorded, for the consumer to voice. The only
 *  case today is the stale-historyId full resync. */
export interface SyncFallbackSpan {
  kind: "history_expired_full_resync";
  detail: string;
}

/** The outcome of one sync pass. `changedMessageIds` is what the caller then runs
 *  its local relevance predicate over; `historyId` is the advanced watermark
 *  (also persisted); `fullResync` flags that history was expired so the caller
 *  treats `changedMessageIds` as a full window read, not a delta; `fallback` (when
 *  present) is the voiced transient span. */
export interface SyncResult {
  changedMessageIds: string[];
  historyId: string;
  fullResync: boolean;
  fallback: SyncFallbackSpan | null;
}

/** Options for a sync pass. `resyncWindow` is the Gmail-search query used when a
 *  full resync is forced (caller computes it via `computeWindow`). */
export interface SyncOptions {
  /** Search query for the full-resync read (e.g. `newer_than:2d`). */
  resyncWindow: string;
  db?: Db;
}

/**
 * Run one incremental sync against the injected adapter:
 *
 *   1. read the stored watermark for `mailbox`;
 *   2. NO stored watermark → full resync (first sync ever);
 *   3. else `adapter.historyList(watermark)`:
 *        - expired (Gmail 404) → full resync + record the voiced fallback span;
 *        - else collect the delta message ids and advance to `newHistoryId`;
 *   4. persist the advanced watermark, return the result.
 *
 * A full resync reads the window via `adapter.search(resyncWindow)` and flattens
 * the matched threads' message ids; it advances the watermark to the value
 * returned by `adapter.getCurrentHistoryId()` so a subsequent incremental pass
 * has a valid floor.
 */
export async function syncMailbox(
  adapter: GmailAdapter,
  mailbox: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const db = opts.db ?? getDb();
  const stored = readHistoryWatermark(mailbox, db);

  // First sync ever — no watermark to diff against → full resync, but this is
  // the expected cold-start, NOT a fallback (nothing went stale).
  if (stored === null) {
    const result = await fullResync(adapter, opts, null);
    writeHistoryWatermark(mailbox, result.historyId, db);
    return result;
  }

  const page = await adapter.historyList(stored);

  if (page.expired) {
    // Stale watermark — Gmail expired the history. The documented recovery is a
    // full resync; auto-allowed transient fallback, voiced via the returned span.
    const span: SyncFallbackSpan = {
      kind: "history_expired_full_resync",
      detail: `gmail historyId ${stored} expired for ${mailbox}; recovered via full resync`,
    };
    const result = await fullResync(adapter, opts, span);
    writeHistoryWatermark(mailbox, result.historyId, db);
    return result;
  }

  // Incremental delta — flatten the changed message ids and advance the
  // watermark to the page's newest historyId (fall back to the stored value when
  // the backend reports nothing new, so the watermark never goes backwards).
  const changedMessageIds = dedupe(page.records.flatMap((r) => r.messageIds));
  const historyId = page.newHistoryId ?? stored;
  writeHistoryWatermark(mailbox, historyId, db);
  return { changedMessageIds, historyId, fullResync: false, fallback: null };
}

/** Full-window read via search — used on cold start and on history-expired
 *  recovery. Advances the watermark to the adapter's current historyId floor. */
async function fullResync(
  adapter: GmailAdapter,
  opts: SyncOptions,
  fallback: SyncFallbackSpan | null,
): Promise<SyncResult> {
  const threads = await adapter.search(opts.resyncWindow);
  const changedMessageIds = dedupe(threads.flatMap((t) => t.messageIds));
  // A search returns threads, not a historyId. Ask the adapter for the
  // mailbox's current historyId floor — the correct watermark for a subsequent
  // incremental historyList pass (a Gmail historyId is an opaque server id,
  // not a timestamp).
  const historyId = await adapter.getCurrentHistoryId();
  return { changedMessageIds, historyId, fullResync: true, fallback };
}

/** Stable de-dup preserving first-seen order. */
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
