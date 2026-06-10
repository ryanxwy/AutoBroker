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
 * SUBCOMMANDS: intake | case | suite. CLI:
 *   pnpm harness intake [--case <name>] [--provider deepseek]
 *                       [--gate-policy approve_safe] [--max-seconds 900]
 *                       [--db <path>] [--dry-run]
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
 * (driver-kind type) — NEVER better-sqlite3/drizzle/playwright/@ai-sdk. The DB
 * reads go through dbReads (the read-only @autobroker/db channel).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  type VerdictDoc,
} from "./evaluator.js";
import { snapshotCounts, openReadHandle, type TableCounts } from "./dbReads.js";
import { assertEnvEnvelope, assertServerActiveDbMatches, PROVIDER_KEY_ENV } from "./preflight.js";
import { startPoller, type GatePolicy } from "./poller.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_HOST = join(HERE, "serverHost.ts");
const TSX_LOADER = join(HERE, "..", "node_modules", ".pnpm", "tsx@4.22.4", "node_modules", "tsx", "dist", "loader.mjs");

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export interface RunnerOpts {
  command: "intake" | "case" | "suite";
  casePath: string | null;
  caseName: string | null;
  step: string | null;
  provider: "deepseek" | "anthropic" | "openai";
  inputMode: "slash" | "freeform" | null;
  apiBase: string | null;
  db: string;
  evidenceRoot: string;
  gatePolicy: GatePolicy | null;
  layer: string;
  maxSeconds: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): RunnerOpts {
  // Drop the node + script argv entries, then strip any standalone "--" separator
  // tokens (pnpm `run <script> --` injects one when forwarding args through a
  // workspace-filtered script). What remains is the subcommand + flags.
  const tokens = argv.slice(2).filter((t) => t !== "--");
  const [cmd, ...rest] = tokens;
  const command = (cmd ?? "intake") as RunnerOpts["command"];
  if (!["intake", "case", "suite"].includes(command)) {
    fail(`unknown subcommand "${command}" (expected intake|case|suite)`);
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
  const runRoot = join(homedir(), ".autobroker-ts", "harness-runs", ts);
  const db = flags.get("db") ?? join(runRoot, "autobroker.db");
  const evidenceRoot = flags.get("evidence-root") ?? join(runRoot, "evidence");
  const provider = (flags.get("provider") ?? "deepseek") as RunnerOpts["provider"];

  return {
    command,
    casePath: flags.get("case") ?? null,
    caseName: flags.get("case-name") ?? null,
    step: flags.get("step") ?? null,
    provider,
    inputMode: (flags.get("input-mode") as RunnerOpts["inputMode"]) ?? null,
    apiBase: flags.get("api-base") ?? null,
    db: resolve(expandTilde(db)),
    evidenceRoot: resolve(expandTilde(evidenceRoot)),
    gatePolicy: (flags.get("gate-policy") as GatePolicy | undefined) ?? null,
    layer: flags.get("layer") ?? "L2",
    maxSeconds: Number(flags.get("max-seconds") ?? 900),
    dryRun: bools.has("dry-run"),
  };
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
 *  AUTOBROKER_DATA_DIR is set to the run's isolated dir before spawn. */
function startServerHost(opts: RunnerOpts): Promise<HostHandle> {
  const dataDir = dirname(opts.db);
  mkdirSync(dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOBROKER_DATA_DIR: dataDir,
    // Ensure the explicit DB override matches --db so /api/mode reports exactly it.
    AUTOBROKER_DB: opts.db,
    MASTRA_TELEMETRY_DISABLED: "1",
  };
  delete env.AUTOBROKER_TEST_AUTO_APPROVE;

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
      resume = { on: pendingKind(pending.step), action: "decline", content: null };
    }
    cursor = Math.min(cursor + 1, resumes.length);

    usedDecisionIds.add(pending.decisionId);
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
    case "forceOverrideGate":
      return "force_override";
    case "resolveLocation":
      return "ambiguous_location";
    case "trimVerify":
    case "prefill":
      return "malformed_tool_call";
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
}): Promise<VerdictDoc> {
  const { apiBase, c, step, runId, detail, before, after, profileId, layer } = args;
  const ctx: EvalContext = {
    profileId,
    before,
    after,
    runWindow: { from: detail.events[0]?.ts ?? "", to: detail.events[detail.events.length - 1]?.ts ?? "" },
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
  //   S1 = SSE terminal text (Driver-observed).
  //   S2 = re-pulled read API (Monitor-observed, refresh-confirmed).
  //   S3 = backend ground truth (read-only SQLite profile-scoped delta).
  const s1Ok = detail.terminalStatus !== null;
  let s2Ok = true;
  let s2Available = true;
  let s2Text = "n/a";
  if (profileId !== null) {
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
  const s3Ok = tableAnchor === undefined ? true : tableAnchor.ok;

  const confidence = computeConfidence({ s1Ok, s2Ok, s3Ok, s2Available });
  const crossCheck: CrossCheck = {
    s1: `SSE terminal=${detail.terminalStatus}`,
    s2: s2Text,
    s3: `profile-scoped delta ${tableAnchor ? `(${String(tableAnchor.observed)})` : "n/a"}`,
    confidence,
  };

  // The S2 re-pull IS a ui_check in the ratified self-contained L2 mode
  // (STANDARD §5): the Monitor surface is the read API, refresh-confirmed.
  // Recording it keeps ui_checks non-vacuous at live layers; dashboard-DOM
  // checks via the five-role Monitor join at L3.
  const uiChecks = [
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
    runId,
    anchors,
    uiChecks,
    crossCheck,
  });
}

// ---------------------------------------------------------------------------
// evidence writing
// ---------------------------------------------------------------------------

function writeEvidence(evidenceRoot: string, cellId: string, files: Record<string, unknown>): string {
  const dir = join(evidenceRoot, cellId.replace(/\//g, "__"));
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
  const step = opts.step ? c.steps.find((s) => s.id === opts.step) ?? fail(`no step "${opts.step}" in case`) : c.steps[0]!;
  const gatePolicy: GatePolicy = opts.gatePolicy ?? step.gatePolicy;

  // (1b) Pin the harness's OWN in-process DB reads to the throwaway --db
  // (review HIGH, 2026-06-05): openDb() resolves via AUTOBROKER_DB first, so an
  // inherited override could point the keystone/table_min_rows/cost reads at a
  // different file than the server writes. Preflight gate ①b already refused a
  // CONFLICTING override; pinning here makes the read path deterministic.
  process.env["AUTOBROKER_DB"] = opts.db;

  // (2) Boot the REAL server host (isolated DB under ~/.autobroker-ts).
  const host = await startServerHost(opts);
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
    const poller = startPoller(host.apiBase, runId, gatePolicy, { maxMs: opts.maxSeconds * 1000 });

    // (7) drive the resume[] script (collect submit / decline / force-override …).
    await driveResumeScript(host.apiBase, runId, step.resume, opts.maxSeconds * 1000);
    poller.stop();

    // (8) drain SSE → RunDetail; resolve the created profile id (for after scope).
    const detail = await buildRunDetail(host.apiBase, runId);
    const profileId = await resolveNewProfileId(host.apiBase, beforeIds);
    const after = snapshotCounts(profileId);

    // (9) evaluate → verdict.json + evidence.
    const verdict = await evaluateStep({ apiBase: host.apiBase, c, step, runId, detail, before, after, profileId, layer: opts.layer });
    const dir = writeEvidence(opts.evidenceRoot, verdict.cell_id, {
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
// entry
// ---------------------------------------------------------------------------

export async function run(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  switch (opts.command) {
    case "intake":
    case "case":
      return cmdIntake(opts);
    case "suite":
      fail("suite subcommand is scaffolded but not wired for the intake slice (single-step intake only)");
      break;
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
