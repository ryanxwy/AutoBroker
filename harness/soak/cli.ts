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
 *   soak mp [--until-dry] [--rounds N]    — LIVE escalating-chaos multi-profile
 *                                            drive (integration); freezes a corpus
 *                                            case on the first invariant violation,
 *                                            converging when K consecutive rounds
 *                                            surface no NOVEL violation. STRUCTURAL +
 *                                            live-deferred (boots the host + spawns
 *                                            the dealer actor). OAuth-only.
 *   soak mp-replay                        — DETERMINISTIC, NO PROVIDER: iterate the
 *                                            multiprofile-corpus.txt manifest,
 *                                            runMpReplayCase each, print a JSON
 *                                            verdict per case, exit non-zero on any
 *                                            case that misses its expectedAllOk. No
 *                                            key needed; runnable in green-adjacent CI.
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

import { parseTranscriptJsonl, type TranscriptEvent } from "@autobroker/model";

import { STRIPPED_KEY_ENV } from "./claudeAgent.js";
import {
  emitCorpusToml,
  minimizeFailingInput,
  writeCorpusCase,
  type EmitCorpusTomlInput,
} from "./freezeToCorpus.js";
import { parseLedgerJsonl } from "./ledger.js";
import {
  assertManifestInSync,
  freezeMultiProfileToCorpus,
  MP_CASES_ROOT,
  MP_MANIFEST_PATH,
  readMpManifest,
  runMpReplayCase,
} from "./multiprofile/freeze.js";
import { runMultiProfileLane, type MpFreezeArgs as LaneFreezeArgs } from "./multiprofile/orchestrator.js";
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
  command: "run" | "suite" | "e2e" | "freeze" | "mp" | "mp-replay" | "list";
  flags: Map<string, string>;
  bools: Set<string>;
}

/** The plan-3 session-consistency scenarios all carry the `sc_` id prefix. */
const SESSION_CONSISTENCY_PREFIX = "sc_";

function parseArgs(argv: string[]): SoakArgs {
  const tokens = argv.slice(2).filter((t) => t !== "--");
  const [cmd, ...rest] = tokens;
  const command = (cmd ?? "list") as SoakArgs["command"];
  if (!["run", "suite", "e2e", "freeze", "mp", "mp-replay", "list"].includes(command)) {
    fail(`unknown subcommand "${command}" (expected run|suite|e2e|freeze|mp|mp-replay|list)`);
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

// ---------------------------------------------------------------------------
// mp — the LIVE escalating-chaos multi-profile drive (integration, structural)
// ---------------------------------------------------------------------------

/** The fixed three different-brand profiles + ONE shared dealer the mp lane drives
 *  (the headline same-segment different-brand collision — a 3-way race for one
 *  rooftop, so exactly one binds and TWO take the voiced-exclusion path). Budgets
 *  feed budget_no_leak only — never printed (inv #9). */
const MP_PROFILES = [
  { id: "mp-accord", year: 2026, make: "Honda", model: "Accord", trim: "EX-L", budgetMax: 40000 },
  { id: "mp-camry", year: 2026, make: "Toyota", model: "Camry", trim: "XSE", budgetMax: 42000 },
  { id: "mp-mazda6", year: 2026, make: "Mazda", model: "Mazda6", trim: "Signature", budgetMax: 38000 },
];
const MP_DEALER = {
  dealerKey: "mp-collision-rooftop",
  name: "Collision Auto Group",
  website: "https://collision.example",
};

/**
 * The mp novelty signature for an until-dry round: the failing invariant's
 * assertionId. A round with NO violation has no signature (null). PURE +
 * unit-tested — the convergence model mirrors cmdSuite's noveltySignature: K
 * consecutive rounds with no NOVEL signature = the discovery engine has gone dry.
 */
export function mpNoveltySignature(failingInvariant: { assertionId: string } | null): string | null {
  if (failingInvariant === null) return null;
  return `mp::${failingInvariant.assertionId}`;
}

/**
 * mp: the LIVE escalating-chaos multi-profile drive. Loops runMultiProfileLane
 * with the chaos schedule, wiring freezeMultiProfileToCorpus into the driver's
 * `freeze` DI hook so the first invariant violation freezes a deterministic
 * no-provider replay case into the multiprofile-corpus.txt lane. With --until-dry
 * it converges when `dry-rounds` consecutive rounds surface no NOVEL violation
 * (mirrors cmdSuite). STRUCTURAL + live-deferred: runMultiProfileLane boots the
 * server host + spawns the Sonnet dealer actor + drives Playwright — integration-
 * tested later, NOT in a unit test (the same posture as orchestrator.ts). OAuth-only.
 */
async function cmdMp(args: SoakArgs): Promise<number> {
  assertOauthOnly(process.env);
  const rounds = args.flags.has("rounds") ? Math.max(1, Number(args.flags.get("rounds"))) : 3;
  const untilDry = args.bools.has("until-dry");
  const dryRounds = args.flags.has("dry-rounds") ? Math.max(1, Number(args.flags.get("dry-rounds"))) : 2;
  const headless = !args.bools.has("headed");

  const seenSignatures = new Set<string>();
  let consecutiveDry = 0;
  let pass = 0;
  let worst = 0;

  // The freeze adapter: map the lane's MpFreezeArgs (a MultiProfileRunPlan +
  // failingInvariant DeterministicResult) into a freezeMultiProfileToCorpus call
  // with the original seed profiles/dealer (the plan carries only ids). Records
  // its signature so until-dry can detect novelty.
  let lastSignature: string | null = null;
  const freeze = (laneArgs: LaneFreezeArgs): void => {
    lastSignature = mpNoveltySignature(laneArgs.failingInvariant);
    freezeMultiProfileToCorpus({
      caseId: `mp_frozen_${laneArgs.failingInvariant.assertionId}_seed${laneArgs.seed}_r${laneArgs.round}`,
      seed: laneArgs.seed,
      config: {
        profiles: MP_PROFILES,
        dealer: MP_DEALER,
        expectedAllOk: false,
      },
      transcript: parseTranscriptFile(laneArgs.transcriptPath),
      failingInvariant: laneArgs.failingInvariant.assertionId,
    });
  };

  do {
    pass += 1;
    lastSignature = null;
    const runRoot = soakRunRoot();
    await runMultiProfileLane({
      seed: pass,
      rounds,
      runRoot,
      profiles: MP_PROFILES,
      dealer: MP_DEALER,
      headless,
      freeze,
    });
    const sig = lastSignature;
    const novel = sig !== null && !seenSignatures.has(sig);
    if (sig !== null) {
      seenSignatures.add(sig);
      worst = 1;
    }
    console.log(JSON.stringify({ soak: "mp", pass, signature: sig, novel }));
    consecutiveDry = novel ? 0 : consecutiveDry + 1;
  } while (untilDry && consecutiveDry < dryRounds);

  if (untilDry) {
    console.log(JSON.stringify({ soak: "mp", done: true, passes: pass, signatures: seenSignatures.size }));
  }
  return worst;
}

/** Parse a recorded transcript file into events; an absent file yields []. */
function parseTranscriptFile(path: string): TranscriptEvent[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return parseTranscriptJsonl(text);
}

// ---------------------------------------------------------------------------
// mp-replay — the DETERMINISTIC no-provider manifest runner (no key needed)
// ---------------------------------------------------------------------------

/**
 * mp-replay: iterate the multiprofile-corpus.txt manifest, runMpReplayCase each
 * (NO PROVIDER), print a JSON verdict per case, and exit non-zero on any case
 * whose results do not meet its expectedAllOk OR when the manifest is out of sync.
 * The OAuth-only guard does NOT apply — mp-replay needs no provider at all.
 */
async function cmdMpReplay(args: SoakArgs): Promise<number> {
  void args;
  // mp-replay IS a deterministic no-provider test lane: it installs the test-only
  // model-wrapper seam (replayModel) which refuses outside a test runner. Pin
  // NODE_ENV=test so the seam's guard passes (the same thing serve-live.mjs does
  // before installing the record/replay hook). No provider is ever called.
  process.env["NODE_ENV"] = "test";
  const manifestPath = MP_MANIFEST_PATH;
  const casesRoot = MP_CASES_ROOT;

  // Sync trap first: a dangling manifest line (or orphan dir) is a hard fail.
  const sync = assertManifestInSync(manifestPath, casesRoot);
  console.log(JSON.stringify({ soak: "mp-replay", sync: sync.ok, detail: sync.ok ? undefined : sync.detail }));
  if (!sync.ok) return 1;

  const ids = readMpManifest(manifestPath);
  if (ids.length === 0) {
    console.log(JSON.stringify({ soak: "mp-replay", done: true, cases: 0 }));
    return 0;
  }

  let worst = 0;
  for (const caseId of ids) {
    const caseDir = join(casesRoot, caseId);
    const config = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as {
      expectedAllOk: boolean;
      failingInvariant?: string;
    };
    const results = await runMpReplayCase(caseDir);
    const allOk = results.every((r) => r.ok);
    const met = allOk === config.expectedAllOk;
    const firstFail = results.find((r) => !r.ok);
    console.log(
      JSON.stringify({
        soak: "mp-replay",
        case: caseId,
        expectedAllOk: config.expectedAllOk,
        allOk,
        met,
        firstFailing: firstFail?.assertionId ?? null,
      }),
    );
    if (!met) worst = 1;
  }
  console.log(JSON.stringify({ soak: "mp-replay", done: true, cases: ids.length, verdict: worst === 0 ? "GREEN" : "RED" }));
  return worst;
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
    case "mp":
      return cmdMp(args);
    case "mp-replay":
      return cmdMpReplay(args);
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
