/**
 * secretsStore — the at-rest store for the FOUR user-supplied API keys, and the
 * only code that reads/writes the keys file or mutates a provider env var.
 *
 * WHY HERE: tools is the sole layer permitted to touch the filesystem or hold a
 * secret (the SQLite/external-API invariant). Routes delegate DOWN into this
 * store; they never open the keys file themselves.
 *
 * THE KEYSTONE — live effect with NO restart: the AI-SDK provider factories
 * resolve their key from process.env at call time, and the geocoder reads
 * GOOGLE_PLACES_API_KEY per call. So setting process.env[VAR] in-place inside
 * the running server process takes effect on the NEXT model/geocode call with no
 * reboot. setKey/clearKey therefore mutate process.env in addition to the file,
 * and loadSecretsIntoEnv seeds the env once at boot.
 *
 * ALLOW-LIST DISCIPLINE: this store manages EXACTLY the four key vars below and
 * nothing else. It NEVER reads, writes, or deletes a system/operational env var
 * (AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS, AUTOBROKER_DATA_DIR, MASTRA_TELEMETRY_DISABLED,
 * NODE_ENV, PORT, ...). An id outside the four is rejected.
 *
 * AT-REST: the file is 0600 plaintext JSON. This is a local-first, single-user
 * app on the owner's own machine, and it matches the existing Gmail-token
 * precedent (a 0600 file under the data dir). OS-keychain / safeStorage
 * encryption is a separate later task; this store stays plaintext-at-0600 until
 * then. A key VALUE is NEVER logged or returned — only presence is exposed.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveDataDir } from "../db.js";

/** The stable id for each managed key (the wire id used by the routes). */
export type SecretKeyId = "deepseek" | "anthropic" | "openai" | "google_places";

/** id -> the process.env var name it backs. This map IS the allow-list: an id
 *  not present here is refused, and only these four env vars are ever touched. */
const KEY_ENV_VARS: Readonly<Record<SecretKeyId, string>> = {
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google_places: "GOOGLE_PLACES_API_KEY",
};

/** The four ids, in a stable order (presence projection + iteration). */
export const SECRET_KEY_IDS = Object.keys(KEY_ENV_VARS) as readonly SecretKeyId[];

/** Per-key presence (NEVER the value). */
export interface KeyPresence {
  readonly present: boolean;
}

/** The presence projection returned to a read route — presence ONLY. */
export type KeyPresenceMap = Readonly<Record<SecretKeyId, KeyPresence>>;

/** Reject an id outside the four. Fail LOUD — a typo must not silently no-op. */
export class UnknownSecretKeyError extends Error {
  constructor(readonly id: string) {
    super(`unknown secret key id '${id}' (allowed: ${SECRET_KEY_IDS.join(", ")})`);
    this.name = "UnknownSecretKeyError";
  }
}

function assertKnownId(id: string): asserts id is SecretKeyId {
  if (!Object.prototype.hasOwnProperty.call(KEY_ENV_VARS, id)) {
    throw new UnknownSecretKeyError(id);
  }
}

/** <dataDir>/settings — the directory the keys file lives in. */
function settingsDir(): string {
  return join(resolveDataDir(), "settings");
}

/** <dataDir>/settings/keys.json — the at-rest file. */
function keysFilePath(): string {
  return join(settingsDir(), "keys.json");
}

/** The on-disk shape: a partial id->value map. Only the four ids are ever
 *  written; an unknown id read from a hand-edited file is ignored. */
type StoredKeys = Partial<Record<SecretKeyId, string>>;

/** Read + parse the keys file, or {} when it is absent / unreadable / malformed
 *  (a corrupt file is treated as no keys — fail safe to "nothing stored", never
 *  throw on boot). Only the four known ids are kept; values must be strings. */
function readStoredKeys(): StoredKeys {
  let raw: string;
  try {
    raw = readFileSync(keysFilePath(), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const out: StoredKeys = {};
  for (const id of SECRET_KEY_IDS) {
    const v = (parsed as Record<string, unknown>)[id];
    if (typeof v === "string" && v.length > 0) out[id] = v;
  }
  return out;
}

/** Write the merged map to <dataDir>/settings/keys.json at 0600, atomically
 *  (write a sibling temp then rename — a reader never sees a half-written file).
 *  mkdir -p the settings dir first. */
function writeStoredKeys(keys: StoredKeys): void {
  const dir = settingsDir();
  mkdirSync(dir, { recursive: true });
  const finalPath = keysFilePath();
  const tmpPath = `${finalPath}.tmp`;
  // 0600 on the temp file so the secret is owner-only the instant it hits disk;
  // the rename preserves that mode on the final file.
  writeFileSync(tmpPath, JSON.stringify(keys, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, finalPath);
}

/**
 * Seed process.env from the persisted keys file. Called ONCE at boot, BEFORE the
 * model registry / first provider call, so the first request sees the stored
 * keys. A missing file is a no-op. Only the four allow-listed env vars are set,
 * and only for ids actually present in the file — a key absent from the file is
 * left to whatever the environment already provides (an env-supplied key is not
 * clobbered).
 */
export function loadSecretsIntoEnv(): void {
  const stored = readStoredKeys();
  for (const id of SECRET_KEY_IDS) {
    const value = stored[id];
    if (value !== undefined) {
      process.env[KEY_ENV_VARS[id]] = value;
    }
  }
}

/** Walk UP from `start` up to `maxDepth` levels and return the first `.env` file
 *  found, or undefined. A no-throw best-effort probe (a stat error = "not here,
 *  keep walking"). The walk stops at the filesystem root regardless of depth. */
function findDotEnvUpwards(start: string, maxDepth: number): string | undefined {
  let dir = start;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = join(dir, ".env");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root.
    dir = parent;
  }
  return undefined;
}

/** Parse one `.env` line into [name, value], or undefined for a blank/comment/
 *  malformed line. Matches `^\s*(?:export\s+)?NAME\s*=\s*VALUE$`; strips ONE layer
 *  of matching surrounding single/double quotes; trims trailing whitespace on an
 *  unquoted value. No variable interpolation. */
function parseDotEnvLine(line: string): [string, string] | undefined {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m === null) return undefined;
  const name = m[1]!;
  let value = m[2]!;
  const quoted =
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
  if (quoted) value = value.slice(1, -1);
  else value = value.replace(/\s+$/, "");
  return [name, value];
}

/**
 * Seed process.env from a data-dir-INDEPENDENT `.env` file — the FALLBACK store
 * so a key written only into a repo-root `.env` works in every lane (server boot
 * AND harness AND CLI) and shows up as "present" in the UI Keys panel.
 *
 * SCOPE: only the FOUR allow-listed provider keys (KEY_ENV_VARS values); every
 * other var in `.env` (operational AUTOBROKER_*, TELEGRAM_*, ...) is IGNORED —
 * this loader never touches a non-key var, matching the store's allow-list.
 *
 * NO-CLOBBER: a var is set only when currently unset-or-empty, so an ambient /
 * exported key wins, and a later loadSecretsIntoEnv() (keys.json, the canonical
 * store) clobbers because it runs AFTER. Precedence: ambient env / keys.json win
 * over `.env`.
 *
 * LOCATION: `envFilePath` if given; else the first `.env` found walking UP from
 * process.cwd() (up to ~5 levels). No `.env` anywhere = no-op.
 *
 * FAIL SAFE: a missing / unreadable / garbled `.env` is treated as "nothing to
 * load" — NEVER throws. A key VALUE is NEVER logged or returned (presence only).
 */
export function loadDotEnvKeys(envFilePath?: string): void {
  const path = envFilePath ?? findDotEnvUpwards(process.cwd(), 5);
  if (path === undefined) return; // no .env anywhere — nothing to load.

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // missing / unreadable / a directory — fail safe.
  }

  // The allow-list as an env-var-name -> id reverse lookup (only the four).
  const allowed = new Set<string>(Object.values(KEY_ENV_VARS));
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line);
    if (parsed === undefined) continue; // blank / comment / malformed — skip.
    const [name, value] = parsed;
    if (!allowed.has(name)) continue; // not one of the four — ignore.
    if (value.length === 0) continue; // an empty value is not a key.
    const current = process.env[name];
    if (current === undefined || current.length === 0) {
      process.env[name] = value; // NO-CLOBBER: only fill an unset/empty slot.
    }
  }
}

/**
 * Presence-only projection of the four keys: a key is "present" when it has a
 * non-empty value EITHER in the persisted file OR in the current process env
 * (an env-supplied key with no file entry still counts as configured). Never
 * exposes the value.
 */
export function getKeyPresence(): KeyPresenceMap {
  const stored = readStoredKeys();
  const out = {} as Record<SecretKeyId, KeyPresence>;
  for (const id of SECRET_KEY_IDS) {
    const fromFile = stored[id];
    const fromEnv = process.env[KEY_ENV_VARS[id]];
    const present = (fromFile !== undefined && fromFile.length > 0) ||
      (fromEnv !== undefined && fromEnv.length > 0);
    out[id] = { present };
  }
  return out;
}

/**
 * Persist a key (merged into the file at 0600) AND set process.env[VAR] in-place
 * for live effect. Rejects an id outside the four and an empty value. NEVER logs
 * the value.
 */
export function setKey(id: string, value: string): void {
  assertKnownId(id);
  if (value.length === 0) {
    throw new Error(`refusing to store an empty value for '${id}'`);
  }
  const merged = { ...readStoredKeys(), [id]: value };
  writeStoredKeys(merged);
  process.env[KEY_ENV_VARS[id]] = value;
}

/**
 * Remove a key from the file AND delete process.env[VAR] in-place. Rejects an id
 * outside the four. Idempotent — clearing an absent key still rewrites the file
 * and deletes the (possibly already-absent) env var.
 */
export function clearKey(id: string): void {
  assertKnownId(id);
  const remaining = { ...readStoredKeys() };
  delete remaining[id];
  if (Object.keys(remaining).length === 0) {
    // Nothing left to store — remove the file entirely (best-effort).
    try {
      rmSync(keysFilePath());
    } catch {
      // Already gone — fine.
    }
  } else {
    writeStoredKeys(remaining);
  }
  delete process.env[KEY_ENV_VARS[id]];
}
