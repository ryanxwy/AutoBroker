/**
 * L1 unit tests — the incentive-source file registry. Freezes:
 *   - data-dir resolution rides AUTOBROKER_DATA_DIR (harness isolation);
 *   - missing file = empty registry; round-trip preserves entries;
 *   - a write keeps every OTHER brand (read-modify-write under the lock);
 *   - escaping round-trips quotes/backslashes;
 *   - the reader fails LOUD on junk lines and contract-missing entries;
 *   - a fresh foreign lock blocks the write (bounded, loud); a stale lock is
 *     evicted and the write proceeds.
 *
 * ISOLATION: every test writes under a fresh os.tmpdir() dir. NEVER touches
 * ~/.autobroker-ts or ~/.autobroker.
 */

import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IncentiveSourceRegistryEntry } from "@autobroker/core";

import {
  incentiveRegistryPath,
  parseIncentiveRegistry,
  readIncentiveRegistry,
  serializeIncentiveRegistry,
  writeIncentiveRegistryEntry,
} from "./registry.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const originalDataDir = process.env[DATA_DIR];

let tmpDir: string;
let path: string;

function entry(overrides: Partial<IncentiveSourceRegistryEntry> = {}): IncentiveSourceRegistryEntry {
  return {
    url_template: "https://www.hyundaiusa.com/us/en/offers?zip={zip}&model={model}",
    added_at: "2026-06-12T18:00:00.000Z",
    added_for_profile: "sp_test_1",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-increg-"));
  process.env[DATA_DIR] = tmpDir;
  path = join(tmpDir, "incentive_sources.toml");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
});

describe("incentiveRegistryPath", () => {
  it("resolves under the ACTIVE data dir (AUTOBROKER_DATA_DIR isolation)", () => {
    expect(incentiveRegistryPath()).toBe(join(tmpDir, "incentive_sources.toml"));
  });
});

describe("read / write round-trip", () => {
  it("a missing file is the empty registry", () => {
    expect(readIncentiveRegistry(path)).toEqual({});
  });

  it("writes an entry and reads it back (first-encounter approval memory)", async () => {
    await writeIncentiveRegistryEntry("hyundai", entry(), path);
    expect(readIncentiveRegistry(path)).toEqual({ hyundai: entry() });
    // The default-path face resolves the same file through the env.
    expect(readIncentiveRegistry()).toEqual({ hyundai: entry() });
  });

  it("a second brand's write keeps the first (read-modify-write)", async () => {
    await writeIncentiveRegistryEntry("hyundai", entry(), path);
    await writeIncentiveRegistryEntry("mazda", entry({ added_for_profile: "sp_test_2" }), path);
    const registry = readIncentiveRegistry(path);
    expect(Object.keys(registry).sort()).toEqual(["hyundai", "mazda"]);
    expect(registry["hyundai"]).toEqual(entry());
  });

  it("re-approving a brand replaces its entry", async () => {
    await writeIncentiveRegistryEntry("hyundai", entry(), path);
    await writeIncentiveRegistryEntry("hyundai", entry({ url_template: "https://x.com/o" }), path);
    expect(readIncentiveRegistry(path)["hyundai"]!.url_template).toBe("https://x.com/o");
  });

  it("escapes and round-trips quotes/backslashes in values", async () => {
    const tricky = entry({ url_template: 'https://x.com/o?q="a\\b"' });
    await writeIncentiveRegistryEntry("hyundai", tricky, path);
    expect(readIncentiveRegistry(path)["hyundai"]).toEqual(tricky);
  });

  it("leaves no temp file behind (atomic rename)", async () => {
    await writeIncentiveRegistryEntry("hyundai", entry(), path);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("[hyundai]");
    expect(body).not.toContain(".tmp.");
  });
});

describe("parse failures are LOUD (an unreadable registry must surface)", () => {
  it("rejects junk lines", () => {
    expect(() => parseIncentiveRegistry("[hyundai]\nwhat is this")).toThrow(/unparseable line/);
  });

  it("rejects keys outside a table", () => {
    expect(() => parseIncentiveRegistry('url_template = "https://x.com"')).toThrow(
      /outside a \[brand\] table/,
    );
  });

  it("rejects duplicate brand tables", () => {
    const body = serializeIncentiveRegistry({ hyundai: entry() });
    expect(() => parseIncentiveRegistry(`${body}\n${body}`)).toThrow(/duplicate table/);
  });

  it("rejects an entry missing the row contract", () => {
    expect(() => parseIncentiveRegistry('[hyundai]\nurl_template = "https://x.com"')).toThrow();
  });

  it("tolerates comments and blank lines", () => {
    const body = `# approved sources\n\n${serializeIncentiveRegistry({ hyundai: entry() })}`;
    expect(parseIncentiveRegistry(body)["hyundai"]).toEqual(entry());
  });
});

describe("the sibling lock", () => {
  it("a FRESH foreign lock blocks the write loudly (bounded retries)", async () => {
    writeFileSync(`${path}.lock`, "", "utf8");
    // Keep the lock's mtime fresh against the stale bound; the bounded retry
    // budget (50 × 100ms) is far below the 10s staleness window.
    await expect(writeIncentiveRegistryEntry("hyundai", entry(), path)).rejects.toThrow(
      /could not acquire/,
    );
  }, 15_000);

  it("a STALE lock is evicted and the write proceeds", async () => {
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "", "utf8");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    await writeIncentiveRegistryEntry("hyundai", entry(), path);
    expect(readIncentiveRegistry(path)["hyundai"]).toEqual(entry());
  });

  it("the lock is released after a successful write", async () => {
    await writeIncentiveRegistryEntry("hyundai", entry(), path);
    // A second write must not see a held lock.
    await writeIncentiveRegistryEntry("mazda", entry(), path);
    expect(Object.keys(readIncentiveRegistry(path))).toHaveLength(2);
  });

  it("does NOT freeze the event loop while waiting for a contended lock", async () => {
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "", "utf8"); // a fresh foreign lock — held, not stale
    let timerFired = false;
    // Concurrent event-loop work that also frees the lock shortly. With the OLD
    // synchronous Atomics.wait this timer could NOT fire until the whole 5s retry
    // budget elapsed (the loop was frozen) and the write threw. Async-yielding
    // lets the timer run mid-wait, so the write acquires and succeeds quickly.
    setTimeout(() => {
      timerFired = true;
      rmSync(lockPath, { force: true });
    }, 20);
    await writeIncentiveRegistryEntry("hyundai", entry(), path);
    expect(timerFired).toBe(true);
    expect(readIncentiveRegistry(path)["hyundai"]).toEqual(entry());
  }, 10_000);
});
