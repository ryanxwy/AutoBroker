#!/usr/bin/env node
/**
 * demo.mjs — thin launcher for the zero-config seeded demo.
 *
 * Boots the backend with the sample-data seed, force-pinned to `test` mode, and
 * echoes the one next action. It is intentionally NOT a multi-process
 * orchestrator (an explicit non-goal): it starts the backend only; the UI stays
 * a separate command. The seed is idempotent and runs in an isolated demo DB —
 * no keys, no network, nothing leaves this machine.
 *
 * Run:  pnpm demo
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";

const ROOT = process.cwd();
const SERVER = join(ROOT, "apps", "server", "dist", "index.js");

// Isolate the demo into a `/demo` subdir of the data dir, mirroring the desktop
// launcher (apps/desktop demoDataDir = ~/.autobroker-ts/demo). The seed only
// fires on an empty DB, so without this it would write sample rows into the
// REAL product DB on a fresh install — never let demo touch real data.
const baseDir = (process.env.AUTOBROKER_DATA_DIR || "~/.autobroker-ts").replace(/^~/, homedir());
const demoDir = join(baseDir, "demo");
const env = {
  ...process.env,
  AUTOBROKER_DATA_DIR: demoDir, // isolated demo DB, never the real ~/.autobroker-ts/autobroker.db
  AUTOBROKER_DEMO_SEED: "1",
  AUTOBROKER_MODE: "test", // demo is fake-only; boot also force-pins test
  MASTRA_TELEMETRY_DISABLED: "1",
};

// Build the server once if it has never been built (keeps `pnpm demo` a single
// command for a fresh checkout; idempotent, so repeat runs skip straight to launch).
if (!existsSync(SERVER)) {
  console.log("Building the server once (apps/server)…");
  execSync("pnpm --filter @autobroker/server build", { stdio: "inherit" });
}

console.log(
  `\nAutoBroker demo — seeded sample data · no keys · mode=test (nothing leaves this machine).\n` +
    `  data dir : ${demoDir}  (isolated demo database — your real data dir is untouched)\n` +
    `  next     : in a second terminal run  \x1b[1mpnpm --filter @autobroker/ui dev\x1b[0m  then open  \x1b[1mhttp://localhost:5173\x1b[0m\n`,
);

const child = spawn(process.execPath, [SERVER], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
