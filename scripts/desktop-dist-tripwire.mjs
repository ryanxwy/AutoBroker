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
 * Contamination rules (all file reads use Buffer to safely handle binaries):
 *
 *   RULE 1 — Marker schema signature: any file containing BOTH the strings
 *     "repoPath" and "builtStamp". These are the two field names that identify
 *     the external freshness marker schema. The marker lives outside the .app
 *     at ~/.autobroker-ts/desktop-refresh/<hash>.json and must never be
 *     written into the bundle or shipped as extraResources.
 *
 *   RULE 2 — Abandoned draft name: any file containing the literal "dev-origin".
 *     This was the discarded name for a proposed in-bundle marker variant;
 *     banning its presence in the artifact mirrors the source-level check:strings
 *     rule that prevents re-introducing it.
 *
 *   RULE 3 — Marker home path fragment: any file containing "desktop-refresh/".
 *     The marker's data-dir sub-path must not be hard-wired into the shipped
 *     bundle (would only appear there by accident / a stale import).
 *
 *   RULE 4 — Test-mode auto-approve token in server.cjs: the packed
 *     Contents/Resources/bundle/server.cjs must not contain
 *     AUTOBROKER_TEST_AUTO_APPROVE. The build env is sanitised before
 *     electron-builder runs (that token is deleted from env), so its presence
 *     in the bundle means the server was compiled with test-mode env baked in.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

// Search targets (kept as plain literals — this file is excluded from the
// check:strings "dev-origin" rule because it is the scanner for that pattern).
const MARKER_REPO_PATH = "repoPath";
const MARKER_BUILT_STAMP = "builtStamp";
const ABANDONED_DRAFT_NAME = "dev-origin";
const MARKER_HOME_FRAGMENT = "desktop-refresh/";
const AUTO_APPROVE_TOKEN = "AUTOBROKER_TEST_AUTO_APPROVE";

const serverCjsAbs = join(appRoot, "Contents", "Resources", "bundle", "server.cjs");

walk(appRoot, (file) => {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return; // unreadable file — not a contamination
  }

  // RULE 1: marker schema signature
  if (bufHas(buf, MARKER_REPO_PATH) && bufHas(buf, MARKER_BUILT_STAMP)) {
    reportFail(`marker schema signature (${MARKER_REPO_PATH}+${MARKER_BUILT_STAMP}) found in:\n  ${file}`);
  }

  // RULE 2: abandoned draft marker name
  if (bufHas(buf, ABANDONED_DRAFT_NAME)) {
    reportFail(`"${ABANDONED_DRAFT_NAME}" found in:\n  ${file}`);
  }

  // RULE 3: marker home path fragment
  if (bufHas(buf, MARKER_HOME_FRAGMENT)) {
    reportFail(`"${MARKER_HOME_FRAGMENT}" found in:\n  ${file}`);
  }

  // RULE 4: test-mode token in server.cjs only
  if (file === serverCjsAbs && bufHas(buf, AUTO_APPROVE_TOKEN)) {
    reportFail(`"${AUTO_APPROVE_TOKEN}" in server.cjs:\n  ${file}`);
  }
});

if (violations === 0) {
  console.log(`OK: ${appRoot} — no marker/test-mode leakage detected.`);
  process.exit(0);
} else {
  process.exit(1);
}
