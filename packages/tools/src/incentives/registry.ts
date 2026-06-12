/**
 * The incentive-source file registry — the cross-run "already approved"
 * memory behind the OEM first-encounter gate. Brand-keyed TOML at
 * `<data dir>/incentive_sources.toml`, where the data dir is ALWAYS resolved
 * through the AUTOBROKER_DATA_DIR isolation env (never a hardcoded home
 * path), so a harness run's registry lives and dies with its throwaway data
 * dir.
 *
 * The file is NOT part of the product DB (the product schema is frozen); it
 * is a small data-dir artifact like traces/exports. Format — exactly the
 * narrow TOML subset this module writes (one [brand] table per entry, three
 * basic-string keys validated against the core registry-row contract):
 *
 *   [hyundai]
 *   url_template = "https://www.hyundaiusa.com/us/en/offers?zip={zip}&model={model}"
 *   added_at = "2026-06-12T18:00:00.000Z"
 *   added_for_profile = "sp_a1b2c3"
 *
 * The reader fails LOUD on anything it does not understand (an unreadable
 * registry must surface, not silently become "never approved anything").
 *
 * WRITE DISCIPLINE: the whole read-modify-write window runs under a sibling
 * `.lock` file (O_EXCL create; the registry body itself gets renamed, so the
 * lock lives on a stable sibling), and the body lands via write-temp +
 * atomic rename. Two overlapping runs adding different brands therefore
 * cannot lose each other's entry. A lock older than the staleness bound is
 * evicted (a crashed run must not wedge every future approval).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  IncentiveSourceRegistryEntrySchema,
  type IncentiveSourceRegistryEntry,
} from "@autobroker/core";

import { resolveDataDir } from "../db.js";

/** A lock file untouched for this long belongs to a dead run — evict it. */
const LOCK_STALE_MS = 10_000;
/** Lock acquisition retry posture (sync, bounded). */
const LOCK_RETRIES = 50;
const LOCK_RETRY_SLEEP_MS = 100;

/** The registry path under the ACTIVE (env-resolved) data dir. */
export function incentiveRegistryPath(): string {
  return join(resolveDataDir(), "incentive_sources.toml");
}

// ---------------------------------------------------------------------------
// the narrow TOML subset (parse + serialize — exactly what we write)
// ---------------------------------------------------------------------------

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeTomlString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Parse the registry body. Fails LOUD on any line outside the subset and on
 *  any entry that misses the core row contract. An empty body is {}. */
export function parseIncentiveRegistry(
  body: string,
): Record<string, IncentiveSourceRegistryEntry> {
  const tables = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;

  for (const [i, rawLine] of body.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table !== null) {
      const brand = table[1]!.trim();
      if (tables.has(brand)) {
        throw new Error(`incentive registry: duplicate table [${brand}] (line ${i + 1})`);
      }
      current = {};
      tables.set(brand, current);
      continue;
    }

    const kv = /^([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"$/.exec(line);
    if (kv !== null) {
      if (current === null) {
        throw new Error(`incentive registry: key outside a [brand] table (line ${i + 1})`);
      }
      current[kv[1]!] = unescapeTomlString(kv[2]!);
      continue;
    }

    throw new Error(
      `incentive registry: unparseable line ${i + 1} ("${line.slice(0, 60)}") — ` +
        "the file holds only [brand] tables with basic-string keys",
    );
  }

  const out: Record<string, IncentiveSourceRegistryEntry> = {};
  for (const [brand, raw] of tables) {
    out[brand] = IncentiveSourceRegistryEntrySchema.parse(raw);
  }
  return out;
}

/** Serialize a registry (brands sorted for a stable file). */
export function serializeIncentiveRegistry(
  registry: Record<string, IncentiveSourceRegistryEntry>,
): string {
  const lines: string[] = [];
  for (const brand of Object.keys(registry).sort()) {
    const entry = registry[brand]!;
    lines.push(`[${brand}]`);
    lines.push(`url_template = "${escapeTomlString(entry.url_template)}"`);
    lines.push(`added_at = "${escapeTomlString(entry.added_at)}"`);
    lines.push(`added_for_profile = "${escapeTomlString(entry.added_for_profile)}"`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// read / write (the side-effecting faces)
// ---------------------------------------------------------------------------

/** Read the registry at `path` (default: the active data dir's file). A
 *  missing file is the empty registry; an unparseable file throws. */
export function readIncentiveRegistry(
  path: string = incentiveRegistryPath(),
): Record<string, IncentiveSourceRegistryEntry> {
  if (!existsSync(path)) return {};
  return parseIncentiveRegistry(readFileSync(path, "utf8"));
}

/** Bounded synchronous sleep (the lock retry pause; Atomics.wait never spins). */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** Acquire the sibling lock (O_EXCL). Evicts a stale lock; throws after the
 *  bounded retries — an approval write must fail LOUD, never block forever. */
function acquireLock(lockPath: string): void {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue; // evicted — retry immediately
        }
      } catch {
        continue; // lock vanished between attempts — retry
      }
      sleepSync(LOCK_RETRY_SLEEP_MS);
    }
  }
  throw new Error(`incentive registry: could not acquire ${lockPath} (still held)`);
}

/**
 * Write/replace ONE brand's entry. The whole read-modify-write window holds
 * the sibling lock; the body lands via temp-file + atomic rename. The entry
 * is validated against the core row contract before anything touches disk.
 */
export function writeIncentiveRegistryEntry(
  brand: string,
  entry: IncentiveSourceRegistryEntry,
  path: string = incentiveRegistryPath(),
): void {
  const validated = IncentiveSourceRegistryEntrySchema.parse(entry);
  if (brand.trim() === "") throw new Error("incentive registry: empty brand key");

  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  acquireLock(lockPath);
  try {
    const registry = readIncentiveRegistry(path);
    registry[brand] = validated;
    const tmpPath = `${path}.tmp.${process.pid}`;
    writeFileSync(tmpPath, serializeIncentiveRegistry(registry), "utf8");
    renameSync(tmpPath, path);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone — never mask the write result
    }
  }
}
