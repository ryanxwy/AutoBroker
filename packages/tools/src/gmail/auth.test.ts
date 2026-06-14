/**
 * Unit tests — Gmail auth persistence + parameterization (no network, no
 * consent flow). Freezes:
 *   - the account is a PARAMETER threaded into the stored record (no hardcoded
 *     address baked in the module);
 *   - the token + client JSON are written 0600 into <AUTOBROKER_DATA_DIR>/gmail/;
 *   - persist → load round-trips the record + client;
 *   - mergeCredentialsIntoRecord keeps the refresh_token + account when a refresh
 *     event omits them, and adopts a fresh access_token/expiry_date;
 *   - the data-dir resolver honors AUTOBROKER_DATA_DIR (isolation).
 *
 * The interactive runConsentFlow (system browser + loopback) is NOT exercised
 * here — it needs a real consent, which tests never perform.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clientPath,
  gmailDataDir,
  loadClient,
  loadTokenRecord,
  mergeCredentialsIntoRecord,
  persistTokenRecord,
  tokenPath,
  type InstalledClient,
  type TokenRecord,
} from "./auth.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const originalDataDir = process.env[DATA_DIR];

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-gmail-auth-"));
  process.env[DATA_DIR] = tmpDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

const CLIENT: InstalledClient = { client_id: "cid-123", client_secret: "csecret-xyz" };

function record(account: string): TokenRecord {
  return {
    account,
    client_id: CLIENT.client_id,
    refresh_token: "refresh-abc",
    access_token: "access-1",
    token_type: "Bearer",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    expiry_date: 1_700_000_000_000,
    obtained_at: "2026-06-13T00:00:00.000Z",
  };
}

describe("gmail data dir isolation", () => {
  it("resolves <AUTOBROKER_DATA_DIR>/gmail and the token/client paths under it", () => {
    expect(gmailDataDir()).toBe(join(tmpDir, "gmail"));
    expect(tokenPath()).toBe(join(tmpDir, "gmail", "token.json"));
    expect(clientPath()).toBe(join(tmpDir, "gmail", "client.json"));
  });
});

describe("persist + load round-trip", () => {
  it("threads an arbitrary account parameter into the stored record", () => {
    const account = "tester@parametric.example";
    persistTokenRecord(record(account), CLIENT);
    const loaded = loadTokenRecord();
    expect(loaded.account).toBe(account);
    expect(loaded.refresh_token).toBe("refresh-abc");
  });

  it("round-trips the installed client creds", () => {
    persistTokenRecord(record("a@b.example"), CLIENT);
    expect(loadClient()).toEqual(CLIENT);
  });

  it("writes both files mode 0600", () => {
    persistTokenRecord(record("a@b.example"), CLIENT);
    // The low 9 permission bits must be exactly rw------- (0o600).
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(statSync(clientPath()).mode & 0o777).toBe(0o600);
  });
});

describe("mergeCredentialsIntoRecord", () => {
  it("keeps the prior refresh_token + account when the refresh omits them", () => {
    const prev = record("keep@me.example");
    const merged = mergeCredentialsIntoRecord(prev, {
      access_token: "access-2",
      expiry_date: 1_800_000_000_000,
    });
    expect(merged.refresh_token).toBe("refresh-abc"); // preserved
    expect(merged.account).toBe("keep@me.example"); // preserved
    expect(merged.access_token).toBe("access-2"); // adopted
    expect(merged.expiry_date).toBe(1_800_000_000_000); // adopted
  });

  it("adopts a rotated refresh_token when the event provides one", () => {
    const prev = record("a@b.example");
    const merged = mergeCredentialsIntoRecord(prev, { refresh_token: "rotated" });
    expect(merged.refresh_token).toBe("rotated");
  });
});

describe("no real account leaks in the auth module", () => {
  it("does not bake any @gmail.com address into the module source", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./auth.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/@gmail\.com/i);
  });
});
