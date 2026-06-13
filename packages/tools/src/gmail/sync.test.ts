/**
 * L1 unit tests — the Gmail sync engine, driven against a BARE in-test adapter
 * stub (NOT the fake-mailbox backend — a minimal object satisfying the
 * GmailAdapter interface). Pure/deterministic, no network. Freezes:
 *   - cold start (no watermark) → full resync, watermark advances + persists;
 *   - an incremental historyList delta advances the watermark and returns the
 *     changed message ids deduped in order;
 *   - a stale watermark (page.expired, Gmail 404) → full resync, the voiced
 *     transient fallback span is RETURNED (never silent, never an error);
 *   - the watermark never goes backwards when a delta reports no newHistoryId;
 *   - the computeWindow predicate table (first-run, sub-day, multi-day);
 *   - C1: sync.ts has NO value-import of a concrete adapter (interface-only).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. NEVER touches ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import type {
  AttachmentData,
  AttachmentRef,
  GmailAdapter,
  HealthResult,
  HistoryPage,
  Message,
  Thread,
  ThreadRef,
} from "./types.js";
import {
  computeWindow,
  historyWatermarkKey,
  readHistoryWatermark,
  syncMailbox,
  writeHistoryWatermark,
} from "./sync.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-gmail-sync-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  db.$client.prepare("DELETE FROM pipeline_state").run();
});

// ---------------------------------------------------------------------------
// A bare in-test adapter stub — the minimal GmailAdapter the sync engine needs.
// Records every call so the test can assert which path ran. Read methods return
// scripted fixtures; mutation/attachment/health paths are unused by sync and
// throw if ever touched (they would signal sync reaching past its contract).
// ---------------------------------------------------------------------------

interface StubScript {
  /** What `historyList(startId)` returns, keyed by the start watermark passed. */
  history: Record<string, HistoryPage>;
  /** Thread refs the resync `search` returns. */
  searchThreads: ThreadRef[];
}

class StubAdapter implements GmailAdapter {
  searchCalls: string[] = [];
  historyCalls: string[] = [];

  constructor(private readonly script: StubScript) {}

  search(query: string): Promise<ThreadRef[]> {
    this.searchCalls.push(query);
    return Promise.resolve(this.script.searchThreads);
  }

  historyList(startHistoryId: string): Promise<HistoryPage> {
    this.historyCalls.push(startHistoryId);
    const page = this.script.history[startHistoryId];
    if (page === undefined) {
      throw new Error(`stub: no scripted historyList for start ${startHistoryId}`);
    }
    return Promise.resolve(page);
  }

  getThread(): Promise<Thread> {
    throw new Error("stub: getThread not used by sync");
  }
  getMessage(): Promise<Message> {
    throw new Error("stub: getMessage not used by sync");
  }
  downloadAttachment(_id: string, _ref: AttachmentRef): Promise<AttachmentData> {
    throw new Error("stub: downloadAttachment not used by sync");
  }
  send(): Promise<{ messageId: string }> {
    throw new Error("stub: send not used by sync");
  }
  health(): Promise<HealthResult> {
    throw new Error("stub: health not used by sync");
  }

  getCurrentHistoryId(): Promise<string> {
    return Promise.resolve("99999");
  }
}

describe("computeWindow", () => {
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  it("never checked → fixed 2d first-run lookback", () => {
    expect(computeWindow(null, Date.now())).toBe("2d");
  });

  it("a sub-hour gap rounds up past the 1h buffer to 2h", () => {
    const now = 10 * HOUR;
    expect(computeWindow(now - 30 * 60_000, now)).toBe("2h");
  });

  it("a multi-hour gap (≤24h) is expressed in hours, buffer included", () => {
    const now = 100 * HOUR;
    // 5h elapsed + 1h buffer = 6h
    expect(computeWindow(now - 5 * HOUR, now)).toBe("6h");
  });

  it("a multi-day gap ceils to whole days", () => {
    const now = 10 * DAY;
    // 3d elapsed + 1h buffer → ceil to 4d
    expect(computeWindow(now - 3 * DAY, now)).toBe("4d");
  });

  it("a future/equal lastCheck clamps the delta to the buffer floor (1h)", () => {
    const now = 5 * HOUR;
    expect(computeWindow(now, now)).toBe("1h");
    expect(computeWindow(now + HOUR, now)).toBe("1h");
  });
});

describe("historyId watermark store", () => {
  it("a never-synced mailbox reads as null", () => {
    expect(readHistoryWatermark("acct@x.test", db)).toBeNull();
  });

  it("a written watermark round-trips and upserts (one row per mailbox)", () => {
    writeHistoryWatermark("acct@x.test", "1000", db);
    writeHistoryWatermark("acct@x.test", "2000", db);
    expect(readHistoryWatermark("acct@x.test", db)).toBe("2000");
    const row = db.$client
      .prepare("SELECT COUNT(*) AS n FROM pipeline_state WHERE key = ?")
      .get(historyWatermarkKey("acct@x.test")) as { n: number };
    expect(row.n).toBe(1);
  });

  it("two mailboxes use distinct keys and never collide", () => {
    writeHistoryWatermark("a@x.test", "1000", db);
    writeHistoryWatermark("b@x.test", "2000", db);
    expect(readHistoryWatermark("a@x.test", db)).toBe("1000");
    expect(readHistoryWatermark("b@x.test", db)).toBe("2000");
    expect(historyWatermarkKey("a@x.test")).not.toBe(historyWatermarkKey("b@x.test"));
  });
});

describe("syncMailbox", () => {
  const MAILBOX = "owner@x.test";

  it("cold start (no watermark) → full resync, watermark advances + persists", async () => {
    const adapter = new StubAdapter({
      history: {},
      searchThreads: [{ threadId: "t1", messageIds: ["m1", "m2"] }],
    });
    const result = await syncMailbox(adapter, MAILBOX, { resyncWindow: "2d" });

    expect(result.fullResync).toBe(true);
    expect(result.fallback).toBeNull();
    expect(result.changedMessageIds).toEqual(["m1", "m2"]);
    expect(adapter.searchCalls).toEqual(["2d"]);
    expect(adapter.historyCalls).toEqual([]); // no watermark → never asks history
    // watermark comes from adapter.getCurrentHistoryId()
    expect(result.historyId).toBe("99999");
    expect(readHistoryWatermark(MAILBOX, db)).toBe("99999");
  });

  it("an incremental delta advances the watermark and dedupes changed ids in order", async () => {
    writeHistoryWatermark(MAILBOX, "100", db);
    const adapter = new StubAdapter({
      history: {
        "100": {
          expired: false,
          newHistoryId: "175",
          records: [{ messageIds: ["m9", "m10"] }, { messageIds: ["m10", "m11"] }],
        },
      },
      searchThreads: [],
    });
    const result = await syncMailbox(adapter, MAILBOX, { resyncWindow: "2d" });

    expect(result.fullResync).toBe(false);
    expect(result.fallback).toBeNull();
    expect(result.changedMessageIds).toEqual(["m9", "m10", "m11"]); // deduped, ordered
    expect(adapter.historyCalls).toEqual(["100"]);
    expect(adapter.searchCalls).toEqual([]); // incremental → no resync search
    expect(result.historyId).toBe("175");
    expect(readHistoryWatermark(MAILBOX, db)).toBe("175");
  });

  it("a stale watermark (expired 404) → full resync + the voiced fallback span", async () => {
    writeHistoryWatermark(MAILBOX, "50", db);
    const adapter = new StubAdapter({
      history: {
        "50": { expired: true, newHistoryId: null, records: [] },
      },
      searchThreads: [{ threadId: "tA", messageIds: ["mA"] }],
    });
    const result = await syncMailbox(adapter, MAILBOX, { resyncWindow: "3d" });

    expect(result.fullResync).toBe(true);
    expect(result.changedMessageIds).toEqual(["mA"]);
    // the transient fallback is RETURNED for the consumer to voice — not silent.
    expect(result.fallback).not.toBeNull();
    expect(result.fallback?.kind).toBe("history_expired_full_resync");
    expect(result.fallback?.detail).toContain("50");
    expect(result.fallback?.detail).toContain(MAILBOX);
    // recovery path: asked history first (got 404), then resynced via search.
    expect(adapter.historyCalls).toEqual(["50"]);
    expect(adapter.searchCalls).toEqual(["3d"]);
    // watermark comes from adapter.getCurrentHistoryId()
    expect(readHistoryWatermark(MAILBOX, db)).toBe("99999");
  });

  it("a delta reporting no newHistoryId keeps the watermark (never backwards)", async () => {
    writeHistoryWatermark(MAILBOX, "200", db);
    const adapter = new StubAdapter({
      history: {
        "200": { expired: false, newHistoryId: null, records: [] },
      },
      searchThreads: [],
    });
    const result = await syncMailbox(adapter, MAILBOX, { resyncWindow: "2d" });

    expect(result.fullResync).toBe(false);
    expect(result.changedMessageIds).toEqual([]);
    expect(result.historyId).toBe("200");
    expect(readHistoryWatermark(MAILBOX, db)).toBe("200");
  });
});

describe("C1 — sync.ts imports the adapter interface only (no concrete backend)", () => {
  it("sync.ts has no value-import of adapter.ts / fakeAdapter.ts", () => {
    const src = readFileSync(join(here, "sync.ts"), "utf8");
    // The only reference to ./types.js is an `import type` (the interface).
    // There must be NO value import naming a concrete adapter module.
    expect(src).not.toMatch(/import\s+(?!type\b)[^;]*from\s+["']\.\/adapter\.js["']/);
    expect(src).not.toMatch(/import\s+(?!type\b)[^;]*from\s+["']\.\/fakeAdapter\.js["']/);
    expect(src).not.toMatch(/from\s+["']\.\/adapter\.js["']/);
    expect(src).not.toMatch(/from\s+["']\.\/fakeAdapter\.js["']/);
    // No dynamic import() of the concrete adapters either.
    expect(src).not.toMatch(/import\(\s*["']\.\/adapter\.js["']/);
    expect(src).not.toMatch(/import\(\s*["']\.\/fakeAdapter\.js["']/);
    expect(src).not.toMatch(/require\(\s*["']\.\/adapter\.js["']/);
    expect(src).not.toMatch(/require\(\s*["']\.\/fakeAdapter\.js["']/);
    // The contract is pulled in type-only.
    expect(src).toMatch(/import\s+type\s+\{[^}]*GmailAdapter[^}]*\}\s+from\s+["']\.\/types\.js["']/);
  });
});
