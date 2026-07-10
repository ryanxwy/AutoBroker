/**
 * envConfigStore — the at-rest store for the NON-SECRET operational env vars the
 * owner may centrally manage from the UI "Environment" panel.
 *
 * A deliberate sibling of secretsStore: same file conventions (0600 JSON under
 * <DATA_DIR>/settings, atomic temp-rename write, live process.env mutation, a
 * boot loader), but the values here are operational toggles, NOT secrets — they
 * ARE returned and shown in the UI.
 *
 * THE KEYSTONE — live effect with NO restart: the consumers of these vars read
 * process.env at call time (the Gmail-backend factory resolves the backend per
 * call; the browser reads its headless flag at each launch). So setting
 * process.env[VAR] in-place inside the running process takes effect on the next
 * call with no reboot. setEnvConfig therefore mutates process.env in addition to
 * the file, and loadEnvConfigIntoEnv seeds the env once at boot.
 *
 * CURATION IS THE SAFETY SURFACE (load-bearing). The descriptor registry below
 * is the single allow-list. It does THREE structural things:
 *   - AUTOBROKER_MODE (the sole send-control var) is the editable "Mode" row;
 *     "test" keeps every send fake/local, "buyer" enables real send (still behind
 *     the L2 approval gate). It is the one send-control knob the owner sets here.
 *   - AUTOBROKER_PORTFOLIO_SCHEDULER is the editable "Auto-run my searches"
 *     switch. It admits only quote_pipeline's read/local fan-out and grants no
 *     outbound approval by itself.
 *   - The two test-escape vars (AUTOBROKER_TEST_AUTO_APPROVE,
 *     AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS) have NO descriptor at all — they are
 *     structurally unreachable: not readable through getEnvConfig (no row),
 *     not writable through setEnvConfig (no id). They can never leak or be set.
 *   - Read-only paths are reported but never written; only the editable
 *     enum/bool/text ids can be persisted.
 *
 * AT-REST: the file is 0600 JSON holding ONLY the editable overrides. A launch-
 * supplied env var with no file override is left untouched at boot (mirroring the
 * secrets loader): the file is the source of persisted overrides, not a clobber.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveDataDir } from "../db.js";
import {
  PER_DEALER_RECORD_CAP_DEFAULT,
  PER_DEALER_RECORD_CAP_MIN,
  PER_DEALER_RECORD_CAP_MAX,
} from "../inventory/recordCap.js";

/** The stable id for each curated row (the wire id used by the routes). The two
 *  TEST_* escapes are deliberately absent — they have no id and so are
 *  unreachable through this store. */
export type EnvVarId =
  // editable
  | "app_mode"
  | "auto_send"
  | "auto_run_searches"
  | "gmail_account"
  | "chrome_headless"
  | "per_dealer_record_cap"
  // read-only status
  | "demo_seed"
  // read-only path
  | "data_dir"
  | "db_path";

export type EnvVarClass =
  | "editable-enum"
  | "editable-bool"
  | "editable-text"
  | "editable-numeric"
  | "read-only-status"
  | "read-only-path";

/** One curated descriptor. The registry of these IS the allow-list. */
export interface EnvVarDescriptor {
  readonly id: EnvVarId;
  /** The backing process.env var name. Empty for db_path (the active DB path is
   *  resolved, not read from a single env var). */
  readonly envVar: string;
  readonly classification: EnvVarClass;
  /** true ONLY for the editable ids — the structural write gate. */
  readonly editable: boolean;
  /** The enum/bool value list; null for path / free status / numeric rows. */
  readonly allowedValues: readonly string[] | null;
  readonly default: string | null;
  /** For editable-numeric: the inclusive lower bound; null otherwise. */
  readonly numericMin: number | null;
  /** For editable-numeric: the inclusive upper bound; null otherwise. */
  readonly numericMax: number | null;
  /** Short non-tech UI label. */
  readonly label: string;
  /** Non-tech tooltip copy shown next to the row. */
  readonly tooltip: string;
}

/** The curated registry. This IS the allow-list: an id absent here cannot be
 *  read or written through this store. The two TEST_* escapes are deliberately
 *  absent (structurally unreachable). */
export const ENV_DESCRIPTORS: readonly EnvVarDescriptor[] = [
  {
    id: "app_mode",
    envVar: "AUTOBROKER_MODE",
    classification: "editable-enum",
    editable: true,
    allowedValues: ["buyer", "test"],
    default: "buyer",
    numericMin: null,
    numericMax: null,
    label: "Mode",
    tooltip:
      "Buyer mode really emails dealers and submits forms. Approvals are manual unless Automatic send approvals is enabled. Test mode keeps everything internal.",
  },
  {
    id: "auto_send",
    envVar: "AUTOBROKER_AUTO_SEND",
    classification: "editable-enum",
    editable: true,
    allowedValues: ["off", "email", "web_form", "all"],
    default: "off",
    numericMin: null,
    numericMax: null,
    label: "Automatic send approvals",
    tooltip:
      "Buyer mode can automatically accept new first-send email or web-form approvals. Email fallback still asks again.",
  },
  {
    id: "auto_run_searches",
    envVar: "AUTOBROKER_PORTFOLIO_SCHEDULER",
    classification: "editable-bool",
    editable: true,
    allowedValues: ["1", "0"],
    default: "0",
    numericMin: null,
    numericMax: null,
    label: "Auto-run my searches",
    tooltip:
      "Automatically runs read-only and local search-pipeline work when new replies or quotes arrive. This switch does not approve outbound sends.",
  },
  {
    id: "gmail_account",
    envVar: "AUTOBROKER_GMAIL_ACCOUNT",
    classification: "editable-text",
    editable: true,
    // Free text → no fixed value list. The default is deliberately null: no real
    // mailbox address is baked into the committed source. The account is set here
    // (or via env) and persisted to the 0600 env.json on this machine only.
    allowedValues: null,
    default: null,
    numericMin: null,
    numericMax: null,
    label: "Gmail account",
    tooltip:
      "The Gmail address AutoBroker connects to in Live email mode. It pre-selects the right account on Google's sign-in screen when you authorize access.",
  },
  {
    id: "chrome_headless",
    envVar: "AUTOBROKER_CHROME_HEADLESS",
    classification: "editable-bool",
    editable: true,
    allowedValues: ["1", "0"],
    default: "1",
    numericMin: null,
    numericMax: null,
    label: "Show the browser",
    tooltip:
      "Show the browser. Off runs the car-search browser invisibly in the background; On pops a real window so you can watch it work.",
  },
  {
    id: "per_dealer_record_cap",
    envVar: "AUTOBROKER_PER_DEALER_RECORD_CAP",
    classification: "editable-numeric",
    editable: true,
    allowedValues: null,
    default: String(PER_DEALER_RECORD_CAP_DEFAULT),
    numericMin: PER_DEALER_RECORD_CAP_MIN,
    numericMax: PER_DEALER_RECORD_CAP_MAX,
    label: "Listings recorded per dealer site",
    tooltip:
      "How many best-match in-stock listings each dealer website records per scan. Higher = more market-research data per site; lower = leaner. Default 20, max 80.",
  },
  {
    id: "demo_seed",
    envVar: "AUTOBROKER_DEMO_SEED",
    classification: "read-only-status",
    editable: false,
    allowedValues: null,
    default: null,
    numericMin: null,
    numericMax: null,
    label: "Demo mode",
    tooltip:
      "Demo mode: shows sample cars and dealers so you can try the app. Set when the app is launched.",
  },
  {
    id: "data_dir",
    envVar: "AUTOBROKER_DATA_DIR",
    classification: "read-only-path",
    editable: false,
    allowedValues: null,
    default: null,
    numericMin: null,
    numericMax: null,
    label: "Data folder",
    tooltip: "Where AutoBroker keeps your data on this computer.",
  },
  {
    id: "db_path",
    // The active product DB path is resolved (AUTOBROKER_DB override or
    // <dataDir>/autobroker.db), not read from a single env var.
    envVar: "",
    classification: "read-only-path",
    editable: false,
    allowedValues: null,
    default: null,
    numericMin: null,
    numericMax: null,
    label: "Database file",
    tooltip: "The database file AutoBroker is using right now.",
  },
];

/** The editable ids only — the write allow-list. */
export const EDITABLE_IDS = [
  "app_mode",
  "auto_send",
  "auto_run_searches",
  "gmail_account",
  "chrome_headless",
  "per_dealer_record_cap",
] as const;

/** Max length for a free-text editable value (an email address — RFC 5321 caps
 *  the full address at 254 chars). Guards against a pathological payload. */
const TEXT_VALUE_MAX_LEN = 254;

export const AUTO_SEND_MODES = ["off", "email", "web_form", "all"] as const;
export type AutoSendMode = (typeof AUTO_SEND_MODES)[number];
export function resolveAutoSendMode(raw = process.env.AUTOBROKER_AUTO_SEND): AutoSendMode {
  return AUTO_SEND_MODES.includes(raw as AutoSendMode) ? (raw as AutoSendMode) : "off";
}

/** Validate an editable-text value (currently only gmail_account → an email).
 *  Permissive but rejects whitespace, empty, over-length, and obvious non-emails
 *  (no "@x.y" shape). The store re-validates regardless of the route schema. */
function isValidTextValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= TEXT_VALUE_MAX_LEN &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

/** One curated row with its CURRENT effective value, ready for the UI. */
export interface EnvVarState extends EnvVarDescriptor {
  /** Effective value now. For the editable enum/bool: file override → live
   *  process.env → descriptor default. For the demo status: a read-only
   *  projection ("on"/"off"). For paths: the resolved path. Never a hidden id. */
  readonly value: string;
}

/** Thrown when an id is not in the curated registry — fail LOUD. */
export class UnknownEnvVarError extends Error {
  constructor(readonly id: string) {
    super(`unknown env var id '${id}' (allowed: ${ENV_DESCRIPTORS.map((d) => d.id).join(", ")})`);
    this.name = "UnknownEnvVarError";
  }
}

/** Thrown when an id is known but not editable (the read-only paths / demo
 *  status). This is the store-layer defense-in-depth that blocks writing a
 *  read-only row, not just the route schema. */
export class NonEditableEnvVarError extends Error {
  constructor(readonly id: string) {
    super(`env var '${id}' is read-only and cannot be set from this store`);
    this.name = "NonEditableEnvVarError";
  }
}

/** Thrown when a value is not in the descriptor's allowedValues. */
export class InvalidEnvValueError extends Error {
  constructor(
    readonly id: string,
    readonly value: string,
    allowed: readonly string[],
  ) {
    super(`invalid value '${value}' for '${id}' (allowed: ${allowed.join(", ")})`);
    this.name = "InvalidEnvValueError";
  }
}

/** Look up a descriptor, or undefined if the id is not curated. */
function findDescriptor(id: string): EnvVarDescriptor | undefined {
  return ENV_DESCRIPTORS.find((d) => d.id === id);
}

/** <dataDir>/settings — the directory the env file lives in. */
function settingsDir(): string {
  return join(resolveDataDir(), "settings");
}

/** <dataDir>/settings/env.json — the at-rest file. */
function envFilePath(): string {
  return join(settingsDir(), "env.json");
}

/** The on-disk shape: a partial editable-id -> value map. Only the editable
 *  ids are ever written; an unknown/non-editable id read from a hand-edited file
 *  is ignored. */
type StoredEnv = Partial<Record<(typeof EDITABLE_IDS)[number], string>>;

/** Read + parse the env file, or {} when it is absent / unreadable / malformed
 *  (a corrupt file is treated as no overrides — fail safe to "nothing stored",
 *  never throw on boot). Only the editable ids are kept, and only with a value
 *  that is currently in the descriptor's allowedValues (a stale/out-of-range
 *  override from a hand-edited file is dropped). */
function readStoredEnv(): StoredEnv {
  let raw: string;
  try {
    raw = readFileSync(envFilePath(), "utf8");
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
  const out: StoredEnv = {};
  for (const id of EDITABLE_IDS) {
    const v = (parsed as Record<string, unknown>)[id];
    const descriptor = findDescriptor(id);
    if (typeof v !== "string" || descriptor === undefined) continue;
    if (descriptor.classification === "editable-text") {
      // Free-text: keep only a value that still passes validation (a stale/garbage
      // override from a hand-edited file is dropped).
      if (isValidTextValue(v)) out[id] = v;
    } else if (descriptor.classification === "editable-numeric") {
      // Numeric: keep only a value that parses as an integer within [min, max].
      const n = parseInt(v, 10);
      const min = descriptor.numericMin ?? -Infinity;
      const max = descriptor.numericMax ?? Infinity;
      if (Number.isInteger(n) && n >= min && n <= max) out[id] = v;
    } else if (descriptor.allowedValues !== null && descriptor.allowedValues.includes(v)) {
      // Enum/bool: keep only a value currently in the descriptor's allowedValues.
      out[id] = v;
    }
  }
  return out;
}

/** Write the merged map to <dataDir>/settings/env.json at 0600, atomically
 *  (write a sibling temp then rename — a reader never sees a half-written file).
 *  mkdir -p the settings dir first. */
function writeStoredEnv(env: StoredEnv): void {
  const dir = settingsDir();
  mkdirSync(dir, { recursive: true });
  const finalPath = envFilePath();
  const tmpPath = `${finalPath}.tmp`;
  // 0600 on the temp file so it is owner-only the instant it hits disk; the
  // rename preserves that mode on the final file.
  writeFileSync(tmpPath, JSON.stringify(env, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, finalPath);
}

/** The resolved active product DB path = AUTOBROKER_DB override or
 *  <dataDir>/autobroker.db (matches the @autobroker/db resolution). */
function resolveActiveDbPath(): string {
  const explicit = process.env.AUTOBROKER_DB;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return join(resolveDataDir(), "autobroker.db");
}

/** Compute the effective value for one descriptor (read FRESH from process.env /
 *  resolved paths each call — never cached). */
function projectValue(descriptor: EnvVarDescriptor, stored: StoredEnv): string {
  switch (descriptor.id) {
    case "demo_seed":
      return process.env.AUTOBROKER_DEMO_SEED === "1" ? "on" : "off";
    case "data_dir":
      return resolveDataDir();
    case "db_path":
      return resolveActiveDbPath();
    case "app_mode":
    case "auto_send":
    case "auto_run_searches":
    case "gmail_account":
    case "chrome_headless":
    case "per_dealer_record_cap": {
      // file override → live process.env → descriptor default.
      const fromFile = stored[descriptor.id];
      if (fromFile !== undefined) return fromFile;
      const fromEnv = process.env[descriptor.envVar];
      if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
      return descriptor.default ?? "";
    }
  }
}

/**
 * The curated set with live values — the GET payload. NEVER includes a hidden id
 * (the two TEST_* escapes have no descriptor). The demo-status row reports
 * "on"/"off" read fresh from process.env.
 */
export function getEnvConfig(): readonly EnvVarState[] {
  const stored = readStoredEnv();
  return ENV_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    value: projectValue(descriptor, stored),
  }));
}

/**
 * Persist one editable override (merged into env.json at 0600, atomic) AND set
 * process.env[VAR] in-place for live effect (no restart).
 *
 * Guards run IN ORDER, all fail-loud:
 *   (a) id must be in ENV_DESCRIPTORS  → else UnknownEnvVarError.
 *   (b) descriptor.editable === true   → else NonEditableEnvVarError. This is
 *       the defense-in-depth that blocks writing a read-only path / status row at
 *       the STORE layer, independent of the route schema.
 *   (c) value must be valid for the class → else InvalidEnvValueError. For an
 *       editable-text var (the Gmail account) that means a well-formed address;
 *       for an enum/bool var it must be one of the descriptor's allowedValues.
 * Only after all three: merge into env.json and mutate process.env.
 */
export function setEnvConfig(id: string, value: string): void {
  const descriptor = findDescriptor(id);
  if (descriptor === undefined) {
    throw new UnknownEnvVarError(id);
  }
  if (!descriptor.editable) {
    throw new NonEditableEnvVarError(id);
  }
  if (descriptor.classification === "editable-text") {
    // Free-text (an email): validate shape, not an allow-list.
    if (!isValidTextValue(value)) {
      throw new InvalidEnvValueError(id, value, ["a valid email address"]);
    }
  } else if (descriptor.classification === "editable-numeric") {
    // Numeric: must be a base-10 integer within [numericMin, numericMax].
    const n = parseInt(value, 10);
    const min = descriptor.numericMin ?? -Infinity;
    const max = descriptor.numericMax ?? Infinity;
    if (!Number.isInteger(n) || isNaN(n) || String(n) !== value || n < min || n > max) {
      throw new InvalidEnvValueError(
        id,
        value,
        [`an integer between ${min} and ${max}`],
      );
    }
  } else {
    // Enum/bool: the value must be one of the descriptor's allowedValues.
    const allowed = descriptor.allowedValues ?? [];
    if (!allowed.includes(value)) {
      throw new InvalidEnvValueError(id, value, allowed);
    }
  }
  const merged = { ...readStoredEnv(), [descriptor.id]: value };
  writeStoredEnv(merged);
  process.env[descriptor.envVar] = value;
}

/**
 * Seed process.env from the persisted env.json overrides. Called ONCE at boot,
 * BEFORE the Gmail factory / model registry, so the first request sees the saved
 * operational toggles. A missing file is a no-op. Only the editable env vars
 * are set, and only for ids actually present in the file — a var absent from the
 * file is left to whatever the launch environment already provides (a launch-
 * supplied value is not clobbered).
 */
export function loadEnvConfigIntoEnv(): void {
  const stored = readStoredEnv();
  for (const id of EDITABLE_IDS) {
    const value = stored[id];
    if (value !== undefined) {
      const descriptor = findDescriptor(id);
      if (descriptor !== undefined) {
        // The mode is safety-critical: a launch/lane-supplied AUTOBROKER_MODE
        // (e.g. a harness lane pinning "test", or a desktop demo launch) must WIN
        // over a stored override, so NEVER clobber an already-set mode back to a
        // persisted "buyer". Other editable settings still apply the stored value
        // (the persisted choice is authoritative for those).
        if (descriptor.id === "app_mode" && process.env[descriptor.envVar] !== undefined) {
          continue;
        }
        process.env[descriptor.envVar] = value;
      }
    }
  }
}
