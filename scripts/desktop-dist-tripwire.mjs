#!/usr/bin/env node
/**
 * desktop-dist-tripwire.mjs — verifies that a packed AutoBroker.app contains
 * no dev-only freshness machinery or test-mode tokens.
 *
 * Usage:
 *   node scripts/desktop-dist-tripwire.mjs [<release-dir>]
 *   TRIPWIRE_RELEASE_DIR=<dir> node scripts/desktop-dist-tripwire.mjs
 *
 * <release-dir> defaults to apps/desktop/release (relative to repo root).
 * The .app is found by scanning mac-<arch>/AutoBroker.app inside that dir.
 *
 * Exit 0 — .app is clean.
 * Exit 1 — .app absent (run electron-builder first) OR contamination found.
 *
 * What we are catching: a LEAKED MARKER (the external freshness marker, or the
 * abandoned in-bundle "dev-origin" draft, accidentally shipped INSIDE the .app)
 * and a test-mode token baked into the packed server bundle. A leaked marker is
 * a FILE, so we detect it by FILE IDENTITY — never by substring-scanning source
 * text. The compiled launch-check code legitimately ships inside app.asar and
 * contains the marker FIELD NAMES (`repoPath`, `builtStamp`) and the data-dir
 * sub-path (`desktop-refresh/`) as live property accesses + JSDoc; a raw
 * substring scan would false-positive on that asar on every real build. So:
 *
 *   RULE A — Leaked marker by FILE IDENTITY: for each `.json` file under the
 *     .app, JSON.parse it; if it parses to an OBJECT carrying the marker
 *     key-set (`repoPath` AND `builtStamp` AND `schemaVersion`/`frameworkStamp`)
 *     → FAIL. The external marker lives outside the .app at
 *     ~/.autobroker-ts/desktop-refresh/<hash>.json and must never ship inside
 *     the bundle. A real app.asar is a binary concat — it will NOT JSON.parse to
 *     such an object (and it does not end in .json), so the asar never trips.
 *
 *   RULE B — Abandoned draft marker FILE: any file whose BASENAME matches
 *     `dev-origin` (e.g. dev-origin.json) → FAIL. A leaked draft marker would be
 *     a file; we check the file's identity, NOT its contents (check:strings
 *     already bans the literal in tracked source, and the asar holds it as
 *     compiled launch-check source).
 *
 *   RULE C — Test-mode auto-approve token in server.cjs: the packed
 *     Contents/Resources/bundle/server.cjs must not contain
 *     AUTOBROKER_TEST_AUTO_APPROVE. The build env is sanitised before
 *     electron-builder runs (that token is deleted from env), so its presence
 *     in the bundle means the server was compiled with test-mode env baked in.
 *     This is the one correctly-narrow content scan (server.cjs only).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// ---------------------------------------------------------------------------
// Locate the .app under the release dir
// ---------------------------------------------------------------------------

const releaseDir =
  process.argv[2] ??
  process.env.TRIPWIRE_RELEASE_DIR ??
  join(REPO_ROOT, "apps", "desktop", "release");

let appRoot = null;
if (existsSync(releaseDir)) {
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("mac")) {
      const candidate = join(releaseDir, entry.name, "AutoBroker.app");
      if (existsSync(candidate)) {
        appRoot = candidate;
        break;
      }
    }
  }
}

if (!appRoot) {
  console.error(
    `ERROR: AutoBroker.app not found under ${releaseDir}.\n` +
      `Run electron-builder first (e.g. pnpm desktop:pack) before running this tripwire.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

let violations = 0;

function reportFail(msg) {
  console.error(`FAIL: ${msg}`);
  violations++;
}

/** Walk all regular files under dir (symlinks skipped), calling cb(path). */
function walk(dir, cb) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(full, cb);
    } else if (entry.isFile()) {
      cb(full);
    }
  }
}

/** Return true if the Buffer contains the UTF-8 byte sequence for str. */
function bufHas(buf, str) {
  return buf.indexOf(Buffer.from(str, "utf8")) !== -1;
}

// The abandoned in-bundle marker draft name (kept as a plain literal — this file
// is excluded from the check:strings "dev-origin" rule because it is the scanner
// for that pattern). Matched against a file BASENAME, never substring-scanned.
const ABANDONED_DRAFT_BASENAME = /^dev-origin(\.|$)/i;
const AUTO_APPROVE_TOKEN = "AUTOBROKER_TEST_AUTO_APPROVE";

const serverCjsAbs = join(appRoot, "Contents", "Resources", "bundle", "server.cjs");

walk(appRoot, (file) => {
  const base = basename(file);

  // RULE B: abandoned draft marker FILE (by basename, not contents).
  if (ABANDONED_DRAFT_BASENAME.test(base)) {
    reportFail(`abandoned draft marker file present:\n  ${file}`);
    return;
  }

  // RULE A: leaked freshness marker by FILE IDENTITY. Only .json files are
  // candidates; a binary app.asar does not end in .json and would not parse to
  // the marker object even if it did, so this never false-positives on the asar.
  if (base.toLowerCase().endsWith(".json")) {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      parsed = null; // not JSON / not utf8 → not a marker
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "repoPath" in parsed &&
      "builtStamp" in parsed &&
      ("schemaVersion" in parsed || "frameworkStamp" in parsed)
    ) {
      reportFail(`leaked freshness marker (marker key-set) in JSON file:\n  ${file}`);
    }
  }

  // RULE C: test-mode token in the packed server bundle only.
  if (file === serverCjsAbs) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return; // unreadable — not a contamination
    }
    if (bufHas(buf, AUTO_APPROVE_TOKEN)) {
      reportFail(`"${AUTO_APPROVE_TOKEN}" in server.cjs:\n  ${file}`);
    }
  }
});

if (violations === 0) {
  console.log(`OK: ${appRoot} — no marker/test-mode leakage detected.`);
  process.exit(0);
} else {
  process.exit(1);
}
