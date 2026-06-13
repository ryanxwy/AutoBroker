/**
 * secretsStore unit tests — against an ISOLATED tmp AUTOBROKER_DATA_DIR (saved /
 * restored). Pins the keystone mechanics: set → 0600 file + live env mutation;
 * presence reflects file/env without leaking values; clear removes the entry +
 * env var; loadSecretsIntoEnv seeds the env from a written file; the allow-list
 * rejects a non-key id; a system env var is NEVER touched.
 *
 * NEVER ~/.autobroker* — every case runs in a fresh os.tmpdir() subdir.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearKey,
  getKeyPresence,
  loadSecretsIntoEnv,
  setKey,
  UnknownSecretKeyError,
} from "./secretsStore.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";

let tmpDir: string;
let originalDataDir: string | undefined;

// The four provider env vars + a system var we assert is never touched.
const ALL_VARS = [
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_PLACES_API_KEY",
] as const;
const SYSTEM_VAR = "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS";

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  tmpDir = mkdtempSync(join(tmpdir(), "secrets-store-"));
  process.env[DATA_DIR] = tmpDir;
  for (const v of [...ALL_VARS, SYSTEM_VAR]) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  for (const v of [...ALL_VARS, SYSTEM_VAR]) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const keysFile = () => join(tmpDir, "settings", "keys.json");

describe("setKey", () => {
  it("writes the keys file at mode 0600 and mutates process.env in place", () => {
    setKey("deepseek", "sk-deepseek-candidate");

    // env mutated live (the keystone).
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("sk-deepseek-candidate");

    // file written + 0600.
    const path = keysFile();
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);

    // file actually carries the value (at-rest plaintext, single-user).
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored).toEqual({ deepseek: "sk-deepseek-candidate" });
  });

  it("merges multiple keys into one file", () => {
    setKey("deepseek", "d1");
    setKey("google_places", "g1");
    const stored = JSON.parse(readFileSync(keysFile(), "utf8"));
    expect(stored).toEqual({ deepseek: "d1", google_places: "g1" });
    expect(process.env["GOOGLE_PLACES_API_KEY"]).toBe("g1");
  });

  it("rejects an id outside the four (the allow-list)", () => {
    expect(() => setKey("AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS", "x")).toThrow(UnknownSecretKeyError);
    expect(() => setKey("gemini", "x")).toThrow(UnknownSecretKeyError);
    // No file leaked, no system var touched.
    expect(existsSync(keysFile())).toBe(false);
    expect(process.env[SYSTEM_VAR]).toBeUndefined();
  });
});

describe("getKeyPresence", () => {
  it("reports presence (never a value) and reflects file + env", () => {
    // empty → all absent.
    expect(getKeyPresence()).toEqual({
      deepseek: { present: false },
      anthropic: { present: false },
      openai: { present: false },
      google_places: { present: false },
    });

    setKey("anthropic", "secret-value-must-not-leak");
    const presence = getKeyPresence();
    expect(presence.anthropic).toEqual({ present: true });
    // presence object carries no value anywhere.
    expect(JSON.stringify(presence)).not.toContain("secret-value-must-not-leak");

    // an env-supplied key with no file entry still counts as present.
    process.env["OPENAI_API_KEY"] = "env-only-key";
    expect(getKeyPresence().openai).toEqual({ present: true });
  });
});

describe("clearKey", () => {
  it("removes the file entry and deletes the env var", () => {
    setKey("deepseek", "d1");
    setKey("openai", "o1");
    clearKey("deepseek");

    expect(process.env["DEEPSEEK_API_KEY"]).toBeUndefined();
    const stored = JSON.parse(readFileSync(keysFile(), "utf8"));
    expect(stored).toEqual({ openai: "o1" });
    expect(getKeyPresence().deepseek).toEqual({ present: false });
  });

  it("removes the file entirely when the last key is cleared", () => {
    setKey("deepseek", "d1");
    clearKey("deepseek");
    expect(existsSync(keysFile())).toBe(false);
  });

  it("rejects an id outside the four", () => {
    expect(() => clearKey("PORT")).toThrow(UnknownSecretKeyError);
  });
});

describe("loadSecretsIntoEnv", () => {
  it("seeds process.env from a written file (missing file is a no-op)", () => {
    // missing file → no throw, no env set.
    loadSecretsIntoEnv();
    for (const v of ALL_VARS) expect(process.env[v]).toBeUndefined();

    // write keys via setKey (which also sets env), then clear env to simulate a
    // fresh process, then loadSecretsIntoEnv should restore them from the file.
    setKey("deepseek", "d1");
    setKey("google_places", "g1");
    delete process.env["DEEPSEEK_API_KEY"];
    delete process.env["GOOGLE_PLACES_API_KEY"];

    loadSecretsIntoEnv();
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("d1");
    expect(process.env["GOOGLE_PLACES_API_KEY"]).toBe("g1");
  });

  it("never touches a system var", () => {
    setKey("deepseek", "d1");
    loadSecretsIntoEnv();
    expect(process.env[SYSTEM_VAR]).toBeUndefined();
  });
});
