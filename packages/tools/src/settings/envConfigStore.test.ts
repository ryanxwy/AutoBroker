/**
 * envConfigStore unit tests — the non-secret operational-env store.
 *
 * Pins the safety surface + keystone mechanics:
 *   - set(editable) → 0600 env.json + live process.env mutation; round-trips
 *     through loadEnvConfigIntoEnv after a simulated restart.
 *   - a read-only-status id can NEVER be written through the store (NonEditableEnvVarError).
 *   - invalid value / unknown id fail loud.
 *   - getEnvConfig never contains a TEST_* id; the demo-status row reports on/off
 *     (read fresh from env); paths resolve from resolveDataDir.
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
  "AUTOBROKER_MODE",
  "AUTOBROKER_GMAIL_ACCOUNT",
  "AUTOBROKER_CHROME_HEADLESS",
  "AUTOBROKER_PER_DEALER_RECORD_CAP",
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
  it("persists app_mode to a 0600 env.json and mutates process.env in place", () => {
    setEnvConfig("app_mode", "test");

    // live process.env mutated for no-restart effect.
    expect(process.env.AUTOBROKER_MODE).toBe("test");

    // file written at 0600.
    const path = envFile();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ app_mode: "test" });
  });

  it("round-trips through loadEnvConfigIntoEnv after a simulated restart", () => {
    setEnvConfig("app_mode", "test");

    // Simulate a restart: the file persists, but process.env is back to launch
    // state (the var unset).
    delete process.env.AUTOBROKER_MODE;
    expect(process.env.AUTOBROKER_MODE).toBeUndefined();

    loadEnvConfigIntoEnv();
    expect(process.env.AUTOBROKER_MODE).toBe("test");
  });

  it("NO-CLOBBER: a launch/lane-pinned AUTOBROKER_MODE wins over a stored app_mode (safety floor)", () => {
    // A persisted "buyer" must NOT overwrite a harness/demo lane that pinned
    // "test" in the env before boot — otherwise loadEnvConfigIntoEnv (which runs
    // before the mode floor) would flip a test lane to real-send-capable.
    setEnvConfig("app_mode", "buyer"); // persisted to env.json
    process.env.AUTOBROKER_MODE = "test"; // a lane pins test before the loader runs
    loadEnvConfigIntoEnv();
    expect(process.env.AUTOBROKER_MODE).toBe("test"); // lane wins; stored is ignored
  });

  it("saves chrome_headless and reflects it in getEnvConfig", () => {
    setEnvConfig("chrome_headless", "0");
    const row = getEnvConfig().find((r) => r.id === "chrome_headless");
    expect(row?.value).toBe("0");
  });
});

describe("gmail_account — the editable-text var (free-text email)", () => {
  it("defaults to empty (NO email baked into the descriptor)", () => {
    const row = getEnvConfig().find((r) => r.id === "gmail_account");
    expect(row?.classification).toBe("editable-text");
    expect(row?.editable).toBe(true);
    expect(row?.allowedValues).toBeNull();
    expect(row?.default).toBeNull();
    expect(row?.value).toBe(""); // no file, no env, null default → ""
  });

  it("persists a valid address to 0600 env.json, mutates env, and projects it", () => {
    setEnvConfig("gmail_account", "person@example.com");
    expect(process.env.AUTOBROKER_GMAIL_ACCOUNT).toBe("person@example.com");
    const path = envFile();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ gmail_account: "person@example.com" });
    expect(getEnvConfig().find((r) => r.id === "gmail_account")?.value).toBe("person@example.com");
  });

  it("round-trips through loadEnvConfigIntoEnv after a simulated restart", () => {
    setEnvConfig("gmail_account", "person@example.com");
    delete process.env.AUTOBROKER_GMAIL_ACCOUNT;
    loadEnvConfigIntoEnv();
    expect(process.env.AUTOBROKER_GMAIL_ACCOUNT).toBe("person@example.com");
  });

  it("rejects a non-email value (validated by shape, not an allow-list) with no write", () => {
    for (const bad of ["not-an-email", "no@domain", "has space@x.com", ""]) {
      expect(() => setEnvConfig("gmail_account", bad)).toThrow(InvalidEnvValueError);
    }
    expect(process.env.AUTOBROKER_GMAIL_ACCOUNT).toBeUndefined();
    expect(existsSync(envFile())).toBe(false);
  });

  it("falls back to a launch-supplied env value when no file override exists", () => {
    process.env.AUTOBROKER_GMAIL_ACCOUNT = "launch@example.com";
    expect(getEnvConfig().find((r) => r.id === "gmail_account")?.value).toBe("launch@example.com");
  });
});

describe("setEnvConfig — fail-loud guards (in order)", () => {
  it("refuses to write a read-only-status id (demo_seed) through the store", () => {
    expect(() => setEnvConfig("demo_seed", "on")).toThrow(NonEditableEnvVarError);
    // No file written, no env mutation as a side effect.
    expect(existsSync(envFile())).toBe(false);
    expect(process.env.AUTOBROKER_DEMO_SEED).toBeUndefined();
  });

  it("rejects a value outside the descriptor's allowedValues", () => {
    expect(() => setEnvConfig("app_mode", "maybe")).toThrow(InvalidEnvValueError);
    expect(process.env.AUTOBROKER_MODE).toBeUndefined();
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

  it("projects the demo-status row as on/off read fresh from env, never the raw '1'", () => {
    const demoRow = () => getEnvConfig().find((r) => r.id === "demo_seed");

    expect(demoRow()?.value).toBe("off");

    process.env.AUTOBROKER_DEMO_SEED = "1";
    expect(demoRow()?.value).toBe("on"); // read fresh, never cached.
    expect(demoRow()?.value).not.toBe("1"); // never the raw value.
    expect(demoRow()?.editable).toBe(false);

    process.env.AUTOBROKER_DEMO_SEED = "0";
    expect(demoRow()?.value).toBe("off"); // anything but "1" is off.
  });

  it("resolves paths from resolveDataDir / the active DB path", () => {
    const rows = getEnvConfig();
    expect(rows.find((r) => r.id === "data_dir")?.value).toBe(tmpDir);
    expect(rows.find((r) => r.id === "db_path")?.value).toBe(join(tmpDir, "autobroker.db"));

    process.env.AUTOBROKER_DB = join(tmpDir, "override.db");
    expect(getEnvConfig().find((r) => r.id === "db_path")?.value).toBe(join(tmpDir, "override.db"));
  });

  it("exposes editable flag + tooltip + allowedValues for UI rendering", () => {
    const mode = getEnvConfig().find((r) => r.id === "app_mode");
    expect(mode?.editable).toBe(true);
    expect(mode?.allowedValues).toEqual(["buyer", "test"]);
    expect(typeof mode?.tooltip).toBe("string");
    expect(mode?.tooltip.length).toBeGreaterThan(0);
  });
});

describe("loadEnvConfigIntoEnv — launch-supplied vars untouched without an override", () => {
  it("leaves a launch-supplied var alone when no file override exists", () => {
    // A var supplied at launch (e.g. harness/CI), with NO file written.
    process.env.AUTOBROKER_MODE = "test";
    expect(existsSync(envFile())).toBe(false);

    loadEnvConfigIntoEnv();

    // Untouched — the loader only applies saved overrides.
    expect(process.env.AUTOBROKER_MODE).toBe("test");
  });
});

describe("per_dealer_record_cap — editable-numeric descriptor + validation", () => {
  it("is present in getEnvConfig with classification editable-numeric, editable true, min 1, max 80", () => {
    const row = getEnvConfig().find((r) => r.id === "per_dealer_record_cap");
    expect(row).toBeDefined();
    expect(row?.classification).toBe("editable-numeric");
    expect(row?.editable).toBe(true);
    expect(row?.numericMin).toBe(1);
    expect(row?.numericMax).toBe(80);
    expect(row?.default).toBe("20");
  });

  it("accepts the default value 20", () => {
    expect(() => setEnvConfig("per_dealer_record_cap", "20")).not.toThrow();
    expect(process.env.AUTOBROKER_PER_DEALER_RECORD_CAP).toBe("20");
  });

  it("accepts boundary value 1", () => {
    expect(() => setEnvConfig("per_dealer_record_cap", "1")).not.toThrow();
    expect(process.env.AUTOBROKER_PER_DEALER_RECORD_CAP).toBe("1");
  });

  it("accepts boundary value 80", () => {
    expect(() => setEnvConfig("per_dealer_record_cap", "80")).not.toThrow();
    expect(process.env.AUTOBROKER_PER_DEALER_RECORD_CAP).toBe("80");
  });

  it("rejects 0 (below minimum) with InvalidEnvValueError", () => {
    expect(() => setEnvConfig("per_dealer_record_cap", "0")).toThrow(InvalidEnvValueError);
    expect(process.env.AUTOBROKER_PER_DEALER_RECORD_CAP).toBeUndefined();
  });

  it("rejects 81 (above maximum) with InvalidEnvValueError", () => {
    expect(() => setEnvConfig("per_dealer_record_cap", "81")).toThrow(InvalidEnvValueError);
    expect(process.env.AUTOBROKER_PER_DEALER_RECORD_CAP).toBeUndefined();
  });

  it("rejects a non-integer string with InvalidEnvValueError", () => {
    expect(() => setEnvConfig("per_dealer_record_cap", "20.5")).toThrow(InvalidEnvValueError);
    expect(() => setEnvConfig("per_dealer_record_cap", "abc")).toThrow(InvalidEnvValueError);
    expect(process.env.AUTOBROKER_PER_DEALER_RECORD_CAP).toBeUndefined();
  });

  it("round-trips through loadEnvConfigIntoEnv after a simulated restart", () => {
    setEnvConfig("per_dealer_record_cap", "40");
    delete process.env.AUTOBROKER_PER_DEALER_RECORD_CAP;
    loadEnvConfigIntoEnv();
    expect(process.env.AUTOBROKER_PER_DEALER_RECORD_CAP).toBe("40");
  });
});
