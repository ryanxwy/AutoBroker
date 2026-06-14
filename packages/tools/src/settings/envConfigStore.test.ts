/**
 * envConfigStore unit tests — the non-secret operational-env store.
 *
 * Pins the safety surface + keystone mechanics:
 *   - set(editable) → 0600 env.json + live process.env mutation; round-trips
 *     through loadEnvConfigIntoEnv after a simulated restart.
 *   - the L1 fuse can NEVER be disarmed through the store (NonEditableEnvVarError).
 *   - invalid value / unknown id fail loud.
 *   - getEnvConfig never contains a TEST_* id; the fuse reports armed/disarmed
 *     (read fresh from env), never the raw "1"; paths resolve from resolveDataDir.
 *   - loadEnvConfigIntoEnv leaves a launch-supplied var untouched when no override.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is mkdtemp'd per test and pointed at via
 * AUTOBROKER_DATA_DIR; every process.env var the store touches is saved and
 * restored around each test. NEVER writes ~/.autobroker-ts or ~/.autobroker.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getEnvConfig,
  setEnvConfig,
  loadEnvConfigIntoEnv,
  UnknownEnvVarError,
  NonEditableEnvVarError,
  InvalidEnvValueError,
} from "./envConfigStore.js";

const TOUCHED = [
  "AUTOBROKER_DATA_DIR",
  "AUTOBROKER_DB",
  "AUTOBROKER_GMAIL_BACKEND",
  "AUTOBROKER_CHROME_HEADLESS",
  "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS",
  "AUTOBROKER_DEMO_SEED",
  "AUTOBROKER_TEST_AUTO_APPROVE",
  "AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS",
] as const;

const original: Record<string, string | undefined> = {};
let tmpDir: string;

beforeEach(() => {
  for (const v of TOUCHED) {
    original[v] = process.env[v];
    delete process.env[v];
  }
  tmpDir = mkdtempSync(join(tmpdir(), "env-config-store-"));
  process.env.AUTOBROKER_DATA_DIR = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  for (const v of TOUCHED) {
    if (original[v] === undefined) delete process.env[v];
    else process.env[v] = original[v];
  }
});

function envFile(): string {
  return join(tmpDir, "settings", "env.json");
}

describe("setEnvConfig — editable persist + live mutation", () => {
  it("persists gmail_backend to a 0600 env.json and mutates process.env in place", () => {
    setEnvConfig("gmail_backend", "real");

    // live process.env mutated for no-restart effect.
    expect(process.env.AUTOBROKER_GMAIL_BACKEND).toBe("real");

    // file written at 0600.
    const path = envFile();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ gmail_backend: "real" });
  });

  it("round-trips through loadEnvConfigIntoEnv after a simulated restart", () => {
    setEnvConfig("gmail_backend", "real");

    // Simulate a restart: the file persists, but process.env is back to launch
    // state (the var unset).
    delete process.env.AUTOBROKER_GMAIL_BACKEND;
    expect(process.env.AUTOBROKER_GMAIL_BACKEND).toBeUndefined();

    loadEnvConfigIntoEnv();
    expect(process.env.AUTOBROKER_GMAIL_BACKEND).toBe("real");
  });

  it("saves chrome_headless and reflects it in getEnvConfig", () => {
    setEnvConfig("chrome_headless", "0");
    const row = getEnvConfig().find((r) => r.id === "chrome_headless");
    expect(row?.value).toBe("0");
  });
});

describe("setEnvConfig — fail-loud guards (in order)", () => {
  it("refuses to disarm the L1 fuse through the store", () => {
    expect(() => setEnvConfig("block_external_mutations", "disarmed")).toThrow(
      NonEditableEnvVarError,
    );
    // No file written, no env mutation as a side effect.
    expect(existsSync(envFile())).toBe(false);
    expect(process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS).toBeUndefined();
  });

  it("rejects a value outside the descriptor's allowedValues", () => {
    expect(() => setEnvConfig("gmail_backend", "maybe")).toThrow(InvalidEnvValueError);
    expect(process.env.AUTOBROKER_GMAIL_BACKEND).toBeUndefined();
    expect(existsSync(envFile())).toBe(false);
  });

  it("rejects an unknown id", () => {
    expect(() => setEnvConfig("nope", "x")).toThrow(UnknownEnvVarError);
    expect(existsSync(envFile())).toBe(false);
  });

  it("refuses a read-only path id", () => {
    expect(() => setEnvConfig("data_dir", "/tmp/elsewhere")).toThrow(NonEditableEnvVarError);
  });
});

describe("getEnvConfig — read-only projection + no hidden ids", () => {
  it("never exposes a TEST_* id even when set in the environment", () => {
    process.env.AUTOBROKER_TEST_AUTO_APPROVE = "1";
    process.env.AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS = "1";
    const ids = getEnvConfig().map((r) => r.id as string);
    expect(ids).not.toContain("test_auto_approve");
    expect(ids.some((id) => id.startsWith("test"))).toBe(false);
    // No row's backing envVar is one of the escapes.
    const envVars = getEnvConfig().map((r) => r.envVar);
    expect(envVars).not.toContain("AUTOBROKER_TEST_AUTO_APPROVE");
    expect(envVars).not.toContain("AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS");
  });

  it("projects the fuse as armed/disarmed read fresh from env, never the raw '1'", () => {
    const fuseRow = () => getEnvConfig().find((r) => r.id === "block_external_mutations");

    expect(fuseRow()?.value).toBe("disarmed");

    process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = "1";
    expect(fuseRow()?.value).toBe("armed"); // read fresh, never cached.
    expect(fuseRow()?.value).not.toBe("1"); // never the raw value.
    expect(fuseRow()?.editable).toBe(false);

    process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = "0";
    expect(fuseRow()?.value).toBe("disarmed"); // anything but "1" is disarmed.
  });

  it("resolves paths from resolveDataDir / the active DB path", () => {
    const rows = getEnvConfig();
    expect(rows.find((r) => r.id === "data_dir")?.value).toBe(tmpDir);
    expect(rows.find((r) => r.id === "db_path")?.value).toBe(join(tmpDir, "autobroker.db"));

    process.env.AUTOBROKER_DB = join(tmpDir, "override.db");
    expect(getEnvConfig().find((r) => r.id === "db_path")?.value).toBe(join(tmpDir, "override.db"));
  });

  it("exposes editable flag + tooltip + allowedValues for UI rendering", () => {
    const gmail = getEnvConfig().find((r) => r.id === "gmail_backend");
    expect(gmail?.editable).toBe(true);
    expect(gmail?.allowedValues).toEqual(["fake", "real"]);
    expect(typeof gmail?.tooltip).toBe("string");
    expect(gmail?.tooltip.length).toBeGreaterThan(0);
  });
});

describe("loadEnvConfigIntoEnv — launch-supplied vars untouched without an override", () => {
  it("leaves a launch-supplied var alone when no file override exists", () => {
    // A var supplied at launch (e.g. harness/CI), with NO file written.
    process.env.AUTOBROKER_GMAIL_BACKEND = "fake";
    expect(existsSync(envFile())).toBe(false);

    loadEnvConfigIntoEnv();

    // Untouched — the loader only applies saved overrides.
    expect(process.env.AUTOBROKER_GMAIL_BACKEND).toBe("fake");
  });
});
