/**
 * L1 unit tests — the Gmail send seam: budget redaction, the backend factory,
 * and GmailTool's gate-wrapped delegation. Pure/deterministic, no network and no
 * real Gmail. The only DB touch is the Fake backend constructed against a
 * throwaway data dir; the real backend is exercised by branch/type, never wired
 * to the network.
 *
 * Freezes:
 *   - redactBudget substitutes leaked budget phrases out, and the substituted
 *     result passes the assertNoBudget belt; a clean string is unchanged;
 *   - createGmailAdapter: default → Fake; =real + isolated dir → Real; =real +
 *     production dir → refused; unknown value → refused; env read FRESH each call;
 *   - GmailTool.send routes through the gate, calls adapter.send exactly once,
 *     threads runId into the gate request, returns {mode, messageId}; decline →
 *     {declined:true} with zero sends; an ARMED L1 fuse throws before send;
 *   - __setGmailAdapterForTests refuses outside NODE_ENV=test.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR for the Fake; the
 * committed migration SQL runs against the throwaway DB. NEVER touches
 * ~/.autobroker or ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb } from "@autobroker/db";

import { RealGmailAdapter } from "./gmail/adapter.js";
import { FakeGmailAdapter } from "./gmail/fakeAdapter.js";
import type { Approver, GateRequest } from "./gate/index.js";
import type { GmailAdapter } from "./gmail/types.js";
import {
  buildRaw,
  createGmailAdapter,
  GmailBackendRefusedError,
  GmailTool,
  redactBudget,
  __resetGmailAdapterForTests,
  __setGmailAdapterForTests,
  type GmailBackend,
  type OutboundEmail,
} from "./gmail.js";
import { assertNoBudget } from "./validators.js";

const BACKEND = "AUTOBROKER_GMAIL_BACKEND";
const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const FUSE = "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS";
const NODE_ENV = "NODE_ENV";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "db", "drizzle");

// Snapshot every env var these tests mutate, restored after each case.
const saved: Record<string, string | undefined> = {};
let tmpDir: string;

function snapshotEnv(): void {
  for (const key of [BACKEND, DATA_DIR, DB_OVERRIDE, FUSE, NODE_ENV]) {
    saved[key] = process.env[key];
  }
}
function restoreEnv(): void {
  for (const key of [BACKEND, DATA_DIR, DB_OVERRIDE, FUSE, NODE_ENV]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

beforeEach(() => {
  snapshotEnv();
  process.env[NODE_ENV] = "test";
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-gmail-seam-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  delete process.env[BACKEND];
  delete process.env[FUSE];
});

afterEach(() => {
  __resetGmailAdapterForTests();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  restoreEnv();
});

/** Migrate the throwaway DB so a FakeGmailAdapter can be constructed/used. */
function migrateFakeDb(): void {
  const db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
}

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

/** A spy adapter — only `send` is exercised; the read methods throw if touched.
 *  `kind` is declared explicitly (default "fake") so a test can prove the send
 *  seam stamps SendResult.mode from the ADAPTER's kind, not the env. */
function spyAdapter(kind: GmailBackend = "fake"): GmailAdapter & { sendCalls: string[] } {
  const sendCalls: string[] = [];
  const unused = () => {
    throw new Error("read path not expected in send-seam tests");
  };
  return {
    sendCalls,
    kind,
    send(raw: string): Promise<{ messageId: string }> {
      sendCalls.push(raw);
      return Promise.resolve({ messageId: "spy-msg-1" });
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

const CLEAN_EMAIL: OutboundEmail = {
  to: "sales@example-dealer.test",
  from: "buyer@example.test",
  subject: "Best out-the-door price request",
  body: "Please send your best out-the-door price for the listed vehicle.",
};

describe("redactBudget", () => {
  it("strips a budget figure and the result passes the assertNoBudget belt", () => {
    const result = redactBudget("my budget is $35k, send me the OTD");
    expect(result).not.toContain("$35k");
    expect(result).toContain("[redacted]");
    expect(assertNoBudget(result).ok).toBe(true);
  });

  it("leaves a no-budget string unchanged", () => {
    const clean = "Please send your best out-the-door price for the vehicle.";
    expect(redactBudget(clean)).toBe(clean);
    expect(assertNoBudget(redactBudget(clean)).ok).toBe(true);
  });
});

describe("buildRaw", () => {
  it("assembles unfolded headers a fake backend can recover, then base64url", () => {
    const raw = buildRaw(CLEAN_EMAIL);
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toMatch(/^To: sales@example-dealer\.test$/m);
    expect(decoded).toMatch(/^From: buyer@example\.test$/m);
    expect(decoded).toMatch(/^Subject: Best out-the-door price request$/m);
  });

  it("throws on a lone surrogate in the body — assembly aborts before any raw bytes", () => {
    // \uD83D is a high surrogate with no low half — invalid Unicode that cannot
    // round-trip through UTF-8; assembly must abort, not mangle it.
    const bad: OutboundEmail = { ...CLEAN_EMAIL, body: `Hello \uD83D there.` };
    expect(() => buildRaw(bad)).toThrow();
  });
});

describe("createGmailAdapter — factory matrix", () => {
  it("defaults to FakeGmailAdapter when the backend env is unset", () => {
    migrateFakeDb();
    delete process.env[BACKEND];
    expect(createGmailAdapter()).toBeInstanceOf(FakeGmailAdapter);
  });

  it("builds RealGmailAdapter for =real under an isolated parity-style dir", () => {
    // Point the data dir at a ~/.autobroker-ts subtree so the prod refusal passes;
    // the real adapter is lazy (no I/O at construction) so this never networks.
    const parityDir = join(homedir(), ".autobroker-ts", "gmail-seam-test");
    process.env[DATA_DIR] = parityDir;
    process.env[BACKEND] = "real";
    expect(createGmailAdapter()).toBeInstanceOf(RealGmailAdapter);
  });

  it("refuses =real when the data dir is under production ~/.autobroker", () => {
    process.env[DATA_DIR] = join(homedir(), ".autobroker");
    process.env[BACKEND] = "real";
    expect(() => createGmailAdapter()).toThrow(GmailBackendRefusedError);
  });

  it("refuses an unknown backend string", () => {
    process.env[BACKEND] = "bogus";
    expect(() => createGmailAdapter()).toThrow(GmailBackendRefusedError);
  });

  it("reads AUTOBROKER_GMAIL_BACKEND FRESH on each call (no module caching)", () => {
    migrateFakeDb();
    delete process.env[BACKEND];
    const first = createGmailAdapter();
    expect(first).toBeInstanceOf(FakeGmailAdapter);

    process.env[BACKEND] = "real";
    process.env[DATA_DIR] = join(homedir(), ".autobroker-ts", "gmail-seam-test");
    const second = createGmailAdapter();
    expect(second).toBeInstanceOf(RealGmailAdapter);
  });

  it("honors an explicit backend argument over the env var", () => {
    migrateFakeDb();
    process.env[BACKEND] = "real";
    process.env[DATA_DIR] = tmpDir; // not parity, but explicit fake skips the check
    expect(createGmailAdapter("fake")).toBeInstanceOf(FakeGmailAdapter);
  });
});

describe("GmailTool.send", () => {
  it("routes through the gate, calls adapter.send once, threads runId, returns {mode, messageId}", async () => {
    const adapter = spyAdapter();
    const approver = recordingApprover(true);
    const tool = new GmailTool(approver, "run-123", adapter);

    const result = await tool.send(CLEAN_EMAIL);

    expect(adapter.sendCalls).toHaveLength(1);
    expect(approver.seen).toHaveLength(1);
    expect(approver.seen[0]?.runId).toBe("run-123");
    expect(approver.seen[0]?.kind).toBe("gmail_send");
    expect(result).toEqual({ mode: "fake", messageId: "spy-msg-1" });
  });

  it("mode FOLLOWS the adapter: an injected kind:'real' adapter reports mode 'real'", async () => {
    const adapter = spyAdapter("real");
    const tool = new GmailTool(recordingApprover(true), "run-r", adapter);
    const result = await tool.send(CLEAN_EMAIL);
    expect(result).toEqual({ mode: "real", messageId: "spy-msg-1" });
  });

  it("mode tracks the ADAPTER, not the env: kind:'fake' under BACKEND=real still reports 'fake'", async () => {
    // The env says "real" but the adapter that actually runs is a fake — the
    // discriminator must follow the adapter that performed the send, never the
    // env (which can disagree with an injected/test-override adapter).
    process.env[BACKEND] = "real";
    const adapter = spyAdapter("fake");
    const tool = new GmailTool(recordingApprover(true), "run-mismatch", adapter);
    const result = await tool.send(CLEAN_EMAIL);
    expect(result).toEqual({ mode: "fake", messageId: "spy-msg-1" });
  });

  it("returns {declined:true} with ZERO sends on a declined gate", async () => {
    const adapter = spyAdapter();
    const tool = new GmailTool(recordingApprover(false), "run-x", adapter);

    const result = await tool.send(CLEAN_EMAIL);

    expect(result).toEqual({ declined: true });
    expect(adapter.sendCalls).toHaveLength(0);
  });

  it("uses the test-injected adapter when no explicit adapter is given", async () => {
    const adapter = spyAdapter();
    __setGmailAdapterForTests(adapter);
    const tool = new GmailTool(recordingApprover(true), "run-di");

    const result = await tool.send(CLEAN_EMAIL);

    expect(adapter.sendCalls).toHaveLength(1);
    expect(result).toMatchObject({ messageId: "spy-msg-1" });
  });

  it("throws on an ARMED L1 fuse — before any send (the unified path)", async () => {
    process.env[FUSE] = "1";
    const adapter = spyAdapter();
    const tool = new GmailTool(recordingApprover(true), "run-fuse", adapter);

    await expect(tool.send(CLEAN_EMAIL)).rejects.toThrow();
    expect(adapter.sendCalls).toHaveLength(0);
  });
});

describe("__setGmailAdapterForTests", () => {
  it("throws unless NODE_ENV is 'test'", () => {
    process.env[NODE_ENV] = "production";
    expect(() => __setGmailAdapterForTests(spyAdapter())).toThrow();
  });

  it("accepts an adapter under NODE_ENV=test", () => {
    process.env[NODE_ENV] = "test";
    expect(() => __setGmailAdapterForTests(spyAdapter())).not.toThrow();
  });
});
