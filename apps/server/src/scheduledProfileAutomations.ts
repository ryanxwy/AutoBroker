/**
 * Pinned, profile-by-profile job bodies for the standing background scheduler.
 *
 * - inbox_poll starts dealer_inbox_check for each active profile. The workflow
 *   may park a review, but this layer never submits a form decision or resumes it.
 * - morning_scan starts inventory_site_scan for each active profile. The existing
 *   scanChain lifecycle listener remains the sole owner of the aggregator follow-up.
 * Starts are awaited in iteration order (never Promise.all). SkillRunService's
 * durable T0 claim is the authoritative occupied-profile check; a loser is a
 * traceable skip with no workflow creation. Harness/test contexts are a complete
 * no-op so scheduled automation cannot make live-harness runs nondeterministic.
 */

import {
  INBOX_CHECK_SKILL_ID,
  INVENTORY_SITE_SCAN_SKILL_ID,
} from "@autobroker/skills";
import { getDb, isHarnessContext, listProfileRows } from "@autobroker/tools";

import {
  ProfileRunConflictError,
  type SkillRunService,
} from "./skillRuns.js";
import type {
  BackgroundScheduler,
  JobSpec,
  JobTrigger,
  ScheduledJobHandler,
  SchedulerTrace,
} from "./scheduler.js";

type HandlerRegistrar = Pick<BackgroundScheduler, "registerHandler">;
type ProfileRunStarter = Pick<SkillRunService, "descriptorFor" | "start">;

export interface ScheduledProfileAutomationDeps {
  listActiveProfiles(): Record<string, unknown>[];
  isHarness(): boolean;
}

const realDeps: ScheduledProfileAutomationDeps = {
  listActiveProfiles: () => listProfileRows(getDb(), "active"),
  isHarness: () => isHarnessContext(),
};

function traceFor(
  scheduler: SchedulerTrace["scheduler"],
  job: JobSpec,
  trigger: JobTrigger,
  detail: string,
  profileId?: string,
): SchedulerTrace {
  return {
    scheduler,
    job: job.name,
    skill: job.skill,
    trigger,
    detail,
    ...(profileId !== undefined ? { profileId } : {}),
  };
}

function profileIdOf(row: Record<string, unknown>): string | null {
  const value = row["search_profile_id"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pinnedProfileHandler(
  skillId: typeof INBOX_CHECK_SKILL_ID | typeof INVENTORY_SITE_SCAN_SKILL_ID,
  skillRuns: ProfileRunStarter,
  deps: ScheduledProfileAutomationDeps,
): ScheduledJobHandler {
  return async (job, trigger, trace) => {
    if (deps.isHarness()) {
      trace(traceFor("job_noop", job, trigger, "harness/test context: automatic runs disabled"));
      return;
    }

    const descriptor = skillRuns.descriptorFor(skillId);
    if (descriptor === undefined) {
      throw new Error(`scheduled skill '${skillId}' has no run descriptor`);
    }

    const rows = deps.listActiveProfiles();
    if (rows.length === 0) {
      trace(traceFor("job_noop", job, trigger, "no active profiles"));
      return;
    }

    for (const row of rows) {
      const profileId = profileIdOf(row);
      if (profileId === null) {
        trace(traceFor("profile_skipped", job, trigger, "active row missing profile id"));
        continue;
      }
      const input = descriptor.buildInput({ search_profile_id: profileId });
      try {
        const started = await skillRuns.start({ skill: skillId, input });
        trace(traceFor("profile_run", job, trigger, `started run ${started.runId}`, profileId));
      } catch (error) {
        if (error instanceof ProfileRunConflictError) {
          trace(
            traceFor(
              "profile_skipped",
              job,
              trigger,
              `occupied by live run ${error.liveRunId ?? "unknown"}`,
              profileId,
            ),
          );
          continue;
        }
        throw error;
      }
    }
  };
}

/** Register the T3/T4 pinned profile sweeps. Daily digest remains registered by
 * the app entrypoint because it is one unscoped run rather than a profile sweep. */
export function installScheduledProfileAutomations(
  scheduler: HandlerRegistrar,
  skillRuns: ProfileRunStarter,
  deps: ScheduledProfileAutomationDeps = realDeps,
): void {
  scheduler.registerHandler(
    "inbox_poll",
    pinnedProfileHandler(INBOX_CHECK_SKILL_ID, skillRuns, deps),
  );
  scheduler.registerHandler(
    "morning_scan",
    pinnedProfileHandler(INVENTORY_SITE_SCAN_SKILL_ID, skillRuns, deps),
  );
}
