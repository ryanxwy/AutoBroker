/**
 * Cross-process crash-and-resume spike: a form-suspend survives a process kill +
 * restart and can be resumed; decline/cancel produce zero writes.
 *
 * child A boots the REAL server (ephemeral port, tmp data dir) → POST start →
 * reach awaiting_user@collect → SIGKILL. child B boots fresh on the SAME data dir
 * → recoverOnBoot re-attaches the suspended run → POST form-decision decline →
 * declined + zero writes. Decline avoids needing geocode/LLM in the child; the
 * resume-ability across a process boundary + the zero-write are the proof.
 *
 * The children import the BUILT dist (apps/server/dist + the workspace package
 * dists), so this suite builds the server package first. It is the ONE suite that
 * shells out + spawns; the rest run in-process via inject().
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR for BOTH children;
 * the L1 BLOCK fuse is armed; telemetry silenced; NEVER ~/.autobroker*.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/tools";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, "..");
const repoRoot = join(serverRoot, "..", "..");
const MIGRATION_SQL = join(
  repoRoot,
  "packages",
  "db",
  "drizzle",
  "0000_military_red_skull.sql",
);
const CHILD_A = join(serverRoot, "spikes", "childA-start-suspend.mjs");
const CHILD_B = join(serverRoot, "spikes", "childB-recover-decline.mjs");

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;

/** The env both children inherit: isolated data dir + armed fuse + silent telem. */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AUTOBROKER_DATA_DIR: tmpDir,
    AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS: "1",
    MASTRA_TELEMETRY_DISABLED: "1",
    PORT: "0",
    // Never auto-approve (keep the gate live); never point at production.
    AUTOBROKER_TEST_AUTO_APPROVE: "",
    AUTOBROKER_DB: "",
  };
}

beforeAll(() => {
  // Build the server (and its workspace deps) so the .mjs children import dist.
  execFileSync("pnpm", ["--filter", "@autobroker/server", "run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}, 180_000);

beforeEach(() => {
  originalDataDir = process.env.AUTOBROKER_DATA_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-xproc-"));
  process.env.AUTOBROKER_DATA_DIR = tmpDir;
  db = openDb();
  db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-1", "a@e.com");
  db.$client.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.AUTOBROKER_DATA_DIR;
  else process.env.AUTOBROKER_DATA_DIR = originalDataDir;
});

/** Spawn child A, resolve with its runId once it prints READY. */
function startChildAUntilReady(): Promise<{ pid: number; runId: string; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CHILD_A], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let runId: string | undefined;
    let out = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`childA did not become READY in time; output:\n${out}`));
    }, 60_000);

    child.stdout.on("data", (buf) => {
      out += buf.toString();
      const m = /RUNID=(\S+)/.exec(out);
      if (m) runId = m[1];
      if (out.includes("READY") && runId !== undefined) {
        clearTimeout(timeout);
        resolve({
          pid: child.pid!,
          runId,
          kill: () => child.kill("SIGKILL"),
        });
      }
    });
    child.stderr.on("data", (buf) => {
      out += buf.toString();
    });
    child.on("exit", (code) => {
      if (runId === undefined) {
        clearTimeout(timeout);
        reject(new Error(`childA exited (code ${code}) before READY; output:\n${out}`));
      }
    });
  });
}

/** Run child B with the runId; resolve with the parsed RESULT line. */
function runChildB(runId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CHILD_B, runId], {
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (out += b.toString()));
    child.on("exit", (code) => {
      const m = /RESULT=(\{.*\})/.exec(out);
      if (m) {
        resolve(JSON.parse(m[1]!));
      } else {
        reject(new Error(`childB produced no RESULT (exit ${code}); output:\n${out}`));
      }
    });
  });
}

describe("cross-process crash-and-resume", () => {
  it(
    "childA start→suspend→SIGKILL; childB recovers→decline→declined, zero writes",
    async () => {
      const a = await startChildAUntilReady();
      expect(a.runId).toBeTruthy();

      // Hard-kill child A mid-suspend (the run lives only in the durable snapshot).
      a.kill();
      // Give the OS a moment to release the process + flush the mastra.db write.
      await new Promise((r) => setTimeout(r, 500));

      const result = await runChildB(a.runId);

      expect(result.recovered).toBe(true); // recoverOnBoot found the suspended run.
      expect(result.reattached).toBe(true); // re-attached in the fresh process.
      expect(result.declineCode).toBe(200); // the decline form-decision succeeded.
      expect(result.status).toBe("declined"); // terminal declined.
      expect(result.profiles).toBe(0); // ZERO search_profiles writes.
      expect(result.audits).toBe(0); // ZERO audit_log writes.

      // Double-check against the DB directly from the parent.
      const check = openDb();
      const profiles = check.$client.prepare("SELECT COUNT(*) AS n FROM search_profiles").get() as { n: number };
      check.$client.close();
      expect(profiles.n).toBe(0);
    },
    120_000,
  );
});
