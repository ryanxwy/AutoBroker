/**
 * orchestrator — the per-scenario soak drive loop (Phase-A affordance-faithful).
 *
 * Per scenario the orchestrator:
 *  (1) boots the REAL serverHost child via the SAME path runner.ts uses
 *      (serverHost.ts under tsx) with an ISOLATED AUTOBROKER_DATA_DIR under
 *      ~/.autobroker-ts/soak-runs/<ts>/, test mode pinned (AUTOBROKER_MODE=test,
 *      the sole send-control floor), and AUTOBROKER_TEST_AUTO_APPROVE DELETED —
 *      refusing to start otherwise (the test-mode preflight);
 *  (2) launches ONE UiDriver (the single pinned browser the orchestrator owns);
 *  (3) spawns the claude BUYER (via claudeAgent — pure NL generation, no browser)
 *      to GENERATE the freeform cold-start, then TYPES it via typeInChatRail;
 *  (4) launches every subsequent skill via /slash typed into the rail;
 *  (5) answers HITL via the gate-BUTTON verbs (clickApprovalApprove/Deny, batch
 *      select/submit/decline, pickProfileStopOption, reset confirm/cancel,
 *      hygiene decline) — NEVER a chat-text answer to a gate;
 *  (6) spawns the Sonnet DEALER (multi-round only) whose replies land in
 *      fake_mailbox_* via applyDealerReplySeeds (zero SUT-shared context);
 *  (7) drains the trace (buildRunDetail), runs the HYBRID verdict, writes a
 *      replayable ledger row.
 *
 * The claude children EMIT text only; the orchestrator owns the one browser +
 * every gate button. This keeps the buyer/dealer agent-agnostic and the session
 * single-owned (the session-consistency story).
 *
 * LIVE behavior (boot server + spawn claude -p + drive Playwright) is integration-
 * tested in a later live e2e, NOT in unit tests — this module is structurally
 * complete + wired + typechecks.
 *
 * Dependency wall: harness layer. Reuses dbReads (read-only), seed (the sanctioned
 * write), uiDriver (the ONE playwright import — via the UiDriver class, never
 * playwright directly), detail (buildRunDetail), claudeAgent + the soak modules.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildRunDetail, type RunDetail } from "../detail.js";
import { externalMutationDbCount, openReadHandle } from "../dbReads.js";
import { UiDriver } from "../uiDriver.js";
import { spawnClaudeAgent, type ClaudeAgentResult } from "./claudeAgent.js";
import {
  appendLedgerRow,
  buildSoakLedgerRow,
  type SoakRunTrace,
} from "./ledger.js";
import { personaDirective, type ScenarioClass } from "./taxonomy.js";
import {
  assertTestModeArmed,
  assertNoExternalMutation,
  combineSoakVerdict,
  type DeterministicResult,
  type SoakVerdictDoc,
} from "./verdict.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** serverHost.ts lives one level up (harness/serverHost.ts), run under tsx — the
 *  SAME child the runner spawns. */
const SERVER_HOST = join(HERE, "..", "serverHost.ts");
// Resolve tsx's loader from its package "." export (dist/loader.mjs) rather than a
// hardcoded .pnpm/tsx@<version>/ path, which broke on any tsx patch/minor bump.
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
/** The role prompts (harness/prompts/*.md). */
const PROMPTS_DIR = join(HERE, "..", "prompts");
export const BUYER_PROMPT = join(PROMPTS_DIR, "buyer.md");
export const DEALER_PROMPT = join(PROMPTS_DIR, "dealer.md");
export const JUDGE_PROMPT = join(PROMPTS_DIR, "judge.md");

// ---------------------------------------------------------------------------
// the isolated soak-run host (mirrors runner.startServerHost + pins AUTOBROKER_MODE=test)
// ---------------------------------------------------------------------------

export interface SoakHostHandle {
  child: ChildProcess;
  apiBase: string;
  dataDir: string;
  dbPath: string;
  /** The exact env handed to the child (the test-mode anchor reads it). */
  env: NodeJS.ProcessEnv;
  stop: () => Promise<void>;
}

/**
 * Build the child env for a soak host: the runner's isolation shape PLUS test
 * mode pinned (AUTOBROKER_MODE=test, the sole send-control floor) and
 * AUTOBROKER_TEST_AUTO_APPROVE deleted. Pure so the test-mode preflight + the
 * unit test can assert it without a spawn. (The child also boots through
 * boot.ts, which force-pins test mode for harness contexts; MODE is set here
 * explicitly so the preflight + ledger anchor read it directly.)
 */
export function buildSoakHostEnv(parentEnv: NodeJS.ProcessEnv, dataDir: string, dbPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    AUTOBROKER_DATA_DIR: dataDir,
    AUTOBROKER_DB: dbPath,
    MASTRA_TELEMETRY_DISABLED: "1",
    // Test mode pinned — AUTOBROKER_MODE is the sole send-control floor; the
    // Gmail backend projects to fake from it, so the soak can never really send.
    AUTOBROKER_MODE: "test",
  };
  // Keep the gate live to exercise the decline path (never auto-approve).
  delete env.AUTOBROKER_TEST_AUTO_APPROVE;
  return env;
}

/** Spawn the real serverHost child for a soak run. Refuses to start if test mode
 *  is not pinned in the constructed env (the test-mode preflight). */
export function startSoakHost(opts: {
  dataDir: string;
  dbPath: string;
  parentEnv?: NodeJS.ProcessEnv;
}): Promise<SoakHostHandle> {
  mkdirSync(opts.dataDir, { recursive: true });
  const env = buildSoakHostEnv(opts.parentEnv ?? process.env, opts.dataDir, opts.dbPath);

  // Test-mode preflight: refuse to spawn with test mode unset / AUTO_APPROVE set.
  const fuse = assertTestModeArmed(env);
  if (!fuse.ok) {
    return Promise.reject(new Error(`startSoakHost: test-mode preflight failed — ${fuse.detail}`));
  }

  return new Promise<SoakHostHandle>((resolveHost, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(TSX_LOADER).href, SERVER_HOST], {
      cwd: join(HERE, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let buf = "";
    let settled = false;
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const line = buf
        .split("\n")
        .find((l) => l.includes('"harness_host":"listening"') || l.includes('"harness_host": "listening"'));
      if (line && !settled) {
        settled = true;
        try {
          const info = JSON.parse(line) as { port: number; dataDir: string };
          resolveHost({
            child,
            apiBase: `http://127.0.0.1:${info.port}`,
            dataDir: info.dataDir,
            dbPath: opts.dbPath,
            env,
            stop: () => stopChild(child),
          });
        } catch (e) {
          reject(e);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => process.stderr.write(`[soak-host] ${d}`));
    child.on("exit", (code) => {
      if (!settled) reject(new Error(`soak serverHost exited early (code ${code})`));
    });
    setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        reject(new Error("soak serverHost did not become ready within 30s"));
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

/** Capture the keystone external-mutation baseline (mirrors runner.captureMutationBaseline). */
export function captureMutationBaseline(): number {
  const { db, close } = openReadHandle();
  try {
    return externalMutationDbCount(db).total;
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
// the per-scenario drive (structurally complete; live-tested later)
// ---------------------------------------------------------------------------

export interface RunScenarioOpts {
  scenario: ScenarioClass;
  /** The run root under ~/.autobroker-ts/soak-runs/<ts>/ (data dir + ledger live here). */
  runRoot: string;
  /** Headless browser (default true). */
  headless?: boolean;
  /** Wall-clock budget per drive leg (ms). */
  legTimeoutMs?: number;
}

export interface RunScenarioResult {
  scenarioId: string;
  verdict: SoakVerdictDoc;
  ledgerPath: string;
  buyerSessionId: string | null;
}

/**
 * Drive ONE scenario end-to-end. The structure is complete + wired; the gate-verb
 * choreography per skill is filled in by the per-skill soak plans (which add their
 * own scenarios + extend this loop). plan-0 wires the spine: boot → buyer-generate
 * → type freeform → capture trace → hybrid verdict → ledger row.
 */
export async function runScenario(opts: RunScenarioOpts): Promise<RunScenarioResult> {
  const dataDir = join(opts.runRoot, "data");
  const dbPath = join(dataDir, "autobroker.db");
  const ledgerPath = join(opts.runRoot, "ledger.jsonl");
  const legTimeoutMs = opts.legTimeoutMs ?? 180_000;

  // Pin the orchestrator's own in-process DB reads to the isolated db.
  process.env["AUTOBROKER_DB"] = dbPath;

  const host = await startSoakHost({ dataDir, dbPath });
  let driver: UiDriver | null = null;
  let buyer: ClaudeAgentResult | null = null;
  const deterministic: DeterministicResult[] = [];

  try {
    // Test-mode anchor (records the pinned env into the verdict for EVERY scenario).
    deterministic.push(assertTestModeArmed(host.env));

    // (2) The single pinned browser.
    driver = await UiDriver.launch({
      baseUrl: host.apiBase,
      screenshotDir: join(opts.runRoot, "screenshots"),
      ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    });

    // (3) Spawn the buyer → GENERATE the freeform cold-start text.
    buyer = await spawnClaudeAgent({
      rolePromptPath: BUYER_PROMPT,
      model: opts.scenario.buyerModel,
      task: buyerTaskFor(opts.scenario),
      timeoutMs: legTimeoutMs,
    });

    // Keystone baseline BEFORE the first launch (mirrors runner.captureMutationBaseline).
    const baseline = captureMutationBaseline();

    // (4) Type the generated freeform into the chat rail (cold-starts intake).
    await driver.typeInChatRail(buyer.generatedText);

    // The intake form renders for human-confirm; the orchestrator owns the gate
    // buttons from here. The per-skill plans add the /slash launches + the gate-
    // verb choreography for this scenario's gate_verbs; plan-0 captures the trace
    // off whatever run the cold-start started.
    const trace = await captureTrace(driver, host.apiBase);

    // The keystone, every scenario step (read-only DB scan delta vs baseline).
    const { db, close } = openReadHandle();
    try {
      deterministic.push(assertNoExternalMutation({ db, baseline }));
    } finally {
      close();
    }

    // (7) The hybrid verdict (deterministic half; the soft-dim judge is wired via
    // verdict.runJudge and invoked by the per-skill plans that capture SUT output).
    const verdict = combineSoakVerdict({ deterministic });

    const row = buildSoakLedgerRow({
      scenarioId: opts.scenario.id,
      className: opts.scenario.className,
      surface: opts.scenario.surface,
      role: "buyer",
      model: buyer.model ?? opts.scenario.buyerModel,
      generatedText: buyer.generatedText,
      contentHash: buyer.contentHash,
      claudeSessionId: buyer.claudeSessionId,
      costUsd: buyer.costUsd,
      rateLimited: buyer.rateLimited,
      trace,
      verdict: verdict.verdict,
      deterministicResults: verdict.deterministic,
      judgeResults: verdict.judge,
    });
    appendLedgerRow(ledgerPath, row);

    return {
      scenarioId: opts.scenario.id,
      verdict,
      ledgerPath,
      buyerSessionId: buyer.claudeSessionId,
    };
  } finally {
    if (driver !== null) await driver.close();
    await host.stop();
  }
}

/** Build the buyer's per-scenario task from the scenario's stresses + class. The
 *  buyer.md role file already constrains "emit text only, one vehicle"; the task
 *  carries the scenario-specific intent. */
export function buyerTaskFor(scenario: ScenarioClass): string {
  const persona = personaDirective(scenario.buyerPersona);
  return [
    `Scenario class: ${scenario.className}.`,
    `What this stresses: ${scenario.stresses}`,
    ...(persona ? [persona] : []),
    "",
    "Write the FIRST chat message a real buyer would send to cold-start this — freeform prose, one vehicle, in character. Emit only that message text.",
  ].join("\n");
}

/** Drain the run trace off whatever run is currently shown in the rail (the
 *  cold-start started one). Returns a small trace summary for the ledger, or null
 *  when no run is on the rail yet. */
async function captureTrace(driver: UiDriver, apiBase: string): Promise<SoakRunTrace | null> {
  const runId = driver.currentRunId();
  if (runId === null) return null;
  let detail: RunDetail;
  try {
    detail = await buildRunDetail(apiBase, runId);
  } catch {
    return { runId, terminalStatus: null, eventCount: 0, sawApprovalGate: false };
  }
  return {
    runId,
    terminalStatus: detail.terminalStatus,
    eventCount: detail.events.length,
    sawApprovalGate: detail.sawApprovalGate,
  };
}

/** The run root for a soak invocation: ~/.autobroker-ts/soak-runs/<ts>/. */
export function soakRunRoot(now: () => Date = () => new Date()): string {
  const ts = now().toISOString().replace(/[:.]/g, "-");
  return join(homedir(), ".autobroker-ts", "soak-runs", ts);
}
