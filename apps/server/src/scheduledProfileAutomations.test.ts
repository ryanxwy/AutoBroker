import { describe, expect, it } from "vitest";

import {
  INBOX_CHECK_SKILL_ID,
  INVENTORY_SITE_SCAN_SKILL_ID,
} from "@autobroker/skills";

import { ProfileRunConflictError, type RunDescriptor } from "./skillRuns.js";
import {
  installScheduledProfileAutomations,
  type ScheduledProfileAutomationDeps,
} from "./scheduledProfileAutomations.js";
import {
  SCHEDULED_JOBS,
  type ScheduledJobHandler,
  type SchedulerTrace,
} from "./scheduler.js";

function fixture(opts: {
  profiles?: string[];
  harness?: boolean;
  testMode?: boolean;
  occupied?: ReadonlySet<string>;
} = {}) {
  const handlers = new Map<string, ScheduledJobHandler>();
  const starts: Array<{ skill: string; input: unknown }> = [];
  let activeStarts = 0;
  let maxActiveStarts = 0;
  const descriptor = (skillId: string): RunDescriptor => ({
    skillId,
    workflowId: `workflow.${skillId}`,
    driverKind: () => "deepseek_apikey",
    buildInput: (body) => ({ search_profile_id: body["search_profile_id"] ?? null }),
    summaryText: () => "done",
  });
  const skillRuns = {
    descriptorFor: (skillId: string) => descriptor(skillId),
    start: async (args: { skill: string; input: unknown }) => {
      const profileId = (args.input as { search_profile_id: string }).search_profile_id;
      starts.push(args);
      activeStarts += 1;
      maxActiveStarts = Math.max(maxActiveStarts, activeStarts);
      await Promise.resolve();
      activeStarts -= 1;
      if (opts.occupied?.has(profileId) === true) {
        throw new ProfileRunConflictError(profileId, `attempt-${profileId}`, `live-${profileId}`);
      }
      return { runId: `run-${args.skill}-${profileId}` };
    },
  };
  const deps: ScheduledProfileAutomationDeps = {
    listActiveProfiles: () =>
      (opts.profiles ?? []).map((search_profile_id) => ({ search_profile_id })),
    isHarness: () => opts.harness ?? false,
    isTestMode: () => opts.testMode ?? false,
  };
  installScheduledProfileAutomations(
    { registerHandler: (name, handler) => void handlers.set(name, handler) },
    skillRuns as never,
    deps,
  );
  return { handlers, starts, maxActiveStarts: () => maxActiveStarts };
}

async function run(
  handlers: Map<string, ScheduledJobHandler>,
  jobName: "inbox_poll" | "morning_scan",
): Promise<SchedulerTrace[]> {
  const job = SCHEDULED_JOBS.find((candidate) => candidate.name === jobName);
  if (job === undefined) throw new Error(`missing job ${jobName}`);
  const traces: SchedulerTrace[] = [];
  const handler = handlers.get(jobName);
  if (handler === undefined) throw new Error(`missing handler ${jobName}`);
  await handler(job, "catch_up_boot", (line) => traces.push(line));
  return traces;
}

describe("scheduled profile automations", () => {
  it("inbox_poll starts only pinned inbox checks, sequentially, and never resumes a gate", async () => {
    const f = fixture({ profiles: ["profile-a", "profile-b"] });
    const traces = await run(f.handlers, "inbox_poll");

    expect(f.starts).toEqual([
      { skill: INBOX_CHECK_SKILL_ID, input: { search_profile_id: "profile-a" } },
      { skill: INBOX_CHECK_SKILL_ID, input: { search_profile_id: "profile-b" } },
    ]);
    expect(f.maxActiveStarts()).toBe(1);
    expect(traces.filter((line) => line.scheduler === "profile_run")).toHaveLength(2);
  });

  it("morning_scan starts only pinned site scans, sequentially, and leaves chaining to scanChain", async () => {
    const f = fixture({ profiles: ["profile-a", "profile-b"] });
    const traces = await run(f.handlers, "morning_scan");

    expect(f.starts).toEqual([
      { skill: INVENTORY_SITE_SCAN_SKILL_ID, input: { search_profile_id: "profile-a" } },
      { skill: INVENTORY_SITE_SCAN_SKILL_ID, input: { search_profile_id: "profile-b" } },
    ]);
    expect(f.maxActiveStarts()).toBe(1);
    expect(traces.filter((line) => line.scheduler === "profile_run")).toHaveLength(2);
    expect(f.starts.every((start) => start.skill === INVENTORY_SITE_SCAN_SKILL_ID)).toBe(true);
  });

  it("skips an occupied profile before workflow creation and continues the sweep", async () => {
    const f = fixture({
      profiles: ["profile-a", "profile-b"],
      occupied: new Set(["profile-a"]),
    });
    const traces = await run(f.handlers, "inbox_poll");

    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheduler: "profile_skipped",
          profileId: "profile-a",
          detail: "occupied by live run live-profile-a",
        }),
        expect.objectContaining({ scheduler: "profile_run", profileId: "profile-b" }),
      ]),
    );
  });

  it("is a graceful no-op with no profiles and in every harness/test context", async () => {
    const empty = fixture({ profiles: [] });
    expect(await run(empty.handlers, "inbox_poll")).toEqual([
      expect.objectContaining({ scheduler: "job_noop", detail: "no active profiles" }),
    ]);
    expect(empty.starts).toEqual([]);

    const harness = fixture({ profiles: ["profile-a"], harness: true });
    expect(await run(harness.handlers, "inbox_poll")).toEqual([
      expect.objectContaining({
        scheduler: "job_noop",
        detail: "harness/test context: automatic runs disabled",
      }),
    ]);
    expect(harness.starts).toEqual([]);

    expect(await run(harness.handlers, "morning_scan")).toEqual([
      expect.objectContaining({
        scheduler: "job_noop",
        detail: "harness/test context: automatic runs disabled",
      }),
    ]);
    expect(harness.starts).toEqual([]);
  });

  it("keeps inbox fake-capable but disables the browser morning scan in test mode", async () => {
    const f = fixture({ profiles: ["profile-a"], testMode: true });

    await run(f.handlers, "inbox_poll");
    expect(f.starts).toEqual([
      { skill: INBOX_CHECK_SKILL_ID, input: { search_profile_id: "profile-a" } },
    ]);

    const traces = await run(f.handlers, "morning_scan");
    expect(traces).toEqual([
      expect.objectContaining({
        scheduler: "job_noop",
        detail: "test mode: browser inventory scan disabled",
      }),
    ]);
    expect(f.starts).toHaveLength(1);
  });
});
