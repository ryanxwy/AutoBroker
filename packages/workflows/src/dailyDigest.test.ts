/**
 * daily_digest workflow-level L1 — drives the REAL flat Mastra createWorkflow
 * (createRun → start) against fully INJECTED deps (no DB, no fs): a stubbed
 * generateDigest, a recording writeDigestArtifact + writeLastDigestAt, and a
 * frozen `now`. Freezes:
 *   - generated outcome on a populated world (artifact written, watermark
 *     advanced for every summarized profile, no budget in the summary);
 *   - skipped outcome on zero active profiles (no write, no watermark);
 *   - the headline/deep-link are produced by notify (no new Notification()).
 *
 * NOTE: this resolves the digest tools against the built `dist` barrel — it is
 * authored here but RUN by the integrate-and-green tail (after the controller
 * barrel-exports the digest tools and rebuilds dist), per the cross-package
 * workflow-test convention. It does NOT run in the tools-only test pass.
 */

import { describe, expect, it, afterEach, vi } from "vitest";

import type { DigestPayload } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import { DailyDigestOutputSchema } from "./dailyDigestContracts.js";
import {
  dailyDigestWorkflow,
  DAILY_DIGEST_WORKFLOW_ID,
  DIGEST_SECTIONS_COUNT,
  __resetDailyDigestDepsForTests,
  __setDailyDigestDepsForTests,
} from "./dailyDigest.js";

const NOW = 1_750_000_000_000;

function populatedPayload(): DigestPayload {
  return {
    state: "ok",
    generatedAtMs: NOW,
    sinceHours: null,
    profiles: [
      {
        searchProfileId: "p1",
        vehicle: "2026 Hyundai Tucson",
        dealerCount: 2,
        boundDealerCount: 1,
        threadCount: 3,
        needsResponseCount: 1,
        unansweredQuestionCount: 2,
        offers: [
          {
            quoteId: "q1",
            dealerId: "d1",
            dealerName: "Alpha",
            otdTotal: 38000,
            financingMode: "cash",
            freshness: "fresh",
          },
        ],
        totalQuotes: 1,
        bestOtd: 38000,
        freshnessMix: { fresh: 1, stale: 0, missing: 0 },
      },
      {
        searchProfileId: "p2",
        vehicle: "2026 Honda CR-V",
        dealerCount: 1,
        boundDealerCount: 0,
        threadCount: 0,
        needsResponseCount: 0,
        unansweredQuestionCount: 0,
        offers: [],
        totalQuotes: 0,
        bestOtd: null,
        freshnessMix: { fresh: 0, stale: 0, missing: 0 },
      },
    ],
    nextActions: [
      {
        kind: "needs_response",
        profileId: "p1",
        vehicle: "2026 Hyundai Tucson",
        count: 1,
        label: "2026 Hyundai Tucson: 1 dealer reply(ies) need a response.",
      },
    ],
    overallBestOtd: 38000,
  };
}

function emptyPayload(): DigestPayload {
  return {
    state: "_NO_ACTIVE_SEARCHES",
    generatedAtMs: NOW,
    sinceHours: null,
    profiles: [],
    nextActions: [],
    overallBestOtd: null,
  };
}

function workflow() {
  const mastra = createMastraInstance({
    workflows: { [DAILY_DIGEST_WORKFLOW_ID]: dailyDigestWorkflow as never },
  });
  return mastra.getWorkflow(DAILY_DIGEST_WORKFLOW_ID);
}

async function startRun(searchProfileId: string | null = null) {
  const run = await workflow().createRun({ runId: `test-${Math.random().toString(36).slice(2)}` });
  const result = await run.start({ inputData: { search_profile_id: searchProfileId } });
  return result;
}

function outputOf(result: unknown): Record<string, unknown> {
  return (result as { result: Record<string, unknown> }).result;
}

afterEach(() => {
  __resetDailyDigestDepsForTests();
});

describe("daily_digest workflow", () => {
  it("generated: writes an artifact, advances the watermark per profile, no budget", async () => {
    const writtenPaths: string[] = [];
    const htmlPaths: string[] = [];
    const watermarks: Array<{ profileId: string; atMs: number }> = [];
    __setDailyDigestDepsForTests({
      now: () => NOW,
      getDb: (() => ({}) as never) as never,
      generateDigest: () => populatedPayload(),
      writeDigestArtifact: (_text, args) => {
        const p = `/tmp/digests/digest-${args.nowMs}.md`;
        writtenPaths.push(p);
        return p;
      },
      writeDigestHtmlSnapshot: () => {
        const p = "/tmp/digests/latest.html";
        htmlPaths.push(p);
        return p;
      },
      writeLastDigestAt: ((_db: unknown, profileId: string, atMs: number) => {
        watermarks.push({ profileId, atMs });
      }) as never,
      resolveDataDir: () => "/tmp",
    });

    const result = await startRun(null);
    const out = DailyDigestOutputSchema.parse(outputOf(result));
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") throw new Error("unreachable");
    expect(out.profilesSummarized).toBe(2);
    expect(out.bestOtd).toBe(38000);
    expect(out.sectionsCount).toBe(DIGEST_SECTIONS_COUNT);
    expect(out.artifactPath).toBe(`/tmp/digests/digest-${NOW}.md`);
    expect(out.summary).not.toMatch(/budget/i);

    expect(writtenPaths).toHaveLength(1);
    expect(htmlPaths).toEqual(["/tmp/digests/latest.html"]);
    // Watermark advanced for EVERY summarized profile.
    expect(watermarks.map((w) => w.profileId).sort()).toEqual(["p1", "p2"]);
    expect(watermarks.every((w) => w.atMs === NOW)).toBe(true);
  });

  it("notify produces the headline + /digest deep-link (in step output)", async () => {
    __setDailyDigestDepsForTests({
      now: () => NOW,
      getDb: (() => ({}) as never) as never,
      generateDigest: () => populatedPayload(),
      writeDigestArtifact: () => "/tmp/digests/x.md",
      writeDigestHtmlSnapshot: () => "/tmp/digests/latest.html",
      writeLastDigestAt: (() => undefined) as never,
      resolveDataDir: () => "/tmp",
    });
    const result = await startRun(null);
    const steps = (result as { steps?: Record<string, { output?: Record<string, unknown> }> }).steps;
    const notifyOut = steps?.["notify"]?.output;
    expect(notifyOut?.["deepLink"]).toBe("/digest");
    expect(typeof notifyOut?.["headline"]).toBe("string");
    expect(String(notifyOut?.["headline"])).not.toMatch(/budget/i);
  });

  it("checks the HTML budget red-line before writing either artifact", async () => {
    const writeText = vi.fn(() => "/tmp/digests/x.md");
    const writeHtml = vi.fn(() => "/tmp/digests/latest.html");
    __setDailyDigestDepsForTests({
      now: () => NOW,
      getDb: (() => ({}) as never) as never,
      generateDigest: () => populatedPayload(),
      renderDigestHtml: () => "My budget is $35,000.",
      writeDigestArtifact: writeText,
      writeDigestHtmlSnapshot: writeHtml,
      writeLastDigestAt: (() => undefined) as never,
      resolveDataDir: () => "/tmp",
    });

    const result = await startRun(null);
    expect((result as { status?: string }).status).toBe("failed");
    expect(writeText).not.toHaveBeenCalled();
    expect(writeHtml).not.toHaveBeenCalled();
  });

  it("skipped: zero active profiles → graceful skip, no artifact, no watermark", async () => {
    const writeArtifact = vi.fn(() => "/tmp/should-not-write.md");
    const writeHtml = vi.fn(() => "/tmp/should-not-write.html");
    const writeWatermark = vi.fn();
    __setDailyDigestDepsForTests({
      now: () => NOW,
      getDb: (() => ({}) as never) as never,
      generateDigest: () => emptyPayload(),
      writeDigestArtifact: writeArtifact,
      writeDigestHtmlSnapshot: writeHtml,
      writeLastDigestAt: writeWatermark as never,
      resolveDataDir: () => "/tmp",
    });

    const result = await startRun(null);
    const out = DailyDigestOutputSchema.parse(outputOf(result));
    expect(out.outcome).toBe("skipped");
    if (out.outcome !== "skipped") throw new Error("unreachable");
    expect(out.reason).toBe("no_active_profile");
    expect(out.summary).toContain("intake");
    expect(writeArtifact).not.toHaveBeenCalled();
    expect(writeHtml).not.toHaveBeenCalled();
    expect(writeWatermark).not.toHaveBeenCalled();
  });

  it("a pinned profile id scopes the digest (passed through to generateDigest)", async () => {
    const seen: Array<string[] | null> = [];
    __setDailyDigestDepsForTests({
      now: () => NOW,
      getDb: (() => ({}) as never) as never,
      generateDigest: (_db, args) => {
        seen.push(args.profileIds ?? null);
        return populatedPayload();
      },
      writeDigestArtifact: () => "/tmp/x.md",
      writeDigestHtmlSnapshot: () => "/tmp/digests/latest.html",
      writeLastDigestAt: (() => undefined) as never,
      resolveDataDir: () => "/tmp",
    });
    await startRun("p-pinned");
    expect(seen[0]).toEqual(["p-pinned"]);
  });
});
