/**
 * multiprofile/freeze — the Phase-4 "self-evolving corpus" freeze + replay.
 *
 * When the live multi-profile lane (runMultiProfileLane) surfaces an invariant
 * VIOLATION, it FREEZES the failing scenario into a DETERMINISTIC, NO-PROVIDER
 * replay case: { case.json (seed + profiles + shared dealer + expectedAllOk),
 * transcript.jsonl (every recorded LLM call) } under harness/cases/mp/<caseId>/,
 * and APPENDS <caseId> to harness/multiprofile-corpus.txt. That case then runs as
 * a fast CI gate forever after (vitest in green.sh + `soak mp-replay`) with NO
 * provider key needed.
 *
 * This is the MULTI-PROFILE sibling of harness/soak/freezeToCorpus.ts (the single
 * skill lane). It is a DISTINCT lane:
 *   - freezeToCorpus.ts emits *.ui_*.toml cases consumed by the LIVE regression
 *     lane (scripts/regression.sh → harness/runner.ts, refuses to start without a
 *     real DEEPSEEK_API_KEY).
 *   - THIS module emits case-dir + JSONL cases consumed by the DETERMINISTIC
 *     no-provider mp lane (vitest + `soak mp-replay`), keyed off the dedicated
 *     manifest harness/multiprofile-corpus.txt — NOT harness/regression-corpus.txt.
 *
 * runMpReplayCase drives the deterministic collision (interleaveClaims) + the
 * replay leg (resolveModel(...).doGenerate(mpReplayLegOptions()) returns the
 * recorded result token-for-token through the real chokepoint, NO provider) +
 * runAllInvariants — proving the replay machinery and re-checking the invariants
 * with zero network.
 *
 * Dependency wall: harness layer. node:fs/path only for the emit/load; reuses the
 * sibling multiprofile modules + @autobroker/model's record/replay seam. NEVER a
 * raw driver / playwright / a provider client.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "@autobroker/db";
import {
  __resetHarnessModelWrapper,
  __setHarnessModelWrapper,
  parseTranscriptJsonl,
  replayModel,
  resolveModel,
  serializeTranscriptEvent,
  TraceIndex,
  type TranscriptEvent,
} from "@autobroker/model";

import { makeTmpDb } from "../../testSupport.js";
import type { DeterministicResult } from "../verdict.js";
import { runAllInvariants } from "./invariants.js";
import { makePrng } from "./prng.js";
import { interleaveClaims, seedMultiActiveSharedDealer, type MpProfileSeed, type SharedDealerSeed } from "./world.js";

// Re-export the seed shapes so callers (freeze.test.ts, cli.ts) get them from the
// freeze module without reaching into world.ts directly.
export type { MpProfileSeed, SharedDealerSeed } from "./world.js";

// ---------------------------------------------------------------------------
// the fixed replay-leg opts (record + replay hash the SAME payload)
// ---------------------------------------------------------------------------

/**
 * A FIXED, well-known v3 call-options payload so the freeze (record) and the
 * replay (runMpReplayCase) compute the IDENTICAL hashPrompt without serializing
 * opts into the case. Both legs call this. Typed loosely (the harness never
 * imports @ai-sdk/provider — same idiom as collision.test.ts): the only fields
 * hashPrompt reads are prompt/tools/responseFormat/temperature/topP/seed, and a
 * constant single-user-message prompt is enough for a deterministic key.
 */
export function mpReplayLegOptions(): { prompt: unknown } {
  return {
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "multi-profile freeze replay probe" }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// case config + freeze args
// ---------------------------------------------------------------------------

export interface MpCaseConfig {
  caseId: string;
  seed: number;
  profiles: MpProfileSeed[];
  dealer: SharedDealerSeed;
  /** True when this case is a CLEAN scenario (every invariant holds). A frozen
   *  violation case sets this false + names the failing invariant. */
  expectedAllOk: boolean;
  /** For a violation case: the invariant assertionId expected to be ok:false. */
  failingInvariant?: string;
  /**
   * For a synthetic VIOLATION case ONLY (expectedAllOk:false): seed one extra
   * profile_dealers row scoped to this UNKNOWN profile id, deterministically
   * tripping no_cross_profile_bleed through the real invariant machinery (NOT a
   * faked result). profile_dealers has no FK (composite PK only) so this is a
   * minimal, schema-stable corruption. A CLEAN case omits it.
   */
  injectBleedProfileId?: string;
}

export interface MpFreezeArgs {
  caseId: string;
  seed: number;
  config: Omit<MpCaseConfig, "caseId" | "seed">;
  transcript: TranscriptEvent[];
  failingInvariant?: string;
  /** Cases root (default harness/cases/mp). */
  outDir?: string;
  /** Manifest path (default harness/multiprofile-corpus.txt). */
  manifestPath?: string;
}

// Repo-relative defaults resolved from this module's location (harness/soak/multiprofile/).
const HERE = new URL(".", import.meta.url).pathname;
/** harness/cases/mp — the mp replay case root. */
export const MP_CASES_ROOT = join(HERE, "..", "..", "cases", "mp");
/** harness/multiprofile-corpus.txt — the dedicated no-provider mp manifest. */
export const MP_MANIFEST_PATH = join(HERE, "..", "..", "multiprofile-corpus.txt");

/** The header written when the manifest is first created (explains the lane). */
const MANIFEST_HEADER = [
  "# multiprofile-corpus.txt — the DETERMINISTIC, NO-PROVIDER multi-profile replay lane.",
  "#",
  "# One case id per line (blank lines + # comments ignored). Each id has a matching",
  "# case dir harness/cases/mp/<id>/ with case.json + transcript.jsonl. The freeze",
  "# (multiprofile/freeze.ts) appends a line here on an invariant violation; the case",
  "# then runs FOREVER AFTER as a fast CI gate — by vitest in green.sh (freeze.test.ts)",
  "# and by `pnpm soak mp-replay` — with NO provider key needed.",
  "#",
  "# This is DISTINCT from harness/regression-corpus.txt (the LIVE regression lane run",
  "# by scripts/regression.sh through harness/runner.ts, which refuses to start without",
  "# a real DEEPSEEK_API_KEY). Do NOT mix the two — a no-provider replay id here, a",
  "# live intake case id there.",
  "#",
  "# Sync trap: every line MUST have a case dir (assertManifestInSync goes RED on a",
  "# dangling line). Remove the case dir AND the line together.",
] as const;

// ---------------------------------------------------------------------------
// freeze (write case + append manifest)
// ---------------------------------------------------------------------------

/**
 * Write harness/cases/mp/<caseId>/{case.json, transcript.jsonl} and APPEND
 * <caseId> to the manifest (kept in sync). Idempotent on the manifest: a caseId
 * already listed is not appended twice. Returns the case dir + the manifest line.
 */
export function freezeMultiProfileToCorpus(args: MpFreezeArgs): { caseDir: string; manifestLine: string } {
  const casesRoot = args.outDir ?? MP_CASES_ROOT;
  const manifestPath = args.manifestPath ?? MP_MANIFEST_PATH;
  const caseDir = join(casesRoot, args.caseId);

  const config: MpCaseConfig = {
    caseId: args.caseId,
    seed: args.seed,
    profiles: args.config.profiles,
    dealer: args.config.dealer,
    expectedAllOk: args.config.expectedAllOk,
    ...(args.failingInvariant !== undefined ? { failingInvariant: args.failingInvariant } : {}),
    ...(args.config.injectBleedProfileId !== undefined
      ? { injectBleedProfileId: args.config.injectBleedProfileId }
      : {}),
  };

  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "case.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  const jsonl = args.transcript.map(serializeTranscriptEvent).join("\n") + (args.transcript.length > 0 ? "\n" : "");
  writeFileSync(join(caseDir, "transcript.jsonl"), jsonl, "utf8");

  // Append to the manifest (create with the header if absent; skip a duplicate id).
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, MANIFEST_HEADER.join("\n") + "\n", "utf8");
  }
  const existing = readMpManifest(manifestPath);
  if (!existing.includes(args.caseId)) {
    appendFileSync(manifestPath, args.caseId + "\n");
  }

  return { caseDir, manifestLine: args.caseId };
}

// ---------------------------------------------------------------------------
// manifest helpers + the sync check
// ---------------------------------------------------------------------------

/** Read the case ids from a manifest, skipping blank lines and # comments. */
export function readMpManifest(manifestPath: string): string[] {
  if (!existsSync(manifestPath)) return [];
  return readFileSync(manifestPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * assertManifestInSync — ok IFF every manifest line has a matching case dir AND
 * no case dir is orphaned (a dir with no manifest line). A dangling manifest line
 * (id with no dir) OR an orphan dir FAILs — the sync trap.
 */
export function assertManifestInSync(manifestPath: string, casesRoot: string): DeterministicResult {
  const id = "mp_manifest_in_sync";
  const listed = readMpManifest(manifestPath);
  const onDisk = existsSync(casesRoot)
    ? readdirSync(casesRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const listedSet = new Set(listed);
  const diskSet = new Set(onDisk);

  const dangling = listed.filter((cid) => !diskSet.has(cid));
  if (dangling.length > 0) {
    return fail(id, `manifest line(s) with no case dir (dangling): ${dangling.join(", ")}`);
  }
  const orphans = onDisk.filter((cid) => !listedSet.has(cid));
  if (orphans.length > 0) {
    return fail(id, `case dir(s) with no manifest line (orphan): ${orphans.join(", ")}`);
  }
  return ok(id, `every manifest line has a case dir and vice versa (${listed.length} case(s))`);
}

// ---------------------------------------------------------------------------
// load + replay a case (NO PROVIDER)
// ---------------------------------------------------------------------------

/** Load + parse a case dir's case.json + transcript.jsonl. */
export function loadMpCase(caseDir: string): { config: MpCaseConfig; transcript: TranscriptEvent[] } {
  const config = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as MpCaseConfig;
  const transcript = parseTranscriptJsonl(readFileSync(join(caseDir, "transcript.jsonl"), "utf8"));
  return { config, transcript };
}

/** Thrown when the replay leg's doGenerate does not return the recorded result
 *  token-for-token — the no-provider chokepoint proof failed (fail LOUD). */
export class ReplayLegMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayLegMismatchError";
  }
}

/**
 * Load + replay a case with NO PROVIDER, returning the invariant results. Async
 * because the replay leg drives the real `doGenerate` chokepoint (replayModel does
 * no I/O, but doGenerate is async per the LanguageModelV3 contract).
 *  1. isolated tmp DB; seed the multi-active shared-dealer world from case.json.
 *  2. install replayModel (from the transcript) via __setHarnessModelWrapper.
 *  3. interleaveClaims drives the collision deterministically (makePrng(seed)).
 *  4. replay leg: resolveModel("deepseek.cheap").doGenerate(mpReplayLegOptions())
 *     returns the recorded event's result token-for-token — proving no-provider
 *     replay through the real chokepoint. A mismatch/exhaustion fails LOUD.
 *  5. runAllInvariants → return the results (clean case → all ok; a frozen
 *     violation case → the failingInvariant is ok:false).
 * The wrapper is ALWAYS reset in finally so a case never leaks the seam.
 */
export async function runMpReplayCase(caseDir: string): Promise<DeterministicResult[]> {
  const { config, transcript } = loadMpCase(caseDir);
  const tmp = makeTmpDb();
  const db: Db = tmp.db;
  const profileIds = config.profiles.map((p) => p.id);

  // Build the replay index + install the no-provider wrapper. modelId comes from
  // the first recorded event (replayModel needs the recorded model identity).
  const index = new TraceIndex(transcript);
  const modelId = transcript[0]?.modelId ?? "structured-object";
  __setHarnessModelWrapper((_model, alias) => replayModel(index, { alias, modelId }));

  try {
    seedMultiActiveSharedDealer(db, config.profiles, config.dealer);
    // Synthetic VIOLATION cases ONLY: seed one profile_dealers row scoped to an
    // unknown profile so no_cross_profile_bleed fails through the REAL invariant
    // (never a faked result). profile_dealers has no FK (composite PK only), so
    // this is the minimal schema-stable corruption.
    if (config.injectBleedProfileId !== undefined) {
      db.$client
        .prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')")
        .run(config.injectBleedProfileId, `live-dealer-${config.dealer.dealerKey}`);
    }
    // Drive the collision deterministically (the same seed → same claim order).
    interleaveClaims(db, profileIds, `live-dealer-${config.dealer.dealerKey}`, makePrng(config.seed));

    // Replay leg, NO provider: the real chokepoint returns the recorded result
    // token-for-token. (Cast through unknown: resolveModel's LanguageModel union
    // is wider than the v3 doGenerate shape the wrapper guarantees.)
    if (transcript.length > 0) {
      const resolved = resolveModel("deepseek.cheap") as unknown as {
        doGenerate: (o: unknown) => Promise<unknown>;
      };
      const replayed = await resolved.doGenerate(mpReplayLegOptions());
      // Token-for-token: deep-equal to the first recorded event's result. A hash
      // mismatch / exhaustion already threw a typed error from index.next(); this
      // guards the value identity too.
      if (JSON.stringify(replayed) !== JSON.stringify(transcript[0]!.result)) {
        throw new ReplayLegMismatchError(
          `replay leg result did not match the recorded result token-for-token (case ${config.caseId})`,
        );
      }
    }

    return runAllInvariants({ db, profileIds });
  } finally {
    __resetHarnessModelWrapper();
    tmp.close();
  }
}

// ---------------------------------------------------------------------------
// result helpers (DeterministicResult requires expected + observed)
// ---------------------------------------------------------------------------

function ok(assertionId: string, observed: string): DeterministicResult {
  return { assertionId, ok: true, expected: "in sync", observed };
}

function fail(assertionId: string, detail: string): DeterministicResult {
  return { assertionId, ok: false, expected: "in sync", observed: "out of sync", detail };
}
