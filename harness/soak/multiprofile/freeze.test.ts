/**
 * freeze.test.ts — the green.sh DETERMINISTIC gate for the Phase-4 self-evolving
 * mp corpus. NO PROVIDER: every test here runs with all provider keys unset (the
 * replay leg goes through resolveModel's wrapper to a no-provider replayModel).
 *
 * Coverage (per task-5-brief §freeze.test.ts):
 *  - freezeMultiProfileToCorpus writes case.json + transcript.jsonl AND appends
 *    exactly one manifest line; re-reading the manifest shows it; the dir exists.
 *  - runMpReplayCase on the CHECKED-IN case returns all-ok invariant results with
 *    provider keys irrelevant; the replay leg returns the recorded result
 *    token-for-token (asserted inside runMpReplayCase; a mismatch throws).
 *  - ITERATE the real manifest: every listed case replays + meets expectedAllOk —
 *    the fast no-provider CI gate forever after.
 *  - assertManifestInSync: ok for the real manifest; RED on a dangling line.
 *  - a freeze-then-replay round-trip for a synthetic VIOLATION reproduces the
 *    violation (ok:false on the named invariant) — proving freeze captures real
 *    failures. Uses a TEMP outDir/manifest so it never pollutes the committed one.
 *
 * NO live provider anywhere: the recorded "real" model is testSupport's
 * makeStructuredObjectModel (a deterministic v3 fake), recorded once through
 * recordingModel, replayed with no provider. budget #9: the seeded budgetMax
 * values exist only so budget_no_leak has data — we never print a figure.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  __resetHarnessModelWrapper,
  recordingModel,
  makeStructuredObjectModel,
  type TranscriptEvent,
  type TranscriptSink,
} from "@autobroker/model";

import {
  assertManifestInSync,
  freezeMultiProfileToCorpus,
  mpReplayLegOptions,
  MP_CASES_ROOT,
  MP_MANIFEST_PATH,
  readMpManifest,
  runMpReplayCase,
  type MpProfileSeed,
  type SharedDealerSeed,
} from "./freeze.js";

// --- shared fixtures --------------------------------------------------------

const PROFILES: MpProfileSeed[] = [
  { id: "mp-accord", year: 2026, make: "Honda", model: "Accord", trim: "EX-L", budgetMax: 40000 },
  { id: "mp-camry", year: 2026, make: "Toyota", model: "Camry", trim: "XSE", budgetMax: 42000 },
];
const DEALER: SharedDealerSeed = {
  dealerKey: "freeze-rooftop",
  name: "Freeze Auto Group",
  website: "https://freeze.example",
};

/** In-memory transcript sink (same idiom as collision.test.ts). */
function memSink(): TranscriptSink & { events: TranscriptEvent[] } {
  const events: TranscriptEvent[] = [];
  return { events, append: (ev) => events.push(ev) };
}

/**
 * Record ONE mpReplayLegOptions() call through recordingModel(makeStructuredObjectModel)
 * into an in-memory sink → the committable transcript events. Stable (the fake
 * model's output is fixed) so the same call always produces the same JSONL.
 */
async function recordOneLeg(runId: string): Promise<TranscriptEvent[]> {
  const real = makeStructuredObjectModel({ object: { verdict: "ok" } });
  const sink = memSink();
  const recorder = recordingModel(real as Parameters<typeof recordingModel>[0], sink, {
    runId,
    alias: "deepseek.cheap",
  });
  await recorder.doGenerate(mpReplayLegOptions() as never);
  return sink.events;
}

afterEach(() => __resetHarnessModelWrapper());

// --- the freeze (write + append) round-trip ---------------------------------

describe("freezeMultiProfileToCorpus — write case + append manifest", () => {
  it("writes case.json + transcript.jsonl and appends exactly one manifest line", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "mp-freeze-"));
    const casesRoot = join(tmpRoot, "cases", "mp");
    const manifestPath = join(tmpRoot, "multiprofile-corpus.txt");
    try {
      const transcript = await recordOneLeg("freeze-write-run");
      const { caseDir, manifestLine } = freezeMultiProfileToCorpus({
        caseId: "mp_clean_write",
        seed: 4242,
        config: { profiles: PROFILES, dealer: DEALER, expectedAllOk: true },
        transcript,
        outDir: casesRoot,
        manifestPath,
      });

      expect(manifestLine).toBe("mp_clean_write");
      // case.json + transcript.jsonl exist + parse.
      const config = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as {
        caseId: string;
        seed: number;
        expectedAllOk: boolean;
        profiles: unknown[];
      };
      expect(config.caseId).toBe("mp_clean_write");
      expect(config.seed).toBe(4242);
      expect(config.expectedAllOk).toBe(true);
      expect(config.profiles).toHaveLength(2);
      const jsonl = readFileSync(join(caseDir, "transcript.jsonl"), "utf8");
      expect(jsonl.trim().split("\n")).toHaveLength(1);

      // Exactly one manifest line; re-reading shows it.
      expect(readMpManifest(manifestPath)).toEqual(["mp_clean_write"]);

      // Idempotent: freezing the same id again does NOT duplicate the line.
      freezeMultiProfileToCorpus({
        caseId: "mp_clean_write",
        seed: 4242,
        config: { profiles: PROFILES, dealer: DEALER, expectedAllOk: true },
        transcript,
        outDir: casesRoot,
        manifestPath,
      });
      expect(readMpManifest(manifestPath)).toEqual(["mp_clean_write"]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// --- replay the checked-in case (NO provider) -------------------------------

describe("runMpReplayCase — the checked-in clean case (NO provider)", () => {
  it("returns all-ok invariant results; the replay leg matched the recorded result token-for-token", async () => {
    const ids = readMpManifest(MP_MANIFEST_PATH);
    expect(ids.length).toBeGreaterThan(0);
    const cleanId = ids[0]!;
    const results = await runMpReplayCase(join(MP_CASES_ROOT, cleanId));
    // Every invariant holds (the checked-in case is a CLEAN scenario). A thrown
    // ReplayLegMismatchError / ReplayPromptMismatchError would already have failed
    // this test — reaching here proves the replay leg matched token-for-token.
    for (const r of results) {
      expect(r.ok, `${r.assertionId}: ${r.detail ?? ""}`).toBe(true);
    }
    // budget_no_leak specifically PASSES (inv #9: figures exist in seed, never leak).
    expect(results.find((r) => r.assertionId === "budget_no_leak")?.ok).toBe(true);
  });
});

// --- iterate the real manifest (the forever-after CI gate) -------------------

describe("the multiprofile-corpus manifest — every case replays + meets expectedAllOk", () => {
  it("each listed case replays with no provider and matches its expectedAllOk", async () => {
    const ids = readMpManifest(MP_MANIFEST_PATH);
    expect(ids.length).toBeGreaterThan(0);
    for (const caseId of ids) {
      const caseDir = join(MP_CASES_ROOT, caseId);
      const config = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as {
        expectedAllOk: boolean;
        failingInvariant?: string;
      };
      const results = await runMpReplayCase(caseDir);
      const allOk = results.every((r) => r.ok);
      expect(allOk, `${caseId} expectedAllOk=${config.expectedAllOk} but allOk=${allOk}`).toBe(
        config.expectedAllOk,
      );
      if (!config.expectedAllOk && config.failingInvariant !== undefined) {
        const named = results.find((r) => r.assertionId === config.failingInvariant);
        expect(named?.ok, `${caseId}: named failing invariant ${config.failingInvariant} should be ok:false`).toBe(
          false,
        );
      }
    }
  });
});

// --- manifest sync trap -----------------------------------------------------

describe("assertManifestInSync — the sync trap", () => {
  it("ok for the real manifest (every line has a case dir, no orphan dir)", () => {
    const res = assertManifestInSync(MP_MANIFEST_PATH, MP_CASES_ROOT);
    expect(res.ok, res.detail ?? "").toBe(true);
  });

  it("RED when a manifest line has no case dir (dangling)", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "mp-sync-"));
    const casesRoot = join(tmpRoot, "cases", "mp");
    const manifestPath = join(tmpRoot, "multiprofile-corpus.txt");
    try {
      // A manifest with a line whose case dir does NOT exist.
      writeFileSync(manifestPath, "# header\nmp_does_not_exist\n", "utf8");
      const res = assertManifestInSync(manifestPath, casesRoot);
      expect(res.ok).toBe(false);
      expect(String(res.detail)).toContain("mp_does_not_exist");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// --- freeze-then-replay a synthetic VIOLATION (temp manifest) ---------------

describe("freeze-then-replay a synthetic VIOLATION — reproduces the named invariant failure", () => {
  it("a frozen no_cross_profile_bleed violation replays as ok:false on that invariant", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "mp-violation-"));
    const casesRoot = join(tmpRoot, "cases", "mp");
    const manifestPath = join(tmpRoot, "multiprofile-corpus.txt");
    try {
      const transcript = await recordOneLeg("freeze-violation-run");
      const { caseDir } = freezeMultiProfileToCorpus({
        caseId: "mp_bleed_violation",
        seed: 99,
        config: {
          profiles: PROFILES,
          dealer: DEALER,
          expectedAllOk: false,
          injectBleedProfileId: "mp-ghost-unknown",
        },
        transcript,
        failingInvariant: "no_cross_profile_bleed",
        outDir: casesRoot,
        manifestPath,
      });

      const results = await runMpReplayCase(caseDir);
      const bleed = results.find((r) => r.assertionId === "no_cross_profile_bleed");
      expect(bleed?.ok, bleed?.detail ?? "").toBe(false);
      // The violation is reproduced, NOT all-ok.
      expect(results.every((r) => r.ok)).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
