/**
 * loadDotEnvKeys unit tests — the data-dir-INDEPENDENT `.env` fallback for the
 * four provider keys. Against an ISOLATED tmp dir holding a temp .env (saved /
 * restored). Pins: loads only the four allow-listed key vars from .env; IGNORES
 * every other var; NO-CLOBBER (an ambient/exported key wins); missing/malformed
 * .env is a no-op (never throws); quoted + `export` forms parse; getKeyPresence
 * reflects a key supplied only via .env; keys.json (loadSecretsIntoEnv) wins over
 * .env because it runs after and clobbers.
 *
 * NEVER ~/.autobroker* — every case runs in a fresh os.tmpdir() subdir.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getKeyPresence, loadDotEnvKeys, loadSecretsIntoEnv, setKey } from "./secretsStore.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";

let tmpDir: string;
let envFile: string;
let originalDataDir: string | undefined;

// The five provider env vars + the non-allow-listed vars we assert stay untouched.
const KEY_VARS = [
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_PLACES_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;
const NON_KEY_VARS = ["TELEGRAM_BOT_TOKEN", "OBSIDIAN_VAULT", "AUTOBROKER_DATA_DIR_X"] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  tmpDir = mkdtempSync(join(tmpdir(), "dotenv-keys-"));
  envFile = join(tmpDir, ".env");
  process.env[DATA_DIR] = tmpDir;
  for (const v of [...KEY_VARS, ...NON_KEY_VARS]) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  for (const v of [...KEY_VARS, ...NON_KEY_VARS]) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadDotEnvKeys", () => {
  it("loads the four allow-listed key vars from an explicit .env into process.env", () => {
    writeFileSync(
      envFile,
      [
        "DEEPSEEK_API_KEY=d1",
        "ANTHROPIC_API_KEY=a1",
        "OPENAI_API_KEY=o1",
        "GOOGLE_PLACES_API_KEY=g1",
      ].join("\n"),
    );
    loadDotEnvKeys(envFile);
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("d1");
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("a1");
    expect(process.env["OPENAI_API_KEY"]).toBe("o1");
    expect(process.env["GOOGLE_PLACES_API_KEY"]).toBe("g1");
  });

  it("IGNORES every non-allow-listed var in the .env (allow-list discipline)", () => {
    writeFileSync(
      envFile,
      [
        "DEEPSEEK_API_KEY=d1",
        "TELEGRAM_BOT_TOKEN=should-not-load",
        "OBSIDIAN_VAULT=/some/path",
        "AUTOBROKER_DATA_DIR_X=nope",
      ].join("\n"),
    );
    loadDotEnvKeys(envFile);
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("d1");
    for (const v of NON_KEY_VARS) expect(process.env[v]).toBeUndefined();
  });

  it("NO-CLOBBER: a key already present in process.env is left unchanged", () => {
    process.env["DEEPSEEK_API_KEY"] = "ambient-wins";
    writeFileSync(envFile, "DEEPSEEK_API_KEY=dotenv-loses\nANTHROPIC_API_KEY=a1");
    loadDotEnvKeys(envFile);
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("ambient-wins");
    // a var that WAS unset is filled.
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("a1");
  });

  it("treats an empty existing value as unset and fills it", () => {
    process.env["DEEPSEEK_API_KEY"] = "";
    writeFileSync(envFile, "DEEPSEEK_API_KEY=filled");
    loadDotEnvKeys(envFile);
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("filled");
  });

  it("missing .env file → no-op, no throw", () => {
    const missing = join(tmpDir, "does-not-exist.env");
    expect(() => loadDotEnvKeys(missing)).not.toThrow();
    for (const v of KEY_VARS) expect(process.env[v]).toBeUndefined();
  });

  it("skips blank lines, comments, and malformed lines without throwing", () => {
    writeFileSync(
      envFile,
      [
        "",
        "# a comment",
        "   # indented comment",
        "garbage-without-equals",
        "=novarname",
        "DEEPSEEK_API_KEY=d1",
      ].join("\n"),
    );
    expect(() => loadDotEnvKeys(envFile)).not.toThrow();
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("d1");
  });

  it("strips one layer of matching single/double quotes and parses the `export` form", () => {
    writeFileSync(
      envFile,
      [
        `DEEPSEEK_API_KEY="d-double"`,
        `ANTHROPIC_API_KEY='a-single'`,
        `export OPENAI_API_KEY=o-exported`,
        `GOOGLE_PLACES_API_KEY=  g-trimmed  `,
      ].join("\n"),
    );
    loadDotEnvKeys(envFile);
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("d-double");
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("a-single");
    expect(process.env["OPENAI_API_KEY"]).toBe("o-exported");
    // unquoted value: trailing whitespace trimmed.
    expect(process.env["GOOGLE_PLACES_API_KEY"]).toBe("g-trimmed");
  });

  it("getKeyPresence reports present:true for a key supplied only via .env (UI reflection)", () => {
    writeFileSync(envFile, "DEEPSEEK_API_KEY=from-dotenv");
    expect(getKeyPresence().deepseek).toEqual({ present: false });
    loadDotEnvKeys(envFile);
    expect(getKeyPresence().deepseek).toEqual({ present: true });
  });

  it("precedence: keys.json (loadSecretsIntoEnv) wins over .env when run after", () => {
    // .env supplies the value first (env was unset)...
    writeFileSync(envFile, "DEEPSEEK_API_KEY=from-dotenv");
    loadDotEnvKeys(envFile);
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("from-dotenv");
    // ...then keys.json is written + loadSecretsIntoEnv clobbers (canonical wins).
    setKey("deepseek", "from-keysjson");
    delete process.env["DEEPSEEK_API_KEY"]; // simulate a fresh process env
    loadDotEnvKeys(envFile); // .env fills the gap...
    loadSecretsIntoEnv(); // ...keys.json runs after and wins.
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("from-keysjson");
  });

  it("never leaks a key value (no throw exposes it); a directory at the path is a no-op", () => {
    // Passing a directory path (unreadable as a file content in a useful way) must
    // not throw — fail safe to "nothing to load".
    expect(() => loadDotEnvKeys(tmpDir)).not.toThrow();
  });

  it("loads CLAUDE_CODE_OAUTH_TOKEN from .env into process.env (no-clobber)", () => {
    writeFileSync(envFile, "CLAUDE_CODE_OAUTH_TOKEN=tok-from-dotenv\n");
    loadDotEnvKeys(envFile);
    expect(process.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-from-dotenv");

    // NO-CLOBBER: an existing value wins.
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "ambient-wins";
    writeFileSync(envFile, "CLAUDE_CODE_OAUTH_TOKEN=tok-loses\n");
    loadDotEnvKeys(envFile);
    expect(process.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("ambient-wins");
  });
});
