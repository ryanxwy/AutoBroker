/**
 * cli — the `pnpm soak` entrypoint (local/owner-run; NEVER green.sh/CI).
 *
 * Subcommands:
 *   soak run   --scenario <id>            — drive one scenario end-to-end.
 *   soak suite [--class <className>]      — iterate the taxonomy (a class, or all).
 *   soak e2e   --mode nl|slash [--scenario <id>]
 *                                         — drive the plan-3 full-journey
 *                                           session-consistency journey in the given
 *                                           mode (nl = the product NL router; slash =
 *                                           the deterministic /skill path). A
 *                                           --scenario picks ONE class; absent → the
 *                                           whole sc_* taxonomy, sequentially.
 *   soak freeze --ledger <jsonl> --row <i> — minimize + emit a corpus case from a
 *                                            recorded failure.
 *   soak list                             — print the loaded taxonomy (coverage).
 *
 * The lane is OAuth-only by nature: `soak run`/`suite` refuse to start when ANY
 * provider api key is present in env (the claude child must use the Keychain
 * subscription, not an api key). It sets the isolated AUTOBROKER_DATA_DIR under
 * ~/.autobroker-ts/soak-runs/<ts>/ and pins AUTOBROKER_MODE=test via the orchestrator.
 *
 * Dependency wall: harness layer. Reuses the soak modules; no framework, no DB
 * write outside the sanctioned seed path, no playwright import (the orchestrator
 * owns the one browser via uiDriver).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { STRIPPED_KEY_ENV } from "./claudeAgent.js";
import {
  emitCorpusToml,
  minimizeFailingInput,
  writeCorpusCase,
  type EmitCorpusTomlInput,
} from "./freezeToCorpus.js";
import { parseLedgerJsonl } from "./ledger.js";
import { runScenario, soakRunRoot } from "./orchestrator.js";
import {
  driveSessionConsistencyJourney,
  type DriveMode,
} from "./skills/sessionConsistency.js";
import {
  findScenario,
  loadTaxonomy,
  scenariosInClass,
  type ScenarioClass,
} from "./taxonomy.js";
import type { SoakVerdictDoc } from "./verdict.js";

interface SoakArgs {
  command: "run" | "suite" | "e2e" | "freeze" | "list";
  flags: Map<string, string>;
  bools: Set<string>;
}

/** The plan-3 session-consistency scenarios all carry the `sc_` id prefix. */
const SESSION_CONSISTENCY_PREFIX = "sc_";

function parseArgs(argv: string[]): SoakArgs {
  const tokens = argv.slice(2).filter((t) => t !== "--");
  const [cmd, ...rest] = tokens;
  const command = (cmd ?? "list") as SoakArgs["command"];
  if (!["run", "suite", "e2e", "freeze", "list"].includes(command)) {
    fail(`unknown subcommand "${command}" (expected run|suite|e2e|freeze|list)`);
  }
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) bools.add(key);
    else {
      flags.set(key, next);
      i += 1;
    }
  }
  return { command, flags, bools };
}

function fail(msg: string): never {
  console.error(`soak: ${msg}`);
  process.exit(1);
}

/**
 * The OAuth-only precondition: refuse to run the live spawn lane when ANY provider
 * api key is present in env — the claude child must use the Keychain subscription.
 * (claudeAgent strips these from the CHILD; this refuses to even start if the
 * PARENT carries one, so the owner notices a mis-set env rather than burning api
 * credits.)
 */
export function assertOauthOnly(env: NodeJS.ProcessEnv): void {
  const present = STRIPPED_KEY_ENV.filter((k) => env[k] !== undefined && env[k] !== "");
  if (present.length > 0) {
    fail(
      `the soak lane is OAuth-subscription-only — found api key env: ${present.join(", ")}. ` +
        "Unset them (the claude child uses the Keychain subscription, no api-key cost).",
    );
  }
}

async function cmdRun(args: SoakArgs): Promise<number> {
  assertOauthOnly(process.env);
  const id = args.flags.get("scenario") ?? fail("`soak run` requires --scenario <id>");
  const scenario = findScenario(loadTaxonomy(), id);
  const runRoot = soakRunRoot();
  const headless = !args.bools.has("headed");
  const result = await runScenario({ scenario, runRoot, headless });
  console.log(
    JSON.stringify({
      soak: "run",
      scenario: result.scenarioId,
      verdict: result.verdict.verdict,
      status: result.verdict.status,
      defect: result.verdict.defect,
      ledger: result.ledgerPath,
      claudeSessionId: result.buyerSessionId,
    }),
  );
  return result.verdict.verdict === "GREEN" ? 0 : 1;
}

async function cmdSuite(args: SoakArgs): Promise<number> {
  assertOauthOnly(process.env);
  const all = loadTaxonomy();
  const className = args.flags.get("class");
  const scenarios: ScenarioClass[] = className === undefined ? all : scenariosInClass(all, className);
  if (scenarios.length === 0) fail(`no scenarios${className ? ` in class "${className}"` : ""}`);
  const headless = !args.bools.has("headed");

  const untilDry = args.bools.has("until-dry");
  const dryRounds = args.flags.has("dry-rounds") ? Math.max(1, Number(args.flags.get("dry-rounds"))) : 2;
  const seenSignatures = new Set<string>();
  let consecutiveDry = 0;
  let round = 0;
  let worst = 0;

  // One suite pass; with --until-dry, loop until `dryRounds` consecutive rounds
  // surface NO novel {surface,assertionId,defect.kind} signature (the discovery
  // engine has gone dry). Without it, exactly one pass (the prior behavior).
  do {
    round += 1;
    let novelThisRound = false;
    // Sequential — the subscription is rate-limited; pace one scenario at a time
    // (claudeAgent surfaces rateLimited so a future backoff can read it).
    for (const scenario of scenarios) {
      const runRoot = soakRunRoot();
      const result = await runScenario({ scenario, runRoot, headless });
      const sig = noveltySignature(scenario, result.verdict);
      const novel = sig !== null && !seenSignatures.has(sig);
      if (sig !== null) seenSignatures.add(sig);
      if (novel) novelThisRound = true;
      console.log(
        JSON.stringify({
          soak: "suite",
          round,
          scenario: result.scenarioId,
          verdict: result.verdict.verdict,
          status: result.verdict.status,
          signature: sig,
          novel,
          ledger: result.ledgerPath,
        }),
      );
      if (result.verdict.verdict !== "GREEN") worst = 1;
    }
    consecutiveDry = novelThisRound ? 0 : consecutiveDry + 1;
  } while (untilDry && consecutiveDry < dryRounds);

  if (untilDry) {
    console.log(JSON.stringify({ soak: "suite", done: true, rounds: round, signatures: seenSignatures.size }));
  }
  return worst;
}

/** The novelty signature for an until-dry round: surface + the first failing
 *  deterministic assertion id + the defect kind. A GREEN scenario (no defect) is
 *  not novel (null). Two rounds that surface only already-seen signatures = dry. */
function noveltySignature(scenario: ScenarioClass, verdict: SoakVerdictDoc): string | null {
  if (verdict.defect === null) return null;
  const failing = verdict.deterministic.find((d) => !d.ok);
  return `${scenario.surface}::${failing?.assertionId ?? verdict.defect.kind}::${verdict.defect.kind}`;
}

/**
 * e2e: the plan-3 full-journey session-consistency lane. Drives the buyer through
 * the WHOLE pinned-session pipeline in the given mode — `--mode nl` routes each
 * turn through the product NL router (POST /api/route), `--mode slash` uses the
 * deterministic /skill launch path. A `--scenario <id>` picks ONE sc_* class;
 * absent → the whole sc_* taxonomy, sequentially (the subscription is rate-limited).
 * Prints the verdict JSON per scenario. OAuth-only (the claude buyer needs the
 * Keychain subscription; the SUT still gets DeepSeek from keys.json — see README).
 */
async function cmdE2e(args: SoakArgs): Promise<number> {
  assertOauthOnly(process.env);
  const modeRaw = args.flags.get("mode");
  if (modeRaw !== "nl" && modeRaw !== "slash") {
    fail("`soak e2e` requires --mode nl|slash");
  }
  const mode = modeRaw as DriveMode;
  const all = loadTaxonomy();
  const scenarioId = args.flags.get("scenario");
  const scenarios: ScenarioClass[] =
    scenarioId !== undefined
      ? [findScenario(all, scenarioId)]
      : all.filter((s) => s.id.startsWith(SESSION_CONSISTENCY_PREFIX));
  if (scenarios.length === 0) {
    fail(`no session-consistency scenarios${scenarioId ? ` matching "${scenarioId}"` : ` (prefix "${SESSION_CONSISTENCY_PREFIX}")`}`);
  }
  const headless = !args.bools.has("headed");
  let worst = 0;
  // Sequential — the subscription is rate-limited; pace one journey at a time.
  for (const scenario of scenarios) {
    const runRoot = soakRunRoot();
    const result = await driveSessionConsistencyJourney({ scenario, mode, runRoot, headless });
    console.log(
      JSON.stringify({
        soak: "e2e",
        mode: result.mode,
        scenario: result.scenarioId,
        verdict: result.verdict.verdict,
        status: result.verdict.status,
        defect: result.verdict.defect,
        routing: result.routingObservations.map((o) => ({ expected: o.expectedSkillId, routed: o.routedSkillId })),
        ledger: result.ledgerPath,
        claudeSessionId: result.buyerSessionId,
      }),
    );
    if (result.verdict.verdict !== "GREEN") worst = 1;
  }
  return worst;
}

/**
 * freeze: minimize a recorded failure + emit a corpus case. Reads the ledger
 * jsonl, picks the row (by --row index, default the first FAILing row), and emits
 * a *.ui_*.toml the existing harness can run as a deterministic regression. The
 * minimizer's predicate here is the OFFLINE one (re-running the scenario live to
 * re-check the predicate is a per-skill plan concern — plan-0 freezes the FULL
 * text deterministically, which is always a valid reproduction). A future
 * --re-run flag wires the live predicate.
 */
function cmdFreeze(args: SoakArgs): number {
  const ledgerPath = args.flags.get("ledger") ?? fail("`soak freeze` requires --ledger <ledger.jsonl>");
  const rows = parseLedgerJsonl(readFileSync(ledgerPath, "utf8"));
  const rowIdx = args.flags.has("row")
    ? Number(args.flags.get("row"))
    : rows.findIndex((r) => r.verdict !== "GREEN");
  if (rowIdx < 0 || rowIdx >= rows.length) {
    fail(`no row to freeze (idx=${rowIdx}, rows=${rows.length})`);
  }
  const row = rows[rowIdx]!;
  const failing = row.deterministicResults.find((d) => !d.ok);
  if (failing === undefined) {
    fail(`row ${rowIdx} (scenario ${row.scenarioId}) has no failed deterministic assertion to freeze`);
  }

  // The offline predicate: the full generated text always reproduces (it is the
  // recorded failure). A live re-run predicate is a per-skill extension; plan-0
  // freezes the full text — the deterministic "could not minimize" fallback that
  // is always a valid reproduction.
  const min = minimizeFailingInput(row.generatedText, () => true, { maxIterations: 0 });

  const caseId = `soak_frozen_${row.scenarioId}`;
  const emitInput: EmitCorpusTomlInput = {
    caseId,
    skill: row.surface,
    provider: "deepseek",
    frozenText: min.minimized,
    failingAssertion: failing.assertionId,
  };
  const toml = emitCorpusToml(emitInput);
  const outDir = args.flags.get("out") ?? join(process.cwd(), "harness", "cases");
  const outPath = join(outDir, `${caseId}.ui_freeform.toml`);
  writeCorpusCase(outPath, toml);
  console.log(
    JSON.stringify({
      soak: "freeze",
      scenario: row.scenarioId,
      assertion: failing.assertionId,
      shrank: min.shrank,
      out: outPath,
    }),
  );
  return 0;
}

function cmdList(): number {
  const scenarios = loadTaxonomy();
  for (const s of scenarios) {
    console.log(
      `${s.id.padEnd(28)} ${s.className.padEnd(28)} surface=${s.surface.padEnd(22)} ` +
        `det=[${s.deterministicAssertions.join(",")}] judge=[${s.judgeDims.join(",")}]`,
    );
  }
  console.log(`\n${scenarios.length} scenario class(es) loaded.`);
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "run":
      return cmdRun(args);
    case "suite":
      return cmdSuite(args);
    case "e2e":
      return cmdE2e(args);
    case "freeze":
      return cmdFreeze(args);
    case "list":
      return cmdList();
    default: {
      const exhausted: never = args.command;
      fail(`unhandled command ${JSON.stringify(exhausted)}`);
    }
  }
}

// Entrypoint (tsx). The `import.meta` guard lets the unit tests import the pure
// helpers without triggering a run.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`soak: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      process.exit(1);
    });
}
