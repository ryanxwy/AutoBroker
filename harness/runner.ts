/**
 * runner — the `pnpm harness` CLI + the self-contained run loop.
 * It IS the Orchestrator+Driver+Monitor folded into one process: it boots
 * the REAL server (a child process on an ephemeral port), runs the isolation
 * preflight (fail-closed, zero network until it passes), the driver_kind self-check
 * (gate ⑦), then per case-step: snapshot-before → POST start → drive the resume[]
 * script over /form-decision → drain SSE → snapshot-after → evalAnchor × 6+1 →
 * write verdict.json + the evidence dir. The harness NEVER writes the product DB
 * (the SUT writes the ledger row per LLM call; the harness only reads it for the
 * cost_and_time anchor + export_daily) and NEVER calls a provider directly.
 *
 * SUBCOMMANDS: intake | case. CLI:
 *   pnpm harness intake [--case <name>] [--provider deepseek]
 *                       [--gate-policy approve_safe] [--max-seconds 900]
 *                       [--db <path>] [--dry-run]
 *
 * STEP BUDGETS are PER-STEP: --max-seconds (when given) overrides everything;
 * else a step's TOML `max_seconds`; else 900s. A long scan step can carry 1800
 * in its case file without inflating its journey siblings or other corpus runs.
 *
 * --dry-run: boot the server with the DI seam DISABLED but STOP before the
 * first live call — proving the wiring end-to-end minus spend. It runs preflight +
 * the driver_kind self-check + the /api/mode read, then exits 0 WITHOUT POSTing a
 * scoring turn that would call DeepSeek/geocode.
 *
 * ISOLATION: --db defaults to a fresh throwaway under
 * ~/.autobroker-ts/harness-runs/<timestamp>/ (NEVER legacy ~/.autobroker). The
 * runner sets AUTOBROKER_DATA_DIR to that dir before spawning the server host, so
 * the host's openDb resolves the isolated file and GET /api/mode reports it.
 *
 * Dependency wall: harness layer. Imports the harness modules + @autobroker/core
 * (driver-kind type) — NEVER better-sqlite3/drizzle/@ai-sdk, and playwright ONLY
 * through uiDriver.ts (the UI lane's TEST browser; the product browser stays in
 * packages/tools). The DB
 * reads go through dbReads (the read-only @autobroker/db channel).
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { INTAKE_FIELD_META } from "@autobroker/core";
import { loadDotEnvKeys, loadSecretsIntoEnv } from "@autobroker/tools";

import { loadCase, cellIdFor, PROVIDER_DRIVER_KIND, type Case, type CaseStep, type CaseResume } from "./cases.js";
import { buildRunDetail, type RunDetail } from "./detail.js";
import { assertDriverKindLockStep } from "./driverKind.js";
import {
  buildVerdict,
  computeConfidence,
  evalAnchor,
  type AnchorResult,
  type CrossCheck,
  type EvalContext,
  type UiCheck,
  type VerdictDoc,
} from "./evaluator.js";
import {
  snapshotCounts,
  openReadHandle,
  externalMutationDbCount,
  sourceBreakdown,
  type TableCounts,
} from "./dbReads.js";
import { assertEnvEnvelope, assertServerActiveDbMatches, PROVIDER_KEY_ENV } from "./preflight.js";
import { startPoller, type GatePolicy } from "./poller.js";
import { applyDealerReplySeeds, applyInventorySourceSeeds } from "./seed.js";
import { planBatchRowDecisions, UiDriver, type UiTerminal } from "./uiDriver.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_HOST = join(HERE, "serverHost.ts");
// Resolve tsx's loader from its package "." export (which maps to dist/loader.mjs)
// instead of a hardcoded .pnpm/tsx@<version>/ path — that pinned path broke on any
// tsx patch/minor bump inside the declared ^4.22.x range.
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
/** The shared root every isolated per-run dir is written under (`<root>/<ts>/`). */
const HARNESS_RUNS_ROOT = join(homedir(), ".autobroker-ts", "harness-runs");
/** Delete run-evidence dirs older than this many days at each runner start. */
const RUN_DIR_RETENTION_DAYS = 14;

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export interface RunnerOpts {
  command: "intake" | "case";
  casePath: string | null;
  caseName: string | null;
  step: string | null;
  provider: "deepseek" | "anthropic" | "openai";
  inputMode: "slash" | "freeform" | null;
  /** The user-action driver lane: "ui" drives the REAL dashboard DOM through
   *  Playwright; "api" (default) drives the HTTP surface. null = take the
   *  case's [narrative] lane (which itself defaults to "api"). */
  lane: "ui" | "api" | null;
  apiBase: string | null;
  db: string;
  evidenceRoot: string;
  gatePolicy: GatePolicy | null;
  layer: string;
  /** The CLI --max-seconds, or null when the flag was absent (per-step budgets
   *  then come from the case TOML's max_seconds, default 900). CLI overrides. */
  maxSeconds: number | null;
  dryRun: boolean;
  /** Functional lane (--fixture): boot the host with the deterministic DI stubs
   *  (AUTOBROKER_HARNESS_FIXTURE=1 — NO live LLM/geocode), force the UI lane, and
   *  install each step's fixture_state via POST /__e2e/apply-fixture before
   *  driving. A kind="ui" step with a fixture_state then needs no prior run. */
  fixture: boolean;
}

function parseArgs(argv: string[]): RunnerOpts {
  // Drop the node + script argv entries, then strip any standalone "--" separator
  // tokens (pnpm `run <script> --` injects one when forwarding args through a
  // workspace-filtered script). What remains is the subcommand + flags.
  const tokens = argv.slice(2).filter((t) => t !== "--");
  const [cmd, ...rest] = tokens;
  const command = (cmd ?? "intake") as RunnerOpts["command"];
  if (!["intake", "case"].includes(command)) {
    fail(`unknown subcommand "${command}" (expected intake|case)`);
  }

  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      bools.add(key);
    } else {
      flags.set(key, next);
      i += 1;
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runRoot = join(HARNESS_RUNS_ROOT, ts);
  const db = flags.get("db") ?? join(runRoot, "autobroker.db");
  const evidenceRoot = flags.get("evidence-root") ?? join(runRoot, "evidence");
  const provider = (flags.get("provider") ?? "deepseek") as RunnerOpts["provider"];

  const lane = flags.get("lane") ?? null;
  if (lane !== null && lane !== "ui" && lane !== "api") {
    fail(`--lane must be "ui" or "api", got "${lane}"`);
  }

  return {
    command,
    casePath: flags.get("case") ?? null,
    caseName: flags.get("case-name") ?? null,
    step: flags.get("step") ?? null,
    provider,
    inputMode: (flags.get("input-mode") as RunnerOpts["inputMode"]) ?? null,
    lane,
    apiBase: flags.get("api-base") ?? null,
    db: resolve(expandTilde(db)),
    evidenceRoot: resolve(expandTilde(evidenceRoot)),
    gatePolicy: (flags.get("gate-policy") as GatePolicy | undefined) ?? null,
    layer: flags.get("layer") ?? "L2",
    maxSeconds: flags.has("max-seconds") ? Number(flags.get("max-seconds")) : null,
    dryRun: bools.has("dry-run"),
    fixture: bools.has("fixture"),
  };
}

/** The default per-step budget when neither the CLI nor the case sets one. */
const DEFAULT_STEP_BUDGET_SECONDS = 900;

/** Resolve one step's wall-clock budget (ms): CLI --max-seconds overrides;
 *  else the step's TOML max_seconds; else the 900s default. PER-STEP — a long
 *  scan step's 1800 never inflates its journey siblings. */
function stepBudgetMs(opts: RunnerOpts, step: CaseStep): number {
  return (opts.maxSeconds ?? step.maxSeconds ?? DEFAULT_STEP_BUDGET_SECONDS) * 1000;
}

function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function fail(msg: string): never {
  console.error(`harness: ${msg}`);
  process.exit(1);
}

/** Resolve the case file path: --case may be a bare name (resolved under
 *  harness/cases/) or an explicit path. Defaults to the slash intake case. */
function resolveCasePath(opts: RunnerOpts): string {
  const fallback = "search_profile_intake.slash.toml";
  let name = opts.casePath ?? fallback;
  if (!name.includes("/") && !name.endsWith(".toml")) name = `${name}.toml`;
  if (!name.includes("/")) return join(HERE, "cases", name);
  return resolve(expandTilde(name));
}

// ---------------------------------------------------------------------------
// server host lifecycle
// ---------------------------------------------------------------------------

interface HostHandle {
  child: ChildProcess;
  apiBase: string;
  dataDir: string;
  stop: () => Promise<void>;
}

/** Spawn the real server host child, parse the listening line, return the base URL.
 *  AUTOBROKER_DATA_DIR is set to the run's isolated dir before spawn.
 *  `scanChain` opts the host into the site_scan→aggregator auto-chain (default
 *  OFF for every lane — see the AUTOBROKER_SITESCAN_CHAIN note below). */
function startServerHost(opts: RunnerOpts, scanChain = false): Promise<HostHandle> {
  const dataDir = dirname(opts.db);
  mkdirSync(dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOBROKER_DATA_DIR: dataDir,
    // Ensure the explicit DB override matches --db so /api/mode reports exactly it.
    AUTOBROKER_DB: opts.db,
    MASTRA_TELEMETRY_DISABLED: "1",
    // The spawned host is a harness context: pin test mode (the product is
    // buyer-by-default) so it can never reach a real dealer. AUTOBROKER_HARNESS=1
    // marks it as a harness context unconditionally (even the LIVE host, which is
    // not a fixture lane), so boot's isHarnessContext() forces test mode and the
    // assertTestModeSafe tripwire re-asserts it even if a persisted app_mode tried
    // to flip it. serverHost self-sets these too.
    AUTOBROKER_HARNESS: "1",
    AUTOBROKER_MODE: "test",
    // The site_scan→aggregator auto-chain is a PRODUCT default (ON), but it must
    // NOT fire in the harness runner lanes: a chained aggregator pass would hit
    // the live shopping sites on every site_scan run, spawn headed windows on CI,
    // and race the runner teardown. So every runner-spawned host defaults the
    // chain OFF ("0"); ONLY a case that opts in (narrative.scan_chain=true) flips
    // it to "1" (the dedicated chain case). NOTE: apps/ui/e2e/serve-live.mjs is a
    // SEPARATE host (not spawned here) — it leaves the chain at the product ON.
    AUTOBROKER_SITESCAN_CHAIN: scanChain ? "1" : "0",
  };
  delete env.AUTOBROKER_TEST_AUTO_APPROVE;
  // Functional lane: arm the host's fixture mode (deterministic DI stubs + the
  // /__e2e/* routes). Absent in every other mode — the host boots live as before.
  if (opts.fixture) env.AUTOBROKER_HARNESS_FIXTURE = "1";

  return new Promise<HostHandle>((resolveHost, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(TSX_LOADER).href, SERVER_HOST], {
      cwd: join(HERE, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let buf = "";
    let settled = false;
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const line = buf.split("\n").find((l) => l.includes('"harness_host":"listening"') || l.includes('"harness_host": "listening"'));
      if (line && !settled) {
        settled = true;
        try {
          const info = JSON.parse(line) as { port: number; dataDir: string };
          resolveHost({
            child,
            apiBase: `http://127.0.0.1:${info.port}`,
            dataDir: info.dataDir,
            stop: () => stopChild(child),
          });
        } catch (e) {
          reject(e);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => process.stderr.write(`[host] ${d}`));
    child.on("exit", (code) => {
      if (!settled) reject(new Error(`serverHost exited early (code ${code})`));
    });
    setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        reject(new Error("serverHost did not become ready within 30s"));
      }
    }, 30_000);
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) return r();
    child.once("exit", () => r());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      r();
    }, 5000);
  });
}

// ---------------------------------------------------------------------------
// the per-step run drive loop
// ---------------------------------------------------------------------------

interface StartResult {
  runId: string;
}

/** POST /api/skill-runs to start an intake run for a step (slash or freeform). */
async function startRun(apiBase: string, c: Case, step: CaseStep): Promise<StartResult> {
  const body = {
    skill: "search_profile_intake",
    input_mode: c.inputMode,
    freeform_text:
      c.inputMode === "freeform" ? String((step.inputInline?.["prompt"] as string | undefined) ?? "") : null,
    seed_fields: null,
  };
  const res = await fetch(`${apiBase}/api/skill-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`start failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { run_id?: string };
  if (typeof json.run_id !== "string") throw new Error("start response missing run_id");
  return { runId: json.run_id };
}

/** Read the current pending suspend (step + decision_id) for the run. */
async function readPending(apiBase: string, runId: string): Promise<{ step: string; decisionId: string; status: string } | null> {
  const res = await fetch(`${apiBase}/api/skill-runs/${encodeURIComponent(runId)}`, { method: "GET" });
  if (!res.ok) return null;
  const body = (await res.json()) as { status?: string; pending?: { step?: string; decision_id?: string } | null };
  if (body.pending == null || body.pending.decision_id === undefined) {
    return body.status !== undefined ? { step: "", decisionId: "", status: body.status } : null;
  }
  return { step: body.pending.step ?? "", decisionId: body.pending.decision_id, status: body.status ?? "running" };
}

/** Map a resume entry's `on` (suspend kind) to the form-decision body, using the
 *  pending decision_id. The case authored the OUTER action; content carries the
 *  inner typed resume for non-collect suspends. */
function buildFormDecisionBody(resume: CaseResume, decisionId: string): Record<string, unknown> {
  const decision: Record<string, unknown> = { action: resume.action };
  if (resume.action === "accept" && resume.content !== null) {
    decision["content"] = resume.content;
  }
  return { decision_id: decisionId, decision };
}

/** The batch_review suspend payload size bound (bytes). The spec_inline must
 *  stay renderable as a card — the workflow keeps it under 8KB at a 40-dealer
 *  full-radius batch; the runner re-asserts it on every live sighting. */
const BATCH_SUSPEND_MAX_BYTES = 8192;

/** The suspend-payload targets the batch verbs resolve names/ids against. */
interface BatchSuspendTarget {
  dealer_id: string;
  name: string;
}

/**
 * Read the run's CURRENT batch_review suspend spec_inline off the status
 * summary's event backlog (the LAST awaiting_user frame with form_kind
 * batch_review — the same frames the SSE stream carries; the status route's
 * `pending` projection stays payload-free so the approvals poller stays
 * structurally blind). Fails LOUD when no such frame exists, and asserts the
 * <8KB payload bound on every sighting.
 */
async function readBatchSuspendPayload(
  apiBase: string,
  runId: string,
): Promise<{ spec: Record<string, unknown>; targets: BatchSuspendTarget[] }> {
  const res = await fetch(`${apiBase}/api/skill-runs/${encodeURIComponent(runId)}`, { method: "GET" });
  if (!res.ok) throw new Error(`readBatchSuspendPayload: GET /api/skill-runs/${runId} → HTTP ${res.status}`);
  const body = (await res.json()) as {
    events?: Array<{ kind?: string; payload?: Record<string, unknown> }>;
  };
  const events = body.events ?? [];
  let spec: Record<string, unknown> | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.kind !== "awaiting_user") continue;
    const payload = ev.payload ?? {};
    if (payload["form_kind"] !== "batch_review") continue;
    const inline = payload["spec_inline"];
    if (inline !== null && typeof inline === "object") {
      spec = inline as Record<string, unknown>;
      break;
    }
  }
  if (spec === null) {
    throw new Error(`readBatchSuspendPayload: run ${runId} has no batch_review awaiting_user frame`);
  }

  const bytes = Buffer.byteLength(JSON.stringify(spec), "utf8");
  if (bytes >= BATCH_SUSPEND_MAX_BYTES) {
    throw new Error(
      `batch_review spec_inline payload is ${bytes} bytes — breaches the <${BATCH_SUSPEND_MAX_BYTES} byte bound`,
    );
  }

  const targetsRaw = spec["targets"];
  const targets: BatchSuspendTarget[] = [];
  if (Array.isArray(targetsRaw)) {
    for (const t of targetsRaw) {
      const row = t as { dealer_id?: unknown; name?: unknown };
      if (typeof row.dealer_id === "string" && typeof row.name === "string") {
        targets.push({ dealer_id: row.dealer_id, name: row.name });
      }
    }
  }
  return { spec, targets };
}

/** One hygiene-stage suspend target (keyed by id — a thread_id or contact_id,
 *  NOT a dealer_id). */
interface HygieneSuspendTarget {
  id: string;
  name: string;
}

/**
 * Read the run's CURRENT hygiene-stage suspend spec_inline (the LAST
 * awaiting_user frame with form_kind batch_review). The hygiene card uses the
 * SAME form_kind as the scan/inbox batch reviews but carries a `stage`
 * discriminator and targets keyed by `id` (thread_id | contact_id) instead of
 * `dealer_id` — so this reader extracts `id` + the stage. Fails LOUD when no
 * such frame exists; asserts the <8KB payload bound on every sighting.
 */
async function readHygieneSuspendPayload(
  apiBase: string,
  runId: string,
): Promise<{ spec: Record<string, unknown>; stage: string; targets: HygieneSuspendTarget[] }> {
  const res = await fetch(`${apiBase}/api/skill-runs/${encodeURIComponent(runId)}`, { method: "GET" });
  if (!res.ok) throw new Error(`readHygieneSuspendPayload: GET /api/skill-runs/${runId} → HTTP ${res.status}`);
  const body = (await res.json()) as {
    events?: Array<{ kind?: string; payload?: Record<string, unknown> }>;
  };
  const events = body.events ?? [];
  let spec: Record<string, unknown> | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.kind !== "awaiting_user") continue;
    const payload = ev.payload ?? {};
    if (payload["form_kind"] !== "batch_review") continue;
    const inline = payload["spec_inline"];
    if (inline !== null && typeof inline === "object" && "stage" in (inline as object)) {
      spec = inline as Record<string, unknown>;
      break;
    }
  }
  if (spec === null) {
    throw new Error(`readHygieneSuspendPayload: run ${runId} has no hygiene-stage awaiting_user frame`);
  }

  const bytes = Buffer.byteLength(JSON.stringify(spec), "utf8");
  if (bytes >= BATCH_SUSPEND_MAX_BYTES) {
    throw new Error(
      `hygiene spec_inline payload is ${bytes} bytes — breaches the <${BATCH_SUSPEND_MAX_BYTES} byte bound`,
    );
  }

  const stage = typeof spec["stage"] === "string" ? (spec["stage"] as string) : "";
  const targetsRaw = spec["targets"];
  const targets: HygieneSuspendTarget[] = [];
  if (Array.isArray(targetsRaw)) {
    for (const t of targetsRaw) {
      const row = t as { id?: unknown; name?: unknown };
      if (typeof row.id === "string" && typeof row.name === "string") {
        targets.push({ id: row.id, name: row.name });
      }
    }
  }
  return { spec, stage, targets };
}

/** Drive the resume[] script: for each suspend the run reaches, find the matching
 *  resume entry (by `on` = suspend kind) and POST /form-decision. Polls pending
 *  status between resumes. Returns when the run reaches a terminal status. */
async function driveResumeScript(apiBase: string, runId: string, resumes: CaseResume[], maxMs: number): Promise<void> {
  const TERMINAL = new Set(["done", "error", "declined", "aborted"]);
  const usedDecisionIds = new Set<string>();
  const startedAt = Date.now();

  // Build a queue of resumes; match the next one to each suspend kind in order.
  let cursor = 0;
  while (Date.now() - startedAt < maxMs) {
    const pending = await readPending(apiBase, runId);
    if (pending === null) {
      await sleep(150);
      continue;
    }
    if (TERMINAL.has(pending.status)) return;
    if (pending.decisionId === "" || usedDecisionIds.has(pending.decisionId)) {
      await sleep(150);
      continue;
    }
    // Find the resume for this suspend. Prefer one whose `on` matches the pending
    // step's suspend kind; else take the next unused resume in order.
    const suspendKind = pendingKind(pending.step);
    let resume = resumes.find((r, i) => i >= cursor && matchesSuspend(r.on, suspendKind));
    if (resume === undefined) resume = resumes[cursor];
    if (resume === undefined) {
      // No script entry for this suspend → fail-closed by declining (never hang).
      // The non-action fields carry their canonical empty (null); this driver
      // path only reads action + content.
      resume = {
        on: pendingKind(pending.step),
        action: "decline",
        content: null,
        contentFrom: null,
        rows: null,
        defaultDecision: null,
      };
    }
    // Every branch above assigned a resume; narrow loudly rather than proceed
    // on an unexpected empty shape.
    if (resume === undefined) {
      throw new Error(`driveResumeScript: no resume resolved for suspend "${suspendKind}"`);
    }
    cursor = Math.min(cursor + 1, resumes.length);

    usedDecisionIds.add(pending.decisionId);
    // Drive-time content source: "suspend.targets" approves ALL dealer ids off
    // the live suspend payload (the API-lane equivalent of the card's
    // Select-all; the wire stays the explicit id list).
    if (resume.action === "accept" && resume.contentFrom === "suspend.targets") {
      const { targets } = await readBatchSuspendPayload(apiBase, runId);
      if (targets.length === 0) {
        throw new Error("resume content_from=suspend.targets but the suspend payload carries zero targets");
      }
      resume = { ...resume, content: { approved_dealer_ids: targets.map((t) => t.dealer_id) } };
    }
    const body = buildFormDecisionBody(resume, pending.decisionId);
    const res = await fetch(`${apiBase}/api/skill-runs/${encodeURIComponent(runId)}/form-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 200) {
      throw new Error(`form-decision failed: HTTP ${res.status} ${await res.text()}`);
    }
    // After a resume the run either ends or suspends again; loop re-polls.
    await sleep(100);
  }
  throw new Error(`run ${runId} did not reach terminal within ${maxMs}ms`);
}

/** Map the workflow's pending STEP id to the suspend KIND a resume's `on` names. */
function pendingKind(step: string): string {
  switch (step) {
    case "collect":
      return "data_collection";
    case "confirmVehicle":
      return "intake_confirm";
    case "resolveLocation":
      return "ambiguous_location";
    case "batchReview":
    case "reviewGate": // inventory_link_scan's batch_review step
      return "batch_review";
    case "confirmGate": // pipeline_reset's destructive typed-YES confirm
      return "confirmation_gate";
    default:
      return "data_collection";
  }
}

function matchesSuspend(on: string, kind: string): boolean {
  return on === kind;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// resolving the created profile id (for the after-snapshot profile scope)
// ---------------------------------------------------------------------------

/** After a created run, read /api/profiles to find the newest profile id (the run's
 *  output). Returns null for a declined/error run (nothing created). */
async function resolveNewProfileId(apiBase: string, beforeIds: Set<string>): Promise<string | null> {
  const res = await fetch(`${apiBase}/api/profiles`, { method: "GET" });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ search_profile_id?: string }>;
  for (const r of rows) {
    if (typeof r.search_profile_id === "string" && !beforeIds.has(r.search_profile_id)) {
      return r.search_profile_id;
    }
  }
  return null;
}

async function readProfileIds(apiBase: string): Promise<Set<string>> {
  const res = await fetch(`${apiBase}/api/profiles`, { method: "GET" });
  if (!res.ok) return new Set();
  const rows = (await res.json()) as Array<{ search_profile_id?: string }>;
  return new Set(rows.map((r) => r.search_profile_id).filter((x): x is string => typeof x === "string"));
}

/** Resolve THE single active profile id (the func-lane pin scope). Used after a
 *  fixture-backed ui step pins the seeded world's one active profile: the read
 *  API returns exactly that profile, so the next skill step's table deltas scope
 *  to it. Returns null when zero or 2+ active profiles exist (an ambiguous scope
 *  the caller leaves unset rather than guess). */
async function resolveSingleActiveProfileId(apiBase: string): Promise<string | null> {
  const res = await fetch(`${apiBase}/api/profiles?status=active`, { method: "GET" });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ search_profile_id?: string }>;
  const ids = rows.map((r) => r.search_profile_id).filter((x): x is string => typeof x === "string");
  return ids.length === 1 ? ids[0]! : null;
}

/** The ACTIVE profile ids (the picker / pin candidates). A fixture world that
 *  seeds exactly one active profile lets a later fixture-backed skill step scope
 *  its table deltas to that profile (no intake step ran to carry an id). */
async function readActiveProfileIds(apiBase: string): Promise<string[]> {
  const res = await fetch(`${apiBase}/api/profiles?status=active`, { method: "GET" });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ search_profile_id?: string }>;
  return rows.map((r) => r.search_profile_id).filter((x): x is string => typeof x === "string");
}

/** Capture the keystone external-mutation DB scan total at a step's BEFORE
 *  moment (a read-only scan; the handle is opened+closed here). The
 *  no_external_mutation anchor subtracts this baseline so the keystone measures
 *  the RUN's delta, not pre-existing fixture rows (e.g. the seeded submitted
 *  lead a dealer_inbox_check sweep requires as its discovery anchor). */
function captureMutationBaseline(): number {
  const { db, close } = openReadHandle();
  try {
    return externalMutationDbCount(db).total;
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
// evaluate one step → verdict.json (the Monitor, encoded)
// ---------------------------------------------------------------------------

async function evaluateStep(args: {
  apiBase: string;
  c: Case;
  step: CaseStep;
  runId: string;
  detail: RunDetail;
  before: TableCounts;
  after: TableCounts;
  profileId: string | null;
  layer: string;
  /** The driver lane recorded on the verdict (default "api"). */
  lane?: "ui" | "api";
  /** Real DOM-derived ui_checks (UI lane) — recorded ALONGSIDE the S2 re-pull. */
  domChecks?: UiCheck[];
  /** A real-world unreachable-bit waiver (e.g. Maps yielded zero candidates). */
  waiver?: { kind: string; reason: string } | null;
  /** A fixture-backed runless ui step (functional lane): there is no run, so S1
   *  reflects the fixture-installed world (the deterministic setup IS the
   *  ground truth), not a nonexistent run terminal. */
  runlessFixture?: boolean;
  /** The keystone external-mutation DB scan total captured BEFORE the run. The
   *  no_external_mutation anchor subtracts it (the run's delta, not pre-existing
   *  fixture rows). Omitted → 0 (absolute-count behavior, unchanged). */
  externalMutationBaseline?: number;
  /** This step's run wipes ALL profiles (a destructive global reset). When set,
   *  the S2 re-pull expectation is INVERTED: a profile that is correctly ABSENT
   *  after the wipe is the EXPECTED, CONSISTENT outcome (and a still-present
   *  profile is the real failure). Omitted/false → the default present-on-re-pull
   *  S2 (byte-identical for every non-wipe step). */
  expectsWipe?: boolean;
}): Promise<VerdictDoc> {
  const { apiBase, c, step, runId, detail, before, after, profileId, layer } = args;
  const ctx: EvalContext = {
    profileId,
    before,
    after,
    runWindow: { from: detail.events[0]?.ts ?? "", to: detail.events[detail.events.length - 1]?.ts ?? "" },
    externalMutationBaseline: args.externalMutationBaseline ?? 0,
  };

  // Score each anchor through the read-only DB handle.
  const { db, close } = openReadHandle();
  let anchors: AnchorResult[];
  try {
    anchors = step.anchors.map((spec) => evalAnchor(spec, detail, db, ctx));
  } finally {
    close();
  }

  // S1/S2/S3 cross-check, encoded automatically:
  //   S1 = SSE terminal text (Driver-observed), OR — for a fixture-backed
  //        runless ui step — the deterministic fixture install (no run exists).
  //   S2 = re-pulled read API (Monitor-observed, refresh-confirmed).
  //   S3 = backend ground truth (read-only SQLite profile-scoped delta).
  const s1Ok = args.runlessFixture === true ? true : detail.terminalStatus !== null;
  let s2Ok = true;
  let s2Available = true;
  let s2Text = "n/a";
  if (profileId !== null && args.expectsWipe === true) {
    // Wipe-aware S2: the run is a destructive GLOBAL reset, so the scoped
    // profile is INTENTIONALLY gone afterward. A NOT-found re-pull is the
    // EXPECTED, CONSISTENT outcome (s2Ok = !res.ok); a profile still PRESENT
    // after the declared wipe is the real failure. S3 (the table_min_rows=0
    // anchors) already agrees with the wipe, so the corrected S2 yields a
    // unanimous high → GREEN.
    const res = await fetch(`${apiBase}/api/profiles/${encodeURIComponent(profileId)}`, { method: "GET" });
    s2Ok = !res.ok;
    s2Available = true;
    s2Text = res.ok
      ? `profile ${profileId} STILL PRESENT after wipe (unexpected)`
      : `profile ${profileId} correctly absent after wipe`;
  } else if (profileId !== null) {
    const res = await fetch(`${apiBase}/api/profiles/${encodeURIComponent(profileId)}`, { method: "GET" });
    s2Ok = res.ok;
    s2Available = true;
    s2Text = res.ok ? `profile ${profileId} present on re-pull` : `profile ${profileId} NOT found on re-pull`;
  } else {
    // Declined/error runs have no profile to re-pull; S2 is the status read.
    s2Available = true;
    s2Text = `no profile created (terminal=${detail.terminalStatus})`;
  }
  const tableAnchor = anchors.find((a) => a.kind === "table_min_rows");
  // A failing table anchor that an explicit table_min_rows waiver covers is NOT
  // an S1/S2/S3 contradiction: the zero-delta IS the true ground truth (an
  // empty real-world result), so S3 agrees with the empty world rather than
  // contradicting the "done" terminal. Without this the confidence would drop
  // to "low" and the verdict would RED out before the waiver can apply.
  const tableWaived =
    args.waiver != null &&
    args.waiver.kind === "table_min_rows" &&
    tableAnchor !== undefined &&
    !tableAnchor.ok;
  const s3Ok = tableAnchor === undefined ? true : tableAnchor.ok || tableWaived;

  const confidence = computeConfidence({ s1Ok, s2Ok, s3Ok, s2Available });
  const crossCheck: CrossCheck = {
    s1:
      args.runlessFixture === true
        ? `fixture installed (${step.fixtureState ?? "?"}) — no run`
        : `SSE terminal=${detail.terminalStatus}`,
    s2: s2Text,
    s3: `profile-scoped delta ${tableAnchor ? `(${String(tableAnchor.observed)})` : "n/a"}${tableWaived ? " — empty real-world result (waiver)" : ""}`,
    confidence,
  };

  // The S2 re-pull IS a ui_check in the ratified self-contained L2 mode
  // (STANDARD §5): the Monitor surface is the read API, refresh-confirmed.
  // Recording it keeps ui_checks non-vacuous at live layers. On the UI lane the
  // caller ALSO passes real dashboard-DOM checks (domChecks), which are
  // prepended so the verdict carries both surfaces.
  const uiChecks = [
    ...(args.domChecks ?? []),
    profileId !== null
      ? {
          surface: `api:/api/profiles/${profileId}`,
          selector: "profile-row",
          expected: profileId,
          observed: s2Text,
          ok: s2Ok,
        }
      : {
          surface: "api:/api/skill-runs/:id",
          selector: "terminal-status",
          expected: "terminal status readable on re-pull",
          observed: s2Text,
          ok: s1Ok,
        },
  ];

  return buildVerdict({
    cellId: cellIdFor(c, step),
    caseId: c.id,
    layer,
    lane: args.lane ?? "api",
    runId,
    anchors,
    uiChecks,
    crossCheck,
    ...(args.waiver !== undefined && args.waiver !== null ? { waiver: args.waiver } : {}),
  });
}

// ---------------------------------------------------------------------------
// evidence writing
// ---------------------------------------------------------------------------

/** The per-step evidence dir name: cell_id + a step-id suffix. The suffix is
 *  load-bearing for multi-step journeys where two steps share one cell_id
 *  (e.g. two intake steps building the 2-profile world) — without it the later
 *  step's evidence silently overwrites the earlier one's. */
function evidenceDirName(cellId: string, stepId: string): string {
  return `${cellId.replace(/\//g, "__")}__${stepId}`;
}

function writeEvidence(
  evidenceRoot: string,
  cellId: string,
  stepId: string,
  files: Record<string, unknown>,
): string {
  const dir = join(evidenceRoot, evidenceDirName(cellId, stepId));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content, null, 2) + "\n", "utf8");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// the intake command (run one case's single intake step end-to-end)
// ---------------------------------------------------------------------------

async function cmdIntake(opts: RunnerOpts): Promise<number> {
  // (1) ENV ENVELOPE — gates ①–⑤, zero network. Fail-closed exit 1 on any miss.
  assertEnvEnvelope({ provider: opts.provider, db: opts.db });

  const c = loadCase(resolveCasePath(opts));

  // Lane dispatch: --lane overrides the case's [narrative] lane (default api).
  // The UI lane runs EVERY step of the case in one browser session (the
  // non-tech-user journey); the API lane keeps its single-step contract. The
  // functional lane (--fixture) is the UI lane against the STUBBED host (no
  // live LLM/geocode) — fixture worlds install per step before driving.
  const lane: "ui" | "api" = opts.fixture ? "ui" : opts.lane ?? c.lane;
  if (lane === "ui") return cmdUiCase(opts, c);

  if (c.seed !== null) {
    // Seeds bootstrap a journey's mid-case DB state (profile + dealers must
    // already exist) — only the UI-lane journey runner applies them.
    fail("case carries [[seed.*]] sections — seeded cases run on the UI lane only (--lane ui)");
  }
  const step = opts.step ? c.steps.find((s) => s.id === opts.step) ?? fail(`no step "${opts.step}" in case`) : c.steps[0]!;
  if (step.kind === "ui") {
    // A pure-UI step has no run to POST — it drives DOM verbs + dom_state
    // anchors against the live dashboard, which only the UI lane has.
    fail(`step "${step.id}" is kind="ui" — pure-UI steps run on the UI lane only (--lane ui)`);
  }
  if (step.edge !== null) {
    // The edges are USER-SURFACE behaviors (reload, double-click, offline) —
    // they only exist on the UI lane; silently ignoring one would hollow the case.
    fail(`step "${step.id}" carries edge="${step.edge}" — edge cases run on the UI lane only (--lane ui)`);
  }
  if (step.pinLabel !== null) {
    // The pin verb is a Searches-popover DOM action — UI lane only; silently
    // skipping it would hollow a reuse_pinned journey.
    fail(`step "${step.id}" carries pin_label — the pin verb runs on the UI lane only (--lane ui)`);
  }
  if (step.anchors.some((a) => a.kind === "chained_run")) {
    // The chained_run wait is driven by the UI lane's per-step loop; on the API
    // lane the anchor would score a vacuous passthrough GREEN — refuse instead.
    fail(`step "${step.id}" carries a chained_run anchor — the auto-chain check runs on the UI lane only (--lane ui)`);
  }
  const gatePolicy: GatePolicy = opts.gatePolicy ?? step.gatePolicy;
  const budgetMs = stepBudgetMs(opts, step);

  // (1b) Pin the harness's OWN in-process DB reads to the throwaway --db
  // (review HIGH, 2026-06-05): openDb() resolves via AUTOBROKER_DB first, so an
  // inherited override could point the keystone/table_min_rows/cost reads at a
  // different file than the server writes. Preflight gate ①b already refused a
  // CONFLICTING override; pinning here makes the read path deterministic.
  process.env["AUTOBROKER_DB"] = opts.db;

  // (2) Boot the REAL server host (isolated DB under ~/.autobroker-ts). The
  // auto-chain is exported OFF unless the case opts in (narrative.scan_chain).
  const host = await startServerHost(opts, c.scanChain);
  let exitCode = 0;
  try {
    // (3) Gate ⑥ — server active DB === --db (first network call).
    await assertServerActiveDbMatches({ provider: opts.provider, db: opts.db, apiBase: host.apiBase });

    // (4) Gate ⑦ — driver_kind lock-step self-check BEFORE scoring. Review
    // MEDIUM (2026-06-05): pin all THREE literals together — the provider-derived
    // runner constant, the case anchor's expect (when the case carries one), and
    // the SUT's emitted init frame. A case anchor that disagrees with the
    // provider-derived label is a case-authoring bug → fail loud HERE, not at
    // scoring.
    // Provider-derived label from the two-place lock-step map (extends to all 3
    // first-class providers for cross-provider smoke; deepseek stays default).
    const expectDriverKind = PROVIDER_DRIVER_KIND[c.provider] ?? fail(`no driver_kind label for provider ${c.provider}`);
    const anchorExpect = step.anchors.find((a) => a.kind === "driver_kind")?.expect;
    if (anchorExpect !== undefined && anchorExpect !== expectDriverKind) {
      fail(
        `case anchor driver_kind expect="${anchorExpect}" disagrees with the provider-derived label "${expectDriverKind}" — fix the case TOML`,
      );
    }
    await assertDriverKindLockStep(host.apiBase, expectDriverKind);

    if (opts.dryRun) {
      // --dry-run: wiring proven (preflight + gate ⑥ + gate ⑦ + /api/mode read) —
      // STOP before the first scoring turn that would call DeepSeek/geocode.
      console.log(JSON.stringify({ harness: "dry-run", ok: true, cell: cellIdFor(c, step), apiBase: host.apiBase, gatePolicy }));
      return 0;
    }

    // (5) snapshot-before (profile scope null — nothing created yet).
    const before = snapshotCounts(null);
    const beforeIds = await readProfileIds(host.apiBase);

    // (6) start the run + background gate poller (intake = approve_safe standby).
    const { runId } = await startRun(host.apiBase, c, step);
    const poller = startPoller(host.apiBase, runId, gatePolicy, { maxMs: budgetMs });

    // (7) drive the resume[] script (collect submit / decline / force-override …).
    await driveResumeScript(host.apiBase, runId, step.resume, budgetMs);
    poller.stop();

    // (8) drain SSE → RunDetail; resolve the created profile id (for after scope).
    const detail = await buildRunDetail(host.apiBase, runId);
    const profileId = await resolveNewProfileId(host.apiBase, beforeIds);
    const after = snapshotCounts(profileId);

    // (9) evaluate → verdict.json + evidence.
    const verdict = await evaluateStep({ apiBase: host.apiBase, c, step, runId, detail, before, after, profileId, layer: opts.layer, expectsWipe: step.expectsWipe });
    const dir = writeEvidence(opts.evidenceRoot, verdict.cell_id, step.id, {
      "verdict.json": verdict,
      "narrative.json": { case: c.id, step: step.id, provider: c.provider, inputMode: c.inputMode, profileId },
      "run.json": { runId, terminalStatus: detail.terminalStatus, driverKind: detail.driverKind, events: detail.events.length },
      "transcript.json": detail.events,
      "db-before.json": before,
      "db-after.json": after,
    });

    console.log(JSON.stringify({ harness: "intake", verdict: verdict.verdict, status: verdict.status, cell: verdict.cell_id, evidence: dir }));
    exitCode = verdict.verdict === "GREEN" || verdict.verdict === "GREEN_WITH_WAIVER" ? 0 : 1;
  } finally {
    await host.stop();
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// the UI lane — drive the REAL dashboard DOM (Playwright test browser)
// ---------------------------------------------------------------------------

const INTAKE_SKILL = "search_profile_intake";

/** Functional lane: install a step's fixture_state via the host's test-only
 *  POST /__e2e/apply-fixture (the host resolves the id from its registry, runs
 *  the seed, and flips the stub scenario) BEFORE the step drives. Fails LOUD on
 *  a non-200 (a typo'd fixture id surfaces as the host's loud reject). */
async function applyFixtureState(apiBase: string, fixtureState: string): Promise<void> {
  const res = await fetch(`${apiBase}/__e2e/apply-fixture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: fixtureState }),
  });
  if (!res.ok) {
    throw new Error(`apply-fixture "${fixtureState}" failed: HTTP ${res.status} ${await res.text()}`);
  }
}

/** Apply a fixture's seed WITHOUT reloading the browser (the
 *  realtime-reactivity proof grows data while the SPA stays put, so only the
 *  data.changed pulse — not a reload — can refresh the view). Same host route
 *  as applyFixtureState; the caller never reloads after. */
async function applyFixtureSeedNoReload(apiBase: string, fixtureState: string): Promise<void> {
  await applyFixtureState(apiBase, fixtureState);
}

/** Emit a data.changed pulse onto an OPEN run channel via the host's test route
 *  (the deterministic SSE→refetch trigger — mirrors the product emit-before-done
 *  without running a real skill). Fails LOUD on a non-200 (a closed/unknown run
 *  surfaces as the host's 400). */
async function emitDataChanged(
  apiBase: string,
  runId: string,
  kinds: string[],
): Promise<void> {
  const res = await fetch(`${apiBase}/__e2e/emit-data-changed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId, kinds }),
  });
  if (!res.ok) {
    throw new Error(`emit-data-changed (run ${runId}) failed: HTTP ${res.status} ${await res.text()}`);
  }
}

/** Newest mtime (ms) under a directory tree (UI dist staleness probe). */
function newestMtimeUnder(dir: string): number {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeUnder(p));
    } else {
      newest = Math.max(newest, statSync(p).mtimeMs);
    }
  }
  return newest;
}

/** The built SPA the server host auto-serves. Builds it when missing or stale
 *  (any apps/ui source newer than dist/index.html). */
function ensureUiDist(): void {
  const repoRoot = join(HERE, "..");
  const uiDir = join(repoRoot, "apps", "ui");
  const indexPath = join(uiDir, "dist", "index.html");
  const srcNewest = Math.max(
    newestMtimeUnder(join(uiDir, "src")),
    existsSync(join(uiDir, "index.html")) ? statSync(join(uiDir, "index.html")).mtimeMs : 0,
  );
  if (existsSync(indexPath) && statSync(indexPath).mtimeMs >= srcNewest) return;
  console.error("[ui-lane] apps/ui/dist missing or stale — building…");
  execFileSync("pnpm", ["--filter", "@autobroker/ui", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (!existsSync(indexPath)) fail("UI build produced no apps/ui/dist/index.html");
}

/** GET / must return the real app shell (the SPA root div), proving the server
 *  host is serving the built dashboard the driver is about to click through. */
async function assertAppShellServed(apiBase: string): Promise<void> {
  const res = await fetch(`${apiBase}/`, { method: "GET" });
  const body = res.ok ? await res.text() : "";
  if (!res.ok || !body.includes('<div id="root">')) {
    fail(`GET / did not return the app shell (HTTP ${res.status}) — is apps/ui/dist being served?`);
  }
}

/** The PII field names the draft store strips before persist — the
 *  reload_mid_form partial fill EXCLUDES them so every partially-filled value
 *  is provably restorable (derived from the same single source as the UI). */
const INTAKE_PII_FIELD_SET = new Set(
  Object.entries(INTAKE_FIELD_META)
    .filter(([, meta]) => (meta as { sensitivity?: string }).sensitivity === "pii")
    .map(([name]) => name),
);

/** The batch_review drive context cmdUiCase builds per step: a live reader for
 *  the suspend payload (name→dealer_id resolution + the <8KB bound) and the
 *  cross-step row-count expectation (the geosearch step's profile_dealers
 *  delta), when the case declares batch_rows_from. */
interface BatchDriveContext {
  readSuspend: () => Promise<{ spec: Record<string, unknown>; targets: BatchSuspendTarget[] }>;
  /** The hygiene-stage reader (targets keyed by id + the stage discriminator);
   *  present only for a step whose resume names the hygiene_review kind. */
  readHygieneSuspend?: () => Promise<{
    spec: Record<string, unknown>;
    stage: string;
    targets: HygieneSuspendTarget[];
  }>;
  expectRowCount: number | null;
}

/** Drive one step's resume[] script as REAL DOM actions, capturing the
 *  DOM-derived ui_checks at the right moments. maxMs bounds the suspend-surface
 *  waits (a freeform launch runs the prefill LLM call BEFORE the form renders).
 *  The step's `edge` (rotation-pool corner case) bends the drive: a mid-form
 *  reload + draft-restore leg, or a double-click on the submit. */
async function driveResumeScriptDom(
  driver: UiDriver,
  step: CaseStep,
  maxMs: number,
  batch?: BatchDriveContext,
): Promise<void> {
  for (const resume of step.resume) {
    if (resume.on === "batch_review") {
      // The batch card renders on the gate-banner track — wait for the REAL
      // card, hold the gate-before-prose invariant by mount position, and read
      // the live suspend payload (the name→dealer_id authority + the <8KB
      // bound asserted inside the reader).
      if (batch === undefined) {
        throw new Error("ui lane: batch_review resume reached with no batch drive context");
      }
      await driver.waitForBatchReviewCard(maxMs);
      await driver.checkBannerGateBeforeProse();
      // EVERY batch_review sighting reads the live suspend payload — the
      // reader asserts the <8KB spec_inline bound on both the accept and the
      // decline path (failing the step loudly on a breach).
      const { targets } = await batch.readSuspend();
      // SKIP ALL — the closeout reset hand-off (terminal, zero writes). Click the
      // dedicated button; no row decisions, no submit. Recognized by the accept
      // content marker {skip_all:true} (must be checked BEFORE the decline/row logic).
      if (resume.action === "accept" && resume.content?.["skip_all"] === true) {
        await driver.screenshot("batch-card-skip-all");
        await driver.clickBatchSkipAll(maxMs);
        continue;
      }
      if (resume.action !== "accept") {
        // Decline twin: terminal, zero writes — no row decisions needed.
        await driver.screenshot("batch-card-decline");
        await driver.clickBatchDecline();
        continue;
      }
      if (batch.expectRowCount !== null) {
        await driver.checkBatchRowCount(batch.expectRowCount);
      }
      const plan = planBatchRowDecisions(resume.rows ?? [], resume.defaultDecision, targets);
      if (plan.kind === "select_all") {
        await driver.clickBatchSelectAll();
      } else {
        for (const d of plan.decisions) {
          await driver.decideBatchRow(d.dealerId, d.decision);
        }
      }
      // The counter must read complete (every row decided) before submit.
      await driver.checkBatchCounter(targets.length, targets.length);
      await driver.clickBatchSubmit(maxMs);
    } else if (resume.on === "inbox_review") {
      // The inbox-check review card renders on the gate-banner track. It mirrors
      // the batch_review machinery (the suspend payload carries the same
      // form_kind:"batch_review" + spec_inline.targets[{dealer_id,name,…}], so
      // readBatchSuspendPayload reads it unchanged) but uses the inbox- testids
      // and an `unrouted` backstop. Approve the routed dealers (or decline).
      if (batch === undefined) {
        throw new Error("ui lane: inbox_review resume reached with no batch drive context");
      }
      await driver.waitForInboxReviewCard(maxMs);
      await driver.checkBannerGateBeforeProse();
      const { targets } = await batch.readSuspend();
      if (resume.action !== "accept") {
        // Decline twin: terminal, zero writes — no row decisions needed.
        await driver.screenshot("inbox-card-decline");
        await driver.clickInboxDecline();
        continue;
      }
      const plan = planBatchRowDecisions(resume.rows ?? [], resume.defaultDecision, targets);
      if (plan.kind === "select_all") {
        await driver.clickInboxSelectAll();
      } else {
        for (const d of plan.decisions) {
          await driver.decideInboxRow(d.dealerId, d.decision);
        }
      }
      // The counter must read complete (every row decided) before submit.
      await driver.checkInboxCounter(targets.length, targets.length);
      await driver.clickInboxSubmit(maxMs);
    } else if (resume.on === "hygiene_review") {
      // The DESTRUCTIVE dealer_hygiene cleanup card renders ONCE PER STAGE across
      // the three strictly-ordered suspends (5a orphans → 5b CRM threads → 5c CRM
      // contacts). Each `resume on="hygiene_review"` entry handles the NEXT stage
      // suspend in author order — so a case expresses the three stage decisions
      // as three ordered entries. The card carries a `data-stage` discriminator
      // and targets keyed by id (thread_id | contact_id, not dealer_id), so it
      // uses the hygiene reader + the hygiene- testid verbs, never the
      // batch/inbox ones.
      if (batch?.readHygieneSuspend === undefined) {
        throw new Error("ui lane: hygiene_review resume reached with no hygiene drive context");
      }
      await driver.waitForHygieneReviewCard(maxMs);
      await driver.checkBannerGateBeforeProse();
      // EVERY stage sighting reads the live suspend payload (the <8KB bound is
      // asserted inside the reader) + the stage discriminator.
      const { stage, targets } = await batch.readHygieneSuspend();
      const observedStage = await driver.readHygieneStage();
      // A case may pin the EXPECTED stage on the entry's content.stage — the
      // strict-order proof (5a→5b→5c). A mismatch fails the step loudly.
      const expectStage = (resume.content ?? {})["stage"];
      if (typeof expectStage === "string" && (expectStage !== stage || expectStage !== observedStage)) {
        throw new Error(
          `ui lane: hygiene stage mismatch — expected "${expectStage}", wire="${stage}", dom="${observedStage}"`,
        );
      }
      if (resume.action !== "accept") {
        // Decline twin: terminal, ZERO writes for the WHOLE run — even when an
        // EARLIER stage was approved-and-staged (the single atomic verify commit
        // only fires when no stage declined). No row decisions needed; stop
        // processing later stage entries (the run is terminal, never suspends
        // again).
        await driver.screenshot(`hygiene-card-decline-${stage}`);
        await driver.clickHygieneDecline(maxMs);
        break;
      }
      // Approve: each stage's one candidate is approved via the explicit
      // Select-all affordance (the wire still carries the full explicit id list).
      // A row-level plan (rows[]) keyed by the target name is also supported.
      if (resume.rows !== null && resume.rows.length > 0) {
        for (const r of resume.rows) {
          const match = targets.find((t) => t.name === r.match);
          if (match === undefined) {
            throw new Error(
              `ui lane: hygiene row "${r.match}" not in stage "${stage}" targets`,
            );
          }
          await driver.decideHygieneRow(match.id, r.decision);
        }
      } else {
        await driver.clickHygieneSelectAll();
      }
      // The counter must read complete (every row decided) before submit.
      await driver.checkHygieneCounter(targets.length, targets.length);
      await driver.clickHygieneSubmit(maxMs);
    } else if (resume.on === "data_collection") {
      await driver.waitForIntakeForm(maxMs);
      await driver.checkFormRenderedBeforeProse();
      await driver.checkGateBeforeProse();
      // GATE-PENDING composer lock (T2-U2): with the data_collection gate open,
      // the chat composer must be disabled so a typed follow-up can't start a
      // rogue second run answering the gate with prose.
      if (step.assertComposerLocked) await driver.checkComposerLockedWhileGated();
      // The freeform launch must show a SEEDED form (any prefilled field —
      // values are LLM-nondeterministic) BEFORE the driver touches it.
      if (step.launch === "chat_freeform" || step.launch === "chat_freeform_humanized")
        await driver.checkFormSeeded();
      if (resume.action === "accept") {
        const content = resume.content ?? {};
        if (step.edge === "reload_mid_form") {
          // Fill PART of the form (the non-PII slice — the draft strips PII,
          // so only non-PII values can prove restoration), let the debounced
          // autosave land, reload mid-form, assert the draft restored, keep it
          // via Continue, then complete the form below.
          const partial = Object.fromEntries(
            Object.entries(content).filter(([k]) => !INTAKE_PII_FIELD_SET.has(k)),
          );
          await driver.fillRenderedForm(partial);
          await driver.screenshot("form-partial-filled");
          await sleep(800); // comfortably past the draft autosave debounce
          await driver.reloadPage(maxMs);
          await driver.checkDraftRestored(maxMs);
          await driver.clickResumeContinue();
        }
        await driver.fillRenderedForm(content);
        await driver.screenshot("form-filled");
        if (step.edge === "double_click_submit") {
          await driver.clickSubmitTwice();
        } else {
          await driver.clickSubmit();
        }
      } else {
        await driver.clickDecline();
      }
    } else if (resume.on === "intake_confirm") {
      // The unconditional end-of-intake buyer confirmation (rail track). accept →
      // persist; decline → terminal, zero write. (edit is not driven in the lane.)
      await driver.waitForIntakeConfirmGate(maxMs);
      await driver.checkGateBeforeProse();
      if (resume.action === "accept") {
        await driver.clickIntakeConfirmAccept();
      } else {
        await driver.clickIntakeConfirmDecline();
      }
    } else if (resume.on === "confirmation_gate") {
      // The DESTRUCTIVE typed-YES second-confirm (pipeline_reset's ONE suspend).
      // The card renders on the gate-banner track ABOVE the prose; assert it is
      // fully shown (the card + its 5 plain-speech consequence lines) BEFORE any
      // decision, then drive the chosen branch.
      await driver.waitForConfirmationGateCard(maxMs);
      await driver.checkBannerGateBeforeProse();
      await driver.checkResetConsequenceLines(5);
      const content = resume.content ?? {};
      const badToken = content["bad_token"];
      if (typeof badToken === "string") {
        // BAD-TOKEN drive: type a NON-YES token and assert the client typed-YES
        // gate keeps Confirm DISABLED (the wipe is never reachable with a wrong
        // token through the real card), then Cancel out — terminal, ZERO
        // destruction. The server-side validateResetToken→400 is a separate
        // surface (the API form-decision path) covered at L1; the production
        // card normalizes Confirm to the canonical YES, so a wrong token never
        // leaves the client.
        await driver.checkResetConfirmDisabledFor(badToken);
        await driver.screenshot("confirmation-gate-bad-token-cancel");
        await driver.clickResetCancel(maxMs);
      } else if (resume.action === "accept") {
        // Type the literal token, then confirm (the card posts the canonical
        // {confirm_token:"YES"} once the typed-YES client gate enables Confirm).
        const token = String(content["confirm_token"] ?? "YES");
        await driver.fillResetToken(token);
        await driver.screenshot("confirmation-gate-confirm");
        await driver.clickResetConfirm(maxMs);
      } else {
        // The never-hidden decline (Cancel) — terminal, ZERO destruction.
        await driver.screenshot("confirmation-gate-decline");
        await driver.clickResetCancel(maxMs);
      }
    } else if (resume.on === "approval") {
      // The banner-track ApprovalPrompt: Approve = accept (approve the shown
      // action), Deny = decline (terminal/skip, zero writes). The send-skill
      // re-confirms ride this card — dealer_web_lead_submit's single_store /
      // email_fallback approval and negotiation_followup's contact-flip
      // re-confirm (all sensitive=true → the danger frame is on; there is no
      // approve-all affordance on this card at all).
      await driver.waitForApprovalPrompt(maxMs);
      await driver.checkBannerGateBeforeProse();
      // The approval card exposes NO approve-all affordance — unconditionally
      // (the dead bulk-approve was removed). A REAL DOM read recorded into
      // ui_checks (not a vacuous anchor passthrough).
      await driver.checkApprovalApproveAllForSensitivity();
      if (resume.action === "accept") {
        await driver.screenshot("approval-approve");
        await driver.clickApprovalApprove();
      } else {
        await driver.screenshot("approval-deny");
        await driver.clickApprovalDeny();
      }
    } else {
      // No DOM verb mapped for this suspend kind yet — fail LOUD rather than
      // silently falling back to an API resume (the UI lane never POSTs).
      throw new Error(`ui lane: no DOM action for suspend kind "${resume.on}"`);
    }
  }
}

/** The empty-result waiver signal: the geosearch confirm summary is a
 *  deterministic zero-LLM template; "0 dealer(s) discovered" + browser activity
 *  + ZERO failed/blocked viewports means Maps really yielded nothing in radius
 *  (nothing to upsert). A zero WITH failed viewports is not a clean empty
 *  result — rate-limiting / blocked viewports must surface as RED, never hide
 *  behind the waiver. */
function geosearchEmptyResultWaiver(
  summaryText: string,
  detail: RunDetail,
): { kind: string; reason: string } | null {
  const m = /(\d+) dealer\(s\) discovered/.exec(summaryText);
  if (m === null || Number(m[1]) !== 0) return null;
  if (!detail.sawBrowserActivity) return null;
  // The confirm summary appends ", N viewport(s) failed" exactly when
  // blocked+errored > 0 — that zero is suspect, not waivable.
  if (summaryText.includes("viewport(s) failed")) return null;
  return {
    kind: "table_min_rows",
    reason:
      "Maps yielded zero dealer candidates in radius (browser activity present; " +
      "empty real-world result — nothing to write into profile_dealers)",
  };
}

/** The incentive-scrape empty-result waiver: the confirm summary is a
 *  deterministic zero-LLM template. "N scraped" with "0 incentive(s) saved"
 *  and NO failed/blocked brand means the OEM offers page really carried no
 *  whitelist-class cash for the profile vehicle (an all-MSRP/all-APR page is a
 *  valid real-world result — nothing to write into manufacturer_incentives).
 *  A scrape that FAILED or was BLOCKED is not a clean empty result and must
 *  surface as RED, never hide behind the waiver; browser activity must also be
 *  present (the page really was visited). */
function incentiveScrapeEmptyResultWaiver(
  summaryText: string,
  detail: RunDetail,
): { kind: string; reason: string } | null {
  if (!/\bscraped\b/.test(summaryText)) return null;
  if (!/0 incentive\(s\) saved/.test(summaryText)) return null;
  if (/failed|blocked/i.test(summaryText)) return null;
  if (!detail.sawBrowserActivity) return null;
  return {
    kind: "table_min_rows",
    reason:
      "OEM offers page carried zero whitelist-class cash for the profile " +
      "vehicle (browser activity present, scrape clean; an all-MSRP/all-APR " +
      "page is a valid empty real-world result — nothing to write into " +
      "manufacturer_incentives)",
  };
}

/** An empty run-detail spine for a fixture-backed runless ui step (no run
 *  exists). The dom_state checks carry the real assertions; this only keeps the
 *  evaluateStep shape uniform. S1 is supplied separately (runlessFixture). */
const EMPTY_RUN_DETAIL: RunDetail = {
  runId: "",
  terminalStatus: null,
  driverKind: null,
  events: [],
  sawBrowserActivity: false,
  sawApprovalGate: false,
  gateBeforeProse: false,
  usage: {
    costUsd: null,
    durationMs: null,
    promptTokens: null,
    completionTokens: null,
    pricingSource: "unavailable",
  },
};

/** Extract the sibling run id + skill the site_scan→aggregator auto-chain
 *  announced on the PARENT stream. The server appends a `text` frame on the
 *  parent channel (BEFORE its `done`) whose payload carries
 *  chained_run:{run_id,skill}. That persisted frame is the MORE DETERMINISTIC
 *  discovery source than polling GET /api/sessions/:id last_run_id (it is minted
 *  before the parent terminal — no polling race, and it survives a headless/
 *  session-less parent that never records a session run), so we read it straight
 *  off the drained parent detail. Returns null when no announce frame landed
 *  (the chain did not fire). */
function findChainedRunAnnounce(detail: RunDetail): { runId: string; skill: string } | null {
  for (const ev of detail.events) {
    const cr = ev.payload["chained_run"];
    if (cr !== null && typeof cr === "object") {
      const rec = cr as Record<string, unknown>;
      const runId = rec["run_id"];
      if (typeof runId === "string" && runId !== "") {
        return { runId, skill: typeof rec["skill"] === "string" ? (rec["skill"] as string) : "" };
      }
    }
  }
  return null;
}

/** Drive the site_scan→aggregator auto-chain proof for a chained_run anchor. Runs
 *  INSIDE the per-step loop (before the case's finally-teardown), so the host
 *  stays alive while the sibling browses — the wait completes or fails BEFORE the
 *  runner stops the host, never orphaning a mid-browse run. Discovers the sibling
 *  off the parent stream, waits for it to reach its OWN done turn (its own
 *  budget), reads the sibling's profile-scoped DB delta, and records each fact as
 *  a UiCheck on the driver (the parent step's verdict carries them — a failing
 *  chain check turns the step RED, never a silent orphan). */
async function driveChainedRun(args: {
  driver: UiDriver;
  parentDetail: RunDetail;
  anchor: { skill: string; maxSeconds: number; table: string; deltaMin: number };
  scopeProfileId: string | null;
  parentTerminal: UiTerminal;
}): Promise<void> {
  const { driver, parentDetail, anchor, scopeProfileId, parentTerminal } = args;
  const announced = findChainedRunAnnounce(parentDetail);
  // The chain only fires on a COMPLETED parent; a non-done parent OR a missing
  // announce means the sibling never started — record the miss (RED) and skip the
  // wait (there is nothing to wait for).
  if (parentTerminal !== "done" || announced === null) {
    await driver.recordChainedRun({
      announced,
      expectedSkill: anchor.skill,
      terminal: null,
      table: anchor.table,
      deltaObserved: 0,
      deltaMin: anchor.deltaMin,
    });
    return;
  }
  // Baseline the sibling's write table right after the parent terminal (the
  // aggregator has only just started; its rows land after its long browse+extract,
  // so this delta captures the aggregator's OWN writes).
  const before = snapshotCounts(scopeProfileId);
  const terminal = await driver.waitForTerminalSafe(announced.runId, anchor.maxSeconds * 1000);
  const after = snapshotCounts(scopeProfileId);
  const scope = scopeProfileId !== null ? "profile" : "global";
  const deltaObserved = (after[scope][anchor.table] ?? 0) - (before[scope][anchor.table] ?? 0);
  await driver.recordChainedRun({
    announced,
    expectedSkill: anchor.skill,
    terminal,
    table: anchor.table,
    deltaObserved,
    deltaMin: anchor.deltaMin,
  });
}

/** Replay one pure-UI step (kind="ui"): drive the generic DOM verbs, score the
 *  dom_state anchors, then assemble the verdict off the recorded DOM checks. A
 *  pure-UI step has no run of its own, so it never POSTs and never polls; its
 *  anchors are dom_state only (enforced at parse).
 *
 *  The verdict's S1/S2/S3 spine reads a run detail when one exists: in a journey
 *  the PRIOR step's run (the live DOM reflects it); in the FUNCTIONAL lane a
 *  step's fixture_state IS its setup, so a fixture-backed ui step needs no prior
 *  run and synthesizes an empty detail. A ui step with NEITHER a prior run NOR a
 *  fixture_state still fails loud (it would score against nothing). */
async function driveUiOnlyStep(args: {
  driver: UiDriver;
  opts: RunnerOpts;
  c: Case;
  step: CaseStep;
  prevRunId: string | null;
  host: HostHandle;
  stepMaxMs: number;
  scopeProfileId: string | null;
}): Promise<VerdictDoc> {
  const { driver, opts, c, step, prevRunId, host, stepMaxMs, scopeProfileId } = args;
  if (prevRunId === null && step.fixtureState === null) {
    fail(`step "${step.id}": a kind="ui" step needs a prior run's DOM, or a fixture_state setup, to act on (neither present)`);
  }

  // Replay the generic verbs in author order against the persistent page.
  for (const action of step.uiActions ?? []) {
    if (action.verb === "click") {
      await driver.clickTestid(action.testid, stepMaxMs);
    } else if (action.verb === "fill") {
      await driver.fillTestid(action.testid, action.value ?? "", stepMaxMs);
    } else if (action.verb === "select") {
      // Choose an option in a <select> by its value (fill cannot target a select).
      await driver.selectOptionTestid(action.testid, action.value ?? "", stepMaxMs);
    } else if (action.verb === "press") {
      await driver.pressKey(action.testid, action.value ?? "Enter", stepMaxMs);
    } else if (action.verb === "navigate") {
      // value = the client-side path; testid = the settle testid the
      // destination route mounts (a navigate with no value is a case bug).
      if (action.value === undefined || action.value.trim() === "") {
        fail(`step "${step.id}": a navigate ui_action needs value=<path> (the route to push)`);
      }
      await driver.navigateTo(action.value, action.testid, stepMaxMs);
    } else if (action.verb === "drag") {
      // dx is required (the case parser already fails loud when it's absent).
      await driver.drag(
        action.testid,
        action.dx ?? 0,
        action.expect ?? "delta",
        action.container ?? "app-body",
        stepMaxMs,
      );
    } else {
      await driver.reloadBrowser(stepMaxMs);
    }
  }

  // ---- realtime-reactivity proof (data_arriving) -------------------------
  // The ui_actions just opened a run stream in the rail (the rail subscribes
  // to /stream-v2). Grow the data WITHOUT reloading the SPA, then emit a
  // data.changed pulse onto that OPEN run channel. The dashboard's SSE→refetch
  // path must refresh the stale view IN PLACE — the dom_state anchors below are
  // scored AFTER the pulse with NO reload between the change and the assert, so
  // a passing count anchor can only have come from the pulse-driven refetch.
  if (step.dataArriving !== null) {
    // The ui_actions started a run; wait for the SPA to land on its /runs/:id
    // route (the rail subscribes to that run's /stream-v2 — the channel the
    // pulse rides). A run that never opened a route is a setup bug → fail loud.
    const openRunId = await driver.waitForRunRoute(prevRunId, stepMaxMs).catch(() => null);
    if (openRunId === null) {
      fail(`step "${step.id}": data_arriving needs an OPEN run stream (no /runs/:id route shown after ui_actions)`);
    }
    // Grow the seeded world (the new rows the pulse will surface), SPA untouched.
    await applyFixtureSeedNoReload(host.apiBase, step.dataArriving.growFixtureState);
    // The pulse on the open channel → the SPA refetches the named kinds.
    await emitDataChanged(host.apiBase, openRunId, step.dataArriving.kinds);
    // The refetch lands asynchronously (GET → state → re-render). Settle on the
    // step's count anchor BEFORE scoring, so the count assert reads the grown
    // (pulse-refreshed) view, not the pre-pulse snapshot. The wait throwing
    // would mean the pulse never refreshed the view — a real RED.
    const countAnchor = step.anchors.find(
      (a): a is Extract<(typeof step.anchors)[number], { kind: "dom_state" }> =>
        a.kind === "dom_state" && a.expect === "count" && a.count !== undefined,
    );
    if (countAnchor !== undefined) {
      await driver.waitForTestidCount(
        countAnchor.testid,
        countAnchor.count!,
        countAnchor.match ?? "exact",
        stepMaxMs,
      );
    }
    await driver.screenshot("data-changed-emitted");
  }

  // The explicit Pin verb on a runless fixture step: pin the fixture-seeded
  // profile through the REAL Searches-popover Pin button BEFORE scoring, so a
  // later pin_required skill step (e.g. dealer_web_lead_submit) launches pinned.
  // This is the func-lane twin of the live lane's intake-then-pin: the fixture
  // installs the profile, this verb pins it (sessions are never auto-pinned), and
  // the pin lands the ui_check the verdict carries.
  if (step.pinLabel !== null) {
    await driver.pinProfileInSearches(step.pinLabel, stepMaxMs);
  }

  // Score the dom_state anchors against the live page (recordDomState pushes a
  // UiCheck per anchor — the channel the verdict carries).
  for (const anchor of step.anchors) {
    if (anchor.kind !== "dom_state") continue; // parse already forbids non-dom anchors here.
    await driver.recordDomState(anchor.testid, anchor.expect, anchor.value, anchor.count, anchor.match);
  }

  // The verdict's S1/S2/S3 spine reads the prior run's detail when one exists
  // (the live DOM reflects it). A fixture-backed first step has no run — the
  // fixture is its setup — so its detail is an empty spine (the real assertions
  // live in the recorded dom_state checks).
  const detail =
    prevRunId !== null ? await buildRunDetail(host.apiBase, prevRunId) : EMPTY_RUN_DETAIL;
  // A runless ui step performs no DB write, so before/after are snapshotted
  // back-to-back (Δ=0 by construction). They exist only to keep the evidence
  // and evaluateStep shape uniform with the run-bearing steps, not to assert.
  const before = snapshotCounts(scopeProfileId);
  const after = snapshotCounts(scopeProfileId);
  // The verdict's run_id is the prior run when one exists; a fixture-backed
  // first step has no run, so it records a fixture sentinel instead.
  const runlessFixture = prevRunId === null;
  const verdict = await evaluateStep({
    apiBase: host.apiBase,
    c,
    step,
    runId: prevRunId ?? `fixture:${step.fixtureState ?? step.id}`,
    detail,
    before,
    after,
    profileId: scopeProfileId,
    layer: opts.layer,
    lane: "ui",
    domChecks: [...driver.checks],
    expectsWipe: step.expectsWipe,
    ...(runlessFixture ? { runlessFixture: true } : {}),
  });
  const dir = writeEvidence(opts.evidenceRoot, verdict.cell_id, step.id, {
    "verdict.json": verdict,
    "narrative.json": { case: c.id, step: step.id, provider: c.provider, inputMode: c.inputMode, lane: "ui", kind: "ui", profileId: scopeProfileId },
    "run.json": { priorRunId: prevRunId, fixtureState: step.fixtureState, uiActions: step.uiActions ?? [] },
    "db-before.json": before,
    "db-after.json": after,
  });
  console.log(
    JSON.stringify({ harness: "ui", step: step.id, kind: "ui", verdict: verdict.verdict, status: verdict.status, cell: verdict.cell_id, evidence: dir }),
  );
  return verdict;
}

/**
 * The UI-lane case runner: ONE server host + ONE driver browser session for the
 * WHOLE case (the non-tech-user journey), every step started by a REAL user
 * action (chat-rail slash/freeform text or the Skills popover Run button —
 * never POST /api/skill-runs) and resumed by REAL clicks. Per step it keeps the API lane's
 * full evidence spine: snapshot-before → drive → SSE drain (read-only evidence)
 * → snapshot-after → 6+1 anchors → S1/S2/S3 cross-check → verdict.json, with
 * the verdict's ui_checks now carrying the real DOM checks too.
 */
async function cmdUiCase(opts: RunnerOpts, c: Case): Promise<number> {
  ensureUiDist();

  // Pin the harness's own in-process DB reads to the throwaway --db (same
  // rationale as the API lane, gate ①b).
  process.env["AUTOBROKER_DB"] = opts.db;

  // The auto-chain host env is exported OFF unless the case opts in.
  const host = await startServerHost(opts, c.scanChain);
  let driver: UiDriver | null = null;
  let exitCode = 0;
  try {
    // Gates ⑥ + ⑦ + the served-shell check, all BEFORE any scoring.
    await assertServerActiveDbMatches({ provider: opts.provider, db: opts.db, apiBase: host.apiBase });
    const expectDriverKind = PROVIDER_DRIVER_KIND[c.provider] ?? fail(`no driver_kind label for provider ${c.provider}`);
    for (const step of c.steps) {
      const anchorExpect = step.anchors.find((a) => a.kind === "driver_kind")?.expect;
      if (anchorExpect !== undefined && anchorExpect !== expectDriverKind) {
        fail(
          `case anchor driver_kind expect="${anchorExpect}" disagrees with the provider-derived label "${expectDriverKind}" — fix the case TOML`,
        );
      }
    }
    await assertDriverKindLockStep(host.apiBase, expectDriverKind);
    await assertAppShellServed(host.apiBase);

    if (opts.dryRun) {
      console.log(JSON.stringify({ harness: "dry-run", ok: true, lane: "ui", case: c.id, apiBase: host.apiBase }));
      return 0;
    }

    driver = await UiDriver.launch({
      baseUrl: host.apiBase,
      screenshotDir: join(opts.evidenceRoot, "ui-shell"),
    });

    // The profiles the journey creates, keyed by the CREATING step's id —
    // a multi-intake journey (e.g. the 2-profile STOP world) needs per-step
    // scoping; `profile_scope_from = "<stepId>"` picks one explicitly. The
    // latest-created pointer keeps the single-intake default behavior.
    const profileByStep = new Map<string, string>();
    let latestProfileId: string | null = null;
    let prevRunId: string | null = null;
    const results: Array<{ cell: string; step: string; verdict: string }> = [];
    // Per-step profile-scoped profile_dealers deltas (the discovery counts a
    // later batch step's batch_rows_from cross-check reads).
    const dealersDeltaByStep = new Map<string, number>();
    // [[seed.dealer_inventory_sources]] applies ONCE, right before the case's
    // first inventory_link_scan step (the consuming skill) — by then the
    // journey's intake+geosearch steps created the profile and bound the
    // dealers the seed entries resolve against. [[seed.dealer_replies]] applies
    // ONCE, right before the case's first dealer_reply_extract step — it CREATES
    // its own dealer/thread/message corpus (no prior geosearch needed). Each
    // section tracks its own applied flag so a case may carry both.
    let inventorySeedsApplied = false;
    let replySeedsApplied = false;

    for (const step of c.steps) {
      // PER-STEP budget: the CLI --max-seconds overrides; else the step's TOML
      // max_seconds; else 900s — a 1800s scan step never inflates its siblings.
      const stepMaxMs = stepBudgetMs(opts, step);
      const gatePolicy: GatePolicy = opts.gatePolicy ?? step.gatePolicy;
      const cellDir = evidenceDirName(cellIdFor(c, step), step.id);
      driver.beginStep(join(opts.evidenceRoot, cellDir, "screenshots"));

      // ---- functional lane: install this step's fixture world FIRST ----------
      // The fixture seeds the isolated DB + flips the deterministic stubs BEFORE
      // the step drives, so a fixture-backed kind="ui" step needs no prior run.
      // A fixture_state outside the functional lane (live host) has no
      // /__e2e/apply-fixture route — fail loud rather than silently skip setup.
      if (step.fixtureState !== null) {
        if (!opts.fixture) {
          fail(`step "${step.id}" carries fixture_state — fixture worlds install on the functional lane only (--fixture)`);
        }
        await applyFixtureState(host.apiBase, step.fixtureState);
        await driver.reloadBrowser(stepMaxMs); // re-read the freshly-installed world.
        // A fixture world that seeds exactly one active profile + no intake step
        // to carry an id: adopt that profile as the scope target so later skill
        // steps measure profile-scoped table deltas honestly. Only the first
        // single-active install seeds it; an explicit profile_scope_from wins.
        if (latestProfileId === null) {
          const active = await readActiveProfileIds(host.apiBase);
          if (active.length === 1) latestProfileId = active[0]!;
        }
      }

      // ---- pure-UI step (kind="ui"): a user does DOM actions, no run --------
      // No startRun, no poller, no POST: replay the generic verbs against the
      // SAME persistent browser, then score the dom_state anchors via
      // recordDomState (which pushes UiChecks). The verdict is produced
      // normally off the PRIOR step's run detail (the DOM reflects that run's
      // terminal state) + the recorded DOM checks. The anchors themselves are
      // dom_state only (enforced at parse), so they passthrough in evalAnchor
      // and the real assertions live in ui_checks.
      if (step.kind === "ui") {
        const verdict = await driveUiOnlyStep({
          driver,
          opts,
          c,
          step,
          prevRunId,
          host,
          stepMaxMs,
          scopeProfileId: latestProfileId,
        });
        // A fixture-backed ui step that PINNED a profile makes that profile the
        // scope for the following skill steps (the func-lane twin of an intake
        // step setting latestProfileId): the fixture seeds exactly one active
        // profile, so the pin resolves it unambiguously off the read API. The
        // pinned profile's lead_submissions/messages deltas the next X1 step
        // asserts then scope correctly.
        if (step.pinLabel !== null) {
          const pinned = await resolveSingleActiveProfileId(host.apiBase);
          if (pinned !== null) {
            latestProfileId = pinned;
            profileByStep.set(step.id, pinned);
          }
        }
        results.push({ cell: verdict.cell_id, step: step.id, verdict: verdict.verdict });
        if (verdict.verdict !== "GREEN" && verdict.verdict !== "GREEN_WITH_WAIVER") {
          exitCode = 1;
          break;
        }
        continue;
      }

      // Past here the step is kind="skill": parse guarantees a skill (the ui
      // branch above returned), so narrow it for the run path.
      const skill = step.skill ?? fail(`step "${step.id}": kind="skill" with no skill (parse invariant breached)`);

      // The profile scope this step's snapshots/anchors read against: an
      // explicit profile_scope_from wins; an intake step scopes to NOTHING
      // before the run (it creates its own profile); otherwise the latest.
      let scopeProfileId: string | null;
      if (step.profileScopeFrom !== null) {
        const scoped = profileByStep.get(step.profileScopeFrom);
        if (scoped === undefined) {
          fail(
            `step "${step.id}": profile_scope_from="${step.profileScopeFrom}" recorded no created profile`,
          );
        }
        scopeProfileId = scoped;
      } else if (step.skill === INTAKE_SKILL) {
        scopeProfileId = null;
      } else {
        scopeProfileId = latestProfileId;
      }

      // ---- pre-step DB seed (consuming-skill corpus bootstrap) -------------
      // Applied BEFORE the step's before-snapshot, so the seeded rows are part
      // of the baseline: the step's own table deltas measure ONLY what the run
      // wrote (a decline case's Δ=0-exact anchors stay honest).
      if (
        !inventorySeedsApplied &&
        c.seed?.dealerInventorySources != null &&
        step.skill === "inventory_link_scan"
      ) {
        if (scopeProfileId === null) {
          fail(`step "${step.id}": [[seed.*]] needs a profile in scope (run intake first)`);
        }
        const applied = applyInventorySourceSeeds({
          dbPath: opts.db,
          profileId: scopeProfileId,
          seeds: c.seed.dealerInventorySources,
        });
        console.error(
          `[seed] dealer_inventory_sources: ${applied.seeded} row(s) inserted ` +
            `(${applied.sourceIds.length} declared) for profile ${scopeProfileId}`,
        );
        inventorySeedsApplied = true;
      }
      // [[seed.dealer_replies]] → the dealer_reply_extract corpus (dealer +
      // thread + fake_mailbox message + the matching inbound `messages` row).
      if (
        !replySeedsApplied &&
        c.seed?.dealerReplies != null &&
        step.skill === "dealer_reply_extract"
      ) {
        if (scopeProfileId === null) {
          fail(`step "${step.id}": [[seed.*]] needs a profile in scope (run intake first)`);
        }
        const applied = applyDealerReplySeeds({
          dbPath: opts.db,
          profileId: scopeProfileId,
          replies: c.seed.dealerReplies,
        });
        console.error(
          `[seed] dealer_replies: ${applied.dealers} dealer(s), ${applied.threads} thread(s), ` +
            `${applied.messages} message(s), ${applied.attachments} attachment(s) for profile ${scopeProfileId}`,
        );
        replySeedsApplied = true;
      }

      const before = snapshotCounts(scopeProfileId);
      const mutationBaseline = captureMutationBaseline();
      const beforeIds = await readProfileIds(host.apiBase);

      // ---- start the run BY USER ACTION -----------------------------------
      if (step.launch === "skills_popover") {
        await driver.launchSkillFromPopover(skill);
      } else if (step.launch === "chat_freeform" || step.launch === "chat_freeform_humanized") {
        const prompt = step.inputInline?.["prompt"];
        if (typeof prompt !== "string" || prompt.trim() === "") {
          fail(`case step "${step.id}" launches ${step.launch} but has no input_inline.prompt`);
        }
        if (step.launch === "chat_freeform_humanized") {
          await driver.typeInChatRailHumanized(prompt);
        } else {
          await driver.typeInChatRail(prompt);
        }
      } else if (step.launch === "stop_picker") {
        // The PREVIOUS step ended in a 2+-profiles STOP whose card is still
        // rendered; pick by vehicle label — the click starts a NEW run with
        // search_profile_id (STOP is terminal; this is never a resume).
        const label = step.inputInline?.["pick_label"];
        if (typeof label !== "string" || label.trim() === "") {
          fail(`case step "${step.id}" launches stop_picker but has no input_inline.pick_label`);
        }
        await driver.pickProfileStopOption(label, stepMaxMs);
      } else if (step.launch === "canvas_button") {
        // A Canvas control that itself starts a run (the host's onClick POSTs the
        // start + navigates to /runs/:id). The button's testid rides
        // input_inline.button_testid (e.g. the Threads "Retry failed extractions"
        // button → dealer_reply_extract escalate:true).
        const testid = step.inputInline?.["button_testid"];
        if (typeof testid !== "string" || testid.trim() === "") {
          fail(`case step "${step.id}" launches canvas_button but has no input_inline.button_testid`);
        }
        await driver.launchSkillFromCanvasButton(testid, stepMaxMs);
      } else {
        // chat_slash: a bare `/skill`, OR with input_inline.slash_args appended as
        // key=value tokens (the parser coerces them to start-body args, e.g.
        // quote_pipeline's target_listing_id / dry_run). Strings only — the slash
        // grammar carries no nesting.
        const slashArgs = step.inputInline?.["slash_args"];
        let slashText = `/${skill}`;
        if (slashArgs !== undefined && slashArgs !== null && typeof slashArgs === "object") {
          for (const [k, v] of Object.entries(slashArgs as Record<string, unknown>)) {
            slashText += ` ${k}=${String(v)}`;
          }
        }
        await driver.typeInChatRail(slashText);
      }
      // A freeform start runs the prefill LLM call BEFORE the ack/navigation,
      // so the route wait gets the full step budget.
      const runId = await driver.waitForRunRoute(prevRunId, stepMaxMs);
      prevRunId = runId;
      await driver.checkRunViewBound(runId);

      // Background gate poller (standby parity with the API lane; read-only
      // for these skills — no approval surface exists).
      const poller = startPoller(host.apiBase, runId, gatePolicy, { maxMs: stepMaxMs });

      // ---- drive the resume script as DOM actions, then await the terminal -
      // batch_review steps get the live suspend reader (name→dealer_id + the
      // <8KB bound) and the cross-step row-count expectation when declared.
      const hasBatchResume = step.resume.some(
        (r) => r.on === "batch_review" || r.on === "inbox_review",
      );
      const hasHygieneResume = step.resume.some((r) => r.on === "hygiene_review");
      let batchCtx: BatchDriveContext | undefined;
      if (hasBatchResume || hasHygieneResume) {
        let expectRowCount: number | null = null;
        if (step.batchRowsFrom !== null) {
          const delta = dealersDeltaByStep.get(step.batchRowsFrom);
          if (delta === undefined) {
            fail(`step "${step.id}": batch_rows_from="${step.batchRowsFrom}" recorded no profile_dealers delta`);
          }
          expectRowCount = delta;
        }
        batchCtx = {
          readSuspend: () => readBatchSuspendPayload(host.apiBase, runId),
          readHygieneSuspend: () => readHygieneSuspendPayload(host.apiBase, runId),
          expectRowCount,
        };
      }
      await driveResumeScriptDom(driver, step, stepMaxMs, batchCtx);
      if (step.edge === "sse_break") {
        // Break the live SSE mid-run: wait until the dashboard provably shows
        // the run in flight (the zone-4 browser trail), knock the TEST browser
        // offline for ~2s, restore. The transport's reconnect+skip must reach
        // the terminal with nothing duplicated (asserted after terminal).
        if (step.skill !== "dealer_geosearch") {
          fail(`step "${step.id}": edge=sse_break is wired for dealer_geosearch (its long browse step) only`);
        }
        await driver.waitForBrowserTrail(stepMaxMs);
        await driver.screenshot("pre-sse-break");
        await driver.setOffline(true);
        await sleep(2_000);
        await driver.setOffline(false);
        await driver.screenshot("post-sse-break");
      }
      const uiTerminal = await driver.waitForTerminal(stepMaxMs, runId);
      // A FRIENDLY typed STOP (no_lead_submitted) terminates `error` but the UI
      // deliberately renders a calm StopCard INSTEAD OF the turn-error line — so
      // the terminal-summary error check would falsely RED. The checkStopCard
      // call below is the terminal evidence for that case (the picker/CTA stops
      // still render turn-error alongside the card, so they keep this check).
      const friendlyStop = step.expectStop === "no_lead_submitted";
      if (!friendlyStop) {
        await driver.checkTerminalSummaryVisible(uiTerminal, runId);
      }
      if (step.edge === "sse_break" && uiTerminal === "done") {
        // The recovery must not have duplicated the rendering: the geosearch
        // confirm summary appears exactly once on exactly one assistant turn.
        await driver.checkNoDuplicateSummary(/dealer\(s\) discovered/);
      }

      // ---- typed-STOP choreography (expect_stop steps) ---------------------
      // The card must render with the expected stop code; the intake-pointing
      // codes also drive the CTA (a real intake run starts and renders its
      // form — zero-LLM, so still free). The 2+ code's picker is driven by the
      // FOLLOWING step's launch="stop_picker".
      if (step.expectStop !== null) {
        await driver.checkStopCard(step.expectStop);
        if (step.expectStop === "no_active_profile" || step.expectStop === "profile_missing_fields") {
          await driver.clickStopIntakeCta(stepMaxMs);
        }
      }
      // A resolution anchor doubles as the DOM provenance check: the rendered
      // turn's meta tag must voice the same pinned/inferred_newest branch.
      const resolutionAnchor = step.anchors.find(
        (a): a is Extract<(typeof step.anchors)[number], { kind: "resolution" }> =>
          a.kind === "resolution",
      );
      if (resolutionAnchor !== undefined && uiTerminal === "done") {
        await driver.checkMismatchBanner(resolutionAnchor.expect === "pinned", undefined, runId);
      }
      // ---- the explicit Pin verb (pin_label — attached to this step's
      // post-checks). Pins the rail session to the labeled profile through the
      // REAL Searches-popover Pin button; later launches then thread the pin
      // as search_profile_id. The ui_check it records lands on THIS step's
      // verdict. Sessions are never auto-pinned — this is the only pin path.
      if (step.pinLabel !== null) {
        if (uiTerminal !== "done") {
          fail(`step "${step.id}": pin_label set but the step terminated "${uiTerminal}" — nothing to pin`);
        }
        await driver.pinProfileInSearches(step.pinLabel, stepMaxMs);
      }
      poller.stop();

      // ---- evidence spine (identical to the API lane) ----------------------
      const detail = await buildRunDetail(host.apiBase, runId);
      if (step.skill === INTAKE_SKILL) {
        const created = await resolveNewProfileId(host.apiBase, beforeIds);
        if (created !== null) {
          profileByStep.set(step.id, created);
          latestProfileId = created;
          scopeProfileId = created;
        }
      }
      const profileId =
        step.skill === INTAKE_SKILL && uiTerminal !== "done" ? null : scopeProfileId;
      const after = snapshotCounts(profileId);
      // Record this step's profile-scoped dealer-discovery delta (a later
      // batch step's batch_rows_from cross-check reads it).
      dealersDeltaByStep.set(
        step.id,
        (after.profile["profile_dealers"] ?? 0) - (before.profile["profile_dealers"] ?? 0),
      );

      // ---- site_scan→aggregator auto-chain proof (chained_run anchor) --------
      // After this (parent) step reaches terminal, discover the sibling aggregator
      // run announced on the parent stream and wait for IT to complete, recording
      // the outcome as UiChecks the verdict carries. This runs BEFORE the case's
      // finally-teardown (host still alive), so the sibling never orphans mid-browse.
      const chainedAnchor = step.anchors.find(
        (a): a is Extract<(typeof step.anchors)[number], { kind: "chained_run" }> =>
          a.kind === "chained_run",
      );
      if (chainedAnchor !== undefined) {
        await driveChainedRun({
          driver,
          parentDetail: detail,
          anchor: chainedAnchor,
          scopeProfileId,
          parentTerminal: uiTerminal,
        });
      }

      let waiver: { kind: string; reason: string } | null = null;
      if (step.skill === "dealer_geosearch" && uiTerminal === "done") {
        waiver = geosearchEmptyResultWaiver(await driver.terminalSummaryText(), detail);
      } else if (step.skill === "incentive_scrape" && uiTerminal === "done") {
        waiver = incentiveScrapeEmptyResultWaiver(await driver.terminalSummaryText(), detail);
      }

      const verdict = await evaluateStep({
        apiBase: host.apiBase,
        c,
        step,
        runId,
        detail,
        before,
        after,
        profileId,
        layer: opts.layer,
        lane: "ui",
        domChecks: [...driver.checks],
        waiver,
        externalMutationBaseline: mutationBaseline,
        expectsWipe: step.expectsWipe,
      });
      // F9: a step asserting site_contribution also gets its per-site source
      // breakdown captured as evidence (the sourceBreakdown GROUP BY, not the
      // anchor's own scoring channel — the anchor reads per_site off detail;
      // this is the extra observability artifact the brief asks for).
      let sourceBreakdownRows: ReturnType<typeof sourceBreakdown> | null = null;
      if (profileId !== null && step.anchors.some((a) => a.kind === "site_contribution")) {
        const { db: readDb, close: closeReadDb } = openReadHandle();
        try {
          sourceBreakdownRows = sourceBreakdown(readDb, profileId);
        } finally {
          closeReadDb();
        }
      }
      const dir = writeEvidence(opts.evidenceRoot, verdict.cell_id, step.id, {
        "verdict.json": verdict,
        "narrative.json": { case: c.id, step: step.id, provider: c.provider, inputMode: c.inputMode, lane: "ui", launch: step.launch, profileId },
        "run.json": { runId, terminalStatus: detail.terminalStatus, driverKind: detail.driverKind, events: detail.events.length, uiTerminal },
        "transcript.json": detail.events,
        "db-before.json": before,
        "db-after.json": after,
        ...(sourceBreakdownRows !== null ? { "source-breakdown.json": sourceBreakdownRows } : {}),
      });
      console.log(
        JSON.stringify({ harness: "ui", step: step.id, verdict: verdict.verdict, status: verdict.status, cell: verdict.cell_id, evidence: dir }),
      );
      results.push({ cell: verdict.cell_id, step: step.id, verdict: verdict.verdict });
      if (verdict.verdict !== "GREEN" && verdict.verdict !== "GREEN_WITH_WAIVER") {
        exitCode = 1;
        break; // a RED step ends the journey — later steps depend on it.
      }
    }

    console.log(JSON.stringify({ harness: "ui-case", case: c.id, results, ok: exitCode === 0 }));
  } finally {
    if (driver !== null) await driver.close();
    await host.stop();
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// evidence-dir retention
// ---------------------------------------------------------------------------

/** Names of timestamp run dirs (`^YYYY-MM-DDT…`) older than `maxAgeDays` by their
 *  NAME date. PURE + FS-free so it is unit-testable in isolation. Only strict
 *  timestamp-prefixed names are ever returned — a non-timestamped sibling (e.g.
 *  regression.sh's root `autobroker.db*`) never matches, so the sweep can never
 *  delete it. */
export function expiredRunDirNames(names: string[], now: Date, maxAgeDays: number = RUN_DIR_RETENTION_DAYS): string[] {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  for (const name of names) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(name);
    if (m === null) continue;
    const dayMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isNaN(dayMs)) continue;
    if (dayMs < cutoff) expired.push(name);
  }
  return expired;
}

/** Best-effort retention sweep of the shared harness-runs root: delete timestamp
 *  run dirs older than the retention window. Never throws (a missing root or a
 *  concurrently-recreated dir is skipped) and — via expiredRunDirNames — never
 *  touches a non-timestamped entry. */
function sweepOldRunDirs(runsRoot: string = HARNESS_RUNS_ROOT, now: Date = new Date()): void {
  let names: string[];
  try {
    if (!existsSync(runsRoot)) return;
    names = readdirSync(runsRoot);
  } catch {
    return;
  }
  for (const name of expiredRunDirNames(names, now)) {
    try {
      rmSync(join(runsRoot, name), { recursive: true, force: true });
    } catch {
      /* best-effort: a busy dir / perms issue must never abort the harness. */
    }
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export async function run(argv: string[]): Promise<number> {
  // The harness runner is, by definition, a harness context — it must never reach
  // a real dealer. The product is buyer-by-default, so mark this a harness context
  // and pin test mode in the runner process itself BEFORE the gate-②b preflight,
  // so the floor holds no matter how the runner was launched.
  process.env.AUTOBROKER_HARNESS = "1";
  process.env.AUTOBROKER_MODE = "test";
  // Self-resolve the provider key BEFORE any model/provider call or the gate-⑤
  // key-presence preflight, so `pnpm harness` needs no manual `source .env`. The
  // .env loader is data-dir-independent (it fills the gap even though the harness
  // sets an ISOLATED AUTOBROKER_DATA_DIR whose keys.json is empty); keys.json runs
  // after and wins for a direct run against the default data dir. NO-CLOBBER means
  // an already-exported key still wins over both. Both missing = no-op.
  loadDotEnvKeys();
  loadSecretsIntoEnv();
  // Retention: prune run-evidence dirs older than the window before this run adds
  // its own. Best-effort + timestamp-name-scoped, so it never blocks a run or
  // deletes a non-run sibling.
  sweepOldRunDirs();
  const opts = parseArgs(argv);
  switch (opts.command) {
    case "intake":
    case "case":
      return cmdIntake(opts);
    default:
      fail(`unhandled command ${opts.command}`);
  }
  return 1;
}

// Validate the provider→key map exists at module load (catch a bad --provider early).
void PROVIDER_KEY_ENV;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`harness FAILED: ${(err as Error).message}`);
      process.exit(1);
    });
}
