/**
 * L1 unit tests — the closeout tools.
 *
 * assembleCloseoutTargets: bound dealers with an open thread + a resolvable
 * reply address become targets; a no-address dealer is skipped + counted; an
 * already-closeout-suppressed dealer is filtered out (the idempotency floor).
 *
 * closeAndSuppressDealer: an approve + disarmed fuse promotes the send AND
 * commits the local close+suppress; an armed fuse blocks the send (zero
 * `messages`) but STILL commits the close+suppress (the X1-style split); a gate
 * decline writes NOTHING; a re-run is a no-op; and the tool issues NO DELETE.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migrations run against the throwaway DB. NEVER touches ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../db.js";
import type { Approver, GateRequest } from "../gate/index.js";
import {
  assembleCloseoutTargets,
  closeAndSuppressDealer,
} from "./sendCloseSuppress.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const FUSE = "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(here, "..", "..", "..", "db", "drizzle", f));

const PROFILE = "profile-1";
const FROM = "buyer@example.test";
const SUBJECT = "[Quote Follow-up] Closing out — 2026 Hyundai Tucson";
const BODY =
  "Thanks for your help on the 2026 Hyundai Tucson. I'm closing out my search " +
  "and have selected another dealer. Please remove me from your follow-up list.";

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;
let originalFuse: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  originalFuse = process.env[FUSE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-closeout-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  delete process.env[FUSE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
  if (originalFuse === undefined) delete process.env[FUSE];
  else process.env[FUSE] = originalFuse;
});

// ---------------------------------------------------------------------------
// seeding helpers — minimal rows the queries read
// ---------------------------------------------------------------------------

function seedProfile(): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', 'active')",
    )
    .run(PROFILE);
}

/** A bound dealer with an open thread. `contactEmail` null → the dealer-row
 *  ladder rung yields nothing; pass an address to make it addressable. */
function seedBoundDealerWithThread(opts: {
  dealerId: string;
  name: string;
  contactEmail: string | null;
  threadId: string;
  state?: string;
}): void {
  db.$client
    .prepare(
      "INSERT INTO dealers (dealer_id, name, contact_email, country) VALUES (?, ?, ?, 'US')",
    )
    .run(opts.dealerId, opts.name, opts.contactEmail);
  db.$client
    .prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    )
    .run(PROFILE, opts.dealerId);
  db.$client
    .prepare(
      "INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, state, search_profile_id, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      opts.threadId,
      opts.dealerId,
      `gmail-${opts.threadId}`,
      opts.state ?? "replied",
      PROFILE,
      "2026-06-10T00:00:00.000Z",
    );
}

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

function count(table: string): number {
  const row = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function threadState(threadId: string): string {
  const row = db.$client
    .prepare("SELECT state FROM threads WHERE thread_id = ?")
    .get(threadId) as { state: string };
  return row.state;
}

// ---------------------------------------------------------------------------
// assembleCloseoutTargets
// ---------------------------------------------------------------------------

describe("assembleCloseoutTargets", () => {
  it("returns addressable bound dealers with an open thread; skips + counts a no-address dealer", () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: "d1",
      name: "Jim Click Hyundai",
      contactEmail: "leads@jimclick.test",
      threadId: "t1",
    });
    seedBoundDealerWithThread({
      dealerId: "d2",
      name: "Royal Hyundai",
      contactEmail: null, // no contact, no ladder rung → no address.
      threadId: "t2",
    });

    const { targets, skippedNoAddress } = assembleCloseoutTargets(db, PROFILE);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      dealerId: "d1",
      dealerName: "Jim Click Hyundai",
      threadId: "t1",
      gmailThreadId: "gmail-t1",
      replyTo: "leads@jimclick.test",
    });
    expect(skippedNoAddress).toBe(1);
  });

  it("excludes a dealer with only a closed/agreed thread (no open thread to close)", () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: "d1",
      name: "Closed Co",
      contactEmail: "x@closed.test",
      threadId: "t1",
      state: "closed",
    });
    seedBoundDealerWithThread({
      dealerId: "d2",
      name: "Agreed Co",
      contactEmail: "y@agreed.test",
      threadId: "t2",
      state: "agreed",
    });

    expect(assembleCloseoutTargets(db, PROFILE).targets).toHaveLength(0);
  });

  it("filters out a dealer already closeout-suppressed (the idempotency floor)", () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: "d1",
      name: "Done Co",
      contactEmail: "z@done.test",
      threadId: "t1",
    });
    // A prior closeout suppression row for d1 → never re-assembled.
    db.$client
      .prepare(
        "INSERT INTO thread_suppression (suppression_id, dealer_id, scope, action, reason, approved_by, search_profile_id) " +
          "VALUES (?, ?, 'dealer', 'suppress', ?, 'user', ?)",
      )
      .run(`closeout:${PROFILE}:d1`, "d1", `closeout:${PROFILE}`, PROFILE);

    expect(assembleCloseoutTargets(db, PROFILE).targets).toHaveLength(0);
  });

  it("excludes a non-bound (candidate) dealer", () => {
    seedProfile();
    db.$client
      .prepare("INSERT INTO dealers (dealer_id, name, contact_email, country) VALUES ('d9', 'Maybe Co', 'm@maybe.test', 'US')")
      .run();
    db.$client
      .prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, 'd9', 'candidate')")
      .run(PROFILE);
    db.$client
      .prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t9', 'd9', 'replied', ?)")
      .run(PROFILE);

    expect(assembleCloseoutTargets(db, PROFILE).targets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// closeAndSuppressDealer
// ---------------------------------------------------------------------------

function targetFor(threadId: string, dealerId = "d1"): {
  dealerId: string;
  dealerName: string;
  threadId: string;
  gmailThreadId: string;
  replyTo: string;
  contactName: string | null;
} {
  return {
    dealerId,
    dealerName: "Jim Click Hyundai",
    threadId,
    gmailThreadId: `gmail-${threadId}`,
    replyTo: "leads@jimclick.test",
    contactName: "Pat Rivera",
  };
}

describe("closeAndSuppressDealer", () => {
  it("approve + disarmed fuse → send promoted AND thread closed + one suppression row", async () => {
    const { FakeGmailAdapter } = await import("../gmail/fakeAdapter.js");
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: "d1",
      name: "Jim Click Hyundai",
      contactEmail: "leads@jimclick.test",
      threadId: "t1",
    });

    const r = await closeAndSuppressDealer({
      db,
      approver: recordingApprover(true),
      runId: "run-1",
      searchProfileId: PROFILE,
      target: targetFor("t1"),
      body: BODY,
      subject: SUBJECT,
      fromEmail: FROM,
      adapter: new FakeGmailAdapter(db),
    });

    expect(r.kind).toBe("closed");
    if (r.kind !== "closed") throw new Error("unreachable");
    expect(r.sendBlocked).toBe(false);
    expect(r.messageRowId).not.toBeNull();
    expect(count("messages")).toBe(1); // the promoted outbound row.
    expect(threadState("t1")).toBe("closed");
    expect(count("thread_suppression")).toBe(1);

    const sup = db.$client
      .prepare("SELECT scope, action, approved_by, reason FROM thread_suppression")
      .get() as { scope: string; action: string; approved_by: string; reason: string };
    expect(sup).toEqual({
      scope: "dealer",
      action: "suppress",
      approved_by: "user",
      reason: `closeout:${PROFILE}`,
    });
  });

  it("armed fuse → send BLOCKED (zero messages) but the local close+suppress STILL commit", async () => {
    process.env[FUSE] = "1";
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: "d1",
      name: "Jim Click Hyundai",
      contactEmail: "leads@jimclick.test",
      threadId: "t1",
    });

    const r = await closeAndSuppressDealer({
      db,
      approver: recordingApprover(true),
      runId: "run-2",
      searchProfileId: PROFILE,
      target: targetFor("t1"),
      body: BODY,
      subject: SUBJECT,
      fromEmail: FROM,
    });

    expect(r.kind).toBe("closed");
    if (r.kind !== "closed") throw new Error("unreachable");
    expect(r.sendBlocked).toBe(true); // the fuse blocked the network send.
    expect(count("messages")).toBe(0); // zero outbound rows — the fake-send.
    expect(threadState("t1")).toBe("closed"); // local close happened on approve.
    expect(count("thread_suppression")).toBe(1); // local suppress happened too.
  });

  it("gate decline → short_circuit, ZERO writes (no send, no close, no suppress)", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: "d1",
      name: "Jim Click Hyundai",
      contactEmail: "leads@jimclick.test",
      threadId: "t1",
    });

    const r = await closeAndSuppressDealer({
      db,
      approver: recordingApprover(false),
      runId: "run-3",
      searchProfileId: PROFILE,
      target: targetFor("t1"),
      body: BODY,
      subject: SUBJECT,
      fromEmail: FROM,
    });

    expect(r.kind).toBe("short_circuit");
    if (r.kind !== "short_circuit") throw new Error("unreachable");
    expect(r.reconcileHint).toBe("gate_declined");
    expect(count("messages")).toBe(0);
    expect(threadState("t1")).toBe("replied"); // untouched.
    expect(count("thread_suppression")).toBe(0);
  });

  it("a second closeout for the same dealer is a no-op (ON CONFLICT DO NOTHING)", async () => {
    process.env[FUSE] = "1";
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: "d1",
      name: "Jim Click Hyundai",
      contactEmail: "leads@jimclick.test",
      threadId: "t1",
    });
    const args = {
      db,
      approver: recordingApprover(true),
      runId: "run-4",
      searchProfileId: PROFILE,
      target: targetFor("t1"),
      body: BODY,
      subject: SUBJECT,
      fromEmail: FROM,
    };

    await closeAndSuppressDealer(args);
    await closeAndSuppressDealer(args);

    expect(count("thread_suppression")).toBe(1); // exactly one row, not two.
  });

  it("a budget figure in an EDITed body fails loud BEFORE any write", async () => {
    process.env[FUSE] = "1";
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: "d1",
      name: "Jim Click Hyundai",
      contactEmail: "leads@jimclick.test",
      threadId: "t1",
    });

    await expect(
      closeAndSuppressDealer({
        db,
        approver: recordingApprover(true),
        runId: "run-5",
        searchProfileId: PROFILE,
        target: targetFor("t1"),
        body: BODY + " My budget is $42000.",
        subject: SUBJECT,
        fromEmail: FROM,
      }),
    ).rejects.toThrow();

    expect(count("messages")).toBe(0);
    expect(count("thread_suppression")).toBe(0);
    expect(threadState("t1")).toBe("replied");
  });

  it("issues NO DELETE statement (state-only)", async () => {
    process.env[FUSE] = "1";
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: "d1",
      name: "Jim Click Hyundai",
      contactEmail: "leads@jimclick.test",
      threadId: "t1",
    });

    // Spy the raw prepare so any DELETE issued by the tool is caught.
    const realPrepare = db.$client.prepare.bind(db.$client);
    const prepared: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.$client as any).prepare = (sql: string) => {
      prepared.push(sql);
      return realPrepare(sql);
    };
    try {
      await closeAndSuppressDealer({
        db,
        approver: recordingApprover(true),
        runId: "run-6",
        searchProfileId: PROFILE,
        target: targetFor("t1"),
        body: BODY,
        subject: SUBJECT,
        fromEmail: FROM,
      });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.$client as any).prepare = realPrepare;
    }

    expect(prepared.some((s) => /\bDELETE\b/i.test(s))).toBe(false);
  });
});
