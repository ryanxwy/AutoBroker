#!/usr/bin/env node
/**
 * doctor.mjs — AutoBroker read-only environment self-check.
 *
 * Composes the checks a fresh user (or a setup agent) needs before the app will
 * run, and prints the literal fix for each failure. It is a CHECKER, NOT a
 * FIXER: it never writes .env / keys.json, never starts the server, never mints
 * a key, never sets AUTOBROKER_MODE, and never prints or leaks a secret VALUE —
 * keys are reported by PRESENCE only (a value is read only to test truthiness,
 * never logged).
 *
 * Exit 0 = ready; exit 1 = at least one hard check failed (with its fix above).
 * Run:  pnpm doctor   (or: node scripts/doctor.mjs)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";

const NODE_FLOOR = [24, 13, 0]; // package.json engines: ">=24.13.0"
const PROVIDER_KEYS = ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
const PLACES_KEY = "GOOGLE_PLACES_API_KEY";

const C = { ok: "\x1b[32m", warn: "\x1b[33m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };
let hardFail = false;
const pass = (m) => console.log(`  ${C.ok}✓${C.off} ${m}`);
const warn = (m, fix) => console.log(`  ${C.warn}⚠${C.off} ${m}${fix ? `\n      ${C.dim}fix:${C.off} ${fix}` : ""}`);
const fail = (m, fix) => {
  hardFail = true;
  console.log(`  ${C.bad}✗${C.off} ${m}${fix ? `\n      ${C.dim}fix:${C.off} ${fix}` : ""}`);
};

function expandHome(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// --- Resolve the data dir the app would use ---------------------------------
const DATA_DIR = expandHome(process.env.AUTOBROKER_DATA_DIR || "~/.autobroker-ts");

console.log(`\nAutoBroker doctor — read-only environment check\n${"─".repeat(48)}`);

// 1) Node version (hard floor) ------------------------------------------------
{
  const cur = process.versions.node.split(".").map(Number);
  const okVer =
    cur[0] > NODE_FLOOR[0] ||
    (cur[0] === NODE_FLOOR[0] && (cur[1] > NODE_FLOOR[1] || (cur[1] === NODE_FLOOR[1] && cur[2] >= NODE_FLOOR[2])));
  if (okVer) pass(`Node ${process.versions.node} (>= 24.13.0)`);
  else
    fail(
      `Node ${process.versions.node} is below the required 24.13.0`,
      "install Node >= 24.13.0 — note .nvmrc pins only major '24', so `nvm install 24.13` (not just `nvm use 24`)",
    );
}

// 2) pnpm present + v9 --------------------------------------------------------
{
  try {
    const v = execSync("pnpm -v", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (v.startsWith("9.")) pass(`pnpm ${v}`);
    else warn(`pnpm ${v} (repo pins pnpm@9)`, "corepack use pnpm@9  (or: npm i -g pnpm@9)");
  } catch {
    fail("pnpm not found", "corepack enable && corepack use pnpm@9  (or: npm i -g pnpm@9)");
  }
}

// 3) Dependencies installed ---------------------------------------------------
{
  if (existsSync(join(process.cwd(), "node_modules"))) pass("dependencies installed (node_modules present)");
  else fail("node_modules missing", "pnpm install");
}

// 4) better-sqlite3 native module loads (best-effort) -------------------------
{
  try {
    const { createRequire } = await import("node:module");
    const dbPkg = join(process.cwd(), "packages", "db", "package.json");
    const req = createRequire(existsSync(dbPkg) ? dbPkg : join(process.cwd(), "package.json"));
    const Database = req("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("create table _doctor(x)");
    db.close();
    pass("better-sqlite3 native module loads (Node ABI OK)");
  } catch (e) {
    const msg = String(e).split("\n")[0];
    if (/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(msg)) {
      warn("better-sqlite3 not resolved (deps not fully installed?)", "pnpm install");
    } else {
      // A genuine load/ABI failure is boot-fatal — the product DB can't open.
      fail(`better-sqlite3 failed to load (likely a Node 24 ABI mismatch): ${msg}`, "rebuild it: in node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 run `rm -rf build && npx node-gyp rebuild`");
    }
  }
}

// 5) Data dir isolation -------------------------------------------------------
{
  const legacy = expandHome("~/.autobroker");
  if (DATA_DIR === legacy)
    warn(
      `AUTOBROKER_DATA_DIR points at the legacy ${legacy}`,
      "set AUTOBROKER_DATA_DIR=~/.autobroker-ts (isolated from the legacy Python store)",
    );
  else pass(`data dir isolated: ${DATA_DIR}`);
}

// 6) Provider key presence (PRESENCE ONLY — never the value) ------------------
{
  // keys.json is keyed by wire id ("deepseek", "google_places"), not the env-var
  // name — map them so a key saved via the Settings UI is detected as present.
  const ID_TO_ENV = {
    deepseek: "DEEPSEEK_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google_places: "GOOGLE_PLACES_API_KEY",
  };
  const keysJson = join(DATA_DIR, "settings", "keys.json");
  const fromKeysJson = new Set();
  if (existsSync(keysJson)) {
    try {
      const obj = JSON.parse(readFileSync(keysJson, "utf8"));
      for (const [k, v] of Object.entries(obj)) {
        const envName = ID_TO_ENV[k.toLowerCase()];
        if (v && envName) fromKeysJson.add(envName);
      }
    } catch {
      /* unreadable keys.json — treated as no keys */
    }
  }
  const presentIn = (envName) => {
    if (process.env[envName] && process.env[envName].length > 0) return "env";
    if (fromKeysJson.has(envName)) return "keys.json";
    return null;
  };
  const llm = PROVIDER_KEYS.map((k) => [k, presentIn(k)]).filter(([, s]) => s);
  if (llm.length) pass(`LLM provider key present: ${llm.map(([k, s]) => `${k.replace("_API_KEY", "")} (${s})`).join(", ")}`);
  else warn("no LLM provider key found", "paste a DeepSeek key in Settings (docs/onboarding/CREDENTIALS_SETUP.md), or run the demo: AUTOBROKER_DEMO_SEED=1");
  if (presentIn(PLACES_KEY)) pass("Google Places key present (dealer search enabled)");
  else warn("no Google Places key (dealer search will suspend at the location step)", "see CREDENTIALS_SETUP.md §4 — required before searching for dealers");
}

// 7) Send mode clarity (NEVER changes it — reports only) ----------------------
{
  const raw = process.env.AUTOBROKER_MODE;
  const mode = raw === "test" ? "test" : "buyer"; // mirrors realSend.ts: only exact "test" is test
  if (mode === "test") pass(`AUTOBROKER_MODE = test (safe: every send is the local fake mailbox)`);
  else
    warn(
      `AUTOBROKER_MODE resolves to BUYER (real-send-capable)${raw === undefined ? " — unset/empty resolves buyer" : raw === "buyer" ? "" : ` — value ${JSON.stringify(raw)} is not the exact string "test"`}`,
      'real sends still pass through L2 approval; approval is manual unless Automatic send approvals is enabled. Set AUTOBROKER_MODE=test to keep everything local. (Anything but exact "test" is buyer.)',
    );
}

// 8) Mastra telemetry disabled (local-first invariant) ------------------------
{
  if (process.env.MASTRA_TELEMETRY_DISABLED === "1") pass("MASTRA_TELEMETRY_DISABLED = 1 (no PostHog egress)");
  else fail("MASTRA_TELEMETRY_DISABLED is not 1 (Mastra may phone home to PostHog)", "export MASTRA_TELEMETRY_DISABLED=1 (keep it in your .env)");
}

// 9) gitignore sanity for secret paths (best-effort) --------------------------
{
  let inGitTree = false;
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    inGitTree = true;
  } catch {
    /* not a git working tree */
  }
  if (!inGitTree) {
    console.log(`  ${C.dim}·${C.off} gitignore check skipped (not a git working tree)`);
  } else {
    let ignored = false;
    try {
      execSync(`git check-ignore -q ${JSON.stringify(".env")}`, { stdio: "ignore" });
      ignored = true; // exit 0 = path is ignored
    } catch {
      ignored = false; // exit 1 = not ignored
    }
    if (ignored) pass(".env is gitignored");
    else warn(".env may not be gitignored — never commit a secret", "confirm .env is in .gitignore before pasting any key into it");
  }
}

// 10) /api/mode reachable (best-effort; server may not be running) ------------
{
  const got = await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: 8100, path: "/api/mode", timeout: 1200 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
  if (got && got.active_db) pass(`server up: /api/mode active_db = ${got.active_db}${got.demo ? " (demo)" : ""}`);
  else console.log(`  ${C.dim}·${C.off} server not running on 127.0.0.1:8100 (start it with: node apps/server/dist/index.js)`);
}

// --- Verdict -----------------------------------------------------------------
console.log("─".repeat(48));
if (hardFail) {
  console.log(`${C.bad}doctor: not ready${C.off} — fix the ✗ items above, then re-run \`pnpm doctor\`.\n`);
  process.exit(1);
}
console.log(`${C.ok}doctor: ready${C.off} — no blocking issues. (⚠ items are optional / situational.)\n`);
