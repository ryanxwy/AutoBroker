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

  it("writes an entry and reads it back (first-encounter approval memory)", () => {
    writeIncentiveRegistryEntry("hyundai", entry(), path);
    expect(readIncentiveRegistry(path)).toEqual({ hyundai: entry() });
    // The default-path face resolves the same file through the env.
    expect(readIncentiveRegistry()).toEqual({ hyundai: entry() });
  });

  it("a second brand's write keeps the first (read-modify-write)", () => {
    writeIncentiveRegistryEntry("hyundai", entry(), path);
    writeIncentiveRegistryEntry("mazda", entry({ added_for_profile: "sp_test_2" }), path);
    const registry = readIncentiveRegistry(path);
    expect(Object.keys(registry).sort()).toEqual(["hyundai", "mazda"]);
    expect(registry["hyundai"]).toEqual(entry());
  });

  it("re-approving a brand replaces its entry", () => {
    writeIncentiveRegistryEntry("hyundai", entry(), path);
    writeIncentiveRegistryEntry("hyundai", entry({ url_template: "https://x.com/o" }), path);
    expect(readIncentiveRegistry(path)["hyundai"]!.url_template).toBe("https://x.com/o");
  });

  it("escapes and round-trips quotes/backslashes in values", () => {
    const tricky = entry({ url_template: 'https://x.com/o?q="a\\b"' });
    writeIncentiveRegistryEntry("hyundai", tricky, path);
    expect(readIncentiveRegistry(path)["hyundai"]).toEqual(tricky);
  });

  it("leaves no temp file behind (atomic rename)", () => {
    writeIncentiveRegistryEntry("hyundai", entry(), path);
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
  it("a FRESH foreign lock blocks the write loudly (bounded retries)", () => {
    writeFileSync(`${path}.lock`, "", "utf8");
    // Keep the lock's mtime fresh against the stale bound; the bounded retry
    // budget (50 × 100ms) is far below the 10s staleness window.
    expect(() => writeIncentiveRegistryEntry("hyundai", entry(), path)).toThrow(
      /could not acquire/,
    );
  }, 15_000);

  it("a STALE lock is evicted and the write proceeds", () => {
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "", "utf8");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    writeIncentiveRegistryEntry("hyundai", entry(), path);
    expect(readIncentiveRegistry(path)["hyundai"]).toEqual(entry());
  });

  it("the lock is released after a successful write", () => {
    writeIncentiveRegistryEntry("hyundai", entry(), path);
    // A second write must not see a held lock.
    writeIncentiveRegistryEntry("mazda", entry(), path);
    expect(Object.keys(readIncentiveRegistry(path))).toHaveLength(2);
  });
});
