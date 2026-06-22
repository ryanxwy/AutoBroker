/**
 * L1 unit tests — the draft-then-promote outbound send+record writer. Proves the
 * four outcomes and the side-effect/row invariants, all against an isolated
 * throwaway DB with a fake spy adapter (no network, no real Gmail):
 *   - approve (fuse disarmed) → exactly one `messages` row, gmail id backfilled
 *     once;
 *   - decline → ZERO rows, adapter.send never called;
 *   - ARMED L1 fuse + approving approver → `blocked`, ZERO rows, send never
 *     called;
 *   - adapter.send throws → `partial`, the draft row survives with a NULL gmail
 *     id;
 *   - promote is double-fire-safe (a second promote is a no-op);
 *   - the reply double-flag invariant rejects exactly-one-of(threadId, replyId);
 *   - batch stops at the first failure, trailing targets write zero rows.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. NEVER touches ~/.autobroker or
 * ~/.autobroker-ts. The L1 fuse is DISARMED for every case except the one that
 * tests the armed fuse.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import type { Approver, GateRequest } from "../gate/index.js";
import type { GmailAdapter } from "./types.js";
import type { OutboundEmail } from "../gmail.js";
import {
  promoteOutbound,
  sendAndRecord,
  sendBatch,
  ThreadFlagMismatchError,
  type SendRecordTarget,
} from "./sendRecord.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const FUSE = "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS";
const MODE = "AUTOBROKER_MODE";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

const saved: Record<string, string | undefined> = {};
let tmpDir: string;
let db: Db;

function snapshotEnv(): void {
  for (const key of [DATA_DIR, FUSE, MODE]) saved[key] = process.env[key];
}
function restoreEnv(): void {
  for (const key of [DATA_DIR, FUSE, MODE]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

beforeEach(() => {
  snapshotEnv();
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-send-record-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[FUSE];
  process.env[MODE] = "test"; // test mode by default; the buyer test opts in
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  restoreEnv();
});

/** An approver that records every request and answers with a fixed verdict. */
function recordingApprover(verdict: boolean): Approver & { seen: GateRequest[] } {
  const seen: GateRequest[] = [];
  return {
    seen,
    decide(req: GateRequest): Promise<boolean> {
      seen.push(req);
      return Promise.resolve(verdict);
    },
  };
}

/** A plain spy adapter (kind "fake"). Used ONLY for paths where the send is
 *  never reached (decline, armed fuse) or where the preflight rejects it first
 *  (non-fake kind override) — the preflight checks `instanceof FakeGmailAdapter`,
 *  so the happy/partial paths use a real FakeGmailAdapter instead. Only `send` is
 *  exercised; read methods throw if touched. */
function spyFakeAdapter(): GmailAdapter & { sendCalls: string[] } {
  const sendCalls: string[] = [];
  const unused = () => {
    throw new Error("read path not expected in send-record tests");
  };
  return {
    sendCalls,
    kind: "fake",
    send(raw: string): Promise<{ messageId: string }> {
      sendCalls.push(raw);
      return Promise.resolve({ messageId: "fake-msg-1" });
    },
    search: unused,
    getThread: unused,
    getMessage: unused,
    downloadAttachment: unused,
    historyList: unused,
    getCurrentHistoryId: unused,
    health: unused,
  } as unknown as GmailAdapter & { sendCalls: string[] };
}

const EMAIL: OutboundEmail = {
  to: "sales@example-dealer.test",
  from: "buyer@example.test",
  subject: "Best out-the-door price request",
  body: "Please send your best out-the-door price for the listed vehicle.",
};

/** A top-level (new-thread) target: no threadId / no reply id. */
function topLevelTarget(): SendRecordTarget {
  return { email: EMAIL, threadId: null, searchProfileId: "profile-1" };
}

function messageRowCount(): number {
  const row = db.$client.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  return row.n;
}

describe("sendAndRecord", () => {
  // The preflight requires a genuine FakeGmailAdapter instance, so the happy and
  // partial paths build one against the isolated DB rather than the plain spy.

  it("approve + disarmed fuse → exactly one row, gmail id backfilled once", async () => {
    const { FakeGmailAdapter } = await import("./fakeAdapter.js");
    const adapter = new FakeGmailAdapter(db);
    const before = messageRowCount();

    const outcome = await sendAndRecord(topLevelTarget(), {
      approver: recordingApprover(true),
      runId: "run-1",
      adapter,
      db,
    });

    expect(outcome.kind).toBe("sent");
    expect(messageRowCount()).toBe(before + 1);
    if (outcome.kind !== "sent") throw new Error("unreachable");
    const row = db.$client
      .prepare("SELECT gmail_message_id, direction, gmail_message_id IS NOT NULL AS promoted FROM messages WHERE message_id = ?")
      .get(outcome.messageRowId) as { gmail_message_id: string | null; direction: string; promoted: number };
    expect(row.direction).toBe("outbound");
    expect(row.gmail_message_id).toBe(outcome.gmailMessageId);
    expect(row.promoted).toBe(1);
  });

  it("decline → ZERO rows, adapter.send never called", async () => {
    const adapter = spyFakeAdapter();
    const before = messageRowCount();

    const outcome = await sendAndRecord(topLevelTarget(), {
      approver: recordingApprover(false),
      runId: "run-2",
      adapter,
      db,
    });

    expect(outcome).toEqual({ kind: "declined", messageRowId: null });
    expect(messageRowCount()).toBe(before);
    expect(adapter.sendCalls).toHaveLength(0);
  });

  it("ARMED fuse + approving approver → blocked, ZERO rows, send never called", async () => {
    process.env[FUSE] = "1";
    const adapter = spyFakeAdapter();
    const before = messageRowCount();

    const outcome = await sendAndRecord(topLevelTarget(), {
      approver: recordingApprover(true),
      runId: "run-3",
      adapter,
      db,
    });

    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.messageRowId).toBeNull();
      expect(outcome.reconcile_hint).toBe("l1_fuse_blocked");
    }
    expect(messageRowCount()).toBe(before);
    expect(adapter.sendCalls).toHaveLength(0);
  });

  it("adapter.send throws → partial, draft row survives with NULL gmail id", async () => {
    const { FakeGmailAdapter } = await import("./fakeAdapter.js");
    const adapter = new FakeGmailAdapter(db);
    // Override send to throw AFTER the draft is inserted.
    Object.defineProperty(adapter, "send", {
      value: () => Promise.reject(new Error("injected send failure")),
    });
    const before = messageRowCount();

    const outcome = await sendAndRecord(topLevelTarget(), {
      approver: recordingApprover(true),
      runId: "run-4",
      adapter,
      db,
    });

    expect(outcome.kind).toBe("partial");
    expect(messageRowCount()).toBe(before + 1);
    if (outcome.kind !== "partial") throw new Error("unreachable");
    expect(outcome.partial).toEqual({
      message_recorded: true,
      state_updated: false,
      reconcile_hint: "send_failed_draft_retained",
      external_id: null,
    });
    const row = db.$client
      .prepare("SELECT gmail_message_id FROM messages WHERE message_id = ?")
      .get(outcome.messageRowId) as { gmail_message_id: string | null };
    expect(row.gmail_message_id).toBeNull();
  });

  it("TEST MODE: throws (fail closed) when in test mode and the adapter is not the fake — no draft written", async () => {
    // In test mode, a non-fake adapter fails the fake-only preflight, which runs
    // INSIDE the commit but BEFORE the draft insert → re-throws with zero state.
    process.env[MODE] = "test"; // test mode (explicit; also the beforeEach default)
    const notFake = spyFakeAdapter();
    Object.defineProperty(notFake, "kind", { value: "real" });
    const before = messageRowCount();

    await expect(
      sendAndRecord(topLevelTarget(), {
        approver: recordingApprover(true),
        runId: "run-5",
        adapter: notFake,
        db,
      }),
    ).rejects.toThrow();
    expect(messageRowCount()).toBe(before);
    expect(notFake.sendCalls).toHaveLength(0);
  });

  it("BUYER: in buyer mode, a real-kind adapter is ALLOWED — row written, send called", async () => {
    // Buyer-by-default: the fake-only preflight is skipped, so the resolved real
    // adapter proceeds (still only because the approver approved + the fuse is
    // disarmed). This is the real-send path the product now ships by default.
    delete process.env[FUSE]; // disarmed
    process.env[MODE] = "buyer"; // buyer mode
    const realish = spyFakeAdapter();
    Object.defineProperty(realish, "kind", { value: "real" });

    const outcome = await sendAndRecord(topLevelTarget(), {
      approver: recordingApprover(true),
      runId: "run-real",
      adapter: realish,
      db,
    });

    expect(outcome.kind).toBe("sent");
    expect(realish.sendCalls).toHaveLength(1);
    expect(messageRowCount()).toBe(1);
  });

  it("rejects exactly-one-of(threadId, inReplyToGmailId) — the reply double-flag", async () => {
    const adapter = spyFakeAdapter();
    await expect(
      sendAndRecord(
        { email: EMAIL, threadId: "thread-1", searchProfileId: "p", inReplyToGmailId: null },
        { approver: recordingApprover(true), runId: "run-6", adapter, db },
      ),
    ).rejects.toBeInstanceOf(ThreadFlagMismatchError);
    expect(adapter.sendCalls).toHaveLength(0);
  });
});

describe("promoteOutbound double-fire safety", () => {
  it("a second promote is a no-op (the NULL guard)", async () => {
    const { FakeGmailAdapter } = await import("./fakeAdapter.js");
    const adapter = new FakeGmailAdapter(db);
    const outcome = await sendAndRecord(topLevelTarget(), {
      approver: recordingApprover(true),
      runId: "run-7",
      adapter,
      db,
    });
    if (outcome.kind !== "sent") throw new Error("expected sent");

    // Re-promote with a different id — the WHERE gmail_message_id IS NULL guard
    // means the row is unchanged (still the first promoted id).
    promoteOutbound(db, outcome.messageRowId, "second-id-should-be-ignored");
    const row = db.$client
      .prepare("SELECT gmail_message_id FROM messages WHERE message_id = ?")
      .get(outcome.messageRowId) as { gmail_message_id: string | null };
    expect(row.gmail_message_id).toBe(outcome.gmailMessageId);
  });
});

describe("sendBatch", () => {
  it("stops at the first failure; trailing targets write zero rows", async () => {
    const { FakeGmailAdapter } = await import("./fakeAdapter.js");
    // A single adapter whose 2nd send throws — drives a partial at index 1.
    const adapter = new FakeGmailAdapter(db);
    let calls = 0;
    Object.defineProperty(adapter, "send", {
      value: (): Promise<{ messageId: string }> => {
        calls++;
        if (calls === 2) return Promise.reject(new Error("injected send failure"));
        return Promise.resolve({ messageId: `fake-msg-${calls}` });
      },
    });
    const before = messageRowCount();

    const result = await sendBatch(
      [topLevelTarget(), topLevelTarget(), topLevelTarget()],
      { approver: recordingApprover(true), runId: "run-8", adapter, db },
    );

    expect(result.failed_index).toBe(1);
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes[0]?.kind).toBe("sent");
    expect(result.outcomes[1]?.kind).toBe("partial");
    // index 2 was never attempted → a synthesized blocked outcome.
    const trailing = result.outcomes[2];
    expect(trailing?.kind).toBe("blocked");
    if (trailing?.kind === "blocked") {
      expect(trailing.reconcile_hint).toBe("batch_stopped_at_index(1)");
    }
    // row 1 (sent) + row 2 (partial draft retained) = 2 rows; row 3 never ran.
    expect(messageRowCount()).toBe(before + 2);
    expect(calls).toBe(2);
  });
});
