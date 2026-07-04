/**
 * Unit tests — assertReadProbeEnvelope and ReadOnlyGmailAdapter.
 * No live Gmail, no network. Env manipulation follows the established
 * save/restore pattern from auth.test.ts.
 *
 * assertReadProbeEnvelope:
 *   - throws when NODE_ENV=test (isHarnessContext true);
 *   - throws when AUTOBROKER_HARNESS=1;
 *   - throws when AUTOBROKER_HARNESS_FIXTURE=1;
 *   - throws when data dir is exactly ~/.autobroker (production tree);
 *   - throws when data dir is a subdir of ~/.autobroker;
 *   - throws when the token file is absent;
 *   - returns { account } on success with a valid token in an isolated dir.
 *
 * ReadOnlyGmailAdapter:
 *   - delegates kind + all seven read methods to the inner adapter;
 *   - send() throws unconditionally and never calls the inner send.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertReadProbeEnvelope, ReadOnlyGmailAdapter } from "./readProbe.js";
import type { GmailAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------

const SAVED_NODE_ENV = process.env.NODE_ENV;
const SAVED_DATA_DIR = process.env.AUTOBROKER_DATA_DIR;
const SAVED_HARNESS = process.env.AUTOBROKER_HARNESS;
const SAVED_HARNESS_FIXTURE = process.env.AUTOBROKER_HARNESS_FIXTURE;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-readprobe-"));
});

afterEach(() => {
  if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = SAVED_NODE_ENV;

  if (SAVED_DATA_DIR === undefined) delete process.env.AUTOBROKER_DATA_DIR;
  else process.env.AUTOBROKER_DATA_DIR = SAVED_DATA_DIR;

  if (SAVED_HARNESS === undefined) delete process.env.AUTOBROKER_HARNESS;
  else process.env.AUTOBROKER_HARNESS = SAVED_HARNESS;

  if (SAVED_HARNESS_FIXTURE === undefined) delete process.env.AUTOBROKER_HARNESS_FIXTURE;
  else process.env.AUTOBROKER_HARNESS_FIXTURE = SAVED_HARNESS_FIXTURE;

  rmSync(tmpDir, { recursive: true, force: true });
});

/** Step outside every harness context so the envelope's harness check passes. */
function exitHarnessContext(): void {
  process.env.NODE_ENV = "production";
  delete process.env.AUTOBROKER_HARNESS;
  delete process.env.AUTOBROKER_HARNESS_FIXTURE;
}

/** Write a minimal token.json into <dir>/gmail/ so loadTokenRecord() succeeds. */
function writeMinimalToken(dir: string, account = "probe@example.com"): void {
  const gmailDir = join(dir, "gmail");
  mkdirSync(gmailDir, { recursive: true });
  writeFileSync(
    join(gmailDir, "token.json"),
    JSON.stringify({
      account,
      client_id: "cid",
      refresh_token: "rtoken",
      access_token: null,
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      expiry_date: null,
      obtained_at: new Date().toISOString(),
    }),
  );
}

// ---------------------------------------------------------------------------
// assertReadProbeEnvelope
// ---------------------------------------------------------------------------

describe("assertReadProbeEnvelope", () => {
  it("throws when NODE_ENV=test (isHarnessContext is true)", () => {
    process.env.NODE_ENV = "test";
    expect(() => assertReadProbeEnvelope()).toThrow(/harness/i);
  });

  it("throws when AUTOBROKER_HARNESS=1", () => {
    exitHarnessContext();
    process.env.AUTOBROKER_HARNESS = "1";
    expect(() => assertReadProbeEnvelope()).toThrow(/harness/i);
  });

  it("throws when AUTOBROKER_HARNESS_FIXTURE=1", () => {
    exitHarnessContext();
    process.env.AUTOBROKER_HARNESS_FIXTURE = "1";
    expect(() => assertReadProbeEnvelope()).toThrow(/harness/i);
  });

  it("throws when data dir is exactly ~/.autobroker (production tree)", () => {
    exitHarnessContext();
    process.env.AUTOBROKER_DATA_DIR = join(homedir(), ".autobroker");
    expect(() => assertReadProbeEnvelope()).toThrow(/production/i);
  });

  it("throws when data dir is a subdirectory of ~/.autobroker", () => {
    exitHarnessContext();
    process.env.AUTOBROKER_DATA_DIR = join(homedir(), ".autobroker", "subdir");
    expect(() => assertReadProbeEnvelope()).toThrow(/production/i);
  });

  it("does NOT block ~/.autobroker-ts — data-dir check passes, token error follows", () => {
    exitHarnessContext();
    // ~/.autobroker-ts does NOT start with ~/.autobroker/ (sep boundary), so
    // the production-tree denylist must not fire.
    process.env.AUTOBROKER_DATA_DIR = join(homedir(), ".autobroker-ts");
    let caughtMsg = "";
    try {
      assertReadProbeEnvelope();
    } catch (err) {
      caughtMsg = (err as Error).message;
    }
    expect(caughtMsg).not.toMatch(/production/i);
  });

  it("throws when the token file is absent (loadTokenRecord fails)", () => {
    exitHarnessContext();
    process.env.AUTOBROKER_DATA_DIR = tmpDir;
    // No token written → loadTokenRecord throws (ENOENT).
    expect(() => assertReadProbeEnvelope()).toThrow();
  });

  it("returns { account } on success with a valid token in an isolated dir", () => {
    exitHarnessContext();
    process.env.AUTOBROKER_DATA_DIR = tmpDir;
    writeMinimalToken(tmpDir, "buyer@example.com");
    expect(assertReadProbeEnvelope()).toEqual({ account: "buyer@example.com" });
  });
});

// ---------------------------------------------------------------------------
// ReadOnlyGmailAdapter
// ---------------------------------------------------------------------------

function makeStubAdapter(): GmailAdapter {
  return {
    kind: "real",
    search: vi.fn(async () => []),
    getThread: vi.fn(async () => ({ threadId: "t1", messages: [] })),
    getMessage: vi.fn(async () => ({
      messageId: "m1",
      threadId: "t1",
      direction: "inbound" as const,
      from: "dealer@example.com",
      to: "buyer@example.com",
      subject: "Quote",
      rfcMessageId: "<m1@example.com>",
      bodyText: "OTD $33,000",
      bodyHtml: "<p>OTD $33,000</p>",
      internalDateMs: 1_700_000_000_000,
      attachments: [],
    })),
    downloadAttachment: vi.fn(async () => ({
      filename: "quote.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
    })),
    historyList: vi.fn(async () => ({
      expired: false,
      records: [],
      newHistoryId: "99",
    })),
    getCurrentHistoryId: vi.fn(async () => "42"),
    send: vi.fn(async () => ({ messageId: "should-not-be-called" })),
    health: vi.fn(async () => ({ ok: true, detail: "7 messages" })),
  };
}

describe("ReadOnlyGmailAdapter", () => {
  it("exposes kind from the inner adapter", () => {
    const stub = makeStubAdapter();
    expect(new ReadOnlyGmailAdapter(stub).kind).toBe("real");
  });

  it("delegates search to the inner adapter", async () => {
    const stub = makeStubAdapter();
    const ro = new ReadOnlyGmailAdapter(stub);
    await ro.search("newer_than:30d", 20);
    expect(stub.search).toHaveBeenCalledWith("newer_than:30d", 20);
  });

  it("delegates getThread to the inner adapter", async () => {
    const stub = makeStubAdapter();
    const ro = new ReadOnlyGmailAdapter(stub);
    const result = await ro.getThread("t1");
    expect(stub.getThread).toHaveBeenCalledWith("t1");
    expect(result.threadId).toBe("t1");
  });

  it("delegates getMessage to the inner adapter", async () => {
    const stub = makeStubAdapter();
    const ro = new ReadOnlyGmailAdapter(stub);
    const msg = await ro.getMessage("m1");
    expect(stub.getMessage).toHaveBeenCalledWith("m1");
    expect(msg.messageId).toBe("m1");
  });

  it("delegates downloadAttachment to the inner adapter", async () => {
    const stub = makeStubAdapter();
    const ro = new ReadOnlyGmailAdapter(stub);
    const ref = {
      attachmentId: "a1",
      filename: "quote.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    };
    const data = await ro.downloadAttachment("m1", ref);
    expect(stub.downloadAttachment).toHaveBeenCalledWith("m1", ref);
    expect(data.filename).toBe("quote.pdf");
  });

  it("delegates historyList to the inner adapter", async () => {
    const stub = makeStubAdapter();
    const ro = new ReadOnlyGmailAdapter(stub);
    const page = await ro.historyList("500");
    expect(stub.historyList).toHaveBeenCalledWith("500");
    expect(page.expired).toBe(false);
    expect(page.newHistoryId).toBe("99");
  });

  it("delegates getCurrentHistoryId to the inner adapter", async () => {
    const stub = makeStubAdapter();
    const ro = new ReadOnlyGmailAdapter(stub);
    const hid = await ro.getCurrentHistoryId();
    expect(stub.getCurrentHistoryId).toHaveBeenCalled();
    expect(hid).toBe("42");
  });

  it("delegates health to the inner adapter", async () => {
    const stub = makeStubAdapter();
    const ro = new ReadOnlyGmailAdapter(stub);
    const h = await ro.health();
    expect(stub.health).toHaveBeenCalled();
    expect(h.ok).toBe(true);
  });

  it("send() throws unconditionally and NEVER calls the inner send", async () => {
    const stub = makeStubAdapter();
    const ro = new ReadOnlyGmailAdapter(stub);
    await expect(ro.send("raw-rfc2822-bytes")).rejects.toThrow(
      "ReadOnlyGmailAdapter: send is forbidden in a read-only probe",
    );
    expect(stub.send).not.toHaveBeenCalled();
  });
});
