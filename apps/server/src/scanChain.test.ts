/**
 * scanChain — the app-layer site_scan → aggregator_scan auto-chain listener.
 * Driven through the same fake-Mastra scripted-result harness as
 * skillRuns.portfolio.test.ts (no real workflow); the SessionService is a stub
 * exposing only recordRun. Covers: the happy chain (pinned input + same session
 * recorded), the no-chain guards (declined/failed/no-profile/kill-switch), the
 * no-recursion property, the announce-before-`done` frame ordering, and the
 * chain-start-failure isolation (the parent terminal must survive).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { resetRuntimeGlueForTests } from "@autobroker/workflows";
import {
  INVENTORY_AGGREGATOR_SCAN_SKILL_ID,
  INVENTORY_SITE_SCAN_SKILL_ID,
} from "@autobroker/skills";

import { SkillRunService } from "./skillRuns.js";
import { SessionService } from "./sessions.js";
import { RunPubSub, type SseEvent } from "./runPubSub.js";
import { installScanChain } from "./scanChain.js";
import { useFreshProductDb } from "./testProductDb.js";

// start()/terminal teardown writes the activation registry (pipeline_state) on
// the product DB — give each case a fresh, migrated DB.
useFreshProductDb();

afterEach(() => {
  resetRuntimeGlueForTests();
  vi.restoreAllMocks();
});

/** Scripted WorkflowResult sequence — the index is SHARED, so a chained sibling
 *  start consumes the next scripted result (or the clamped last). Status is
 *  tracked PER runId so a second run's dup-check (getWorkflowRunById) sees null
 *  for its own fresh id (a single shared flag would falsely flag it duplicate). */
function fakeMastra(sequence: Array<Record<string, unknown>>) {
  let i = 0;
  const statusByRun = new Map<string, string>();
  const next = () => sequence[Math.min(i++, sequence.length - 1)]!;
  const workflow = {
    createRun: async ({ runId }: { runId: string }) => ({
      start: async () => {
        const result = next();
        statusByRun.set(runId, String((result as { status?: unknown }).status ?? "running"));
        return result;
      },
      resume: async () => {
        const result = next();
        statusByRun.set(runId, String((result as { status?: unknown }).status ?? "running"));
        return result;
      },
    }),
    getWorkflowRunById: async (runId: string) => {
      const status = statusByRun.get(runId);
      return status === undefined ? null : { status };
    },
  };
  return { getWorkflow: () => workflow } as never;
}

/** A completed site/aggregator scan result (outcome != declined → completed). */
const SUCCESS_SCANNED = {
  status: "success",
  result: { outcome: "scanned", summary: "Scanned 2 of 2." },
};
const SUCCESS_DECLINED = { status: "success", result: { outcome: "declined" } };
const FAILED = { status: "failed", error: { message: "scan_blew_up" } };

/** A SessionService stub exposing only the recordRun seam the chain uses. */
function fakeSessions(): { sessions: SessionService; recordRun: ReturnType<typeof vi.fn> } {
  const recordRun = vi.fn().mockResolvedValue(undefined);
  return { sessions: { recordRun } as unknown as SessionService, recordRun };
}

/** Flush enough micro/macrotask turns for the parent translate + the
 *  fire-and-forget sibling start + its recordRun to settle. */
async function flush(times = 6): Promise<void> {
  for (let n = 0; n < times; n += 1) await new Promise((r) => setTimeout(r, 0));
}

/** A pinned site_scan input (buildInput is not re-run — svc.start takes it verbatim). */
function siteScanInput(profileId: string | null): Record<string, unknown> {
  return { search_profile_id: profileId, dealer_ids: null, approved_by: null, max_targets: null };
}

function findAnnounce(frames: SseEvent[]): { frame: SseEvent; index: number } | null {
  const index = frames.findIndex(
    (f) => f.kind === "text" && (f.payload as { chained_run?: unknown }).chained_run !== undefined,
  );
  return index === -1 ? null : { frame: frames[index]!, index };
}

describe("scanChain — happy path", () => {
  it("a completed site_scan with a profile auto-starts an aggregator_scan (pinned input + same session recorded)", async () => {
    const svc = new SkillRunService(fakeMastra([SUCCESS_SCANNED]), new RunPubSub());
    const { sessions, recordRun } = fakeSessions();
    installScanChain(svc, sessions);
    const startSpy = vi.spyOn(svc, "start");

    const { runId: parentRunId } = await svc.start({
      skill: INVENTORY_SITE_SCAN_SKILL_ID,
      runId: "parent-site-1",
      input: siteScanInput("profile-A"),
      sessionId: "sess-1",
    });
    await flush();

    // Exactly two starts: the parent site_scan (call 0) + the aggregator sibling (call 1).
    expect(startSpy).toHaveBeenCalledTimes(2);
    const sibling = startSpy.mock.calls[1]![0] as {
      skill: string;
      runId: string;
      input: unknown;
      sessionId: string | null;
    };
    expect(sibling.skill).toBe(INVENTORY_AGGREGATOR_SCAN_SKILL_ID);
    expect(sibling.input).toEqual({ search_profile_id: "profile-A" });
    expect(sibling.sessionId).toBe("sess-1");
    expect(typeof sibling.runId).toBe("string");
    expect(sibling.runId).not.toBe(parentRunId);

    // The sibling is bound to the parent's session (durable rail turn).
    expect(recordRun).toHaveBeenCalledWith("sess-1", sibling.runId);
  });

  it("an UNPINNED site_scan (null input profile, resolver-inferred) chains via the RESULT's profile", async () => {
    // The live gap this pins: a Skills-popover launch passes search_profile_id
    // null (the workflow resolves inferred-newest internally), so
    // RunState.searchProfileId is null at start — translate() must backfill it
    // from the completed result's searchProfileId before the terminal fan-out,
    // else the chain silently never fires for every unpinned scan.
    const resolvedResult = {
      status: "success",
      result: {
        outcome: "scanned",
        searchProfileId: "profile-resolved",
        resolution: "inferred_newest",
        summary: "Scanned 2 of 2.",
      },
    };
    const svc = new SkillRunService(fakeMastra([resolvedResult]), new RunPubSub());
    const { sessions, recordRun } = fakeSessions();
    installScanChain(svc, sessions);
    const startSpy = vi.spyOn(svc, "start");

    await svc.start({
      skill: INVENTORY_SITE_SCAN_SKILL_ID,
      runId: "parent-unpinned",
      input: siteScanInput(null),
      sessionId: "sess-1",
    });
    await flush();

    expect(startSpy).toHaveBeenCalledTimes(2);
    const sibling = startSpy.mock.calls[1]![0] as { skill: string; input: unknown; runId: string };
    expect(sibling.skill).toBe(INVENTORY_AGGREGATOR_SCAN_SKILL_ID);
    // The sibling is PINNED to the profile the parent actually acted on.
    expect(sibling.input).toEqual({ search_profile_id: "profile-resolved" });
    expect(recordRun).toHaveBeenCalledWith("sess-1", sibling.runId);
  });

  it("headless parent (no session) still chains, but records no session link", async () => {
    const svc = new SkillRunService(fakeMastra([SUCCESS_SCANNED]), new RunPubSub());
    const { sessions, recordRun } = fakeSessions();
    installScanChain(svc, sessions);
    const startSpy = vi.spyOn(svc, "start");

    await svc.start({
      skill: INVENTORY_SITE_SCAN_SKILL_ID,
      runId: "parent-site-headless",
      input: siteScanInput("profile-A"),
      // no sessionId → headless
    });
    await flush();

    expect(startSpy).toHaveBeenCalledTimes(2);
    const sibling = startSpy.mock.calls[1]![0] as { sessionId: string | null };
    expect(sibling.sessionId).toBeNull();
    expect(recordRun).not.toHaveBeenCalled();
  });
});

describe("scanChain — no-chain guards", () => {
  it("a DECLINED site_scan does not chain", async () => {
    const svc = new SkillRunService(fakeMastra([SUCCESS_DECLINED]), new RunPubSub());
    const { sessions, recordRun } = fakeSessions();
    installScanChain(svc, sessions);
    const startSpy = vi.spyOn(svc, "start");

    await svc.start({
      skill: INVENTORY_SITE_SCAN_SKILL_ID,
      runId: "parent-declined",
      input: siteScanInput("profile-A"),
      sessionId: "sess-1",
    });
    await flush();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("a FAILED site_scan does not chain", async () => {
    const svc = new SkillRunService(fakeMastra([FAILED]), new RunPubSub());
    const { sessions, recordRun } = fakeSessions();
    installScanChain(svc, sessions);
    const startSpy = vi.spyOn(svc, "start");

    await svc.start({
      skill: INVENTORY_SITE_SCAN_SKILL_ID,
      runId: "parent-failed",
      input: siteScanInput("profile-A"),
      sessionId: "sess-1",
    });
    await flush();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("a site_scan with NO profile does not chain", async () => {
    const svc = new SkillRunService(fakeMastra([SUCCESS_SCANNED]), new RunPubSub());
    const { sessions } = fakeSessions();
    installScanChain(svc, sessions);
    const startSpy = vi.spyOn(svc, "start");

    await svc.start({
      skill: INVENTORY_SITE_SCAN_SKILL_ID,
      runId: "parent-noprofile",
      input: siteScanInput(null),
      sessionId: "sess-1",
    });
    await flush();

    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("AUTOBROKER_SITESCAN_CHAIN=0 disables the chain", async () => {
    const prev = process.env.AUTOBROKER_SITESCAN_CHAIN;
    process.env.AUTOBROKER_SITESCAN_CHAIN = "0";
    try {
      const svc = new SkillRunService(fakeMastra([SUCCESS_SCANNED]), new RunPubSub());
      const { sessions } = fakeSessions();
      installScanChain(svc, sessions);
      const startSpy = vi.spyOn(svc, "start");

      await svc.start({
        skill: INVENTORY_SITE_SCAN_SKILL_ID,
        runId: "parent-killswitch",
        input: siteScanInput("profile-A"),
        sessionId: "sess-1",
      });
      await flush();

      expect(startSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.AUTOBROKER_SITESCAN_CHAIN;
      else process.env.AUTOBROKER_SITESCAN_CHAIN = prev;
    }
  });

  it("a completed aggregator_scan does NOT chain (recursion is structurally impossible)", async () => {
    const svc = new SkillRunService(fakeMastra([SUCCESS_SCANNED]), new RunPubSub());
    const { sessions } = fakeSessions();
    installScanChain(svc, sessions);
    const startSpy = vi.spyOn(svc, "start");

    await svc.start({
      skill: INVENTORY_AGGREGATOR_SCAN_SKILL_ID,
      runId: "parent-agg",
      input: { search_profile_id: "profile-A" },
      sessionId: "sess-1",
    });
    await flush();

    // Only the aggregator itself started — its terminal does not re-enter the chain.
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

describe("scanChain — announce frame + failure isolation", () => {
  it("appends the chained_run announce on the PARENT channel BEFORE its done frame", async () => {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(fakeMastra([SUCCESS_SCANNED]), pubsub);
    const { sessions } = fakeSessions();
    installScanChain(svc, sessions);
    const startSpy = vi.spyOn(svc, "start");

    await svc.start({
      skill: INVENTORY_SITE_SCAN_SKILL_ID,
      runId: "parent-announce",
      input: siteScanInput("profile-A"),
      sessionId: "sess-1",
    });
    await flush();

    const frames = pubsub.snapshot("parent-announce");
    const announce = findAnnounce(frames);
    const doneIndex = frames.findIndex((f) => f.kind === "done");
    expect(announce).not.toBeNull();
    expect(doneIndex).toBeGreaterThan(-1);
    // The announce lands BEFORE done (post-terminal appends would be discarded).
    expect(announce!.index).toBeLessThan(doneIndex);

    // It carries a voiced line + the sibling {run_id, skill}.
    const payload = announce!.frame.payload as {
      text?: string;
      chained_run?: { run_id?: string; skill?: string };
    };
    expect(typeof payload.text).toBe("string");
    expect(payload.text!.length).toBeGreaterThan(0);
    const siblingRunId = (startSpy.mock.calls[1]![0] as { runId: string }).runId;
    expect(payload.chained_run).toEqual({
      run_id: siblingRunId,
      skill: INVENTORY_AGGREGATOR_SCAN_SKILL_ID,
    });
  });

  it("a session-LINK failure (start succeeded) logs a link failure, not a start one", async () => {
    // The sibling started fine; only sessions.recordRun rejected. The log must
    // tell the truth — a link failure, never "failed to start".
    const svc = new SkillRunService(fakeMastra([SUCCESS_SCANNED]), new RunPubSub());
    const recordRun = vi.fn().mockRejectedValue(new Error("link_boom"));
    const sessions = { recordRun } as unknown as SessionService;
    installScanChain(svc, sessions);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await svc.start({
      skill: INVENTORY_SITE_SCAN_SKILL_ID,
      runId: "parent-linkfail",
      input: siteScanInput("profile-A"),
      sessionId: "sess-1",
    });
    await flush();

    // The start ran (the sibling exists), recordRun was attempted and rejected,
    // and the single logged message names the LINK failure, not a start failure.
    expect(svc.isTerminal("parent-linkfail")).toBe(true);
    expect(recordRun).toHaveBeenCalledWith("sess-1", expect.any(String));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]![0]);
    expect(logged).toContain("linking it to session");
    expect(logged).not.toContain("failed to start");
  });

  it("a chain-start FAILURE never breaks the parent terminal", async () => {
    const pubsub = new RunPubSub();
    const svc = new SkillRunService(fakeMastra([SUCCESS_SCANNED]), pubsub);
    const { sessions, recordRun } = fakeSessions();
    installScanChain(svc, sessions);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Fail ONLY the aggregator sibling start; the parent runs through the real start.
    const realStart = svc.start.bind(svc);
    vi.spyOn(svc, "start").mockImplementation((args: Parameters<SkillRunService["start"]>[0]) => {
      if (args.skill === INVENTORY_AGGREGATOR_SCAN_SKILL_ID) {
        return Promise.reject(new Error("sibling_start_boom"));
      }
      return realStart(args);
    });

    await svc.start({
      skill: INVENTORY_SITE_SCAN_SKILL_ID,
      runId: "parent-chainfail",
      input: siteScanInput("profile-A"),
      sessionId: "sess-1",
    });
    await flush();

    // The parent still reached its terminal `done`, with the announce before it.
    const frames = pubsub.snapshot("parent-chainfail");
    expect(frames.some((f) => f.kind === "done")).toBe(true);
    expect(findAnnounce(frames)).not.toBeNull();
    expect(svc.isTerminal("parent-chainfail")).toBe(true);
    // The failed sibling recorded no session link, and the failure was logged.
    expect(recordRun).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
