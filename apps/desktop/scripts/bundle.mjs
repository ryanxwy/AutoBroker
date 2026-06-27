/**
 * bundle.mjs — build the self-contained desktop server bundle (idempotent).
 *
 * The repo's node_modules carries better-sqlite3 compiled for the SYSTEM Node
 * ABI; a utilityProcess runs Electron's bundled Node (a different ABI), so the
 * shell forks its OWN bundle with its OWN Electron-ABI native deps instead of
 * polluting the workspace install. Four steps:
 *
 *   1. esbuild apps/server/dist/index.js (+ a tiny boot wrapper, below) into
 *      bundle/server.cjs — platform=node, format=cjs, everything inlined
 *      EXCEPT three packages that cannot be inlined:
 *        - better-sqlite3 (native addon; product DB; per-ABI prebuilds)
 *        - libsql (mastra.db storage via @mastra/libsql → @libsql/client; its
 *          loader does a runtime platform-specific require of a NAPI .node
 *          binary)
 *        - playwright (esbuild-hostile: playwright-core hard-requires the
 *          optional chromium-bidi package and the fsevents .node binary, and
 *          its browser registry resolves assets relative to its own package
 *          dir — it must stay a real package in bundle/node_modules)
 *   2. copy apps/ui/dist → bundle/ui-dist (served via AUTOBROKER_UI_DIST)
 *   3. copy packages/db/drizzle → bundle/drizzle (the committed migration set;
 *      the boot wrapper applies it to a FRESH data dir — the server itself
 *      never applies migrations)
 *   4. write bundle/package.json (better-sqlite3 + libsql only) and
 *      npm-install it with npm_config_runtime=electron + the pinned Electron
 *      version, so prebuild-install fetches the Electron-ABI binary (zero
 *      compile); then prove the ABI by requiring better-sqlite3 inside the
 *      Electron binary in Node mode. The npm-install + ABI-proof are SKIPPED
 *      when bundle/.deps-stamp shows the native deps are unchanged (so a repeat
 *      bundle does no network I/O); package.json is still written every run.
 *
 * ELECTRON VERSION BUMP-GATE (checked 2026-06-12): pin the newest Electron
 * major that has an official better-sqlite3 prebuild asset. Verify with
 *   gh api repos/WiseLibs/better-sqlite3/releases/latest --jq '.assets[].name'
 * Today: assets stop at electron-v145 (= Electron 41); no electron-v146
 * (= Electron 42) asset exists → Electron stays pinned at 41. No auto-bump.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url)); // apps/desktop/scripts
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const bundleDir = join(desktopDir, "bundle");
const serverDist = join(repoRoot, "apps", "server", "dist");
const uiDist = join(repoRoot, "apps", "ui", "dist");
const drizzleDir = join(repoRoot, "packages", "db", "drizzle");

const desktopRequire = createRequire(join(desktopDir, "package.json"));
const electronVersion = desktopRequire("electron/package.json").version;
const electronBin = desktopRequire("electron"); // path string when required under plain Node

/** Resolve a dependency's installed version from the workspace package that
 *  declares it (pnpm isolation: hop package by package, never guess paths).
 *  Resolves each dep's ENTRY file and walks up to its package root — some
 *  packages (e.g. @libsql/client) do not export ./package.json. */
function installedVersion(fromPkgDir, chain) {
  let pkgDir = fromPkgDir;
  let version = "";
  for (const dep of chain) {
    const req = createRequire(join(pkgDir, "package.json"));
    let dir = dirname(req.resolve(dep));
    for (;;) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pj = JSON.parse(readFileSync(candidate, "utf8"));
        if (pj.name === dep) {
          ({ version } = pj);
          pkgDir = dir;
          break;
        }
      }
      if (dir === dirname(dir)) throw new Error(`package root for ${dep} not found`);
      dir = dirname(dir);
    }
  }
  return version;
}

for (const [dir, hint] of [
  [serverDist, "pnpm --filter @autobroker/server build"],
  [uiDist, "pnpm --filter @autobroker/ui build"],
]) {
  if (!existsSync(join(dir, dir === uiDist ? "index.html" : "index.js"))) {
    console.error(`bundle: missing ${dir} — run \`${hint}\` (or root \`pnpm build\`) first`);
    process.exit(1);
  }
}
mkdirSync(bundleDir, { recursive: true });

// ---- 1. server.cjs ---------------------------------------------------------
// Boot wrapper: provision a FRESH data dir (the dev/harness data dirs are
// provisioned by their own hosts; the bundled server has no other migration
// path), then start the server via its exported main(). Inlined as the esbuild
// entry so the migration code lives nowhere in the layered src tree — at
// runtime require("better-sqlite3") resolves to bundle/node_modules (the
// Electron-ABI build) because server.cjs sits inside bundle/.
const entrySource = `
const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");

function expandTilde(p) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

// Same resolution order as the db client: AUTOBROKER_DB file override beats
// AUTOBROKER_DATA_DIR beats the ~/.autobroker-ts default.
const explicitDb = process.env.AUTOBROKER_DB;
const dataDir = expandTilde(process.env.AUTOBROKER_DATA_DIR || join(homedir(), ".autobroker-ts"));
const dbPath = explicitDb ? expandTilde(explicitDb) : join(dataDir, "autobroker.db");

if (!existsSync(dbPath)) {
  // Fresh data dir: apply the committed migration set in journal order, then
  // seed the single local account that active-slot uniqueness + intake persist
  // expect (every provisioned environment has exactly one account row).
  const Database = require("better-sqlite3");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    const migrationsDir = join(__dirname, "drizzle");
    const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"));
    for (const entry of journal.entries) {
      db.exec(readFileSync(join(migrationsDir, entry.tag + ".sql"), "utf8"));
    }
    db.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-local-1", "owner@localhost");
    console.info(JSON.stringify({ server: "bootstrap", db: dbPath, migrations: journal.entries.length }));
  } finally {
    db.close();
  }
}

// DOUBLE-BOOT TRAP -- do not remove. apps/server/index.ts ends with an entry
// guard that calls main() when import.meta.url equals
// pathToFileURL(process.argv[1]).href -- meant to auto-start ONLY when index.js
// is run directly (the dev path). In THIS bundle that guard fires too: esbuild
// inlines index.ts here, the banner shims import.meta.url to
// pathToFileURL(__filename).href (the server.cjs URL), and the utilityProcess
// runs server.cjs, so process.argv[1] is also server.cjs -- the guard's
// equality is TRUE and it auto-fires main(). Combined with the explicit main()
// below, that boots the HTTP server + scheduler TWICE (two listen ports, two
// armed schedulers, two recovery passes). Blank argv[1] so the inlined guard
// stays FALSE; this wrapper's explicit main() is then the single, deterministic
// boot path. (Leave the import.meta.url shim a valid string -- packages/db's
// migrator does an eager fileURLToPath on it.)
process.argv[1] = "";

const { main } = require("./index.js");
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

await build({
  stdin: { contents: entrySource, resolveDir: serverDist, sourcefile: "desktop-server-entry.cjs" },
  outfile: join(bundleDir, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["better-sqlite3", "libsql", "playwright"],
  // esbuild emits `import.meta` as empty in a CJS bundle, so `import.meta.url`
  // is `undefined`. An EAGER `fileURLToPath(import.meta.url)` at module init
  // (e.g. packages/db migrator's DEFAULT_MIGRATIONS_FOLDER) then throws and
  // crashes the bundled server on boot. Shim import.meta.url to the bundle
  // file's own URL so every such usage resolves to a real string. The resolved
  // values are inert here anyway — boot applies migrations from bundle/drizzle
  // directly (never migrate()), and AUTOBROKER_UI_DIST bypasses the ui-dist
  // fallback — so only crash-avoidance matters.
  banner: { js: "const __IMPORT_META_URL__ = require('node:url').pathToFileURL(__filename).href;" },
  define: { "import.meta.url": "__IMPORT_META_URL__" },
  // Other (non-.url) import.meta usages stay empty; silence that residual noise.
  logOverride: { "empty-import-meta": "silent" },
});

// ---- 2 + 3. static assets ---------------------------------------------------
// apps/ui/dist mixes the served vite build (index.html + assets/) with tsc
// compile output (*.js/*.d.ts incl. compiled *.test.js). Drop the test/types
// artifacts so the gitignored bundle never resurfaces them to tooling scans.
for (const [src, dest] of [
  [uiDist, join(bundleDir, "ui-dist")],
  [drizzleDir, join(bundleDir, "drizzle")],
]) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => !/\.(test\.js|test\.d\.ts|d\.ts|js\.map|d\.ts\.map|tsbuildinfo)$/.test(p),
  });
}

// ---- 4. runtime deps the bundle keeps as real packages ----------------------
// Versions pinned to what the workspace resolved, so bundle and dev run the
// exact same code (and playwright reuses the browser builds already cached).
const nativeDeps = {
  "better-sqlite3": installedVersion(join(repoRoot, "packages", "db"), ["better-sqlite3"]),
  libsql: installedVersion(join(repoRoot, "packages", "workflows"), [
    "@mastra/libsql",
    "@libsql/client",
    "libsql",
  ]),
  playwright: installedVersion(join(repoRoot, "packages", "tools"), ["playwright"]),
};
// Always write package.json — ensures it reflects the current workspace
// versions even on a skip-install run (e.g. after a package.json deletion).
writeFileSync(
  join(bundleDir, "package.json"),
  JSON.stringify(
    {
      name: "autobroker-desktop-bundle",
      private: true,
      description: "Generated by scripts/bundle.mjs — Electron-ABI native deps for bundle/server.cjs. Never committed.",
      dependencies: nativeDeps,
    },
    null,
    2,
  ) + "\n",
);

// Stamp: SHA-256 of the exact set of native-dep versions + Electron version.
// Written to bundle/.deps-stamp after a successful install + ABI proof. On the
// next run, if the stamp matches and node_modules/better-sqlite3 still exists
// (guard against a deleted/corrupt node_modules with a stale stamp), skip the
// npm install and ABI proof entirely so offline rebuilds succeed and the common
// case is fast. The stamp file lives inside bundle/ which is gitignored.
const depsStampContent = JSON.stringify({
  electronVersion,
  "better-sqlite3": nativeDeps["better-sqlite3"],
  libsql: nativeDeps.libsql,
  playwright: nativeDeps.playwright,
});
const depsStamp = createHash("sha256").update(depsStampContent).digest("hex");
const stampPath = join(bundleDir, ".deps-stamp");

const savedStamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : null;
const nativeInstalled = existsSync(join(bundleDir, "node_modules", "better-sqlite3"));

if (savedStamp === depsStamp && nativeInstalled) {
  console.log(`bundle: native deps unchanged, skipping install (${depsStamp.slice(0, 7)})`);
} else {
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: bundleDir,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_runtime: "electron",
      npm_config_target: electronVersion,
      npm_config_disturl: "https://electronjs.org/headers",
    },
  });

  // ABI proof: require better-sqlite3 inside Electron's Node (the exact runtime
  // utilityProcess uses). A system-ABI binary would throw ERR_DLOPEN_FAILED here.
  execFileSync(
    electronBin,
    ["-e", "require('better-sqlite3')(':memory:').prepare('select 1 as ok').get(); console.log('abi-ok');"],
    { cwd: bundleDir, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
  );

  // Write stamp ONLY after both install and ABI proof succeed; a failed install
  // must not leave a "fresh" stamp that would cause the next run to skip a
  // necessary reinstall.
  writeFileSync(stampPath, depsStamp + "\n");
}

console.log(
  `bundle: OK (electron ${electronVersion}, better-sqlite3 ${nativeDeps["better-sqlite3"]}, libsql ${nativeDeps.libsql}, playwright ${nativeDeps.playwright})`,
);
