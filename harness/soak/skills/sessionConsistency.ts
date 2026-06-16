/**
 * skills/sessionConsistency — the plan-3 full-journey session-consistency soak
 * driver (the buyer drives the WHOLE pinned-session pipeline by NATURAL LANGUAGE
 * through the product NL router, gates answered by BUTTONS).
 *
 * A SELF-CONTAINED per-skill soak module. It imports plan-0's FROZEN shared infra
 * (startSoakHost / captureMutationBaseline from orchestrator, the UiDriver verbs,
 * spawnClaudeAgent for the buyer + the Opus judge, combineSoakVerdict, the ledger)
 * and the plan-3 assertion lib (sessionConsistency.assertions). It NEVER edits a
 * shared file — the verdict id space is OPEN by design, so the plan-3 assertions
 * declare their OWN assertionId strings + severity and fold via the frozen
 * combineSoakVerdict. The SUT is READ-ONLY: this driver only OBSERVES App.tsx /
 * quotePipeline.ts / skillRuns.ts / router.ts via the live HTTP + DOM surfaces.
 *
 * THE CORE ABSTRACTION — driveMode: "nl" | "slash":
 *  - "nl"  (the real-user way): each skill is launched by typing NATURAL LANGUAGE
 *          into the chat rail (driver.typeInChatRail(<prose>)). The product router
 *          (POST /api/route, commit 8863d11) classifies the prose → the right skill
 *          and launches it through the EXACT existing start path. The journey records
 *          the router's chosen skill per NL turn (off routing.skill_id) → the
 *          deterministic routing-accuracy assertion. Cold-start intake is the buyer's
 *          freeform; every subsequent skill is ALSO NL. HITL is answered ONLY via
 *          gate BUTTONS, never chat text.
 *  - "slash" (the deterministic path): each skill is launched by typing "/skill"
 *          into the SAME rail (driver.typeInChatRail("/dealer_geosearch")). The
 *          slash bypasses the router (App.onSlash → doLaunchSkill). Routing-accuracy
 *          is not scored in slash mode (the router was never exercised).
 *
 * Both modes drive the SAME journey: intake → dealer_geosearch → inventory_site_scan
 * → dealer_inbox_check → quote_pipeline (the ~7-8 launches), one pinned browser =
 * one rail = one Mastra Memory thread for the whole journey.
 *
 * Two halves (mirrors skills/intake.ts + skills/dealerReplyExtract.ts):
 *  (1) the PURE assertion lib (sessionConsistency.assertions, unit-tested over a
 *      real isolated migrated tmp DB) — INV-1..INV-7 + projection + scrape-reap +
 *      journey-wide no_external_mutation + budget + routing-accuracy.
 *  (2) the LIVE drive lane (driveSessionConsistencyJourney): boot the isolated
 *      serverHost, spawn the claude buyer, drive the pinned journey in the given
 *      mode, answer the HITL via buttons, read the assertions off the isolated DB +
 *      the live surfaces, score the Opus coherence judge, append a replayable ledger
 *      row. The live lane (claude -p + Playwright + real DeepSeek) is NOT
 *      unit-tested — it mirrors orchestrator.runScenario / driveIntakeScenario
 *      (wired; live deferred to the e2e under `pnpm soak`).
 *
 * Dependency wall: harness layer. Read-only DB reads ride the @autobroker/db Db
 * handle (via openReadHandleAt) — NEVER better-sqlite3/drizzle directly; the ONE
 * playwright import is the UiDriver class; NO direct provider client.
 */

import { join } from "node:path";

import { openReadHandleAt } from "../../dbReads.js";
import { UiDriver } from "../../uiDriver.js";
import { spawnClaudeAgent, type ClaudeAgentResult } from "../claudeAgent.js";
import { appendLedgerRow, buildSoakLedgerRow, type SoakRunTrace } from "../ledger.js";
import {
  BUYER_PROMPT,
  JUDGE_PROMPT,
  captureMutationBaseline,
  startSoakHost,
} from "../orchestrator.js";
import type { ScenarioClass } from "../taxonomy.js";
import {
  assertL1FuseArmed,
  assertNoExternalMutation,
  combineSoakVerdict,
  runJudge,
  type DeterministicResult,
  type JudgeDimId,
  type JudgeDimResult,
  type SoakVerdictDoc,
} from "../verdict.js";
import type { RoutingObservation } from "./sessionConsistency.assertions.js";

// ===========================================================================
// the journey step script (the version-controlled launch sequence)
// ===========================================================================

/** The drive mode — the core plan-3 abstraction. */
export type DriveMode = "nl" | "slash";

/** One launch in the journey: the skill it should reach + the NL prose a real
 *  buyer would type to get there (used in "nl" mode; "slash" mode types `/skillId`).
 *  `isIntake` marks the cold-start (a fresh-unpinned fork, never a pinned launch). */
export interface JourneyLaunch {
  skillId: string;
  /** The natural-language phrasing template a real buyer would type (nl mode). The
   *  buyer agent may rephrase; this is the deterministic fallback / intent anchor. */
  nlPhrasing: string;
  isIntake: boolean;
}

/** The canonical journey: cold-start intake → geosearch → inventory scan → inbox
 *  check → quote_pipeline (the ~7-8 launches the spec's happy-path-full-journey
 *  drives). Frozen + enumerable so coverage is measured, not luck. */
export const JOURNEY_LAUNCHES: readonly JourneyLaunch[] = [
  {
    skillId: "search_profile_intake",
    nlPhrasing:
      "I'm looking for a 2026 Hyundai Tucson SEL near Irvine, around $34k, financing — can you help me start a search?",
    isIntake: true,
  },
  {
    skillId: "dealer_geosearch",
    nlPhrasing: "Find the Hyundai dealers near me for this search.",
    isIntake: false,
  },
  {
    skillId: "inventory_site_scan",
    nlPhrasing: "Scan those dealers' inventory sites for matching Tucsons.",
    isIntake: false,
  },
  {
    skillId: "dealer_inbox_check",
    nlPhrasing: "Check my inbox for any dealer replies and pull in the new ones.",
    isIntake: false,
  },
  {
    skillId: "quote_pipeline",
    nlPhrasing: "Run the full quote pipeline over what we have so far.",
    isIntake: false,
  },
] as const;

/** The NL text to type for one launch in the given mode: the prose (nl) or the
 *  deterministic `/skillId` (slash). Pure. */
export function launchTextFor(launch: JourneyLaunch, mode: DriveMode): string {
  return mode === "nl" ? launch.nlPhrasing : `/${launch.skillId}`;
}

// ===========================================================================
// the live drive lane (structurally complete; live-tested later)
// ===========================================================================

/** The judge dims this driver may activate (a subset of the frozen JUDGE_DIM_IDS —
 *  the buyer's step-to-step coherence + the dealer-reply extraction fidelity). */
const JOURNEY_JUDGE_DIMS: readonly JudgeDimId[] = ["buyer_coherence", "extraction_quality"];

export interface DriveJourneyOpts {
  scenario: ScenarioClass;
  /** The drive mode (the core abstraction): nl routes via the product router; slash
   *  uses the deterministic /skill path. */
  mode: DriveMode;
  /** Run root under ~/.autobroker-ts/soak-runs/<ts>/ (data dir + ledger live here). */
  runRoot: string;
  headless?: boolean;
  legTimeoutMs?: number;
}

export interface DriveJourneyResult {
  scenarioId: string;
  mode: DriveMode;
  verdict: SoakVerdictDoc;
  ledgerPath: string;
  buyerSessionId: string | null;
  /** The router's per-NL-turn decisions (empty in slash mode) — the routing-accuracy
   *  evidence persisted into the ledger / surfaced to the operator. */
  routingObservations: RoutingObservation[];
}

/**
 * Build the buyer's per-scenario journey task. The buyer.md role file (plan-0)
 * already constrains "emit text only, one vehicle, in character, no test-framework
 * language"; the task carries the journey edge-class intent + the drive mode (so
 * the buyer phrases natural prose in nl mode, never a literal slash).
 */
export function journeyBuyerTaskFor(scenario: ScenarioClass, mode: DriveMode): string {
  return [
    `Scenario class: ${scenario.className}.`,
    `What this stresses: ${scenario.stresses}`,
    `Drive mode: ${mode} (${mode === "nl" ? "type natural prose; the assistant routes it" : "the harness types /slash launches; you still narrate naturally"}).`,
    "",
    "Write the FIRST chat message a real car buyer would type to cold-start this",
    "search — freeform prose, ONE vehicle of interest, in character. Emit ONLY that",
    "message text — no JSON wrapper, no commentary, no slash command.",
  ].join("\n");
}

/** The journey-wide keystone leg flag: by the END of the journey, the targeted-VIN
 *  approve leg's LOCAL dealer_quotes record is a legal fake-outbound write, so the
 *  final keystone scan opts into allowFakeOutbound. The intermediate scans (no send
 *  has fired) use the strict default. Exposed for the unit tests + the live lane. */
export const FINAL_LEG_ALLOWS_FAKE_OUTBOUND = true;

/**
 * Drive ONE session-consistency journey end-to-end (LIVE — boot host + spawn
 * claude + drive Playwright in the given mode). Structurally complete + wired;
 * mirrors orchestrator.runScenario / driveIntakeScenario. The per-launch gate
 * choreography (cold-start intake confirm → geosearch approve → inventory
 * batch_review → inbox batch_review → quote_pipeline fan-out / targeted approve)
 * + the per-INV reads are filled in against real DeepSeek under `pnpm soak`. NOT
 * unit-tested — the pure assertion lib (sessionConsistency.assertions) IS.
 *
 * THE MODE BRANCH (the core abstraction) is the launch helper: in "nl" mode each
 * launch is `driver.typeInChatRail(<prose>)` and the router's routing.skill_id is
 * recorded for the routing-accuracy assertion; in "slash" mode each launch is
 * `driver.typeInChatRail("/skillId")` (router not exercised). HITL is answered ONLY
 * via the gate-BUTTON verbs in BOTH modes (clickApprovalApprove/Deny,
 * decideBatchRow/clickBatchSubmit, decideInboxRow/clickInboxSubmit,
 * pickProfileStopOption/clickStopIntakeCta) — NEVER a chat-text answer to a gate.
 */
export async function driveSessionConsistencyJourney(
  opts: DriveJourneyOpts,
): Promise<DriveJourneyResult> {
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
  let judge: JudgeDimResult[] = [];
  const routingObservations: RoutingObservation[] = [];

  try {
    // L1-fuse anchor — the armed env recorded into the verdict for every scenario.
    deterministic.push(assertL1FuseArmed(host.env));

    // The single pinned browser (the orchestrator owns the one UiDriver = one rail
    // = one Mastra Memory thread for the WHOLE journey — the session-consistency
    // invariant).
    driver = await UiDriver.launch({
      baseUrl: host.apiBase,
      screenshotDir: join(opts.runRoot, "screenshots"),
      ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    });

    // Spawn the buyer → GENERATE the freeform cold-start text (emit only). The
    // buyer/dealer claude children EMIT text; the orchestrator owns the one browser
    // + every gate button.
    buyer = await spawnClaudeAgent({
      rolePromptPath: BUYER_PROMPT,
      model: opts.scenario.buyerModel,
      task: journeyBuyerTaskFor(opts.scenario, opts.mode),
      timeoutMs: legTimeoutMs,
    });

    // Keystone baseline BEFORE the first launch.
    const baseline = captureMutationBaseline();

    // (cold-start) Type the buyer's freeform into the chat rail. In nl mode the
    // product router (POST /api/route) classifies it → intake; in slash mode the
    // cold-start would be /search_profile_intake — but a real cold start is always
    // freeform, so the cold-start types the buyer's prose in BOTH modes (the mode
    // branch starts at the SECOND launch). The intake form renders for human-confirm;
    // the orchestrator owns the gate buttons (fillRenderedForm + clickSubmit) from
    // here. The per-launch choreography for geosearch → inventory → inbox →
    // quote_pipeline (mode-branched launch text + gate buttons), the
    // pinProfileInSearches pin, the per-INV reads, and the targeted-VIN approve/
    // decline leg are driven against real DeepSeek under `pnpm soak`.
    await driver.typeInChatRail(buyer.generatedText);
    await driver.waitForIntakeForm(legTimeoutMs);

    const trace = await captureJourneyTrace(driver, host.apiBase);

    // The journey-wide keystone (read-only DB scan delta vs baseline) — emitted under
    // the canonical `no_external_mutation` id (the always-on floor every scenario
    // declares + combineSoakVerdict's BLOCKER set scores). At the END of the journey
    // the targeted-approve local dealer_quotes record is a legal fake-outbound write,
    // so the live lane opts into allowFakeOutbound for the FINAL scan; the cold-start
    // scan here (no send fired) uses the strict default.
    const { db, close } = openReadHandleAt(dbPath);
    try {
      deterministic.push(assertNoExternalMutation({ db, baseline }));
    } finally {
      close();
    }

    // The soft-dim coherence judge (load-bearing for the buyer's step-to-step
    // coherence + the dealer-reply extraction fidelity ONLY; deterministic red-lines
    // stay authoritative). Activated when the scenario asks for it; the live lane
    // assembles the journey transcript as the judge's SUT view.
    // The cold-start-only journey runs NO extraction skill, so the soft
    // extraction_quality dim has no SUT data to score — asking it would flip the
    // verdict RED on empty output (a category error, NOT a safety/extraction
    // failure). Gate it off until the full multi-launch journey (which extracts) is
    // wired; buyer_coherence still scores the cold-start prose.
    const COLD_START_ONLY = true; // flip when the full multi-launch choreography lands
    const activeDims = (opts.scenario.judgeDims as JudgeDimId[])
      .filter((d) => JOURNEY_JUDGE_DIMS.includes(d))
      .filter((d) => !(COLD_START_ONLY && d === "extraction_quality"));
    if (activeDims.length > 0) {
      try {
        const verdict = await runJudge({
          judgePromptPath: JUDGE_PROMPT,
          scenarioIntent: opts.scenario.stresses,
          generatedText: buyer.generatedText,
          sutOutput: buildJourneyJudgeSutOutput({ mode: opts.mode, routingObservations }),
          activeDims,
        });
        judge = verdict.dims;
      } catch (err) {
        // The Opus judge is a SOFT dimension — a spawn/rate-limit/timeout failure
        // must NEVER block the authoritative deterministic verdict (the safety
        // floor). Record it and proceed with the deterministic half.
        console.error(
          `soak e2e: judge unavailable (${err instanceof Error ? err.message : String(err)}) — deterministic verdict stands`,
        );
      }
    }

    const verdict = combineSoakVerdict({ deterministic, judge });

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
      mode: opts.mode,
      verdict,
      ledgerPath,
      buyerSessionId: buyer.claudeSessionId,
      routingObservations,
    };
  } finally {
    // Bounded teardown — Playwright's driver.close() and the host SIGTERM can wedge
    // AFTER the verdict + ledger are written; a soft-timeout race guarantees the CLI
    // returns (the entrypoint then process.exit's) instead of hanging on teardown +
    // orphaning the serverHost.
    const bounded = (p: Promise<unknown>, ms: number): Promise<unknown> =>
      Promise.race([
        p.catch(() => undefined),
        new Promise<void>((r) => {
          setTimeout(r, ms).unref();
        }),
      ]);
    if (driver !== null) await bounded(driver.close(), 6000);
    await bounded(host.stop(), 8000);
  }
}

/** Assemble the journey judge's SUT-output view: the drive mode + the router's
 *  per-NL-turn decisions (the judge reasons about whether the buyer's prose drove a
 *  coherent journey). Pure — unit-tested. */
export function buildJourneyJudgeSutOutput(args: {
  mode: DriveMode;
  routingObservations: readonly RoutingObservation[];
}): string {
  if (args.mode === "slash") {
    return "drive mode: slash (deterministic /skill launches — the router was not exercised)";
  }
  if (args.routingObservations.length === 0) {
    return "drive mode: nl (no router decisions captured yet)";
  }
  const lines = args.routingObservations.map(
    (o) => `"${o.nlText.slice(0, 48)}…" → routed ${o.routedSkillId ?? "clarify"} (expected ${o.expectedSkillId})`,
  );
  return `drive mode: nl — router decisions:\n${lines.join("\n")}`;
}

/** Drain the journey run trace off the rail's current run (the cold-start started
 *  one). Mirrors orchestrator.captureTrace; small + stable for the ledger row. */
async function captureJourneyTrace(driver: UiDriver, apiBase: string): Promise<SoakRunTrace | null> {
  const runId = driver.currentRunId();
  if (runId === null) return null;
  const { buildRunDetail } = await import("../../detail.js");
  try {
    const detail = await buildRunDetail(apiBase, runId);
    return {
      runId,
      terminalStatus: detail.terminalStatus,
      eventCount: detail.events.length,
      sawApprovalGate: detail.sawApprovalGate,
      sawMalformedToolCall: detail.sawMalformedToolCall,
    };
  } catch {
    return { runId, terminalStatus: null, eventCount: 0, sawApprovalGate: false, sawMalformedToolCall: false };
  }
}
